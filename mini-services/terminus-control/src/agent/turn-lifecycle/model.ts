/**
 * Deterministic turn lifecycle model — the canonical reference loop.
 *
 * A pure transition boundary: `State + Event -> State + Commands`.
 *
 * The reducer owns the semantics of the coding turn lifecycle (admission →
 * context compilation → provider attempt → tool settlement → recompilation →
 * verification → completion) and nothing else. It performs no network,
 * database, provider, or wall-clock work: those belong to the executor
 * (`executor.ts`), which durably records the outcome of every command and
 * feeds it back into this reducer as an event.
 *
 * Every event carries a unique `eventId`; the reducer deduplicates on it, so
 * duplicate delivery of a settled outcome cannot duplicate a logical effect.
 * Context generations advance monotonically, observations are never lost from
 * the next compiled context, and every non-terminal state derives a pending
 * command or an explicit waiting reason so recovery can always re-drive the
 * turn after a restart.
 *
 * This module is the executable contract for the invariants the assembled
 * loop was previously enforcing implicitly across `index.ts` CAS sites:
 * see `invariants.ts` for the checked properties.
 */

/** Non-terminal states the canonical turn lifecycle moves through. */
export type LifecyclePhase =
  | "ADMITTED"
  | "CONTEXT_COMPILING"
  | "PROVIDER_RUNNING"
  | "RESPONSE_VALIDATING"
  | "TOOL_SETTLEMENT"
  | "VERIFYING"
  | "FINALIZING";

/** Terminal states. Once reached, no event changes the phase. */
export type TerminalPhase =
  | "COMPLETED"
  | "FAILED"
  | "BUDGET_EXHAUSTED"
  | "POLICY_DENIED"
  | "ABORTED"
  | "INTERRUPTED"
  | "BLOCKED"
  | "USER_ACTION_REQUIRED";

export type LifecycleStateName = LifecyclePhase | TerminalPhase;

export const TERMINAL_PHASES: readonly TerminalPhase[] = [
  "COMPLETED",
  "FAILED",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
  "ABORTED",
  "INTERRUPTED",
  "BLOCKED",
  "USER_ACTION_REQUIRED",
];

export const isTerminalPhase = (state: LifecycleStateName): state is TerminalPhase =>
  (TERMINAL_PHASES as readonly string[]).includes(state);

/** States that must never remain permanently reachable by any schedule. */
export const LIVENESS_CRITICAL_PHASES: readonly LifecyclePhase[] = [
  "CONTEXT_COMPILING",
  "PROVIDER_RUNNING",
  "TOOL_SETTLEMENT",
  "VERIFYING",
];

/** One provider attempt accepted against the turn. */
export interface AttemptRecord {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly contextGeneration: number;
  readonly settled: boolean;
}

/** One authorized tool call and its logical settlement. */
export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly authorizedAtGeneration: number;
  readonly settlement:
    | {
        readonly status: "success" | "failed" | "denied";
        readonly mutatesWorkspace: boolean;
        /** Durable workspace revision bound to a mutating settlement. */
        readonly workspaceRevision: string | null;
      }
    | undefined;
}

/** Deterministic monotonic time, injected by the executor. */
export type LifecycleInstant = number;

