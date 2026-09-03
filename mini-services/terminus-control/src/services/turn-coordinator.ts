import type { MutationRunner, ServiceEventAppender } from "./service-types.js";
import type { LoopErrorEnvelope } from "../agent/loop-contracts.js";
import type { EvidenceTerminalOutcome } from "../agent/minimal-profile.js";
import { turnFailureDisposition, type TerminalTurnState } from "../agent/turn-failure-policy.js";
import type { ProviderToolSchema } from "@terminus/provider-core";
import type { Uuid7 } from "@terminus/domain";
import type { EngineToolSettlement } from "../agent/coding-turn-engine.js";

export type TurnAdmissionReason =
  | "task_not_found"
  | "thread_mismatch"
  | "state_conflict"
  | "turn_active"
  | "state_changed"
  | "sequence_changed";

export class TurnAdmissionError extends Error {
  constructor(
    readonly reason: TurnAdmissionReason,
    readonly detail: string | null = null,
  ) {
    super(reason);
    this.name = "TurnAdmissionError";
  }
}

export interface TurnTaskSnapshot {
  readonly id: string;
  readonly threadId: string;
  readonly status: string;
}

export interface TurnRow {
  readonly id: string;
  readonly threadId: string;
  readonly taskId: string | null;
  readonly sequence: number;
  readonly state: string;
  readonly initiatingActor: string;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  /** Routing recorded at admission, so a client can see where a turn ran. */
  readonly selectedModel: string | null;
  readonly selectedReasoningEffort: string | null;
  readonly selectedProviderAccountId: string | null;
}

export interface TurnAdmissionInput {
  readonly turnId: string;
  readonly threadId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly inputArtifactUri: string;
  readonly inputArtifactHash: string;
  readonly initiatingActor: string;
  /**
   * Per-turn model selection (H7). Recorded in the same transaction as the
   * turn row so the selection can never be lost between admission and the
   * first provider call. Null means "use the configured provider".
   */
  readonly selectedModel?: string | null | undefined;
  readonly selectedReasoningEffort?: string | null | undefined;
  /**
   * The connected provider account this turn runs on, resolved at admission.
   * Recorded on the turn row so the account cannot change under a turn that is
   * already running. Null means the legacy direct/gateway/local chain.
   */
  readonly selectedProviderAccountId?: string | null | undefined;
  /**
   * The caller's per-turn budget, already validated and serialised. Written in
   * the admission transaction so the loop cannot start against a budget that
   * was never durably recorded.
   */
  readonly requestedBudgetJson?: string | null | undefined;
}

export interface TurnCoordinatorTransaction {
  readonly findTask: (taskId: string) => Promise<TurnTaskSnapshot | null>;
  readonly findActiveTurn: (taskId: string, activeStates: readonly string[]) => Promise<{ readonly id: string } | null>;
  readonly findLatestSequence: (threadId: string) => Promise<number | null>;
  /** Restore a steerable task and clear every terminal projection atomically. */
  readonly resumeTask: (taskId: string, expectedStatus: string) => Promise<void>;
  readonly createTurn: (input: TurnAdmissionInput) => Promise<void>;
  readonly createUserEpisode: (input: TurnAdmissionInput) => Promise<void>;
  readonly interruptTurn: (turnId: string, reason: string) => Promise<void>;
  /** Mark a turn cancelled after durable cancellation intent is recorded. */
  readonly abortTurn?: (turnId: string, reason: string) => Promise<void>;
}

export interface TurnCoordinatorDependencies<TTransaction> {
  readonly readTask: (taskId: string) => Promise<TurnTaskSnapshot | null>;
  readonly readTurn: (turnId: string) => Promise<TurnRow | null>;
  readonly appendEvent: ServiceEventAppender<TTransaction>;
  readonly transaction: (transaction: TTransaction) => TurnCoordinatorTransaction;
  readonly mutate: MutationRunner;
  readonly projectTask: (taskId: string, eventType: string) => Promise<void>;
  readonly activeTurnStates: readonly string[];
}

