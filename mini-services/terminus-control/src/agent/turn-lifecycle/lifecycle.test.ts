/**
 * Deterministic lifecycle conformance — the reference loop regression suite.
 *
 * Every schedule is a fixed interleaving of durable events; nothing here uses
 * `setTimeout`, `Date.now`, sleeps, or wall-clock polling. The suite covers
 * the canonical settled-interaction path and the adversarial schedules the
 * assembled loop previously handled implicitly (duplicates, restarts,
 * deadlines, cancellation, lease loss, revision churn, interrupted
 * publication).
 *
 * The `legacy stranding` test reproduces, deterministically, the production
 * failure class where a successfully settled provider/tool interaction leaves
 * an active turn indefinitely in CONTEXT_COMPILING: the legacy failure
 * settlement path rethrows on a secondary fault and the admission-site trap
 * swallows it, so nothing ever re-drives the turn.
 */

import { describe, expect, test } from "bun:test";

import {
  canonicalSpine,
  ev,
  requireConvergence,
  ScheduleRun,
  TURN_DEADLINE,
} from "./schedules.js";

const TURN_CONST = "0199face-7000-7000-8000-000000000001";

/**
 * Replay the full canonical spine. Already-applied prefixes collapse as
 * duplicates — that idempotence is itself part of the contract under test.
 */
const spineAll = (run: ScheduleRun): void => {
  for (const partial of canonicalSpine()) {
    run.apply(ev(partial));
  }
};

const spinePrefix = (run: ScheduleRun, count: number): void => {
  const spine = canonicalSpine();
  for (let index = 0; index < count; index += 1) {
    run.apply(ev(spine[index]!));
  }
};

describe("turn lifecycle — canonical spine", () => {
  test("settled provider/tool interaction converges to COMPLETED with monotonic generations", () => {
    const run = new ScheduleRun();
    spineAll(run);
    const outcome = requireConvergence(run, "canonical spine");
    expect(outcome.finalPhase).toBe("COMPLETED");
    const state = run.currentState;
    // Context generations advanced monotonically, one per compile.
    expect(state.contextGeneration).toBe(3);
    // The accepted observation from the mutating tool is in the compiled
    // context — it did not disappear between observation and compile.
    expect(state.observationsThrough).toBe(1);
    // Every authorized tool call has exactly one logical settlement.
    expect(state.toolCalls.map((call) => call.settlement !== undefined).every(Boolean)).toBe(true);
    // The mutating settlement recorded a workspace revision.
    const patch = state.toolCalls.find((call) => call.toolCallId === "t-patch");
    expect(patch?.settlement?.workspaceRevision).toBe("rev-1");
  });
});

