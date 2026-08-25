/**
 * @terminus/task-runtime — Transactional Effect Ledger (SPEC §7, §16).
 *
 * Implements the 17-state Transactional Effect Ledger:
 * PROPOSED -> POLICY_CHECKED -> AUTHORIZATION_REQUIRED -> AUTHORIZED -> PREPARED -> DISPATCHED -> OBSERVED -> VALIDATED -> COMMITTED
 * With UNCERTAIN, RECONCILING, COMPENSATING, COMPENSATED, RESIDUE, MANUAL_RECONCILE, DENIED, CANCELLED.
 *
 * Invariants:
 * 1. Semantic idempotency keys derive from canonical task intent & parameters, preventing duplicate external effects.
 * 2. In-flight crashes or timeouts transition to UNCERTAIN and require reconciliation before retry ("verify before retry").
 * 3. Authorizations are consumed atomically during PREPARED transition.
 * 4. Speculative / losing branches cannot commit external effects.
 */
import type {
  EffectRecord,
  ResourceHandle,
  EffectState,
  Rfc3339Timestamp,
} from "@terminus/domain";
import {
  effectRecordSchema,
  isEffectTransitionAllowed,
  StateTransitionError,
  ValidationError,
  nowTimestamp,
} from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";
import { TransactionalOutbox, sha256Hex } from "./outbox.js";
import type { AuthorizationManager } from "./authorizations.js";

export interface ProposeEffectInput {
  readonly id?: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly principal: string;
  readonly connectorOrWorker: string;
  readonly intentType: string;
  readonly canonicalParameters: Readonly<Record<string, unknown>>;
  readonly resourceHandles?: readonly ResourceHandle[];
  readonly effectClass: string;
}