export interface AdmittedTurn {
  readonly turn: TurnRow;
}

/**
 * Owns turn admission and interruption without owning the HTTP route.
 *
 * Transaction boundary: admission uses one event-plus-row transaction. The
 * preflight read is only an early error response; the transaction repeats all
 * lineage, state, active-turn, and sequence checks before creating the turn.
 */
export class TurnCoordinator<TTransaction> {
  constructor(
    private readonly dependencies: TurnCoordinatorDependencies<TTransaction>,
  ) {}

  async admit(input: TurnAdmissionInput): Promise<AdmittedTurn> {
    return this.dependencies.mutate(() => this.admitUnderMutationLock(input));
  }

  /**
   * Admit a turn when the composition root already holds its mutation lock.
   * This keeps route-level idempotency serialization and the coordinator's
   * transaction boundary separate without attempting to reacquire a
   * non-reentrant mutex.
   */
  async admitUnderMutationLock(input: TurnAdmissionInput): Promise<AdmittedTurn> {
    const task = await this.dependencies.readTask(input.taskId);
    if (task === null) throw new TurnAdmissionError("task_not_found");
    if (task.threadId !== input.threadId) {
      throw new TurnAdmissionError("thread_mismatch", task.threadId);
    }
    if (!["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED"].includes(task.status)) {
      throw new TurnAdmissionError("state_conflict", task.status);
    }

    await this.dependencies.appendEvent(
      {
        eventType: "turn.started",
        aggregateType: "turn",
        aggregateId: input.turnId,
        correlationId: input.taskId,
        payload: {
          thread_id: input.threadId,
          task_id: input.taskId,
          sequence: input.sequence,
          input_artifact: input.inputArtifactUri,
          input_hash: input.inputArtifactHash,
          ...(input.selectedModel === undefined || input.selectedModel === null
            ? {}
            : { model: input.selectedModel }),
          ...(input.selectedReasoningEffort === undefined || input.selectedReasoningEffort === null
            ? {}
            : { reasoning_effort: input.selectedReasoningEffort }),
          ...(input.selectedProviderAccountId === undefined || input.selectedProviderAccountId === null
            ? {}
            : { provider_account_id: input.selectedProviderAccountId }),
        },
        artifactRefs: [input.inputArtifactUri],
      },
      async (transaction) => {
        const store = this.dependencies.transaction(transaction);
        const current = await store.findTask(input.taskId);
        if (current === null) throw new TurnAdmissionError("task_not_found");
        if (current.threadId !== input.threadId) {
          throw new TurnAdmissionError("thread_mismatch", current.threadId);
        }
        if (!["ACTIVE", "NEEDS_USER_DECISION", "BLOCKED"].includes(current.status)) {
          throw new TurnAdmissionError("state_conflict", current.status);
        }
        // A pending repair blocks ordinary user admission. The repair
        // controller is the sole actor allowed to add the continuation turn
        // while its parent remains in REPAIR_PENDING.
        const activeStates = input.initiatingActor === "repair-controller"
          ? this.dependencies.activeTurnStates
          : [...this.dependencies.activeTurnStates, "REPAIR_PENDING"];
        const activeTurn = await store.findActiveTurn(input.taskId, activeStates);
        if (activeTurn !== null) throw new TurnAdmissionError("turn_active", activeTurn.id);
        const previousSequence = await store.findLatestSequence(input.threadId);
        if ((previousSequence ?? 0) + 1 !== input.sequence) {
          throw new TurnAdmissionError("sequence_changed");
        }
        if (current.status !== "ACTIVE") {
          await store.resumeTask(input.taskId, current.status);
        }
        await store.createTurn(input);
        await store.createUserEpisode(input);
      },
    );

    const turn = await this.dependencies.readTurn(input.turnId);
    if (turn === null) throw new Error(`admitted turn ${input.turnId} could not be reloaded`);
    await this.dependencies.projectTask(input.taskId, "task.running");
    return { turn };
  }

  async interrupt(turnId: string, reason: string): Promise<TurnRow> {
    return this.dependencies.mutate(() => this.interruptUnderMutationLock(turnId, reason));
  }

