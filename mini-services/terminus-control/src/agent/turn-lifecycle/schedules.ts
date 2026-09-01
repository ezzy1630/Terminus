/**
 * Conformance schedules for the deterministic turn lifecycle.
 *
 * Each schedule fixes an interleaving of durable events — duplicates,
 * restarts, lease loss, revision changes — drives it through the pure
 * reducer, and asserts the invariants held at every step and the turn
 * converged. The permutation harness explores random valid schedules under a
 * printed seed and retains the full event log of any failing schedule.
 */

import { checkInvariants, type InvariantViolation } from "./invariants.js";
import {
  initialLifecycleState,
  isTerminalPhase,
  recoverableCommands,
  reduce,
  type LifecycleEvent,
  type LifecycleState,
  type PendingCommand,
} from "./model.js";

export const TURN = "0199face-7000-7000-8000-000000000001";

/** Deterministic linear-congruential PRNG so seeds replay exactly. */
export function makeRng(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current = (Math.imul(current, 1664525) + 1013904223) >>> 0;
    return current / 0x1_0000_0000;
  };
}

let eventCounter = 0;

/**
 * `Omit` distributes over a union of event shapes, so callers constructing a
 * partial event (`ev({ type: "DeadlineExpired", deadline })`) get the fields
 * of exactly the variant they name instead of the union's common properties.
 * This is the type behind every schedule, permutation, and conformance
 * event literal.
 */
export type LifecycleEventInput = DistributiveOmit<LifecycleEvent, "eventId" | "turnId">;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function ev(partial: LifecycleEventInput): LifecycleEvent {
  eventCounter += 1;
  return { ...partial, eventId: `e${eventCounter}`, turnId: TURN } as LifecycleEvent;
}

export function resetEventCounter(): void {
  eventCounter = 0;
}

/**
 * The canonical spine: user request → activation tool succeeds → observation
 * durably committed → context recompiles → provider receives the observation
 * → provider continues with another tool → completion.
 *
 * The turn carries an explicit injected-clock deadline (virtual instant
 * 1_000_000). With a deadline on the state, `DeadlineExpired` has two
 * observable paths: a *stale* expiry (deadline earlier than the armed one) is
 * absorbed as a duplicate, and a *current* expiry settles the turn
 * BUDGET_EXHAUSTED. Schedules that relied on an unbounded turn still behave
 * identically — no spine event reads the deadline otherwise.
 */
export const TURN_DEADLINE = 1_000_000;

export function canonicalSpine(): readonly LifecycleEventInput[] {
  return [
    { type: "TurnStarted", at: 1, deadline: TURN_DEADLINE },
    { type: "ContextCompiled", generation: 1, observationsThrough: 0 },
    { type: "ProviderAttemptAccepted", attemptId: "a1", attemptNumber: 1, contextGeneration: 1 },
    { type: "ProviderAttemptSettled", attemptId: "a1", finishReason: "stop", toolCallIds: ["t-activate"], observation: null },
    { type: "ToolSettlementCommitted", toolCallId: "t-activate", status: "success", mutatesWorkspace: false, workspaceRevision: null },
    { type: "ContextCompiled", generation: 2, observationsThrough: 0 },
    { type: "ProviderAttemptAccepted", attemptId: "a2", attemptNumber: 2, contextGeneration: 2 },
    { type: "ProviderAttemptSettled", attemptId: "a2", finishReason: "stop", toolCallIds: ["t-patch"], observation: "obs-patch" },
    { type: "ToolSettlementCommitted", toolCallId: "t-patch", status: "success", mutatesWorkspace: true, workspaceRevision: "rev-1" },
    { type: "ContextCompiled", generation: 3, observationsThrough: 1 },
    { type: "ProviderAttemptAccepted", attemptId: "a3", attemptNumber: 3, contextGeneration: 3 },
    { type: "ProviderAttemptSettled", attemptId: "a3", finishReason: "stop", toolCallIds: [], observation: null },
    { type: "ArtifactsPersisted", artifactKeys: ["response"] },
    { type: "VerificationStarted", planId: "plan-1" },
    { type: "VerificationSettled", planId: "plan-1", passed: true },
    { type: "CompletionAccepted", attemptId: "a3" },
  ];
}

