import {
  AutomationError,
  PolicyGuard,
  RunJournal,
  assert,
  assertCapabilityValid,
  assertCheckpoint,
  conditionSatisfied,
  redact,
  resolveTemplate,
  validateInputs
} from './core.js';

function errorShape(error, { stepId, observed } = {}) {
  return {
    code: error.code || 'UNEXPECTED_ERROR',
    message: error.message || String(error),
    stepId: stepId ?? null,
    expected: redact(error.details?.expected ?? error.details ?? {}),
    observed: redact(observed ?? {})
  };
}

export class ReplayRunner {
  constructor({ surface, journal = new RunJournal(), handoffBroker = null } = {}) {
    this.surface = surface;
    this.journal = journal;
    this.handoffBroker = handoffBroker;
  }

  async _state() {
    const observation = await this.surface.observe();
    return { observation, state: observation.state || this.surface.currentCondition?.() || 'ready' };
  }

  async _failure(capability, { error, stepId, observed, forceEscalate = false }) {
    const normalized = errorShape(error, { stepId, observed });
    const hardConfig = capability.outcomes.hardFailures.find((item) => item.code === normalized.code || item.surfaceState === normalized.code);
    const shouldEscalate = forceEscalate || Boolean(hardConfig?.escalate);
    const snapshot = await this.surface.captureEvidence().catch(() => null);
    let intervention = null;
    if (shouldEscalate && this.handoffBroker) {
      intervention = await this.handoffBroker.request({
        runId: this.journal.runId,
        capabilityId: capability.id,
        goal: capability.title,
        stepId: stepId ?? 'unknown',
        reason: normalized,
        surface: this.surface,
        snapshot
      });
    }
    this.journal.emit('replay.failed', {
      capabilityId: capability.id,
      error: normalized,
      escalation: intervention ? { requestId: intervention.id, surfaceSessionId: intervention.surfaceSessionId } : null,
      evidence: snapshot ? { kind: snapshot.kind, state: snapshot.state, currentUrl: snapshot.currentUrl } : null
    });
    return {
      kind: intervention ? 'escalated' : 'failure',
      capabilityId: capability.id,
      runId: this.journal.runId,
      error: normalized,
      intervention,
      journal: this.journal,
      snapshot
    };
  }

  async _handleKnownState(capability, stepId) {
    const { observation, state } = await this._state();
    if (state === 'ready') return null;
    const business = capability.outcomes.business.find((item) => item.surfaceState === state);
    if (business) {
      const result = {
        kind: 'business_outcome',
        capabilityId: capability.id,
        runId: this.journal.runId,
        code: business.code,
        callerStatus: business.callerStatus,
        message: business.message,
        outputs: { outcome: business.code }
      };
      this.journal.emit('replay.business_outcome', { stepId, result });
      return { ...result, journal: this.journal };
    }
    const recoverable = capability.outcomes.recoverable.find((item) => item.surfaceState === state);
    if (recoverable) {
      for (let attempt = 1; attempt <= recoverable.maxAttempts; attempt += 1) {
        this.journal.emit('replay.recovery_started', { stepId, condition: recoverable.code, attempt, maxAttempts: recoverable.maxAttempts });
        await this.surface.wait(recoverable.delayMs);
        const retried = await this._state();
        if (retried.state === 'ready') {
          this.journal.emit('replay.recovery_succeeded', { stepId, condition: recoverable.code, attempt });
          return null;
        }
        if (retried.state !== state) return this._handleKnownState(capability, stepId);
      }
      return this._failure(capability, {
        error: new AutomationError('RECOVERY_EXHAUSTED', `Recovery exhausted for ${recoverable.code}.`, { expected: recoverable }),
        stepId,
        observed: observation,
        forceEscalate: true
      });
    }
    const hard = capability.outcomes.hardFailures.find((item) => item.surfaceState === state);
    if (hard) {
      return this._failure(capability, {
        error: new AutomationError(hard.code, `Target reported ${hard.code}.`, { expected: hard }),
        stepId,
        observed: observation,
        forceEscalate: hard.escalate
      });
    }
    return this._failure(capability, {
      error: new AutomationError('UNKNOWN_SURFACE_STATE', `Target reported an unknown state: ${state}.`, { state }),
      stepId,
      observed: observation,
      forceEscalate: true
    });
  }

  async run({ capability, inputs }) {
    try {
      assertCapabilityValid(capability);
      assert(capability.approval.status === 'approved', 'CAPABILITY_NOT_APPROVED', 'Unattended replay requires an approved capability.');
      const typedInputs = validateInputs(capability.contract, inputs);
      const guard = new PolicyGuard(capability.policy, this.surface);
      const outputs = {};
      this.journal.emit('replay.started', {
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        surfaceSessionId: this.surface.sessionId,
        inputNames: Object.keys(typedInputs)
      });

      for (const step of capability.steps) {
        const knownBefore = await this._handleKnownState(capability, step.id);
        if (knownBefore) return knownBefore;
        this.journal.emit('replay.step_started', { stepId: step.id, action: step.type });
        if (step.type === 'navigate') {
          guard.assertAction({ type: 'navigate', path: step.path });
          await this.surface.navigate(step.path);
        } else if (step.type === 'type') {
          guard.assertAction({ type: 'type' }, { targetRisk: this.surface.getControlRisk(step.target.logicalName) });
          await this.surface.type(step.target, resolveTemplate(step.value, typedInputs));
        } else if (step.type === 'click') {
          guard.assertAction({ type: 'click' }, { targetRisk: this.surface.getControlRisk(step.target.logicalName) });
          await this.surface.click(step.target);
        } else if (step.type === 'wait') {
          guard.assertAction({ type: 'wait' });
          await this.surface.wait(step.delayMs);
        } else if (step.type === 'extract') {
          guard.assertAction({ type: 'extract' });
          const observation = await this.surface.observe();
          const match = new RegExp(step.extract.pattern).exec(observation.text);
          assert(match, 'EXTRACTION_FAILED', `Could not extract ${step.extract.output}.`, { expected: step.extract });
          outputs[step.extract.output] = match[step.extract.group ?? 1] ?? match[0];
        } else {
          throw new AutomationError('INVALID_ARTIFACT', `Unsupported replay step ${step.type}.`);
        }
        await assertCheckpoint(this.surface, step.checkpoint, step.id);
        const knownAfter = await this._handleKnownState(capability, step.id);
        if (knownAfter) return knownAfter;
        this.journal.emit('replay.step_completed', { stepId: step.id, action: step.type });
      }

      for (const condition of capability.success.all) {
        assert(await conditionSatisfied(this.surface, condition), 'SUCCESS_CONDITION_FAILED', `Final success condition failed: ${condition.type}`, { expected: condition });
      }
      outputs.outcome = 'success';
      const result = { kind: 'success', capabilityId: capability.id, runId: this.journal.runId, outputs };
      this.journal.emit('replay.succeeded', { result });
      return { ...result, journal: this.journal };
    } catch (error) {
      const observed = await this.surface.observe().catch(() => ({}));
      return this._failure(capability, { error, stepId: error.details?.stepId, observed, forceEscalate: ['TARGET_NOT_FOUND', 'AMBIGUOUS_TARGET', 'CHECKPOINT_FAILED'].includes(error.code) });
    }
  }
}