  /** Caller already holds the composition root's mutation lock. */
  async interruptUnderMutationLock(turnId: string, reason: string): Promise<TurnRow> {
    const current = await this.dependencies.readTurn(turnId);
    if (current === null) throw new TurnAdmissionError("task_not_found", turnId);
    if (!this.dependencies.activeTurnStates.includes(current.state)) {
      throw new TurnAdmissionError("state_conflict", current.state);
    }

    await this.dependencies.appendEvent(
      {
        eventType: "turn.interrupted",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: current.taskId ?? turnId,
        payload: { reason },
      },
      async (transaction) => {
        await this.dependencies.transaction(transaction).interruptTurn(turnId, reason);
      },
    );
    const interrupted = await this.dependencies.readTurn(turnId);
    if (interrupted === null) throw new Error(`interrupted turn ${turnId} could not be reloaded`);
    return interrupted;
  }

  /**
   * Persist cancellation at the turn boundary before asking the in-process
   * executor to stop. REPAIR_PENDING is included because it is nonterminal
   * but intentionally excluded from the normal admission active-state set.
   */
  async abortUnderMutationLock(turnId: string, reason: string): Promise<TurnRow> {
    const current = await this.dependencies.readTurn(turnId);
    if (current === null) throw new TurnAdmissionError("task_not_found", turnId);
    if (
      !this.dependencies.activeTurnStates.includes(current.state)
      && current.state !== "REPAIR_PENDING"
    ) {
      throw new TurnAdmissionError("state_conflict", current.state);
    }

    await this.dependencies.appendEvent(
      {
        eventType: "turn.aborted",
        aggregateType: "turn",
        aggregateId: turnId,
        correlationId: current.taskId ?? turnId,
        payload: {
          reason,
          previous_state: current.state,
          phase: current.state,
        },
      },
      async (transaction) => {
        const store = this.dependencies.transaction(transaction);
        if (store.abortTurn !== undefined) {
          await store.abortTurn(turnId, reason);
        } else {
          // Compatibility for older test/adaptor stores. Production wiring
          // supplies abortTurn and therefore records the ABORTED state.
          await store.interruptTurn(turnId, reason);
        }
      },
    );
    const aborted = await this.dependencies.readTurn(turnId);
    if (aborted === null) throw new Error(`aborted turn ${turnId} could not be reloaded`);
    return aborted;
  }
}

// ─────────────── Lifecycle transitions, terminal settlement ─────────────────
//
// The loop body (`agentLoop` in the composition root) used to own the turn
// state machine by hand: each transition was an inline `updateMany` CAS with
// its own error text, terminal classification was two parallel ternary
// chains, and the failure path re-derived the same tables a second time.
// The decisions live here now, as pure planners. The composition root keeps
// one generic executor per side (turn rows, task rows, provider attempts)
// so persistence stays in exactly one place and the coordinator never
// touches the database.

/** Non-terminal turn states a lifecycle transition may be entered from. */
export const LIFECYCLE_ACTIVE_TURN_STATES = [
  "PENDING",
  "CONTEXT_COMPILING",
  "PROVIDER_RUNNING",
  "RESPONSE_VALIDATING",
  "TOOL_SETTLEMENT",
  "VERIFYING",
  "REPAIRING",
  "FINALIZING",
] as const;

/** Turn states that are non-terminal but not ordinary active phases. */
export const LIFECYCLE_SETTLEMENT_STATES = ["REPAIR_PENDING", "VERIFIED"] as const;

/** A lifecycle transition: one event plus one guarded row write. */
export interface TurnTransitionPlan {
  readonly eventType: string;
  readonly aggregateType: "turn";
  readonly aggregateId: string;
  readonly correlationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Turn states the CAS accepts; empty means "state must not have changed". */
  readonly expectedStates: readonly string[];
  readonly nextState: string;
  readonly setStartedAt: boolean;
  readonly setCompletedAt: boolean;
  readonly terminalErrorJson: string | null;
  /** Exact CAS-failure error text; the loop and recovery both match on it. */
  readonly conflictError: string;
}