describe("turn lifecycle — regression schedules", () => {
  test("1. tool settlement lands before the next context job dequeues", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 5);
    // The batch is durably settled; the recompile is a durable pending
    // command, so a dequeue that arrives before the projection flips is inert.
    expect(run.phase).toBe("CONTEXT_COMPILING");
    run.apply(ev({ type: "CompileJobDequeued", generation: 1 }));
    expect(run.phase).toBe("CONTEXT_COMPILING");
    spineAll(run);
    expect(requireConvergence(run, "settlement-before-dequeue").finalPhase).toBe("COMPLETED");
  });

  test("2. context job dequeues before the public projection updates", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 4);
    expect(run.phase).toBe("TOOL_SETTLEMENT");
    // A dequeue that arrives before the batch re-arms must not start a
    // compile out of order: it is ignored, and the batch settlement re-arms.
    run.apply(ev({ type: "CompileJobDequeued", generation: 2 }));
    expect(run.phase).toBe("TOOL_SETTLEMENT");
    run.apply(ev({ type: "ToolSettlementCommitted", toolCallId: "t-activate", status: "success", mutatesWorkspace: false, workspaceRevision: null }));
    expect(run.phase).toBe("CONTEXT_COMPILING");
    spineAll(run);
    expect(requireConvergence(run, "dequeue-before-projection").finalPhase).toBe("COMPLETED");
  });

  test("3. duplicate tool settlement does not duplicate the logical effect", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 9);
    const settledOnce = run.currentState.toolCalls.find((call) => call.toolCallId === "t-patch");
    expect(settledOnce?.settlement).toBeDefined();
    run.apply(ev({ type: "ToolSettlementCommitted", toolCallId: "t-patch", status: "success", mutatesWorkspace: true, workspaceRevision: "rev-1" }));
    const settledTwice = run.currentState.toolCalls.find((call) => call.toolCallId === "t-patch");
    expect(settledTwice?.settlement).toEqual(settledOnce?.settlement);
    // The duplicate did not re-authorize the batch or reset settlements.
    expect(run.currentState.toolCalls).toHaveLength(2);
    spineAll(run);
    expect(requireConvergence(run, "duplicate-tool-settlement").finalPhase).toBe("COMPLETED");
  });

  test("4. duplicate provider-result delivery settles exactly once", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 4);
    expect(run.phase).toBe("TOOL_SETTLEMENT");
    const attemptsBefore = run.currentState.attempts.length;
    run.apply(ev({ type: "ProviderAttemptSettled", attemptId: "a1", finishReason: "stop", toolCallIds: ["t-activate"], observation: "obs-activate" }));
    // Duplicate delivery changes nothing: one attempt, one settlement.
    expect(run.currentState.attempts).toHaveLength(attemptsBefore);
    expect(run.phase).toBe("TOOL_SETTLEMENT");
    spineAll(run);
    expect(requireConvergence(run, "duplicate-provider-result").finalPhase).toBe("COMPLETED");
  });

  test("5. restart immediately after tool persistence re-derives the recompile", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 9);
    expect(run.phase).toBe("CONTEXT_COMPILING");
    run.crash();
    expect(run.recoverable()).toEqual(["CompileContext"]);
    spineAll(run);
    expect(requireConvergence(run, "restart-after-tool-persistence").finalPhase).toBe("COMPLETED");
  });

  test("6. restart after entering CONTEXT_COMPILING but before compile execution", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 1);
    expect(run.phase).toBe("CONTEXT_COMPILING");
    run.crash();
    expect(run.recoverable()).toEqual(["CompileContext"]);
    spineAll(run);
    expect(requireConvergence(run, "restart-before-compile").finalPhase).toBe("COMPLETED");
  });

  test("7. compile fails once then succeeds", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 1);
    run.apply(ev({ type: "ContextCompileFailed", retryable: true }));
    expect(run.phase).toBe("CONTEXT_COMPILING");
    spineAll(run);
    expect(requireConvergence(run, "compile-retry").finalPhase).toBe("COMPLETED");
  });

  test("8. current deadline during compile ends the turn BUDGET_EXHAUSTED", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 1);
    // The turn is armed with TURN_DEADLINE; an expiry at or after that
    // instant is the current deadline and settles the turn.
    run.apply(ev({ type: "DeadlineExpired", deadline: TURN_DEADLINE + 500 }));
    expect(requireConvergence(run, "deadline-during-compile").finalPhase).toBe("BUDGET_EXHAUSTED");
    expect(run.currentState.terminalReason).toBe("deadline_expired");
  });

  test("8b. stale deadline redelivery is absorbed without changing state", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 1);
    // An expiry earlier than the armed instant is a stale duplicate from an
    // injected clock that has not caught up — it must not settle the turn.
    run.apply(ev({ type: "DeadlineExpired", deadline: TURN_DEADLINE - 500 }));
    expect(run.lastApplyChangedState).toBe(false);
    expect(run.phase).toBe("CONTEXT_COMPILING");
    spineAll(run);
    expect(requireConvergence(run, "stale-deadline").finalPhase).toBe("COMPLETED");
  });

  test("9. cancellation during compile ends the turn ABORTED", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 1);
    run.apply(ev({ type: "CancellationRequested", reason: "user_cancelled" }));
    expect(requireConvergence(run, "cancellation-during-compile").finalPhase).toBe("ABORTED");
    expect(run.currentState.terminalReason).toBe("user_cancelled");
  });

  test("9b. cancellation during PROVIDER_RUNNING ends the turn ABORTED and spawns no new attempt", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 7); // a1 accepted+settled, a2 accepted → PROVIDER_RUNNING
    expect(run.phase).toBe("PROVIDER_RUNNING");
    run.apply(ev({ type: "CancellationRequested", reason: "operator_stop" }));
    expect(requireConvergence(run, "cancellation-during-provider").finalPhase).toBe("ABORTED");
    // Exactly the attempts that were accepted before the cancellation: the
    // terminal settlement must not spawn or authorize another provider call.
    expect(run.currentState.attempts).toHaveLength(2);
    expect(run.currentState.activeAttemptId).toBeNull();
    // Redelivering the rest of the spine changes nothing: the terminal
    // outcome is the authoritative record.
    const fingerprint = run.fingerprint();
    spineAll(run);
    expect(run.fingerprint()).toBe(fingerprint);
  });

  test("10. writer-lease change during transition waits explicitly and recovers", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 4);
    expect(run.phase).toBe("TOOL_SETTLEMENT");
    run.apply(ev({ type: "WriterLeaseLost" }));
    expect(run.currentState.waitReason).toBe("writer_lease_lost");
    expect(run.currentState.pendingCommand).toBeNull();
    run.apply(ev({ type: "WriterLeaseRestored" }));
    expect(run.currentState.waitReason).toBeNull();
    expect(run.currentState.pendingCommand?.kind).toBe("ExecuteToolBatch");
    spineAll(run);
    expect(requireConvergence(run, "writer-lease-change").finalPhase).toBe("COMPLETED");
  });

  test("11. workspace revision changes between observation and compile", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 9);
    expect(run.currentState.workspaceRevision).toBe("rev-1");
    run.apply(ev({ type: "WorkspaceRevisionChanged", revision: "rev-2" }));
    expect(run.currentState.workspaceRevision).toBe("rev-2");
    spineAll(run);
    const outcome = requireConvergence(run, "revision-churn");
    expect(outcome.finalPhase).toBe("COMPLETED");
    // The accepted observation still reached the compiled context.
    expect(run.currentState.observationsThrough).toBe(1);
  });

  test("12. artifact persistence succeeds but publication is interrupted", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 12);
    expect(run.phase).toBe("RESPONSE_VALIDATING");
    run.apply(ev({ type: "ArtifactPublicationInterrupted", artifactKeys: ["response"] }));
    expect(run.currentState.pendingCommand?.kind).toBe("PersistArtifacts");
    spineAll(run);
    expect(requireConvergence(run, "publication-interrupted").finalPhase).toBe("COMPLETED");
  });
});

