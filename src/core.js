import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ACTION_TYPES = new Set(['navigate', 'type', 'click', 'wait', 'extract']);
export const OUTCOME_KINDS = new Set(['success', 'business_outcome', 'failure', 'escalated']);

const SENSITIVE_KEY = /(?:password|secret|token|authorization|cookie|credential|member(?:_?id|_?no)?|balance|account(?:_?number)?|ssn|financial)/i;
const MEMBER_PATTERN = /\bM-(?:\d{3,}|TIMEOUT|RETRY|DENIED|DIALOG)\b/gi;
const LITERAL_MEMBER_PATTERN = /\bM-(?:\d{3,}|TIMEOUT|RETRY|DENIED|DIALOG)\b/i;
const MONEY_PATTERN = /(?:\$\s?\d[\d,]*(?:\.\d{2})?)/g;
const AUTH_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const LONG_ID_PATTERN = /\b\d{8,}\b/g;

export class AutomationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, code, message, details = {}) {
  if (!condition) throw new AutomationError(code, message, details);
}

export function isoNow(clock = Date) {
  return new clock().toISOString();
}

export function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function redactText(value) {
  return String(value)
    .replace(AUTH_PATTERN, '$1 [REDACTED]')
    .replace(MEMBER_PATTERN, '[MEMBER_ID]')
    .replace(MONEY_PATTERN, '[FINANCIAL_VALUE]')
    .replace(LONG_ID_PATTERN, '[IDENTIFIER]');
}

export function redact(value, parentKey = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(parentKey) && !value.startsWith('{{')) {
      return `[REDACTED:${parentKey || 'value'}:${stableHash(value)}]`;
    }
    return redactText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return SENSITIVE_KEY.test(parentKey) ? `[REDACTED:${parentKey}]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, parentKey));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
  }
  return String(value);
}

export async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, 'utf8');
}

export class RunJournal {
  constructor({ runId = randomUUID(), clock = Date } = {}) {
    this.runId = runId;
    this.clock = clock;
    this.events = [];
  }

  emit(type, payload = {}) {
    const event = {
      seq: this.events.length + 1,
      at: isoNow(this.clock),
      runId: this.runId,
      type,
      ...redact(payload)
    };
    this.events.push(event);
    return event;
  }

  toJsonl() {
    return `${this.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  }

  async save(filePath) {
    await writeText(filePath, this.toJsonl());
  }
}

export function routeMatches(pathname, rule) {
  if (rule === '*') return true;
  if (rule.endsWith('*')) return pathname.startsWith(rule.slice(0, -1));
  return pathname === rule;
}

export class PolicyGuard {
  constructor(policy, surface) {
    this.policy = policy;
    this.surface = surface;
  }

  assertAction(action, { targetRisk = 'safe' } = {}) {
    assert(this.policy.allowedActions.includes(action.type), 'ACTION_NOT_ALLOWED', `Action ${action.type} is not allowlisted.`, { action });

    if (action.type === 'navigate') {
      const destination = new URL(action.path, this.surface.baseUrl);
      const originIsAllowed = this.policy.allowedOrigins.includes('same-origin')
        ? destination.origin === this.surface.origin
        : this.policy.allowedOrigins.includes(destination.origin);
      assert(originIsAllowed, 'ORIGIN_NOT_ALLOWED', `Navigation origin is not allowlisted: ${destination.origin}`, { destination: destination.href });
      assert(
        this.policy.allowedRoutes.some((rule) => routeMatches(destination.pathname, rule)),
        'ROUTE_NOT_ALLOWED',
        `Navigation route is not allowlisted: ${destination.pathname}`,
        { destination: destination.href }
      );
    }

    const risky = targetRisk === 'risky' || targetRisk === 'irreversible' || action.type === 'submit';
    if (risky && !this.policy.allowRiskyActions) {
      throw new AutomationError('RISKY_ACTION_REQUIRES_APPROVAL', 'A risky or irreversible action cannot run unattended.', {
        action: redact(action),
        targetRisk
      });
    }
  }
}

export function resolveTemplate(value, inputs) {
  if (typeof value !== 'string') return value;
  const whole = value.match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/);
  if (whole) {
    assert(Object.hasOwn(inputs, whole[1]), 'MISSING_INPUT', `Missing input parameter: ${whole[1]}`);
    return inputs[whole[1]];
  }
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, name) => {
    assert(Object.hasOwn(inputs, name), 'MISSING_INPUT', `Missing input parameter: ${name}`);
    return String(inputs[name]);
  });
}