/** Plan the PENDING/REPAIRING → CONTEXT_COMPILING entry. */
export const planEnterContextCompiling = (input: {
  readonly turnId: string;
  readonly taskId: string | null;
  readonly resumedFrom: "PENDING" | "REPAIRING";
}): TurnTransitionPlan => ({
  eventType: "turn.context_compiling",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: { phase: "context_compiling", resumed_from: input.resumedFrom },
  expectedStates: [input.resumedFrom],
  nextState: "CONTEXT_COMPILING",
  setStartedAt: input.resumedFrom === "PENDING",
  setCompletedAt: false,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before context compilation`,
});

/** Plan the RESPONSE_VALIDATING → TOOL_SETTLEMENT entry (first call only). */
export const planEnterToolSettlement = (input: {
  readonly turnId: string;
  readonly taskId: string;
  readonly providerAttemptId: string;
  readonly toolCallCount: number;
}): TurnTransitionPlan => ({
  eventType: "turn.tool_settlement",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: { provider_attempt_id: input.providerAttemptId, tool_calls: input.toolCallCount },
  expectedStates: ["RESPONSE_VALIDATING"],
  nextState: "TOOL_SETTLEMENT",
  setStartedAt: false,
  setCompletedAt: false,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before tool settlement`,
});

/**
 * Plan the TOOL_SETTLEMENT → CONTEXT_COMPILING re-entry after every tool
 * call of one provider response has settled. The engine re-arms this
 * boundary each loop iteration, so recovery after a restart is idempotent.
 */
export const planReenterContextCompiling = (input: {
  readonly turnId: string;
  readonly taskId: string;
}): TurnTransitionPlan => ({
  eventType: "turn.context_compiling",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: { phase: "context_compiling", reason: "tool_calls_settled" },
  expectedStates: ["TOOL_SETTLEMENT"],
  nextState: "CONTEXT_COMPILING",
  setStartedAt: false,
  setCompletedAt: false,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before context recompilation`,
});

/** Plan the RESPONSE_VALIDATING → VERIFYING entry. */
export const planEnterVerifying = (input: {
  readonly turnId: string;
  readonly taskId: string;
  readonly proposalArtifact: string;
}): TurnTransitionPlan => ({
  eventType: "turn.verifying",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: { phase: "VERIFY", proposal_artifact: input.proposalArtifact },
  expectedStates: ["RESPONSE_VALIDATING"],
  nextState: "VERIFYING",
  setStartedAt: false,
  setCompletedAt: false,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before verification`,
});

/** Plan the RESPONSE_VALIDATING|VERIFIED → FINALIZING entry. */
export const planEnterFinalizing = (input: {
  readonly turnId: string;
  readonly taskId: string | null;
  readonly after: "verification_admitted" | "verification_not_applicable" | "verification_unavailable" | "taskless_turn";
  readonly expectedState: "RESPONSE_VALIDATING" | "VERIFIED";
}): TurnTransitionPlan => ({
  eventType: "turn.finalizing",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: { phase: "finalizing", after: input.after },
  expectedStates: [input.expectedState],
  nextState: "FINALIZING",
  setStartedAt: false,
  setCompletedAt: false,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before finalizing`,
});

/** Verification outcome the turn completion record must reflect. */
export type TurnCompletionVerification =
  | { readonly kind: "no_checkpoint" }
  | { readonly kind: "checkpoint"; readonly publication: {
      readonly id: string;
      readonly threadId: string;
      readonly taskId: string;
      readonly artifactHash: string;
    } };

/** Payload of the turn.completed event. */
export interface TurnCompletedPayload {
  readonly state: "COMPLETED";
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly continuation: string | null;
  readonly reasoning: string | null;
  // skipcq: JS-T1001
  readonly recovered?: true | undefined;
}

/** Event emitted with a successful completion settlement. */
export const turnCompletedEvent = (input: {
  readonly turnId: string;
  readonly taskId: string | null;
  readonly payload: TurnCompletedPayload;
  readonly responseArtifactUri: string;
}): { readonly eventType: "turn.completed"; readonly aggregateType: "turn"; readonly aggregateId: string; readonly correlationId: string | null; readonly payload: TurnCompletedPayload; readonly artifactRefs: readonly string[] } => ({
  eventType: "turn.completed",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: input.payload,
  artifactRefs: [input.responseArtifactUri],
});

/** Plan the FINALIZING → COMPLETED settlement. */
export const planComplete = (input: {
  readonly turnId: string;
}): TurnTransitionPlan => ({
  eventType: "turn.completed",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: null,
  payload: {},
  expectedStates: ["FINALIZING"],
  nextState: "COMPLETED",
  setStartedAt: false,
  setCompletedAt: true,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before completion settlement`,
});

