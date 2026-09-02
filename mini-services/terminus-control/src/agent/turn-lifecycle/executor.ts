/**
 * Executor for the deterministic turn lifecycle.
 *
 * The executor is the only component allowed to touch effects. It performs
 * the commands the reducer emits through injected ports, durably appends the
 * outcome events, and feeds them back into the reducer. All dependencies —
 * clock, scheduler, event store, and the effect handlers — are injected, so
 * conformance tests drive it on virtual time with no sleeps, no `Date.now`,
 * and no wall-clock polling.
 *
 * Restart safety: the state is a pure fold of the durable event log. A crash
 * at any point loses only in-memory dispatch; recovery replays the log and
 * re-dispatches the derived pending command, which is idempotent per command
 * key — duplicate outcome events collapse in the reducer.
 */

import { checkInvariants, type InvariantViolation } from "./invariants.js";
import {
  initialLifecycleState,
  isTerminalPhase,
  recoverableCommands,
  reduce,
  type LifecycleEvent,
  type LifecycleInstant,
  type LifecycleState,
  type PendingCommand,
} from "./model.js";

/** Deterministic time source. Never `Date.now` in lifecycle tests. */
export interface LifecycleClock {
  readonly now: () => LifecycleInstant;
}

/** Deterministic scheduler. Wakeups are virtual; tests advance time. */
export interface LifecycleScheduler {
  readonly schedule: (wakeup: ScheduledWakeup) => void;
  readonly cancel: (wakeupId: string) => void;
  readonly pending: () => readonly ScheduledWakeup[];
}

export interface ScheduledWakeup {
  readonly wakeupId: string;
  readonly at: LifecycleInstant;
  readonly deliver: () => LifecycleEvent;
}

/** Durable, ordered event store. Append is the durability boundary. */
export interface LifecycleEventStore {
  readonly append: (event: LifecycleEvent) => Promise<void>;
  readonly readAll: () => Promise<readonly LifecycleEvent[]>;
}

export interface ExecuteToolBatchOutcome {
  readonly toolCallId: string;
  readonly status: "success" | "failed" | "denied";
  readonly mutatesWorkspace: boolean;
  readonly workspaceRevision: string | null;
}

/** Effect ports the commands dispatch to. Handlers return outcome events. */
export interface LifecycleEffects {
  readonly compileContext: (input: {
    readonly turnId: string;
    readonly generation: number;
  }) => Promise<{ readonly generation: number; readonly observationsThrough: number } | { readonly retryable: true } | { readonly retryable: false }>;
  readonly invokeProvider: (input: {
    readonly turnId: string;
    readonly attemptId: string;
  }) => Promise<{
    readonly finishReason: "stop" | "length" | "cancelled" | "error";
    readonly toolCallIds: readonly string[];
    readonly observation: string | null;
  }>;
  readonly executeToolBatch: (input: {
    readonly turnId: string;
    readonly toolCallIds: readonly string[];
  }) => Promise<readonly ExecuteToolBatchOutcome[]>;
  readonly persistArtifacts: (input: {
    readonly turnId: string;
    readonly generation: number;
  }) => Promise<{ readonly published: boolean; readonly artifactKeys: readonly string[] }>;
  readonly runVerification: (input: { readonly turnId: string }) => Promise<{ readonly passed: boolean; readonly planId: string }>;
  readonly markTerminal: (input: { readonly turnId: string; readonly detail: string | null }) => Promise<void>;
}

export interface LifecycleExecutorOptions {
  readonly turnId: string;
  readonly clock: LifecycleClock;
  readonly scheduler: LifecycleScheduler;
  readonly store: LifecycleEventStore;
  readonly effects: LifecycleEffects;
  /**
   * Wall bound in virtual ticks, recorded durably at TurnStarted so every
   * active state carries a deadline: one of the three recovery anchors
   * (pending command, deadline, explicit waiting reason).
   */
  readonly deadlineTick?: number | null;
}

export class LifecycleInvariantError extends Error {
  constructor(readonly violation: InvariantViolation) {
    super(`lifecycle invariant violated: ${violation.invariant} — ${violation.detail}`);
    this.name = "LifecycleInvariantError";
  }
}