export interface LifecycleState {
  readonly turnId: string;
  readonly phase: LifecycleStateName;
  /**
   * Monotonic context generation. Advances exactly once per successful
   * compilation; never decreases. A settled observation is only visible to
   * the provider from the generation that first includes it.
   */
  readonly contextGeneration: number;
  /** Highest observation (settled tool result) index reflected in compiled context. */
  readonly observationsThrough: number;
  /** Settled observations awaiting inclusion in the next compiled context. */
  readonly pendingObservations: readonly string[];
  readonly attempts: readonly AttemptRecord[];
  readonly activeAttemptId: string | null;
  readonly toolCalls: readonly ToolCallRecord[];
  /**
   * The durable work item the executor must perform while the turn is in its
   * current phase, or an explicit reason the turn is waiting on something
   * outside the reducer's control. Non-terminal states always carry one.
   */
  readonly pendingCommand: PendingCommand | null;
  readonly waitReason: string | null;
  /** Virtual time at which the turn's deadline expires; null when unbounded. */
  readonly deadline: LifecycleInstant | null;
  /** Compile retry counter for transient compile faults. */
  readonly compileRetries: number;
  /** Terminal outcome reason when phase is terminal. */
  readonly terminalReason: string | null;
  /** Workspace revision observed at the last mutation-committing settlement. */
  readonly workspaceRevision: string | null;
  /** True when the durable writer lease was lost and has not been restored. */
  readonly leaseLost: boolean;
}

export interface PendingCommand {
  readonly kind:
    | "CompileContext"
    | "InvokeProvider"
    | "ExecuteToolBatch"
    | "PersistArtifacts"
    | "RunVerification"
    | "MarkTerminal";
  /** Idempotency key: identical command outcomes collapse to one effect. */
  readonly idempotencyKey: string;
  readonly attemptId: string | null;
  readonly detail: string | null;
}

export type LifecycleEvent =
  | { readonly eventId: string; readonly type: "TurnStarted"; readonly turnId: string; readonly at: LifecycleInstant; readonly deadline: LifecycleInstant | null }
  | { readonly eventId: string; readonly type: "ContextCompiled"; readonly turnId: string; readonly generation: number; readonly observationsThrough: number }
  | { readonly eventId: string; readonly type: "ContextCompileFailed"; readonly turnId: string; readonly retryable: boolean }
  | { readonly eventId: string; readonly type: "CompileJobDequeued"; readonly turnId: string; readonly generation: number }
  | { readonly eventId: string; readonly type: "ProviderAttemptAccepted"; readonly turnId: string; readonly attemptId: string; readonly attemptNumber: number; readonly contextGeneration: number }
  | { readonly eventId: string; readonly type: "ProviderAttemptSettled"; readonly turnId: string; readonly attemptId: string; readonly finishReason: "stop" | "length" | "cancelled" | "error"; readonly toolCallIds: readonly string[]; readonly observation: string | null }
  | { readonly eventId: string; readonly type: "ToolCallsAuthorized"; readonly turnId: string; readonly attemptId: string; readonly toolCallIds: readonly string[] }
  | { readonly eventId: string; readonly type: "ToolSettlementCommitted"; readonly turnId: string; readonly toolCallId: string; readonly status: "success" | "failed" | "denied"; readonly mutatesWorkspace: boolean; readonly workspaceRevision: string | null }
  | { readonly eventId: string; readonly type: "VerificationStarted"; readonly turnId: string; readonly planId: string }
  | { readonly eventId: string; readonly type: "VerificationSettled"; readonly turnId: string; readonly planId: string; readonly passed: boolean }
  | { readonly eventId: string; readonly type: "CompletionAccepted"; readonly turnId: string; readonly attemptId: string }
  | { readonly eventId: string; readonly type: "DeadlineExpired"; readonly turnId: string; readonly deadline: LifecycleInstant }
  | { readonly eventId: string; readonly type: "CancellationRequested"; readonly turnId: string; readonly reason: string }
  | { readonly eventId: string; readonly type: "WriterLeaseLost"; readonly turnId: string }
  | { readonly eventId: string; readonly type: "WriterLeaseRestored"; readonly turnId: string }
  | { readonly eventId: string; readonly type: "WorkspaceRevisionChanged"; readonly turnId: string; readonly revision: string }
  | { readonly eventId: string; readonly type: "ArtifactsPersisted"; readonly turnId: string; readonly artifactKeys: readonly string[] }
  | { readonly eventId: string; readonly type: "ArtifactPublicationInterrupted"; readonly turnId: string; readonly artifactKeys: readonly string[] }
  | { readonly eventId: string; readonly type: "RecoveryRequested"; readonly turnId: string; readonly reason: string };