/** Plan the VERIFYING → FAILED verification settlement. */
export const planFailVerification = (input: {
  readonly turnId: string;
  readonly taskId: string | null;
  readonly reason: Readonly<Record<string, unknown>>;
}): TurnTransitionPlan => ({
  eventType: "turn.failed",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: { reason: "verification_failed", ...input.reason },
  expectedStates: ["VERIFYING"],
  nextState: "FAILED",
  setStartedAt: false,
  setCompletedAt: true,
  terminalErrorJson: JSON.stringify({ reason: "verification_failed", ...input.reason }),
  conflictError: `turn ${input.turnId} changed during verification failure settlement`,
});

/** Plan the VERIFYING → REPAIR_PENDING handoff to the repair controller. */
export const planEnterRepairPending = (input: {
  readonly turnId: string;
  readonly taskId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): TurnTransitionPlan => ({
  eventType: "turn.repair_pending",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: input.payload,
  expectedStates: ["VERIFYING"],
  nextState: "REPAIR_PENDING",
  setStartedAt: false,
  setCompletedAt: false,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before repair scheduling`,
});

/** Result of classifying a loop stop or thrown condition into a terminal. */
export interface TerminalTurnClassification {
  /** The durable turn state to settle into. */
  readonly state: TerminalTurnState;
  /** The semantic event that publishes the settlement. */
  readonly eventType: string;
  /** Short machine reason recorded in `terminalErrorJson`. */
  readonly reason: string;
  /** Failure envelope code; provider faults get the transport code. */
  readonly code: string;
  /** True only for an ambiguous tool settlement (INTERRUPTED family). */
  readonly ambiguousToolSettlement: boolean;
  /** Evidence-bundle terminal outcome, or null when the task stays ACTIVE. */
  readonly evidenceOutcome: EvidenceTerminalOutcome | null;
}

/** Context needed to classify why a loop stopped. */
export interface TerminalClassificationInput {
  readonly stopKind: string | null;
  readonly stopEnvelope: LoopErrorEnvelope | null;
  readonly providerUnavailable: boolean;
  readonly policyDenied: boolean;
  readonly budgetExhausted: boolean;
  readonly ambiguousToolSettlement: boolean;
}

/**
 * Map any loop terminal condition into its durable state, semantic event,
 * error code, machine reason, and task-level disposition.
 *
 * Precedence mirrors the original inline chains exactly — engine stops
 * first, then typed errors (provider transport, policy, budget, ambiguous
 * settlement), then the generic loop failure. `turnFailureDisposition`
 * supplies the task-level consequence so the two vocabularies cannot drift.
 */
// skipcq: JS-R1005
export const classifyTerminalTurn = (input: TerminalClassificationInput): TerminalTurnClassification => {
  const { stopKind } = input;
  const stopEnvelope = input.stopEnvelope;
  const ambiguous = input.ambiguousToolSettlement;
  const state: TerminalTurnState = stopKind === "interrupted"
    ? "ABORTED"
    : stopKind === "budget_stop" || stopKind === "budget_exhausted" || input.budgetExhausted
      ? "BUDGET_EXHAUSTED"
      : stopKind === "policy_stop" || stopKind === "policy_denied" || input.policyDenied
        ? "POLICY_DENIED"
        : stopKind === "blocked"
          ? "BLOCKED"
          : stopKind === "needs_user_input"
            ? "USER_ACTION_REQUIRED"
            : ambiguous
              ? "INTERRUPTED"
              : "FAILED";
  const eventType = state === "ABORTED"
    ? "turn.aborted"
    : state === "BUDGET_EXHAUSTED"
      ? "turn.budget_exhausted"
      : state === "POLICY_DENIED"
        ? "turn.policy_denied"
        : state === "BLOCKED"
          ? "turn.blocked"
          : state === "USER_ACTION_REQUIRED"
            ? "turn.needs_user_input"
            : ambiguous
              ? "turn.interrupted"
              : "turn.failed";
  const code = stopEnvelope?.code
    ?? (stopKind === "budget_stop" ? "BUDGET_EXHAUSTED"
      : stopKind === "policy_stop" ? "POLICY_DENIED"
        : stopKind === "blocked" ? "PROVIDER_BLOCKED"
          : stopKind === "needs_user_input" ? "USER_INPUT_REQUIRED"
            : stopKind === "interrupted" ? "CANCELLED"
              : input.providerUnavailable
                ? "PROVIDER_TRANSPORT_UNAVAILABLE"
                : input.policyDenied
                  ? "TOOL_POLICY_DENIED"
                  : input.budgetExhausted
                    ? "TOOL_BUDGET_EXHAUSTED"
                    : ambiguous
                      ? "TOOL_SETTLEMENT_UNKNOWN"
                      : "PROVIDER_EXECUTION_FAILED");
  const reason = stopKind === "budget_stop" || stopKind === "budget_exhausted" || input.budgetExhausted
    ? "budget_exhausted"
    : stopKind === "policy_stop" || stopKind === "policy_denied" || input.policyDenied
      ? "policy_denied"
      : stopKind === "blocked" || input.providerUnavailable
        ? "provider_blocked"
        : stopKind === "needs_user_input"
          ? "needs_user_input"
          : stopKind === "interrupted"
            ? "aborted"
            : ambiguous
              ? "tool_settlement_unknown"
              : stopKind === "failed_verification"
                ? "failed_verification"
                : "agent_loop_error";
  const disposition = turnFailureDisposition(state);
  const evidenceOutcome: EvidenceTerminalOutcome | null = disposition.taskStatus === "ABORTED"
    ? "ABORTED"
    : disposition.taskStatus === "BUDGET_EXHAUSTED"
      ? "BUDGET_EXHAUSTED"
      : disposition.taskStatus === "POLICY_DENIED"
        ? "POLICY_DENIED"
        : disposition.taskStatus === "NEEDS_USER_DECISION"
          ? "NEEDS_USER_DECISION"
          : disposition.taskStatus === "BLOCKED"
            ? "BLOCKED"
            : disposition.taskStatus === "FAILED_VERIFICATION"
              ? "FAILED_VERIFICATION"
              : null;
  return { state, eventType, reason, code, ambiguousToolSettlement: ambiguous, evidenceOutcome };
};

/**
 * The failure envelope published on the terminal event. Note the original
 * shape: `message` rides at the top level while `details` stays nested.
 */
export const terminalTurnFailurePayload = (
  classification: TerminalTurnClassification,
  envelope: LoopErrorEnvelope | null,
): Readonly<Record<string, unknown>> => ({
  code: classification.code,
  category: envelope?.category ?? null,
  message: envelope?.message ?? null,
  reason: classification.reason,
  retryable: envelope?.retryable ?? false,
  details: envelope?.details ?? null,
});

/**
 * Task-row data for a terminal stop: hard stops write the terminal status;
 * steerable failures return the task to ACTIVE/IMPLEMENT with no completedAt
 * or terminal reason, or the task becomes unsteerable.
 */
export const taskRowDataForTerminalStop = (input: {
  readonly taskStaysActive: boolean;
  readonly taskTerminalStatus: string | null;
  readonly failedTaskStatus: string;
  readonly blockedError: boolean;
  readonly failure: {
    readonly reason: string;
    readonly code: string;
    readonly message: string;
    readonly details: unknown;
  };
}): {
  readonly status: string;
  readonly phase: string;
  readonly completedAt: Date | null;
  readonly terminalReasonJson: string | null;
} => {
  if (input.taskStaysActive) {
    return {
      status: "ACTIVE",
      phase: "IMPLEMENT",
      completedAt: null,
      terminalReasonJson: null,
    };
  }
  return {
    status: input.taskTerminalStatus ?? "ACTIVE",
    phase: input.failedTaskStatus === "VERIFYING" ? "VERIFY" : "IMPLEMENT",
    completedAt: input.blockedError ? null : new Date(),
    terminalReasonJson: JSON.stringify({
      reason: input.failure.reason,
      code: input.failure.code,
      message: input.failure.message,
      details: input.failure.details,
    }),
  };
};

/** Write model for one terminal settlement's guarded writes. */
export interface TerminalSettlementPlan {
  readonly classification: TerminalTurnClassification;
  /** Turn row CAS: settle unless already in an immutable state. */
  readonly turnExpectedStates: readonly string[];
  readonly turnNextState: TerminalTurnState;
  /** Provider attempts still `running` fail with the turn. */
  readonly failRunningProviderAttempts: boolean;
  /** The terminal event's payload, ready for the bus. */
  readonly eventPayload: Readonly<Record<string, unknown>>;
  /** Exact CAS-failure error text. */
  readonly conflictError: string;
  /** Envelope written to every still-running provider attempt. */
  readonly providerAttemptsErrorJson: string;
  /** Envelope written to the turn row's `terminalErrorJson`. */
  readonly turnTerminalErrorJson: string;
}

/**
 * Turn states a terminal settlement must never overwrite. Mirrors the
 * inline `immutableTurnStates` list of the original settlement block.
 */
export const IMMUTABLE_TURN_STATES: readonly string[] = [
  "COMPLETED",
  "INTERRUPTED",
  "FAILED",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
  "BLOCKED",
  "USER_ACTION_REQUIRED",
  "REPAIR_PENDING",
  "VERIFIED",
  "ABORTED",
];

/**
 * Plan the convergent terminal settlement for a failed turn: classify, then
 * describe the guarded turn-row write, the running-attempt failure, and the
 * event payload. The composition root executes the plan inside its
 * event-plus-rows transaction; the task-side consequence is planned by
 * `turnFailureDisposition` and applied by the same executor.
 */
export const planTerminalTurnSettlement = (input: {
  readonly turnId: string;
  readonly classification: TerminalTurnClassification;
  /** Envelope of the typed engine stop, when the stop carried one. */
  readonly stopEnvelope: LoopErrorEnvelope | null;
  /** Envelope the loop classifier produced for a raw error. */
  readonly classifiedEnvelope: LoopErrorEnvelope;
}): TerminalSettlementPlan => {
  const envelope = input.stopEnvelope;
  const classified = input.classifiedEnvelope;
  const message = envelope?.message ?? classified.message;
  const details = envelope?.details ?? classified.details;
  const category = envelope?.category ?? classified.category;
  const retryable = envelope?.retryable ?? classified.retryable;
  return {
    classification: input.classification,
    turnExpectedStates: IMMUTABLE_TURN_STATES,
    turnNextState: input.classification.state,
    failRunningProviderAttempts: true,
    eventPayload: {
      code: input.classification.code,
      category,
      message,
      reason: input.classification.reason,
      retryable,
      details,
    },
    conflictError: `turn ${input.turnId} changed during failure settlement`,
    providerAttemptsErrorJson: JSON.stringify({
      code: input.classification.code,
      message,
      category,
      details,
    }),
    turnTerminalErrorJson: JSON.stringify({
      code: input.classification.code,
      message,
      reason: input.classification.reason,
      details,
    }),
  };
};

// ─────────────── Provider-continuation re-arm (engine boundary) ─────────────
//
// The loop's compile command used to re-arm RESPONSE_VALIDATING inline. The
// decision — a settled response may only re-enter compilation with a new
// generation, in the same transaction as the steering episode — belongs to
// the coordinator.

/** Plan the RESPONSE_VALIDATING → CONTEXT_COMPILING provider continuation. */
export const planProviderContinuation = (input: {
  readonly turnId: string;
  readonly taskId: string;
}): TurnTransitionPlan => ({
  eventType: "turn.context_compiling",
  aggregateType: "turn",
  aggregateId: input.turnId,
  correlationId: input.taskId,
  payload: { phase: "context_compiling", reason: "provider_continuation" },
  expectedStates: ["RESPONSE_VALIDATING"],
  nextState: "CONTEXT_COMPILING",
  setStartedAt: false,
  setCompletedAt: false,
  terminalErrorJson: null,
  conflictError: `turn ${input.turnId} changed before provider continuation`,
});

/** The per-attempt bookkeeping a turn's executor accumulates. */
export interface TurnAttemptLedger {
  /** Tool schemas declared to the provider, keyed by attempt id. */
  readonly declaredToolSchemasByAttempt: Map<string, readonly ProviderToolSchema[]>;
  /** Context manifest backing each attempt. */
  readonly manifestIdByAttempt: Map<string, Uuid7>;
  /** Cache tokens the compiler predicted for each attempt. */
  readonly predictedCacheByAttempt: Map<string, bigint>;
  /** Cache tokens the compiler predicted for each manifest's prompt. */
  readonly predictedPromptByManifest: Map<string, number>;
  /** Tool settlements by provider call id, written by the tool path. */
  readonly settlementByProviderCallId: Map<string, EngineToolSettlement>;
  /** Attempt ids whose tool-settlement entry event was already emitted. */
  readonly toolSettlementEnteredFor: Set<string>;
}

export const createTurnAttemptLedger = (): TurnAttemptLedger => ({
  declaredToolSchemasByAttempt: new Map(),
  manifestIdByAttempt: new Map(),
  predictedCacheByAttempt: new Map(),
  predictedPromptByManifest: new Map(),
  settlementByProviderCallId: new Map(),
  toolSettlementEnteredFor: new Set(),
});

/** Ports the executor needs to run one compiled attempt's commands. */
export interface TurnCommandExecutorPorts {
  readonly mutate: MutationRunner;
  readonly emit: (input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    correlationId?: string | undefined;
    payload: unknown;
    artifactRefs?: string[] | undefined;
  }, mutation?: (transaction: unknown) => Promise<void>) => Promise<unknown>;
  /**
   * Re-arm RESPONSE_VALIDATING → CONTEXT_COMPILING for a steering
   * continuation, in the caller's transaction. Returns rows updated.
   */
  readonly rearmProviderContinuation: (turnId: string, tx: unknown) => Promise<number>;
}

/**
 * Executes the loop's compiled-attempt commands. Owns effects, not
 * decisions: the lifecycle state machine stays in the coordinator; this
 * class turns coordinator state and engine callbacks into durable writes
 * and provider/tool/verification dispatches.
 */
export class TurnCommandExecutor {
  constructor(
    private readonly ports: TurnCommandExecutorPorts,
    readonly ledger: TurnAttemptLedger = createTurnAttemptLedger(),
  ) {}

  /**
   * Re-arm a settled response before a durable steering continuation. The
   * turn must still be in RESPONSE_VALIDATING; the CAS is the guard that
   * makes a re-delivered continuation command a no-op instead of a second
   * generation.
   */
  async rearmForProviderContinuation(input: {
    readonly turnId: string;
    readonly taskId: string;
  }): Promise<void> {
    await this.ports.mutate(() => this.ports.emit({
      eventType: "turn.context_compiling",
      aggregateType: "turn",
      aggregateId: input.turnId,
      correlationId: input.taskId,
      payload: { phase: "context_compiling", reason: "provider_continuation" },
    }, async (transaction) => {
      const updated = await this.ports.rearmProviderContinuation(input.turnId, transaction);
      if (updated !== 1) {
        throw new Error(`turn ${input.turnId} changed before provider continuation`);
      }
    }));
  }
}