export function validateInputs(contract, inputs) {
  const received = inputs ?? {};
  const allowed = new Set(contract.inputs.map((input) => input.name));
  for (const key of Object.keys(received)) {
    assert(allowed.has(key), 'UNKNOWN_INPUT', `Unknown input parameter: ${key}`);
  }
  for (const definition of contract.inputs) {
    const value = received[definition.name];
    if (value === undefined || value === null) {
      assert(!definition.required, 'MISSING_INPUT', `Missing required input: ${definition.name}`);
      continue;
    }
    assert(typeof value === definition.type, 'INVALID_INPUT_TYPE', `Input ${definition.name} must be a ${definition.type}.`);
    if (definition.pattern) {
      assert(new RegExp(definition.pattern).test(value), 'INVALID_INPUT', `Input ${definition.name} has an invalid format.`);
    }
  }
  return received;
}

export function assertCapabilityValid(capability) {
  assert(capability && typeof capability === 'object', 'INVALID_ARTIFACT', 'Capability must be an object.');
  assert(capability.schemaVersion === 'computer-use-capability/v1', 'INVALID_ARTIFACT', 'Unsupported capability schema version.');
  assert(/^[a-z0-9][a-z0-9._-]+$/.test(capability.id ?? ''), 'INVALID_ARTIFACT', 'Capability id is invalid.');
  assert(/^\d+\.\d+\.\d+$/.test(capability.version ?? ''), 'INVALID_ARTIFACT', 'Capability version must be semantic.');
  assert(['draft', 'approved', 'retired'].includes(capability.approval?.status), 'INVALID_ARTIFACT', 'Capability approval status is invalid.');
  assert(Array.isArray(capability.contract?.inputs), 'INVALID_ARTIFACT', 'Capability must declare typed inputs.');
  assert(Array.isArray(capability.contract?.outputs), 'INVALID_ARTIFACT', 'Capability must declare typed outputs.');
  assert(Array.isArray(capability.steps) && capability.steps.length > 0, 'INVALID_ARTIFACT', 'Capability must contain at least one step.');
  assert(Array.isArray(capability.policy?.allowedActions), 'INVALID_ARTIFACT', 'Capability policy must allowlist actions.');
  assert(Array.isArray(capability.policy?.allowedRoutes), 'INVALID_ARTIFACT', 'Capability policy must allowlist routes.');
  assert(Array.isArray(capability.policy?.allowedOrigins), 'INVALID_ARTIFACT', 'Capability policy must allowlist origins.');
  assert(Array.isArray(capability.success?.all), 'INVALID_ARTIFACT', 'Capability needs a success checkpoint.');
  assert(capability.outcomes?.business && capability.outcomes?.recoverable && capability.outcomes?.hardFailures, 'INVALID_ARTIFACT', 'Capability needs all outcome classes.');

  const inputNames = new Set();
  for (const input of capability.contract.inputs) {
    assert(typeof input.name === 'string' && input.name.length > 0, 'INVALID_ARTIFACT', 'Input needs a name.');
    assert(!inputNames.has(input.name), 'INVALID_ARTIFACT', `Duplicate input: ${input.name}`);
    inputNames.add(input.name);
    assert(['string', 'number', 'boolean'].includes(input.type), 'INVALID_ARTIFACT', `Unsupported input type: ${input.type}`);
  }
  const outputNames = new Set();
  for (const output of capability.contract.outputs) {
    assert(typeof output.name === 'string' && output.name.length > 0, 'INVALID_ARTIFACT', 'Output needs a name.');
    assert(!outputNames.has(output.name), 'INVALID_ARTIFACT', `Duplicate output: ${output.name}`);
    outputNames.add(output.name);
  }
  for (const step of capability.steps) {
    assert(ACTION_TYPES.has(step.type), 'INVALID_ARTIFACT', `Unsupported step type: ${step.type}`);
    assert(typeof step.id === 'string', 'INVALID_ARTIFACT', 'Every step needs an id.');
    if (['type', 'click'].includes(step.type)) {
      assert(step.target?.logicalName && Array.isArray(step.target?.candidates), 'INVALID_ARTIFACT', `Step ${step.id} needs a robust target.`);
      assert(step.target.candidates.length > 0, 'INVALID_ARTIFACT', `Step ${step.id} needs locator candidates.`);
    }
    if (step.type === 'type') {
      assert(typeof step.value === 'string' && step.value.includes('{{'), 'SENSITIVE_LITERAL_IN_ARTIFACT', `Typed step ${step.id} must use an input template rather than a literal.`);
    }
    if (step.type === 'extract') {
      assert(step.extract?.output && step.extract?.pattern, 'INVALID_ARTIFACT', `Extract step ${step.id} needs an output and pattern.`);
      assert(outputNames.has(step.extract.output), 'INVALID_ARTIFACT', `Extract step ${step.id} references undeclared output ${step.extract.output}.`);
    }
  }
  const serialised = JSON.stringify(capability);
  assert(!LITERAL_MEMBER_PATTERN.test(serialised), 'SENSITIVE_LITERAL_IN_ARTIFACT', 'Artifact contains a literal member identifier.');
  return capability;
}