export class EffectLedger {
  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly outbox: TransactionalOutbox
  ) {}

  /**
   * Compute semantic idempotency key for an effect intent.
   */
  static computeSemanticIdempotencyKey(params: {
    taskId: string;
    intentType: string;
    effectClass: string;
    connectorOrWorker: string;
    canonicalParameters: Readonly<Record<string, unknown>>;
    resourceHandles?: readonly ResourceHandle[];
  }): string {
    const sortedKeys = Object.keys(params.canonicalParameters).sort();
    const sortedParams: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      sortedParams[k] = params.canonicalParameters[k];
    }

    const handles = (params.resourceHandles ?? []).map((h) => ({
      objectId: h.objectId,
      version: h.version,
      scope: h.scope,
    }));

    const canonical = JSON.stringify({
      taskId: params.taskId,
      intentType: params.intentType,
      effectClass: params.effectClass,
      connectorOrWorker: params.connectorOrWorker,
      canonicalParameters: sortedParams,
      resourceHandles: handles,
    });

    return `sem-idem:${sha256Hex(canonical)}`;
  }

  /**
   * Propose a new effect in the ledger.
   * If an effect with the same semantic idempotency key already exists, returns the existing record.
   */
  async proposeEffect(input: ProposeEffectInput): Promise<EffectRecord> {
    const semanticKey = EffectLedger.computeSemanticIdempotencyKey({
      taskId: input.taskId,
      intentType: input.intentType,
      effectClass: input.effectClass,
      connectorOrWorker: input.connectorOrWorker,
      canonicalParameters: input.canonicalParameters,
      ...(input.resourceHandles !== undefined ? { resourceHandles: input.resourceHandles } : {}),
    });

    // Check for existing semantic effect (idempotency guarantee)
    const existing = await this.repo.getEffectBySemanticKey(semanticKey);
    if (existing) {
      return existing;
    }

    const id = input.id ?? `eff-${sha256Hex(semanticKey + Date.now()).slice(0, 16)}`;
    const now = nowTimestamp();

    const effect: EffectRecord = {
      id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      principal: input.principal,
      connectorOrWorker: input.connectorOrWorker,
      intentType: input.intentType,
      canonicalParameters: input.canonicalParameters,
      resourceHandles: input.resourceHandles ?? [],
      effectClass: input.effectClass,
      semanticIdempotencyKey: semanticKey,
      authorizationId: null,
      policyDecisionId: null,
      state: "PROPOSED",
      uncertaintyReason: null,
      compensationRef: null,
      version: 1,
      createdAt: now,
      settledAt: null,
    };

    effectRecordSchema.parse(effect);

    const outboxMessage = this.outbox.createMessage(
      "effect",
      effect.id,
      1,
      "effect.proposed",
      {
        effectId: effect.id,
        taskId: effect.taskId,
        attemptId: effect.attemptId,
        principal: effect.principal,
        connectorOrWorker: effect.connectorOrWorker,
        intentType: effect.intentType,
        canonicalParameters: effect.canonicalParameters,
        resourceHandles: effect.resourceHandles,
        effectClass: effect.effectClass,
        semanticIdempotencyKey: effect.semanticIdempotencyKey,
      },
      effect.semanticIdempotencyKey
    );

    return this.repo.createEffectRecord(effect, outboxMessage);
  }

  /**
   * Record policy evaluation result for a proposed effect.
   */
  async checkPolicy(
    effectId: string,
    policy: {
      readonly decision: "ALLOW" | "PROMPT" | "DENY";
      readonly decisionId: string;
      readonly reason?: string;
    }
  ): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    let current = effect;

    // 1. If currently in PROPOSED, transition through POLICY_CHECKED or DENIED
    if (current.state === "PROPOSED") {
      if (policy.decision === "DENY") {
        this.assertValidTransition("PROPOSED", "DENIED", effectId);
        const denied: EffectRecord = {
          ...current,
          state: "DENIED",
          policyDecisionId: policy.decisionId,
          version: current.version + 1,
          settledAt: nowTimestamp(),
        };
        return this.repo.updateEffectRecord(
          denied,
          this.outbox.createMessage("effect", denied.id, denied.version, "effect.denied", {
            effectId,
            fromState: "PROPOSED",
            toState: "DENIED",
            policyDecisionId: policy.decisionId,
            reason: policy.reason,
          })
        );
      }

      this.assertValidTransition("PROPOSED", "POLICY_CHECKED", effectId);
      current = await this.repo.updateEffectRecord(
        {
          ...current,
          state: "POLICY_CHECKED",
          policyDecisionId: policy.decisionId,
          version: current.version + 1,
        },
        this.outbox.createMessage("effect", current.id, current.version + 1, "effect.policy_checked", {
          effectId,
          fromState: "PROPOSED",
          toState: "POLICY_CHECKED",
          policyDecisionId: policy.decisionId,
        })
      );

      if (policy.decision === "ALLOW") {
        return current;
      }
    }

    // 2. From POLICY_CHECKED, transition to AUTHORIZATION_REQUIRED or DENIED
    let targetState: EffectState;
    if (policy.decision === "DENY") {
      targetState = "DENIED";
    } else if (policy.decision === "PROMPT") {
      targetState = "AUTHORIZATION_REQUIRED";
    } else {
      targetState = "POLICY_CHECKED";
    }

    if (current.state === targetState) {
      return current;
    }

    this.assertValidTransition(current.state, targetState, effectId);

    const updated: EffectRecord = {
      ...current,
      state: targetState,
      policyDecisionId: policy.decisionId,
      version: current.version + 1,
      settledAt: targetState === "DENIED" ? nowTimestamp() : null,
    };

    const eventType = targetState === "DENIED"
      ? "effect.denied"
      : targetState === "AUTHORIZATION_REQUIRED"
      ? "effect.authorization_required"
      : "effect.policy_checked";

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      eventType,
      {
        effectId: updated.id,
        fromState: current.state,
        toState: targetState,
        policyDecisionId: policy.decisionId,
        reason: policy.reason,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Bind an authorization instance to an effect, transitioning to AUTHORIZED.
   */
  async authorizeEffect(effectId: string, authorizationId: string): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    const targetState: EffectState = "AUTHORIZED";

    this.assertValidTransition(effect.state, targetState, effectId);

    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      authorizationId,
      version: effect.version + 1,
    };

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      "effect.authorized",
      {
        effectId: updated.id,
        fromState: effect.state,
        toState: targetState,
        authorizationId,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Prepare the effect for execution, atomically consuming its bound authorization if present.
   */
  async prepareEffect(
    effectId: string,
    options?: {
      readonly authzManager?: AuthorizationManager;
      readonly taskVersion?: number;
      readonly approvalHash?: string;
    }
  ): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    const targetState: EffectState = "PREPARED";

    this.assertValidTransition(effect.state, targetState, effectId);

    // Atomically consume authorization instance if bound
    if (effect.authorizationId && options?.authzManager) {
      await options.authzManager.consumeAuthorization(effect.authorizationId, {
        taskId: effect.taskId,
        taskVersion: options.taskVersion ?? 1,
        effectClass: effect.effectClass,
        approvalHash: options.approvalHash ?? null,
        principal: effect.principal,
      });
    }

    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      version: effect.version + 1,
    };

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      "effect.prepared",
      {
        effectId: updated.id,
        fromState: effect.state,
        toState: targetState,
        authorizationId: effect.authorizationId,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Dispatch the effect to the worker / external connector.
   */
  async dispatchEffect(effectId: string): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    const targetState: EffectState = "DISPATCHED";

    this.assertValidTransition(effect.state, targetState, effectId);

    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      version: effect.version + 1,
    };

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      "effect.dispatched",
      {
        effectId: updated.id,
        fromState: effect.state,
        toState: targetState,
        connectorOrWorker: effect.connectorOrWorker,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Record observation from execution.
   */
  async observeEffect(
    effectId: string,
    observation: {
      readonly outcome: "SUCCESS" | "FAILURE" | "TIMEOUT" | "UNCERTAIN";
      readonly uncertaintyReason?: string;
    }
  ): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);

    if (observation.outcome === "TIMEOUT" || observation.outcome === "UNCERTAIN") {
      return this.markUncertain(effectId, observation.uncertaintyReason ?? "Observation timeout or ambiguous network receipt");
    }

    let current = effect;
    if (current.state === "DISPATCHED") {
      this.assertValidTransition("DISPATCHED", "OBSERVED", effectId);
      current = await this.repo.updateEffectRecord(
        {
          ...current,
          state: "OBSERVED",
          version: current.version + 1,
        },
        this.outbox.createMessage(
          "effect",
          current.id,
          current.version + 1,
          "effect.observed",
          { effectId, fromState: "DISPATCHED", toState: "OBSERVED" }
        )
      );

      if (observation.outcome === "SUCCESS") {
        return current;
      }
    }

    const targetState: EffectState = observation.outcome === "SUCCESS" ? "OBSERVED" : "COMPENSATING";
    this.assertValidTransition(current.state, targetState, effectId);

    const updated: EffectRecord = {
      ...current,
      state: targetState,
      version: current.version + 1,
    };

    const eventType = targetState === "OBSERVED" ? "effect.observed" : "effect.compensating";
    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      eventType,
      {
        effectId: updated.id,
        fromState: current.state,
        toState: targetState,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Validate observed effect against postconditions.
   */
  async validateEffect(effectId: string, validationPassed: boolean): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    const targetState: EffectState = validationPassed ? "VALIDATED" : "COMPENSATING";

    this.assertValidTransition(effect.state, targetState, effectId);

    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      version: effect.version + 1,
    };

    const eventType = targetState === "VALIDATED" ? "effect.validated" : "effect.compensating";
    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      eventType,
      {
        effectId: updated.id,
        fromState: effect.state,
        toState: targetState,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Commit the validated effect to authoritative state.
   */
  async commitEffect(effectId: string): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    const targetState: EffectState = "COMMITTED";

    this.assertValidTransition(effect.state, targetState, effectId);

    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      version: effect.version + 1,
      settledAt: nowTimestamp(),
    };

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      "effect.committed",
      {
        effectId: updated.id,
        fromState: effect.state,
        toState: targetState,
        settledAt: updated.settledAt,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Mark an in-flight or observed effect as UNCERTAIN.
   */
  async markUncertain(effectId: string, reason: string): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    const targetState: EffectState = "UNCERTAIN";

    this.assertValidTransition(effect.state, targetState, effectId);

    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      uncertaintyReason: reason,
      version: effect.version + 1,
    };

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      "effect.uncertain",
      {
        effectId: updated.id,
        fromState: effect.state,
        toState: targetState,
        uncertaintyReason: reason,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Reconcile an uncertain effect via read-probe / connector query before retry.
   */
  async reconcileEffect(
    effectId: string,
    reconciliation: {
      readonly status: "EXECUTED" | "NOT_EXECUTED" | "AMBIGUOUS";
      readonly details?: string;
    }
  ): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);

    // 1. Transition to RECONCILING first
    let current = effect;
    if (current.state === "UNCERTAIN") {
      this.assertValidTransition(current.state, "RECONCILING", effectId);
      current = await this.repo.updateEffectRecord(
        {
          ...current,
          state: "RECONCILING",
          version: current.version + 1,
        },
        this.outbox.createMessage(
          "effect",
          effectId,
          current.version + 1,
          "effect.reconciling",
          { effectId, fromState: "UNCERTAIN", toState: "RECONCILING" }
        )
      );
    }

    // 2. Resolve based on probe status
    let nextState: EffectState;
    if (reconciliation.status === "EXECUTED") {
      nextState = "COMMITTED";
    } else if (reconciliation.status === "NOT_EXECUTED") {
      // Transition to COMPENSATING then COMPENSATED
      this.assertValidTransition(current.state, "COMPENSATING", effectId);
      current = await this.repo.updateEffectRecord(
        {
          ...current,
          state: "COMPENSATING",
          version: current.version + 1,
        },
        this.outbox.createMessage(
          "effect",
          effectId,
          current.version + 1,
          "effect.compensating",
          { effectId, fromState: "RECONCILING", toState: "COMPENSATING" }
        )
      );
      nextState = "COMPENSATED";
    } else {
      nextState = "MANUAL_RECONCILE";
    }

    this.assertValidTransition(current.state, nextState, effectId);

    const updated: EffectRecord = {
      ...current,
      state: nextState,
      uncertaintyReason: reconciliation.details ?? null,
      version: current.version + 1,
      settledAt: nextState === "COMMITTED" || nextState === "COMPENSATED" ? nowTimestamp() : null,
    };

    const eventType = nextState === "COMMITTED"
      ? "effect.committed"
      : nextState === "COMPENSATED"
      ? "effect.compensated"
      : "effect.manual_reconcile";

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      eventType,
      {
        effectId: updated.id,
        fromState: current.state,
        toState: nextState,
        details: reconciliation.details,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Compensate an effect that failed validation or was aborted.
   */
  async compensateEffect(
    effectId: string,
    compensation: {
      readonly compensationRef: string;
      readonly outcome: "COMPENSATED" | "RESIDUE" | "MANUAL_RECONCILE";
      readonly reason?: string;
    }
  ): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);

    let current = effect;
    if (current.state !== "COMPENSATING") {
      this.assertValidTransition(current.state, "COMPENSATING", effectId);
      current = await this.repo.updateEffectRecord(
        {
          ...current,
          state: "COMPENSATING",
          compensationRef: compensation.compensationRef,
          version: current.version + 1,
        },
        this.outbox.createMessage(
          "effect",
          effectId,
          current.version + 1,
          "effect.compensating",
          { effectId, fromState: effect.state, toState: "COMPENSATING", compensationRef: compensation.compensationRef }
        )
      );
    }

    const targetState: EffectState = compensation.outcome;
    this.assertValidTransition(current.state, targetState, effectId);

    const updated: EffectRecord = {
      ...current,
      state: targetState,
      compensationRef: compensation.compensationRef,
      version: current.version + 1,
      settledAt: targetState === "COMPENSATED" ? nowTimestamp() : null,
    };

    const eventType = targetState === "COMPENSATED"
      ? "effect.compensated"
      : targetState === "RESIDUE"
      ? "effect.residue"
      : "effect.manual_reconcile";

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      eventType,
      {
        effectId: updated.id,
        fromState: current.state,
        toState: targetState,
        compensationRef: compensation.compensationRef,
        reason: compensation.reason,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  /**
   * Cancel an in-flight or proposed effect.
   */
  async cancelEffect(effectId: string, reason?: string): Promise<EffectRecord> {
    const effect = await this.requireEffect(effectId);
    const targetState: EffectState = "CANCELLED";

    this.assertValidTransition(effect.state, targetState, effectId);

    const updated: EffectRecord = {
      ...effect,
      state: targetState,
      version: effect.version + 1,
      settledAt: nowTimestamp(),
    };

    const outboxMessage = this.outbox.createMessage(
      "effect",
      updated.id,
      updated.version,
      "effect.cancelled",
      {
        effectId: updated.id,
        fromState: effect.state,
        toState: targetState,
        reason,
      }
    );

    return this.repo.updateEffectRecord(updated, outboxMessage);
  }

  private async requireEffect(id: string): Promise<EffectRecord> {
    const eff = await this.repo.getEffectRecord(id);
    if (!eff) {
      throw new ValidationError(`EffectRecord not found: ${id}`);
    }
    return eff;
  }

  private assertValidTransition(from: EffectState, to: EffectState, effectId: string): void {
    if (!isEffectTransitionAllowed(from, to)) {
      throw new StateTransitionError("effect", from, to);
    }
  }
}