export class LifecycleExecutor {
  private state: LifecycleState;
  private readonly history: LifecycleEvent[] = [];
  private readonly options: LifecycleExecutorOptions;
  private readonly turnDeadline: number | null;
  private dispatching = false;

  constructor(options: LifecycleExecutorOptions) {
    this.options = options;
    this.state = initialLifecycleState(options.turnId);
    this.turnDeadline = options.deadlineTick ?? null;
  }

  /** Current reduced state (a fold of the durable log). */
  get currentState(): LifecycleState {
    return this.state;
  }

  get eventHistory(): readonly LifecycleEvent[] {
    return this.history;
  }

  /**
   * Feed one durable event into the reducer. The event must already be
   * durable (the caller or store owns ordering); the executor validates the
   * reduction against the full history and keeps the resulting commands for
   * `drain` to dispatch.
   */
  async apply(event: LifecycleEvent): Promise<void> {
    await this.applyInternal(event);
    await this.drain();
  }

  private async applyInternal(event: LifecycleEvent): Promise<LifecycleState> {
    const delivered: LifecycleEvent = event.type === "TurnStarted" && event.deadline === undefined
      ? { ...event, deadline: this.turnDeadline }
      : event;
    const candidate = reduce(this.state, delivered);
    const violation = checkInvariants(candidate.state, [...this.history, delivered]);
    if (violation !== null) throw new LifecycleInvariantError(violation);
    if (candidate.duplicate) {
      this.state = candidate.state;
      return this.state;
    }
    await this.options.store.append(delivered);
    this.state = candidate.state;
    this.history.push(delivered);
    this.ensureDeadlineWakeup();
    return this.state;
  }

  /** Dispatch the pending command through the effect ports. */
  async dispatch(commandToRun: PendingCommand): Promise<void> {
    if (this.dispatching) throw new Error("executor reentrancy: dispatch overlapped");
    this.dispatching = true;
    try {
      const outcomes = await this.perform(commandToRun);
      for (const event of outcomes) {
        await this.applyInternal(event);
      }
    } finally {
      this.dispatching = false;
    }
    await this.drain();
  }

  /** Deliver a scheduler-produced event (deadline, cancellation, lease). */
  async deliver(event: LifecycleEvent): Promise<void> {
    await this.apply(event);
  }

  /**
   * Restart semantics: rebuild the state by replaying the durable log. The
   * fold produces the same state the pre-crash executor held, so a crash
   * after any persisted transition converges to the same logical result.
   * Returns the commands recovery must re-dispatch.
   */
  async recover(): Promise<readonly PendingCommand[]> {
    const events = await this.options.store.readAll();
    let state = initialLifecycleState(this.options.turnId);
    const history: LifecycleEvent[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      const next = reduce(state, event);
      if (next.state !== state) history.push(event);
      state = next.state;
    }
    this.state = state;
    this.history.length = 0;
    this.history.push(...history);
    this.ensureDeadlineWakeup();
    return recoverableCommands(state);
  }

  /** Commands derivable from the current state without an event. */
  recoverableCommands(): readonly PendingCommand[] {
    return recoverableCommands(this.state);
  }

  /**
   * Every active turn keeps a durable deadline wakeup scheduled on the
   * injected scheduler; terminal turns cancel it. This is the liveness
   * anchor: a turn can never sit in a critical phase without either pending
   * work or a pending deadline.
   */
  private ensureDeadlineWakeup(): void {
    const wakeupId = `deadline:${this.options.turnId}`;
    if (isTerminalPhase(this.state.phase)) {
      this.options.scheduler.cancel(wakeupId);
      return;
    }
    if (this.state.deadline === null) return;
    if (this.options.scheduler.pending().some((wakeup) => wakeup.wakeupId === wakeupId)) return;
    this.options.scheduler.schedule({
      wakeupId,
      at: this.state.deadline,
      deliver: () => ({
        eventId: wakeupId,
        type: "DeadlineExpired",
        turnId: this.options.turnId,
        deadline: this.state.deadline!,
      }),
    });
  }