export interface Reduction {
  readonly state: LifecycleState;
  readonly commands: readonly PendingCommand[];
  /** True when the event was a duplicate whose delivery changed nothing. */
  readonly duplicate: boolean;
}

const NO_COMMANDS: readonly PendingCommand[] = [];

export const initialLifecycleState = (turnId: string): LifecycleState => ({
  turnId,
  phase: "ADMITTED",
  contextGeneration: 0,
  observationsThrough: 0,
  pendingObservations: [],
  attempts: [],
  activeAttemptId: null,
  toolCalls: [],
  pendingCommand: null,
  waitReason: null,
  deadline: null,
  compileRetries: 0,
  terminalReason: null,
  workspaceRevision: null,
  leaseLost: false,
});

export const command = (input: {
  readonly kind: PendingCommand["kind"];
  readonly idempotencyKey: string;
  readonly attemptId?: string | null | undefined;
  readonly detail?: string | null | undefined;
}): PendingCommand => ({
  kind: input.kind,
  idempotencyKey: input.idempotencyKey,
  attemptId: input.attemptId ?? null,
  detail: input.detail ?? null,
});

const terminal = (input: {
  readonly state: LifecycleState;
  readonly phase: TerminalPhase;
  readonly reason: string;
}): LifecycleState => ({
  ...input.state,
  phase: input.phase,
  pendingCommand: null,
  waitReason: null,
  deadline: null,
  activeAttemptId: null,
  terminalReason: input.reason,
});

const withPending = (input: {
  readonly state: LifecycleState;
  readonly pending: PendingCommand;
}): LifecycleState => ({
  ...input.state,
  pendingCommand: input.pending,
  waitReason: null,
});

const attemptRecord = (state: LifecycleState, attemptId: string): AttemptRecord | undefined =>
  state.attempts.find((attempt) => attempt.attemptId === attemptId);

const toolRecord = (state: LifecycleState, toolCallId: string): ToolCallRecord | undefined =>
  state.toolCalls.find((call) => call.toolCallId === toolCallId);

/**
 * Settle into a terminal phase from any non-terminal state. The mapping keeps
 * production's failure disposition vocabulary (`turn-failure-policy.ts`).
 */
const settleTerminal = (state: LifecycleState, event: {
  readonly phase: TerminalPhase;
  readonly reason: string;
}): LifecycleState => terminal({ state, phase: event.phase, reason: event.reason });

/** Commands that re-drive a turn stuck at a safe boundary after restart. */
// skipcq: JS-R1005, JS-0067
const recoveryCommands = (state: LifecycleState): readonly PendingCommand[] => {
  switch (state.phase) {
    case "ADMITTED":
      return [command({ kind: "CompileContext", idempotencyKey: `compile:${state.turnId}:g${state.contextGeneration}` })];
    case "CONTEXT_COMPILING":
      return [command({ kind: "CompileContext", idempotencyKey: `compile:${state.turnId}:g${state.contextGeneration}` })];
    case "PROVIDER_RUNNING":
      // The accepted result must settle or be explicitly recoverable: the
      // executor replays delivery of the in-flight attempt's outcome.
      return state.activeAttemptId === null
        ? [command({ kind: "CompileContext", idempotencyKey: `compile:${state.turnId}:g${state.contextGeneration}` })]
        : [command({ kind: "InvokeProvider", idempotencyKey: `settle:${state.activeAttemptId}`, attemptId: state.activeAttemptId, detail: "recover_settlement" })];
    case "RESPONSE_VALIDATING":
      return [command({ kind: "PersistArtifacts", idempotencyKey: `persist:${state.turnId}:g${state.contextGeneration}` })];
    case "TOOL_SETTLEMENT": {
      const unsettled = state.toolCalls.filter((call) => call.settlement === undefined);
      return unsettled.length > 0
        ? [command({
            kind: "ExecuteToolBatch",
            idempotencyKey: `tools:${state.turnId}:${state.contextGeneration}:${unsettled.map((call) => call.toolCallId).join(",")}`,
            attemptId: state.activeAttemptId,
            detail: "recover_settlement",
          })]
        : [command({ kind: "CompileContext", idempotencyKey: `compile:${state.turnId}:g${state.contextGeneration}` })];
    }
    case "VERIFYING":
      return [command({ kind: "RunVerification", idempotencyKey: `verify:${state.turnId}` })];
    case "FINALIZING":
      return [command({ kind: "MarkTerminal", idempotencyKey: `complete:${state.turnId}`, detail: "COMPLETED" })];
    default:
      return NO_COMMANDS;
  }
};