export async function conditionSatisfied(surface, condition) {
  const observation = await surface.observe();
  switch (condition.type) {
    case 'page_contains':
      return observation.text.includes(condition.value);
    case 'page_not_contains':
      return !observation.text.includes(condition.value);
    case 'url_path':
      return new URL(observation.url).pathname === condition.value;
    case 'control_present':
      return observation.controls.some((control) => control.key === condition.value);
    case 'control_value':
      return surface.getControlValue(condition.key ?? condition.control) === condition.value;
    default:
      throw new AutomationError('UNKNOWN_CONDITION', `Unknown condition type: ${condition.type}`, { condition });
  }
}

export async function assertCheckpoint(surface, checkpoint, stepId) {
  if (!checkpoint) return;
  const passed = await conditionSatisfied(surface, checkpoint);
  assert(passed, 'CHECKPOINT_FAILED', `Checkpoint failed after ${stepId}: ${checkpoint.type}`, {
    stepId,
    expected: checkpoint,
    observed: redact(await surface.observe())
  });
}

export function createMemberBalanceCapability({ steps, discoveryRunId = 'fixture', approval = 'draft' }) {
  const capability = {
    schemaVersion: 'computer-use-capability/v1',
    id: 'member.savings-balance.read',
    version: '1.0.0',
    title: 'Read current savings balance',
    description: 'Looks up a member and returns the current savings balance without changing account state.',
    createdFrom: { discoveryRunId, recorder: 'executor-normalized' },
    approval: {
      status: approval,
      approvedBy: approval === 'approved' ? 'demo-review-fixture' : null,
      approvedAt: approval === 'approved' ? '2026-08-20T00:00:00.000Z' : null
    },
    surface: {
      kind: 'web',
      vendorFamily: 'coreflex-member-service',
      entryPath: '/',
      fingerprint: {
        titleContains: 'CoreFlex',
        landmarkText: 'Member servicing',
        strategy: 'semantic-locator-with-legacy-form-fallback'
      }
    },
    tenantScope: {
      mode: 'vendor-family',
      compatibilityKey: 'coreflex-member-service@demo-v1',
      tenantOverrides: []
    },
    contract: {
      inputs: [
        {
          name: 'memberId',
          type: 'string',
          required: true,
          sensitive: true,
          pattern: '^M-(?:[0-9]{4}|404|TIMEOUT|RETRY|DENIED|DIALOG)$',
          description: 'Institution-scoped member identifier. This value is never serialized into the capability or journal.'
        }
      ],
      outputs: [
        { name: 'savingsBalance', type: 'string', sensitive: true, description: 'Current savings balance as displayed by the target.' },
        { name: 'outcome', type: 'string', description: 'success or an expected business-outcome code.' }
      ]
    },
    policy: {
      allowedOrigins: ['same-origin'],
      allowedRoutes: ['/', '/members', '/members/search'],
      allowedActions: ['navigate', 'type', 'click', 'wait', 'extract'],
      allowRiskyActions: false,
      dataHandling: 'redact-before-persist'
    },
    steps,
    success: {
      all: [
        { type: 'url_path', value: '/members/search' },
        { type: 'page_contains', value: 'Savings balance' }
      ]
    },
    outcomes: {
      business: [
        { code: 'member_not_found', surfaceState: 'member_not_found', callerStatus: 'not_found', message: 'No member matched the supplied identifier.' }
      ],
      recoverable: [
        { code: 'transient_loading', surfaceState: 'transient_loading', strategy: 'wait_then_retry', maxAttempts: 2, delayMs: 20 }
      ],
      hardFailures: [
        { code: 'session_expired', surfaceState: 'session_expired', escalate: true },
        { code: 'permission_denied', surfaceState: 'permission_denied', escalate: true },
        { code: 'validation_error', surfaceState: 'validation_error', escalate: false },
        { code: 'unexpected_dialog', surfaceState: 'unexpected_dialog', escalate: true }
      ]
    }
  };
  return assertCapabilityValid(capability);
}
