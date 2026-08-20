import test from 'node:test';
import strict from 'node:assert/strict';
import { DiscoveryRunner } from '../src/discovery.js';
import { HandoffBroker } from '../src/handoff.js';
import { startLegacyApp } from '../src/localLegacyApp.js';
import { OpenAIResponsesPolicy, RecordedPlanner } from '../src/policies.js';
import { ReplayRunner } from '../src/replay.js';
import { HttpLegacySurface } from '../src/surfaces.js';
import { AutomationError, PolicyGuard, RunJournal, assertCapabilityValid, redactText } from '../src/core.js';

async function withSurface(run) {
  const app = await startLegacyApp();
  const surface = await HttpLegacySurface.open(app.baseUrl);
  try {
    return await run({ app, surface });
  } finally {
    await surface.close();
    await app.close();
  }
}

async function approvedArtifact() {
  return withSurface(async ({ surface }) => {
    const result = await new DiscoveryRunner({ surface, planner: new RecordedPlanner() }).run({
      goal: 'Look up member {{memberId}} and return the current savings balance.',
      inputs: { memberId: 'M-1042' }
    });
    strict.equal(result.kind, 'success');
    const artifact = {
      ...result.capability,
      approval: { status: 'approved', approvedBy: 'test-reviewer', approvedAt: '2026-08-20T00:00:00.000Z' }
    };
    assertCapabilityValid(artifact);
    return artifact;
  });
}

test('discovery drives the live local UI, records a parameterized artifact, and redacts the journal', async () => {
  await withSurface(async ({ surface }) => {
    const journal = new RunJournal();
    const result = await new DiscoveryRunner({ surface, planner: new RecordedPlanner(), journal }).run({
      goal: 'Look up member {{memberId}} and return the current savings balance.',
      inputs: { memberId: 'M-1042' }
    });
    strict.equal(result.kind, 'success');
    strict.equal(result.outputs.savingsBalance, '1,234.56');
    strict.deepEqual(result.capability.steps.map((step) => step.type), ['navigate', 'type', 'click', 'extract']);
    strict.equal(result.capability.steps[1].value, '{{memberId}}');
    strict.equal(result.capability.steps[1].target.candidates[0].strategy, 'accessibility');
    strict.equal(result.capability.steps[1].target.candidates[1].strategy, 'legacy_form_control');
    strict.doesNotMatch(JSON.stringify(result.capability), /M-1042|1,234\.56/);
    strict.doesNotMatch(journal.toJsonl(), /M-1042|1,234\.56|\$1,234\.56/);
    strict.match(journal.toJsonl(), /recorded-decision-fixture/);
  });
});

test('approved artifact replays deterministically and returns the declared output without a planner', async () => {
  const artifact = await approvedArtifact();
  await withSurface(async ({ surface }) => {
    const result = await new ReplayRunner({ surface }).run({ capability: artifact, inputs: { memberId: 'M-1042' } });
    strict.equal(result.kind, 'success');
    strict.deepEqual(result.outputs, { savingsBalance: '1,234.56', outcome: 'success' });
    strict.doesNotMatch(result.journal.toJsonl(), /M-1042|1,234\.56/);
    strict.match(result.journal.toJsonl(), /replay.succeeded/);
  });
});

test('not found is an expected business outcome rather than an automation failure', async () => {
  const artifact = await approvedArtifact();
  await withSurface(async ({ surface }) => {
    const result = await new ReplayRunner({ surface }).run({ capability: artifact, inputs: { memberId: 'M-404' } });
    strict.equal(result.kind, 'business_outcome');
    strict.equal(result.code, 'member_not_found');
    strict.equal(result.callerStatus, 'not_found');
    strict.equal(result.outputs.outcome, 'member_not_found');
  });
});

test('declared transient state is retried with a bounded recovery path', async () => {
  const artifact = await approvedArtifact();
  await withSurface(async ({ surface }) => {
    const result = await new ReplayRunner({ surface }).run({ capability: artifact, inputs: { memberId: 'M-RETRY' } });
    strict.equal(result.kind, 'success');
    strict.match(result.journal.toJsonl(), /replay.recovery_started/);
    strict.match(result.journal.toJsonl(), /replay.recovery_succeeded/);
  });
});

test('session expiry creates a same-session human handoff and resumes audited control', async () => {
  const artifact = await approvedArtifact();
  await withSurface(async ({ surface }) => {
    const broker = new HandoffBroker();
    const result = await new ReplayRunner({ surface, handoffBroker: broker }).run({ capability: artifact, inputs: { memberId: 'M-TIMEOUT' } });
    strict.equal(result.kind, 'escalated');
    strict.equal(result.intervention.surfaceSessionId, surface.sessionId);
    const operator = broker.takeControl(result.intervention.id, 'operator-test');
    await operator.perform({ type: 'navigate', path: '/members' });
    const resumed = await operator.resume();
    strict.equal(resumed.status, 'resumed');
    strict.equal(resumed.ownership, 'automation');
    strict.equal(resumed.surfaceSessionId, surface.sessionId);
    strict.equal(resumed.actions.filter((item) => item.type === 'manual_action').length, 1);
  });
});

test('guardrails reject non-allowlisted routes and risky state-changing controls', async () => {
  const artifact = await approvedArtifact();
  await withSurface(async ({ surface }) => {
    const guard = new PolicyGuard(artifact.policy, surface);
    strict.throws(() => guard.assertAction({ type: 'navigate', path: '/admin/export' }), (error) => error instanceof AutomationError && error.code === 'ROUTE_NOT_ALLOWED');
    await surface.navigate('/members/search?member_no=M-1042');
    strict.throws(() => guard.assertAction({ type: 'click' }, { targetRisk: surface.getControlRisk('open_sub_account') }), (error) => error instanceof AutomationError && error.code === 'RISKY_ACTION_REQUIRES_APPROVAL');
    strict.equal(redactText('Member M-1042 has $1,234.56'), 'Member [MEMBER_ID] has [FINANCIAL_VALUE]');
  });
});

test('live planner sends a strict structured Responses request and validates the returned action', async () => {
  let request;
  const policy = new OpenAIResponsesPolicy({
    apiKey: 'test-key-not-persisted',
    model: 'test-model',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          type: 'navigate',
          reason: 'Open the visible member inquiry route.',
          path: '/members',
          targetKey: null,
          value: null,
          output: null,
          pattern: null,
          group: null,
          delayMs: null
        })
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const decision = await policy.decide({
    goal: 'Read a balance.',
    observation: { url: 'https://tenant.example/', text: 'Home', controls: [] },
    policy: { allowedActions: ['navigate'], allowedRoutes: ['/members'], allowRiskyActions: false }
  });
  strict.equal(decision.path, '/members');
  strict.equal(request.url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(request.init.body);
  strict.equal(body.input[0].role, 'system');
  strict.equal(body.text.format.type, 'json_schema');
  strict.equal(body.text.format.strict, true);
  strict.deepEqual(body.text.format.schema.required, ['type', 'reason', 'path', 'targetKey', 'value', 'output', 'pattern', 'group', 'delayMs']);
});
