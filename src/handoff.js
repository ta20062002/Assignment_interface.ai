import { randomUUID } from 'node:crypto';
import { assert, isoNow, redact, redactText } from './core.js';
import { redactedSnapshot } from './surfaces.js';

function publicRequest(request) {
  return {
    id: request.id,
    status: request.status,
    ownership: request.ownership,
    runId: request.runId,
    capabilityId: request.capabilityId,
    goal: request.goal,
    stepId: request.stepId,
    reason: request.reason,
    surfaceSessionId: request.surfaceSessionId,
    operatorUrl: request.operatorUrl,
    createdAt: request.createdAt,
    resumedAt: request.resumedAt ?? null,
    operator: request.operator ?? null,
    snapshot: request.snapshot,
    actions: request.actions
  };
}

export class HandoffBroker {
  constructor({ clock = Date } = {}) {
    this.clock = clock;
    this.requests = new Map();
  }

  async request({ runId, capabilityId, goal, stepId, reason, surface, snapshot }) {
    const id = `hitl-${randomUUID()}`;
    const request = {
      id,
      status: 'awaiting_human',
      ownership: 'human',
      runId,
      capabilityId,
      goal: redact(goal),
      stepId,
      reason: redact(reason),
      surfaceSessionId: surface.sessionId,
      operatorUrl: `${surface.baseUrl}/operator?request=${encodeURIComponent(id)}`,
      createdAt: isoNow(this.clock),
      snapshot: snapshot ? {
        kind: snapshot.kind,
        state: snapshot.state,
        currentUrl: redactText(snapshot.currentUrl),
        content: redactedSnapshot(snapshot)
      } : null,
      actions: [],
      _surface: surface
    };
    this.requests.set(id, request);
    return publicRequest(request);
  }

  get(requestId) {
    const request = this.requests.get(requestId);
    assert(request, 'HANDOFF_NOT_FOUND', `No intervention request ${requestId}.`);
    return publicRequest(request);
  }

  takeControl(requestId, operatorId = 'human-operator') {
    const request = this.requests.get(requestId);
    assert(request, 'HANDOFF_NOT_FOUND', `No intervention request ${requestId}.`);
    assert(request.status === 'awaiting_human', 'HANDOFF_NOT_AVAILABLE', `Request ${requestId} is not awaiting human control.`);
    request.status = 'human_in_control';
    request.ownership = 'human';
    request.operator = operatorId;
    request.actions.push({ at: isoNow(this.clock), actor: operatorId, type: 'control_taken', surfaceSessionId: request.surfaceSessionId });

    return {
      request: () => publicRequest(request),
      perform: async (action) => {
        assert(request.status === 'human_in_control' && request.ownership === 'human', 'HUMAN_NOT_IN_CONTROL', 'The human does not currently own this session.');
        const observation = await request._surface.humanPerform(action);
        request.actions.push({ at: isoNow(this.clock), actor: operatorId, type: 'manual_action', action: redact(action), observation: redact(observation) });
        return redact(observation);
      },
      resume: async () => {
        assert(request.status === 'human_in_control' && request.ownership === 'human', 'HANDOFF_NOT_RESUMABLE', 'Only the current human owner may resume automation.');
        request.status = 'resumed';
        request.ownership = 'automation';
        request.resumedAt = isoNow(this.clock);
        request.actions.push({ at: request.resumedAt, actor: operatorId, type: 'automation_resumed', surfaceSessionId: request.surfaceSessionId });
        return publicRequest(request);
      }
    };
  }

  export(requestId) {
    return this.get(requestId);
  }
}