/**
 * A schedule run: applies events to the pure reducer, enforcing the
 * invariants after every accepted event. `apply` records only events that
 * changed logical state — duplicates are acknowledged and dropped exactly
 * like the executor records them.
 */
export class ScheduleRun {
  private state: LifecycleState = initialLifecycleState(TURN);
  private readonly log: LifecycleEvent[] = [];
  private lastApplyChanged = false;

  apply(event: LifecycleEvent): void {
    const before = this.state;
    const reduction = reduce(this.state, event);
    this.state = reduction.state;
    this.lastApplyChanged = reduction.state !== before;
    if (reduction.state !== before) this.log.push(event);
    const violation = checkInvariants(this.state, this.log);
    if (violation !== null) throw new ScheduleFailure(violation, this.log);
  }

  /**
   * Whether the most recent `apply` changed logical state. `false` means the
   * event was absorbed — a duplicate delivery, a stale deadline, or a no-op —
   * which is exactly what idempotency measurements count.
   */
  get lastApplyChangedState(): boolean {
    return this.lastApplyChanged;
  }

  applyAll(events: readonly LifecycleEvent[]): void {
    for (const event of events) this.apply(event);
  }

  /** Rebuild state from the durable log alone, exactly like a restart. */
  crash(): void {
    this.state = initialLifecycleState(TURN);
    for (const event of this.log) {
      this.state = reduce(this.state, event).state;
    }
  }

  /** Commands recovery must re-dispatch after a restart at this point. */
  recoverable(): readonly PendingCommand["kind"][] {
    return recoverableCommands(this.state).map((pending) => pending.kind);
  }

  get phase(): LifecycleState["phase"] {
    return this.state.phase;
  }

  get currentState(): LifecycleState {
    return this.state;
  }

  get eventLog(): readonly LifecycleEvent[] {
    return this.log;
  }

  /** Deep-logical fingerprint used to prove restart convergence. */
  fingerprint(): string {
    const calls = this.state.toolCalls
      .map((call) => `${call.toolCallId}:${call.settlement === undefined ? "unsettled" : call.settlement.status}`)
      .sort()
      .join(",");
    return [
      this.state.phase,
      `gen=${this.state.contextGeneration}`,
      `obs=${this.state.observationsThrough}`,
      `attempts=${this.state.attempts.length}`,
      calls,
    ].join("|");
  }

  assertInvariants(): void {
    const violation = checkInvariants(this.state, this.log);
    if (violation !== null) throw new ScheduleFailure(violation, this.log);
  }
}

export class ScheduleFailure extends Error {
  constructor(
    readonly violation: InvariantViolation,
    readonly eventLog: readonly LifecycleEvent[],
  ) {
    super(`invariant ${violation.invariant} violated: ${violation.detail}`);
    this.name = "ScheduleFailure";
  }
}

export interface ScheduleOutcome {
  readonly finalPhase: LifecycleState["phase"];
  readonly eventLog: readonly LifecycleEvent[];
}

/**
 * Run a schedule to quiescence and require convergence: the turn must end
 * terminal, or be explicitly waiting on a named external reason. Anything
 * else is a stuck schedule and the failure carries the retained event log.
 */
export function requireConvergence(
  run: ScheduleRun,
  label: string,
): ScheduleOutcome {
  run.assertInvariants();
  const phase = run.phase;
  if (!isTerminalPhase(phase) && phase !== "ADMITTED") {
    // Explicit waiting (writer lease lost) is legal only with a reason and a
    // restoration path; every other non-terminal phase at quiescence means
    // the schedule stranded the turn.
    if (run.currentState.waitReason === "writer_lease_lost") {
      return { finalPhase: phase, eventLog: run.eventLog };
    }
    throw new Error(
      `${label}: schedule stranded the turn in ${phase} (pending=${run.currentState.pendingCommand?.kind ?? "none"}); event log: ${
        JSON.stringify(run.eventLog.map((event) => event.type))
      }`,
    );
  }
  return { finalPhase: phase, eventLog: run.eventLog };
}