  // skipcq: JS-R1005, JS-0067
  private async drain(): Promise<void> {
    for (;;) {
      if (this.dispatching) return;
      const pending = this.state.pendingCommand;
      if (pending === null || isTerminalPhase(this.state.phase) || this.state.waitReason !== null) return;
      await this.dispatch(pending);
      if (this.state.pendingCommand?.idempotencyKey === pending.idempotencyKey) {
        // The effect produced no advancing outcome; avoid spinning forever.
        return;
      }
    }
  }

  // skipcq: JS-R1005, JS-0067
  private async perform(running: PendingCommand): Promise<readonly LifecycleEvent[]> {
    const turnId = this.options.turnId;
    switch (running.kind) {
      case "CompileContext": {
        const result = await this.options.effects.compileContext({
          turnId,
          generation: this.state.contextGeneration,
        });
        if ("retryable" in result) {
          return [{
            eventId: `compile-failed:${turnId}:${this.state.compileRetries}`,
            type: "ContextCompileFailed",
            turnId,
            retryable: result.retryable,
          }];
        }
        return [{
          eventId: `compiled:${turnId}:${result.generation}`,
          type: "ContextCompiled",
          turnId,
          generation: result.generation,
          observationsThrough: result.observationsThrough,
        }];
      }
      case "InvokeProvider": {
        // The attempt id is minted deterministically from the generation so a
        // replay after a crash re-derives the same identity. Acceptance and
        // settlement are separate durable events, mirroring the production
        // begin-then-settle boundary.
        const attemptId = running.attemptId ?? `a${this.state.contextGeneration}`;
        const result = await this.options.effects.invokeProvider({ turnId, attemptId });
        return [
          {
            eventId: `accepted:${turnId}:${attemptId}`,
            type: "ProviderAttemptAccepted" as const,
            turnId,
            attemptId,
            attemptNumber: this.state.attempts.length + 1,
            contextGeneration: this.state.contextGeneration,
          },
          {
            eventId: `settled:${turnId}:${attemptId}`,
            type: "ProviderAttemptSettled" as const,
            turnId,
            attemptId,
            finishReason: result.finishReason,
            toolCallIds: [...result.toolCallIds],
            observation: result.observation,
          },
        ];
      }
      case "ExecuteToolBatch": {
        if (running.attemptId === null) throw new Error("ExecuteToolBatch requires an attempt id");
        const batch = await this.options.effects.executeToolBatch({
          turnId,
          toolCallIds: this.state.toolCalls
            .filter((call) => call.settlement === undefined)
            .map((call) => call.toolCallId),
        });
        return batch.map((outcome) => ({
          eventId: `tool:${turnId}:${outcome.toolCallId}`,
          type: "ToolSettlementCommitted" as const,
          turnId,
          toolCallId: outcome.toolCallId,
          status: outcome.status,
          mutatesWorkspace: outcome.mutatesWorkspace,
          workspaceRevision: outcome.workspaceRevision,
        }));
      }
      case "PersistArtifacts": {
        const result = await this.options.effects.persistArtifacts({
          turnId,
          generation: this.state.contextGeneration,
        });
        if (!result.published) {
          return [{
            eventId: `publication-interrupted:${turnId}:${this.state.contextGeneration}`,
            type: "ArtifactPublicationInterrupted",
            turnId,
            artifactKeys: [...result.artifactKeys],
          }];
        }
        return [{
          eventId: `artifacts-persisted:${turnId}:${this.state.contextGeneration}`,
          type: "ArtifactsPersisted",
          turnId,
          artifactKeys: [...result.artifactKeys],
        }];
      }
      case "RunVerification": {
        const result = await this.options.effects.runVerification({ turnId });
        return [
          {
            eventId: `verification-started:${turnId}:${result.planId}`,
            type: "VerificationStarted",
            turnId,
            planId: result.planId,
          },
          {
            eventId: `verification-settled:${turnId}:${result.planId}`,
            type: "VerificationSettled",
            turnId,
            planId: result.planId,
            passed: result.passed,
          },
        ];
      }
      case "MarkTerminal": {
        await this.options.effects.markTerminal({ turnId, detail: running.detail });
        return [{
          eventId: `completion-accepted:${turnId}`,
          type: "CompletionAccepted",
          turnId,
          attemptId: this.state.attempts[this.state.attempts.length - 1]?.attemptId ?? "none",
        }];
      }
      default:
        return [];
    }
  }
}