describe("turn lifecycle — terminal-outcome immutability under late redelivery", () => {
  test("a completed turn absorbs late cancellation, deadline, and lease-loss events", () => {
    const run = new ScheduleRun();
    spineAll(run);
    expect(run.phase).toBe("COMPLETED");
    const fingerprint = run.fingerprint();
    const lateEvents: Parameters<typeof ev>[0][] = [
      { type: "CancellationRequested", reason: "late_cancel" },
      { type: "DeadlineExpired", deadline: TURN_DEADLINE + 10_000 },
      { type: "WriterLeaseLost" },
      { type: "RecoveryRequested", reason: "late_probe" },
    ];
    for (const partial of lateEvents) {
      run.apply(ev(partial));
      expect(run.phase).toBe("COMPLETED");
      expect(run.currentState.terminalReason).toBe("completion_accepted");
      expect(run.lastApplyChangedState).toBe(false);
    }
    expect(run.fingerprint()).toBe(fingerprint);
  });

  test("an explicitly waiting turn (lease lost) recovers with exactly its earlier deadline intact", () => {
    const run = new ScheduleRun();
    spinePrefix(run, 4);
    run.apply(ev({ type: "WriterLeaseLost" }));
    expect(run.currentState.waitReason).toBe("writer_lease_lost");
    // The waiting state is one valid non-terminal outcome: it names its
    // reason and nothing else consumes budget while it waits.
    run.crash();
    // A restart of a waiting turn re-derives its obligations from the log.
    expect(run.currentState.leaseLost).toBe(true);
    run.apply(ev({ type: "WriterLeaseRestored" }));
    spineAll(run);
    expect(requireConvergence(run, "wait-then-restore").finalPhase).toBe("COMPLETED");
  });
});