/**
 * The transition function. Total over events; unknown/duplicate/terminal
 * events return the unchanged state with no commands.
 */
// skipcq: JS-R1005, JS-0067
export const reduce = (state: LifecycleState, event: LifecycleEvent): Reduction => {
  // A terminal turn absorbs every later event: terminal settlement is the
  // authoritative record, so re-delivered outcomes are duplicates.
  if (isTerminalPhase(state.phase)) return { state, commands: NO_COMMANDS, duplicate: true };
  if (event.turnId !== state.turnId) {
    return { state, commands: NO_COMMANDS, duplicate: false };
  }

  switch (event.type) {
    case "TurnStarted": {
      if (state.phase !== "ADMITTED") return { state, commands: NO_COMMANDS, duplicate: false };
      const next: LifecycleState = {
        ...state,
        phase: "CONTEXT_COMPILING",
        deadline: event.deadline,
        pendingCommand: command({ kind: "CompileContext", idempotencyKey: `compile:${state.turnId}:g0` }),
      };
      return { state: next, commands: [next.pendingCommand!], duplicate: false };
    }

    case "CompileJobDequeued": {
      // The context job dequeues only when compilation is pending; a dequeue
      // that arrives before the public projection updated is a duplicate.
      if (state.phase !== "CONTEXT_COMPILING" || event.generation !== state.contextGeneration) {
        return { state, commands: NO_COMMANDS, duplicate: false };
      }
      return { state, commands: NO_COMMANDS, duplicate: false };
    }

    case "ContextCompiled": {
      if (state.phase !== "CONTEXT_COMPILING") return { state, commands: NO_COMMANDS, duplicate: false };
      if (event.generation <= state.contextGeneration) {
        return { state, commands: NO_COMMANDS, duplicate: true };
      }
      // The compiled context binds every observation accepted so far — the
      // compiler reads the durable episode ledger, never a subset. A claimed
      //-through beyond the accepted set is clamped, never allowed to erase
      // an accepted observation from the next provider context.
      const availableThrough = state.observationsThrough + state.pendingObservations.length;
      const boundThrough = Math.min(event.observationsThrough, availableThrough);
      const includedCount = boundThrough - state.observationsThrough;
      const next: LifecycleState = {
        ...state,
        contextGeneration: event.generation,
        observationsThrough: boundThrough,
        pendingObservations: state.pendingObservations.slice(includedCount),
        phase: "CONTEXT_COMPILING",
        compileRetries: 0,
        leaseLost: false,
        // Compilation succeeded: the durable next step is a provider attempt
        // against exactly this generation. The executor mints the attempt id
        // when it performs the command; acceptance stays a separate event.
        pendingCommand: command({
          kind: "InvokeProvider",
          idempotencyKey: `invoke:${state.turnId}:g${event.generation}`,
        }),
      };
      return { state: next, commands: [next.pendingCommand!], duplicate: false };
    }

    case "ContextCompileFailed": {
      if (state.phase !== "CONTEXT_COMPILING") return { state, commands: NO_COMMANDS, duplicate: false };
      if (!event.retryable || state.compileRetries >= 3) {
        // Non-retryable faults block immediately; a transient fault that has
        // exhausted its bounded retry budget blocks with an explicit reason
        // rather than spinning. Both leave a recoverable terminal record.
        const blocked = settleTerminal(state, {
          phase: "BLOCKED",
          reason: event.retryable ? "context_compile_retries_exhausted" : "context_compilation_failed",
        });
        return { state: blocked, commands: NO_COMMANDS, duplicate: false };
      }
      const next: LifecycleState = {
        ...state,
        compileRetries: state.compileRetries + 1,
      };
      // A bounded transient retry keeps the turn convergent: the executor
      // schedules a deterministic wakeup and re-runs the same command.
      return {
        state: next,
        commands: [command({ kind: "CompileContext", idempotencyKey: `compile:${state.turnId}:g${state.contextGeneration}:r${next.compileRetries}` })],
        duplicate: false,
      };
    }

    case "ProviderAttemptAccepted": {
      if (state.phase !== "CONTEXT_COMPILING") return { state, commands: NO_COMMANDS, duplicate: false };
      if (state.activeAttemptId !== null) {
        // Invariant: at most one active provider attempt per accepted turn.
        return { state, commands: NO_COMMANDS, duplicate: false };
      }
      if (attemptRecord(state, event.attemptId) !== undefined) {
        return { state, commands: NO_COMMANDS, duplicate: true };
      }
      if (event.contextGeneration !== state.contextGeneration) {
        return { state, commands: NO_COMMANDS, duplicate: false };
      }
      const next: LifecycleState = {
        ...state,
        phase: "PROVIDER_RUNNING",
        activeAttemptId: event.attemptId,
        pendingCommand: null,
        attempts: [
          ...state.attempts,
          {
            attemptId: event.attemptId,
            attemptNumber: event.attemptNumber,
            contextGeneration: event.contextGeneration,
            settled: false,
          },
        ],
      };
      return { state: next, commands: NO_COMMANDS, duplicate: false };
    }

    case "ProviderAttemptSettled": {
      const record = attemptRecord(state, event.attemptId);
      if (record === undefined) return { state, commands: NO_COMMANDS, duplicate: false };
      if (record.settled) return { state, commands: NO_COMMANDS, duplicate: true };
      if (state.phase !== "PROVIDER_RUNNING" || state.activeAttemptId !== event.attemptId) {
        return { state, commands: NO_COMMANDS, duplicate: false };
      }
      const attempts = state.attempts.map((attempt) =>
        attempt.attemptId === event.attemptId ? { ...attempt, settled: true } : attempt,
      );
      const observations = event.observation === null
        ? state.pendingObservations
        : [...state.pendingObservations, event.observation];
      if (event.finishReason === "cancelled") {
        const aborted = settleTerminal(state, { phase: "ABORTED", reason: "provider_attempt_cancelled" });
        return {
          state: { ...aborted, attempts, activeAttemptId: null },
          commands: NO_COMMANDS,
          duplicate: false,
        };
      }
      if (event.finishReason === "error") {
        const failed = settleTerminal(state, { phase: "FAILED", reason: "provider_attempt_failed" });
        return {
          state: { ...failed, attempts, activeAttemptId: null },
          commands: NO_COMMANDS,
          duplicate: false,
        };
      }
      const hasTools = event.toolCallIds.length > 0;
      const next: LifecycleState = {
        ...state,
        attempts,
        activeAttemptId: null,
        phase: hasTools ? "TOOL_SETTLEMENT" : "RESPONSE_VALIDATING",
        toolCalls: hasTools
          ? [
              ...state.toolCalls,
              ...event.toolCallIds
                .filter((toolCallId) => toolRecord(state, toolCallId) === undefined)
                .map((toolCallId) => ({
                  toolCallId,
                  authorizedAtGeneration: state.contextGeneration,
                  settlement: undefined,
                })),
            ]
          : state.toolCalls,
        pendingObservations: observations,
        pendingCommand: hasTools
          ? command({
              kind: "ExecuteToolBatch",
              idempotencyKey: `tools:${state.turnId}:${event.attemptId}:${event.toolCallIds.join(",")}`,
              attemptId: event.attemptId,
            })
          : command({ kind: "PersistArtifacts", idempotencyKey: `persist:${state.turnId}:g${state.contextGeneration}` }),
      };
      return { state: next, commands: [next.pendingCommand!], duplicate: false };
    }

    case "ToolCallsAuthorized": {
      // Authorization is implied by the settled response; a duplicate
      // authorization must not extend the batch or reset settlements.
      return { state, commands: NO_COMMANDS, duplicate: true };
    }

    case "ToolSettlementCommitted": {
      if (state.phase !== "TOOL_SETTLEMENT") return { state, commands: NO_COMMANDS, duplicate: false };
      const existing = toolRecord(state, event.toolCallId);
      if (existing === undefined) return { state, commands: NO_COMMANDS, duplicate: false };
      if (existing.settlement !== undefined) return { state, commands: NO_COMMANDS, duplicate: true };
      // Invariant: a mutating settlement must record a workspace revision.
      if (event.mutatesWorkspace && event.workspaceRevision === null) {
        return { state, commands: NO_COMMANDS, duplicate: false };
      }
      const toolCalls = state.toolCalls.map((call) =>
        call.toolCallId === event.toolCallId
          ? {
              ...call,
              settlement: {
                status: event.status,
                mutatesWorkspace: event.mutatesWorkspace,
                workspaceRevision: event.workspaceRevision,
              },
            }
          : call,
      );
      const next: LifecycleState = {
        ...state,
        toolCalls,
        workspaceRevision: event.workspaceRevision ?? state.workspaceRevision,
      };
      const allSettled = next.toolCalls.every((call) => call.settlement !== undefined);
      if (!allSettled) return { state: next, commands: NO_COMMANDS, duplicate: false };
      // The batch is durably settled: re-arm context compilation. This is a
      // durable pending command, never an in-memory callback, so a restart
      // here converges to the same recompilation.
      const recompiled: LifecycleState = withPending({
        state: { ...next, phase: "CONTEXT_COMPILING" },
        pending: command({ kind: "CompileContext", idempotencyKey: `compile:${state.turnId}:g${state.contextGeneration}:post-tools` }),
      });
      return { state: recompiled, commands: [recompiled.pendingCommand!], duplicate: false };
    }

    case "WorkspaceRevisionChanged": {
      if (isTerminalPhase(state.phase)) return { state, commands: NO_COMMANDS, duplicate: false };
      // A workspace change between observation and compile invalidates the
      // compiled prefix: the next compile must re-observe. The reducer only
      // records the revision; the executor drops the in-flight compile.
      const next: LifecycleState = { ...state, workspaceRevision: event.revision };
      return { state: next, commands: NO_COMMANDS, duplicate: false };
    }

    case "ArtifactsPersisted": {
      if (state.phase !== "RESPONSE_VALIDATING") return { state, commands: NO_COMMANDS, duplicate: false };
      const next: LifecycleState = {
        ...state,
        phase: "VERIFYING",
        pendingCommand: command({ kind: "RunVerification", idempotencyKey: `verify:${state.turnId}` }),
      };
      return { state: next, commands: [next.pendingCommand!], duplicate: false };
    }

    case "ArtifactPublicationInterrupted": {
      if (state.phase !== "RESPONSE_VALIDATING") return { state, commands: NO_COMMANDS, duplicate: false };
      // Persistence succeeded but publication is interrupted: the outbox
      // retains the publication; recovery re-drains it.
      const republished: LifecycleState = withPending({
        state,
        pending: command({ kind: "PersistArtifacts", idempotencyKey: `persist:${state.turnId}:g${state.contextGeneration}:republish` }),
      });
      return { state: republished, commands: [republished.pendingCommand!], duplicate: false };
    }

    case "VerificationStarted": {
      if (state.phase !== "VERIFYING") return { state, commands: NO_COMMANDS, duplicate: false };
      return { state, commands: NO_COMMANDS, duplicate: false };
    }

    case "VerificationSettled": {
      if (state.phase !== "VERIFYING") return { state, commands: NO_COMMANDS, duplicate: false };
      if (!event.passed) {
        const failed = settleTerminal(state, { phase: "FAILED", reason: "verification_failed" });
        return { state: failed, commands: NO_COMMANDS, duplicate: false };
      }
      const finalized: LifecycleState = {
        ...state,
        phase: "FINALIZING",
        pendingCommand: command({ kind: "MarkTerminal", idempotencyKey: `complete:${state.turnId}`, detail: "COMPLETED" }),
      };
      return { state: finalized, commands: [finalized.pendingCommand!], duplicate: false };
    }

    case "CompletionAccepted": {
      // Applies while finalizing because the executor produces it as the
      // outcome of the MarkTerminal command; earlier phases admit it as an
      // externally observed completion.
      if (state.phase !== "VERIFYING" && state.phase !== "RESPONSE_VALIDATING" && state.phase !== "FINALIZING") {
        return { state, commands: NO_COMMANDS, duplicate: false };
      }
      return {
        state: terminal({ state, phase: "COMPLETED", reason: "completion_accepted" }),
        commands: NO_COMMANDS,
        duplicate: false,
      };
    }

    case "DeadlineExpired": {
      if (state.deadline !== null && event.deadline < state.deadline) {
        return { state, commands: NO_COMMANDS, duplicate: true };
      }
      const exhausted = settleTerminal(state, { phase: "BUDGET_EXHAUSTED", reason: "deadline_expired" });
      return { state: exhausted, commands: NO_COMMANDS, duplicate: false };
    }

    case "CancellationRequested": {
      const aborted = settleTerminal(state, { phase: "ABORTED", reason: event.reason });
      return { state: aborted, commands: NO_COMMANDS, duplicate: false };
    }

    case "WriterLeaseLost": {
      // The turn cannot make durable progress without the lease, but it must
      // expose an explicit waiting reason rather than a silent stall.
      const next: LifecycleState = {
        ...state,
        leaseLost: true,
        pendingCommand: null,
        waitReason: "writer_lease_lost",
      };
      return { state: next, commands: NO_COMMANDS, duplicate: false };
    }

    case "WriterLeaseRestored": {
      if (!state.leaseLost) return { state, commands: NO_COMMANDS, duplicate: true };
      const next: LifecycleState = { ...state, leaseLost: false, waitReason: null };
      const commands = recoveryCommands(next);
      const restored = commands.length > 0 ? withPending({ state: next, pending: commands[0]! }) : next;
      return { state: restored, commands, duplicate: false };
    }

    case "RecoveryRequested": {
      const commands = recoveryCommands(state);
      const recovered = commands.length > 0 ? withPending({ state, pending: commands[0]! }) : state;
      return { state: recovered, commands, duplicate: false };
    }

    default:
      return { state, commands: NO_COMMANDS, duplicate: false };
  }
};

/**
 * Derive the pending command for a state without an event. Used on restart:
 * the executor reduces the durable log and then asks the model what must run.
 */
export const recoverableCommands = (state: LifecycleState): readonly PendingCommand[] => {
  if (isTerminalPhase(state.phase)) return NO_COMMANDS;
  if (state.pendingCommand !== null) return [state.pendingCommand];
  if (state.waitReason !== null) return NO_COMMANDS;
  return recoveryCommands(state);
};
