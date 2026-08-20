import {
  AutomationError,
  PolicyGuard,
  RunJournal,
  assert,
  assertCheckpoint,
  conditionSatisfied,
  createMemberBalanceCapability,
  redact,
  resolveTemplate
} from './core.js';

export const DEFAULT_DISCOVERY_POLICY = {
  allowedOrigins: ['same-origin'],
  allowedRoutes: ['/', '/members', '/members/search'],
  allowedActions: ['navigate', 'type', 'click', 'wait', 'extract'],
  allowRiskyActions: false
};

function stepId(type, ordinal) {
  const known = {
    'navigate-1': 'open-member-inquiry',
    'type-2': 'enter-member-id',
    'click-3': 'submit-member-inquiry',
    'extract-4': 'read-savings-balance'
  };
  return known[`${type}-${ordinal}`] ?? `${type}-${ordinal}`;
}

function checkpointFor(type) {
  if (type === 'navigate') return { type: 'page_contains', value: 'Member inquiry' };
  if (type === 'click') return { type: 'url_path', value: '/members/search' };
  if (type === 'extract') return { type: 'page_contains', value: 'Savings balance' };
  return undefined;
}

function normalizeError(error) {
  return {
    code: error.code || 'UNEXPECTED_ERROR',
    message: error.message || String(error),
    details: redact(error.details || {})
  };
}

export class DiscoveryRunner {
  constructor({ surface, planner, journal = new RunJournal(), policy = DEFAULT_DISCOVERY_POLICY, maxSteps = 12, timeoutMs = 30_000, handoffBroker = null } = {}) {
    this.surface = surface;
    this.planner = planner;
    this.journal = journal;
    this.policy = policy;
    this.maxSteps = maxSteps;
    this.timeoutMs = timeoutMs;
    this.handoffBroker = handoffBroker;
  }

  async run({ goal, inputs }) {
    const startedAt = Date.now();
    const guard = new PolicyGuard(this.policy, this.surface);
    const recordedSteps = [];
    const outputs = {};
    this.journal.emit('discovery.started', {
      goal,
      planner: this.planner.name || 'unnamed-planner',
      surfaceSessionId: this.surface.sessionId,
      target: this.surface.baseUrl
    });

    try {
      for (let index = 0; index < this.maxSteps; index += 1) {
        assert(Date.now() - startedAt < this.timeoutMs, 'DISCOVERY_TIMEOUT', 'Discovery reached its time limit.');
        const observation = await this.surface.observe();
        this.journal.emit('surface.observed', { phase: 'discovery', step: index + 1, observation });
        const decision = await this.planner.decide({ goal, inputs, observation, policy: this.policy });
        this.journal.emit('planner.decided', { planner: this.planner.name || 'unnamed-planner', decision });

        if (decision.type === 'finish') {
          assert(Object.hasOwn(outputs, 'savingsBalance'), 'GOAL_NOT_MET', 'Planner finished before the declared output was extracted.');
          const capability = createMemberBalanceCapability({ steps: recordedSteps, discoveryRunId: this.journal.runId, approval: 'draft' });
          for (const successCondition of capability.success.all) {
            assert(await conditionSatisfied(this.surface, successCondition), 'GOAL_NOT_MET', `Planner finished without success condition ${successCondition.type}.`);
          }
          this.journal.emit('artifact.recorded', {
            capabilityId: capability.id,
            version: capability.version,
            approval: capability.approval.status,
            stepCount: capability.steps.length,
            outputs
          });
          return { kind: 'success', capability, outputs, journal: this.journal, steps: recordedSteps };
        }

        const ordinal = recordedSteps.length + 1;
        let normalizedStep;
        if (decision.type === 'navigate') {
          guard.assertAction(decision);
          await this.surface.navigate(decision.path);
          normalizedStep = { id: stepId('navigate', ordinal), type: 'navigate', path: decision.path, checkpoint: checkpointFor('navigate') };
        } else if (decision.type === 'type') {
          const target = this.surface.getControlSpec(decision.targetKey);
          guard.assertAction(decision, { targetRisk: this.surface.getControlRisk(decision.targetKey) });
          const value = resolveTemplate(decision.value, inputs);
          await this.surface.type(target, value);
          normalizedStep = {
            id: stepId('type', ordinal),
            type: 'type',
            target,
            value: decision.value,
            sensitiveInput: 'memberId'
          };
        } else if (decision.type === 'click') {
          const target = this.surface.getControlSpec(decision.targetKey);
          guard.assertAction(decision, { targetRisk: this.surface.getControlRisk(decision.targetKey) });
          await this.surface.click(target);
          normalizedStep = { id: stepId('click', ordinal), type: 'click', target, checkpoint: checkpointFor('click') };
        } else if (decision.type === 'wait') {
          guard.assertAction(decision);
          await this.surface.wait(decision.delayMs ?? 20);
          normalizedStep = { id: stepId('wait', ordinal), type: 'wait', delayMs: decision.delayMs ?? 20 };
        } else if (decision.type === 'extract') {
          guard.assertAction(decision);
          const observationAfterAction = await this.surface.observe();
          const expression = new RegExp(decision.pattern);
          const matched = expression.exec(observationAfterAction.text);
          assert(matched, 'EXTRACTION_FAILED', `Could not extract ${decision.output} from the visible UI.`, { output: decision.output, pattern: decision.pattern });
          outputs[decision.output] = matched[decision.group ?? 1] ?? matched[0];
          normalizedStep = {
            id: stepId('extract', ordinal),
            type: 'extract',
            extract: { output: decision.output, pattern: decision.pattern, group: decision.group ?? 1 },
            checkpoint: checkpointFor('extract')
          };
        } else {
          throw new AutomationError('INVALID_MODEL_DECISION', `Unsupported planner action: ${decision.type}`);
        }
        recordedSteps.push(normalizedStep);
        await assertCheckpoint(this.surface, normalizedStep.checkpoint, normalizedStep.id);
        this.journal.emit('surface.action_completed', { phase: 'discovery', action: normalizedStep.type, stepId: normalizedStep.id });
      }
      throw new AutomationError('MAX_STEPS', `Discovery stopped after ${this.maxSteps} actions.`);
    } catch (error) {
      const snapshot = await this.surface.captureEvidence().catch(() => null);
      this.journal.emit('discovery.failed', { error: normalizeError(error), snapshot: snapshot ? { kind: snapshot.kind, state: snapshot.state, currentUrl: snapshot.currentUrl } : null });
      let intervention = null;
      if (this.handoffBroker && ['RISKY_ACTION_REQUIRES_APPROVAL', 'MAX_STEPS', 'DISCOVERY_TIMEOUT', 'TARGET_NOT_FOUND', 'AMBIGUOUS_TARGET'].includes(error.code)) {
        intervention = await this.handoffBroker.request({
          runId: this.journal.runId,
          capabilityId: 'discovery-in-progress',
          goal,
          stepId: recordedSteps.at(-1)?.id ?? 'before-first-step',
          reason: normalizeError(error),
          surface: this.surface,
          snapshot
        });
      }
      return { kind: intervention ? 'escalated' : 'failure', error: normalizeError(error), intervention, journal: this.journal, snapshot, steps: recordedSteps };
    }
  }
}