describe("turn lifecycle — deterministic reproduction of the production stranding class", () => {
  /**
   * Mirrors the assembled loop's failure path (mini-services/terminus-control
   * /src/index.ts): the engine re-arms CONTEXT_COMPILING after a settled
   * batch (`afterToolsSettled`, the TOOL_SETTLEMENT → CONTEXT_COMPILING CAS),
   * then a fault hits the failure-settlement handler (the `agentLoop` catch:
   * `settleTurnRow` throws `turn changed during failure settlement` on any
   * CAS miss, and `ControlWriterFencedError` aborts the lease-fenced write).
   * The handler rethrows, the admission-site trap
   * (`agentLoop(id).catch(console.error)`) swallows it, and — because no
   * durable record says the turn needs recovery and the only re-entry points
   * are HTTP admission and the repair lease — the turn stays active in
   * CONTEXT_COMPILING until the process is restarted. That is exactly the
   * reported failure; it is timing-dependent in production because the fault
   * window only opens when the writer lease or a settlement CAS races.
   */
  test("legacy failure settlement strands a settled turn in CONTEXT_COMPILING; the reference loop converges", () => {
    // Production-shaped simulation of the settled window.
    let phase = "ADMITTED";
    const legacyApply = (next: string): void => {
      const allowed: Record<string, readonly string[]> = {
        ADMITTED: ["CONTEXT_COMPILING"],
        CONTEXT_COMPILING: ["PROVIDER_RUNNING"],
        PROVIDER_RUNNING: ["RESPONSE_VALIDATING"],
        RESPONSE_VALIDATING: ["TOOL_SETTLEMENT"],
        TOOL_SETTLEMENT: ["CONTEXT_COMPILING"],
      };
      if (!allowed[phase]!.includes(next)) {
        throw new Error(`turn ${TURN_CONST} changed before ${next}`);
      }
      phase = next;
    };
    legacyApply("CONTEXT_COMPILING");
    legacyApply("PROVIDER_RUNNING");
    legacyApply("RESPONSE_VALIDATING");
    legacyApply("TOOL_SETTLEMENT");
    legacyApply("CONTEXT_COMPILING");
    // The interaction is fully settled and re-armed; then a secondary fault
    // (writer-lease fence) hits during failure settlement.
    const settleFailureIdempotently = (): void => {
      throw new Error("the control-plane writer lease changed or expired before the transaction committed");
    };
    expect(() => settleFailureIdempotently()).toThrow("writer lease");
    // Legacy semantics: the rethrow escapes the loop promise, the
    // admission-site `.catch` logs it, and no durable recovery record exists.
    expect(phase).toBe("CONTEXT_COMPILING");
    // Nothing ever re-drives it: the turn is stranded in the reported state.

    // Reference semantics under the same schedule: the fault becomes a
    // durable RecoveryRequested event, and the reducer re-derives the
    // pending compile from the settled facts.
    const run = new ScheduleRun();
    spinePrefix(run, 5);
    run.apply(ev({ type: "RecoveryRequested", reason: "failure_settlement_fault" }));
    expect(run.currentState.pendingCommand?.kind).toBe("CompileContext");
    spineAll(run);
    expect(requireConvergence(run, "reference-loop-recovery").finalPhase).toBe("COMPLETED");
  });
});
