import { AutomationError, assert, redact } from './core.js';

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'reason', 'path', 'targetKey', 'value', 'output', 'pattern', 'group', 'delayMs'],
  properties: {
    type: { enum: ['navigate', 'type', 'click', 'wait', 'extract', 'finish'] },
    reason: { type: 'string' },
    path: { type: ['string', 'null'] },
    targetKey: { type: ['string', 'null'] },
    value: { type: ['string', 'null'] },
    output: { type: ['string', 'null'] },
    pattern: { type: ['string', 'null'] },
    group: { type: ['number', 'null'] },
    delayMs: { type: ['number', 'null'] }
  }
};

export function validatePlannerDecision(decision, observation) {
  assert(decision && typeof decision === 'object', 'INVALID_MODEL_DECISION', 'Planner did not return an object.');
  assert(['navigate', 'type', 'click', 'wait', 'extract', 'finish'].includes(decision.type), 'INVALID_MODEL_DECISION', 'Planner returned an unsupported action.', { decision });
  assert(typeof decision.reason === 'string' && decision.reason.length > 0, 'INVALID_MODEL_DECISION', 'Planner must explain a decision briefly.');
  if (decision.type === 'navigate') assert(typeof decision.path === 'string', 'INVALID_MODEL_DECISION', 'Navigate action requires a path.');
  if (['type', 'click'].includes(decision.type)) {
    assert(typeof decision.targetKey === 'string', 'INVALID_MODEL_DECISION', `${decision.type} requires a target key.`);
    assert(observation.controls.some((control) => control.key === decision.targetKey), 'MODEL_TARGET_NOT_VISIBLE', `Planner selected non-visible control ${decision.targetKey}.`, { decision, controls: observation.controls });
  }
  if (decision.type === 'type') assert(typeof decision.value === 'string', 'INVALID_MODEL_DECISION', 'Type action requires a template value.');
  if (decision.type === 'extract') {
    assert(typeof decision.output === 'string' && typeof decision.pattern === 'string', 'INVALID_MODEL_DECISION', 'Extract action requires output and pattern.');
  }
  return decision;
}

export class RecordedPlanner {
  constructor() {
    this.name = 'recorded-decision-fixture';
    this.index = 0;
    this.decisions = [
      { type: 'navigate', path: '/members', reason: 'The goal requires the member inquiry screen.' },
      { type: 'type', targetKey: 'member_number', value: '{{memberId}}', reason: 'Enter the supplied member identifier in the visible inquiry field.' },
      { type: 'click', targetKey: 'find_member', reason: 'Submit the inquiry using the labeled lookup control.' },
      { type: 'extract', output: 'savingsBalance', pattern: 'Savings balance\\s*\\$([0-9,]+\\.\\d{2})', group: 1, reason: 'Read the balance next to the explicit Savings balance label.' },
      { type: 'finish', reason: 'The required value was extracted and the success state is visible.' }
    ];
  }

  async decide({ observation }) {
    const decision = this.decisions[this.index] ?? { type: 'finish', reason: 'The recorded plan is complete.' };
    this.index += 1;
    if (['type', 'click'].includes(decision.type)) return validatePlannerDecision(decision, observation);
    return decision;
  }
}

function responseText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.value === 'string') return content.value;
    }
  }
  return null;
}

export class OpenAIResponsesPolicy {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-5.6', fetchImpl = fetch } = {}) {
    this.name = 'openai-responses';
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
  }

  async decide({ goal, observation, policy }) {
    assert(this.apiKey, 'MODEL_KEY_MISSING', 'OPENAI_API_KEY is required for a genuine LLM discovery run.');
    const visibleControls = observation.controls.map(({ key, role, name, risk }) => ({ key, role, name, risk }));
    const developer = [
      'You are a conservative computer-use planner for a financial back-office UI.',
      'Take exactly one permitted action per turn. Never invent an unseen control, action, route, credential, or value.',
      'Use parameter templates such as {{memberId}}, never literal sensitive data.',
      'Prefer semantic visible controls and stop when the goal is met.',
      'Return JSON that conforms to the provided schema.'
    ].join(' ');
    const user = {
      goal,
      observation: redact({ ...observation, controls: visibleControls }),
      policy: {
        allowedActions: policy.allowedActions,
        allowedRoutes: policy.allowedRoutes,
        riskyActionsAllowed: Boolean(policy.allowRiskyActions)
      },
      instruction: 'For the requested member balance goal, extract savingsBalance only after it is visible. Use finish only after a verified success state or a known business outcome.'
    };
    const response = await this.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: 'system', content: developer },
          { role: 'user', content: JSON.stringify(user) }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'computer_use_decision',
            strict: true,
            schema: ACTION_SCHEMA
          }
        }
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new AutomationError('MODEL_REQUEST_FAILED', `Planner request failed with HTTP ${response.status}.`, { status: response.status, response: redact(body) });
    }
    const payload = await response.json();
    const text = responseText(payload);
    assert(text, 'MODEL_RESPONSE_INVALID', 'Planner response did not contain JSON text.');
    let decision;
    try {
      decision = JSON.parse(text);
    } catch {
      throw new AutomationError('MODEL_RESPONSE_INVALID', 'Planner returned non-JSON output.', { response: redact(text) });
    }
    return validatePlannerDecision(decision, observation);
  }
}
