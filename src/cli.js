import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscoveryRunner } from './discovery.js';
import { HandoffBroker } from './handoff.js';
import { startLegacyApp } from './localLegacyApp.js';
import { OpenAIResponsesPolicy, RecordedPlanner } from './policies.js';
import { ReplayRunner } from './replay.js';
import { HttpLegacySurface, PlaywrightSurface, redactedSnapshot } from './surfaces.js';
import { assertCapabilityValid, redact, writeJson, writeText } from './core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultGoal = 'Look up member {{memberId}} and return the current savings balance.';

function parseArgs(values) {
  const args = {};
  for (const value of values) {
    if (!value.startsWith('--')) continue;
    const [key, ...rest] = value.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  }
  return args;
}

function outputPath(value, fallback) {
  return path.resolve(root, value || fallback);
}

async function startSurface(kind = 'http') {
  const app = await startLegacyApp();
  const surface = kind === 'browser'
    ? await PlaywrightSurface.launch(app.baseUrl)
    : await HttpLegacySurface.open(app.baseUrl);
  return {
    app,
    surface,
    async close() {
      await surface.close();
      await app.close();
    }
  };
}

function printable(result) {
  const { journal, snapshot, ...rest } = result;
  return rest;
}

async function saveRun(outputDir, prefix, result) {
  await result.journal.save(path.join(outputDir, `${prefix}.jsonl`));
  if (result.snapshot) await writeText(path.join(outputDir, `${prefix}-snapshot.html`), redactedSnapshot(result.snapshot));
  await writeJson(path.join(outputDir, `${prefix}-result.json`), redact(printable(result)));
}

async function discover(args) {
  const runtime = await startSurface(args.surface || 'http');
  try {
    const planner = args.policy === 'openai' ? new OpenAIResponsesPolicy() : new RecordedPlanner();
    const result = await new DiscoveryRunner({ surface: runtime.surface, planner }).run({
      goal: args.goal || defaultGoal,
      inputs: { memberId: args.memberId || 'M-1042' }
    });
    if (args.output) {
      const destination = outputPath(args.output, 'evidence/live');
      await saveRun(destination, 'discovery', result);
      if (result.kind === 'success') await writeJson(path.join(destination, 'capability.draft.json'), result.capability);
    }
    console.log(JSON.stringify(printable(result), null, 2));
    process.exitCode = result.kind === 'success' ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

async function loadCapability(value) {
  const filePath = outputPath(value, 'evidence/capabilities/read-savings-balance.v1.json');
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function replay(args) {
  const capability = await loadCapability(args.artifact);
  const runtime = await startSurface(args.surface || 'http');
  try {
    const broker = new HandoffBroker();
    const result = await new ReplayRunner({ surface: runtime.surface, handoffBroker: broker }).run({
      capability,
      inputs: { memberId: args.memberId || 'M-1042' }
    });
    if (args.output) await saveRun(outputPath(args.output, 'evidence/runs'), 'replay', result);
    console.log(JSON.stringify(printable(result), null, 2));
    process.exitCode = result.kind === 'success' || result.kind === 'business_outcome' ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

async function handoff(args) {
  const capability = await loadCapability(args.artifact);
  const runtime = await startSurface(args.surface || 'http');
  try {
    const broker = new HandoffBroker();
    const result = await new ReplayRunner({ surface: runtime.surface, handoffBroker: broker }).run({
      capability,
      inputs: { memberId: args.memberId || 'M-TIMEOUT' }
    });
    let resumed = null;
    if (result.intervention) {
      const operator = broker.takeControl(result.intervention.id, 'demo-operator');
      await operator.perform({ type: 'navigate', path: '/members' });
      resumed = await operator.resume();
    }
    console.log(JSON.stringify({ result: printable(result), resumed }, null, 2));
    process.exitCode = result.intervention && resumed?.surfaceSessionId === result.intervention.surfaceSessionId ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

async function evidence() {
  const evidenceDir = path.join(root, 'evidence');
  let artifact;

  {
    const runtime = await startSurface('http');
    try {
      const discovery = await new DiscoveryRunner({ surface: runtime.surface, planner: new RecordedPlanner() }).run({ goal: defaultGoal, inputs: { memberId: 'M-1042' } });
      if (discovery.kind !== 'success') throw new Error(`Fixture discovery failed: ${discovery.error?.message}`);
      artifact = {
        ...discovery.capability,
        approval: { status: 'approved', approvedBy: 'demo-review-fixture', approvedAt: '2026-08-20T00:00:00.000Z' }
      };
      assertCapabilityValid(artifact);
      await writeJson(path.join(evidenceDir, 'capabilities/read-savings-balance.v1.json'), artifact);
      await discovery.journal.save(path.join(evidenceDir, 'discovery-fixture.jsonl'));
      await writeJson(path.join(evidenceDir, 'discovery-fixture-result.json'), redact(printable(discovery)));
      await writeText(path.join(evidenceDir, 'snapshots/discovery-success.html'), redactedSnapshot(await runtime.surface.captureEvidence()));
    } finally {
      await runtime.close();
    }
  }

  {
    const runtime = await startSurface('http');
    try {
      const result = await new ReplayRunner({ surface: runtime.surface }).run({ capability: artifact, inputs: { memberId: 'M-1042' } });
      await result.journal.save(path.join(evidenceDir, 'replay-success.jsonl'));
      await writeJson(path.join(evidenceDir, 'replay-success-result.json'), redact(printable(result)));
    } finally {
      await runtime.close();
    }
  }

  {
    const runtime = await startSurface('http');
    try {
      const result = await new ReplayRunner({ surface: runtime.surface }).run({ capability: artifact, inputs: { memberId: 'M-404' } });
      await result.journal.save(path.join(evidenceDir, 'replay-not-found.jsonl'));
      await writeJson(path.join(evidenceDir, 'replay-not-found-result.json'), redact(printable(result)));
    } finally {
      await runtime.close();
    }
  }

  {
    const runtime = await startSurface('http');
    try {
      const broker = new HandoffBroker();
      const result = await new ReplayRunner({ surface: runtime.surface, handoffBroker: broker }).run({ capability: artifact, inputs: { memberId: 'M-TIMEOUT' } });
      await result.journal.save(path.join(evidenceDir, 'replay-session-expired.jsonl'));
      await writeJson(path.join(evidenceDir, 'replay-session-expired-result.json'), redact(printable(result)));
      if (result.intervention) {
        const operator = broker.takeControl(result.intervention.id, 'demo-operator');
        await operator.perform({ type: 'navigate', path: '/members' });
        const resumed = await operator.resume();
        await writeJson(path.join(evidenceDir, 'handoff-session-expired.json'), resumed);
        await writeText(path.join(evidenceDir, 'snapshots/session-expired.html'), redactedSnapshot(result.snapshot));
      }
    } finally {
      await runtime.close();
    }
  }

  console.log(`Evidence written to ${evidenceDir}`);
}

function usage() {
  console.log(`Usage:
  node src/cli.js evidence
  node src/cli.js discover --policy=fixture|openai --memberId=M-1042 [--surface=http|browser] [--output=evidence/live]
  node src/cli.js replay --artifact=evidence/capabilities/read-savings-balance.v1.json --memberId=M-1042
  node src/cli.js handoff --artifact=evidence/capabilities/read-savings-balance.v1.json --memberId=M-TIMEOUT`);
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (command === 'discover') await discover(args);
else if (command === 'replay') await replay(args);
else if (command === 'handoff') await handoff(args);
else if (command === 'evidence') await evidence();
else usage();
