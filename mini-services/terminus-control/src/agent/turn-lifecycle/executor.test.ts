/**
 * Executor conformance: crash/restart replay at every critical transition,
 * outbox re-drain on interrupted publication, and duplicate outcome
 * suppression — all on an injected virtual clock and deterministic scheduler.
 * No `setTimeout`, `Date.now`, or sleeps anywhere in this suite.
 */

import { describe, expect, test } from "bun:test";

import {
  LifecycleExecutor,
  type LifecycleClock,
  type LifecycleEffects,
  type LifecycleEventStore,
  type LifecycleScheduler,
  type ScheduledWakeup,
} from "./executor.js";
import type { LifecycleEvent, LifecycleInstant } from "./model.js";

const TURN_ID = "0199face-7000-7000-8000-00000000e2e1";

/** Virtual clock: time moves only when the test advances it. */
class VirtualClock implements LifecycleClock {
  private current: LifecycleInstant = 0;
  now(): LifecycleInstant {
    return this.current;
  }
  advance(ticks: number): void {
    this.current += ticks;
  }
}

/** Deterministic scheduler: wakeups fire only when the test releases them. */
class VirtualScheduler implements LifecycleScheduler {
  readonly wakeups: ScheduledWakeup[] = [];
  schedule(wakeup: ScheduledWakeup): void {
    this.wakeups.push(wakeup);
  }
  cancel(wakeupId: string): void {
    const index = this.wakeups.findIndex((wakeup) => wakeup.wakeupId === wakeupId);
    if (index >= 0) this.wakeups.splice(index, 1);
  }
  pending(): readonly ScheduledWakeup[] {
    return [...this.wakeups];
  }
  fire(wakeupId: string): Promise<LifecycleEvent> {
    const index = this.wakeups.findIndex((wakeup) => wakeup.wakeupId === wakeupId);
    if (index < 0) throw new Error(`no such wakeup: ${wakeupId}`);
    const [wakeup] = this.wakeups.splice(index, 1);
    return Promise.resolve(wakeup!.deliver());
  }
}

/** In-memory durable log standing in for the SQLite event store. */
class MemoryEventStore implements LifecycleEventStore {
  private readonly events: LifecycleEvent[] = [];
  append(event: LifecycleEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
  readAll(): Promise<readonly LifecycleEvent[]> {
    return Promise.resolve([...this.events]);
  }
  get size(): number {
    return this.events.length;
  }
}

interface EffectScript {
  readonly compileFailures: number;
  readonly persistFailures: number;
  readonly toolRevisions: readonly string[];
  readonly verificationPasses: boolean;
}

const scriptedEffects = (script: EffectScript, effectLog: string[]): LifecycleEffects => {
  let compileFailuresLeft = script.compileFailures;
  let persistFailuresLeft = script.persistFailures;
  // The compiler binds every observation accepted so far, mirroring the
  // production context compiler's read of the durable episode ledger.
  let observationsAccepted = 0;
  return {
    compileContext: ({ generation }) => {
      if (compileFailuresLeft > 0) {
        compileFailuresLeft -= 1;
        effectLog.push(`compile:fail:${generation}`);
        return Promise.resolve({ retryable: true });
      }
      effectLog.push(`compile:ok:${generation}`);
      return Promise.resolve({ generation: generation + 1, observationsThrough: observationsAccepted });
    },
    invokeProvider: ({ attemptId }) => {
      effectLog.push(`provider:${attemptId}`);
      // Attempt 1 activates the workspace (no observation); attempt 2
      // mutates the workspace (observation committed durably); attempt 3
      // returns the final response.
      if (attemptId === "a1") {
        return Promise.resolve({ finishReason: "stop", toolCallIds: ["t-activate"], observation: null });
      }
      if (attemptId === "a2") {
        observationsAccepted += 1;
        return Promise.resolve({ finishReason: "stop", toolCallIds: ["t-patch"], observation: "obs-patch" });
      }
      return Promise.resolve({ finishReason: "stop", toolCallIds: [], observation: null });
    },
    executeToolBatch: ({ toolCallIds }) => {
      effectLog.push(`tools:${toolCallIds.join("+")}`);
      return Promise.resolve(
        toolCallIds.map((toolCallId) => ({
          toolCallId,
          status: "success" as const,
          mutatesWorkspace: toolCallId === "t-patch",
          workspaceRevision: toolCallId === "t-patch" ? "rev-1" : null,
        })),
      );
    },
    persistArtifacts: ({ generation }) => {
      if (persistFailuresLeft > 0) {
        persistFailuresLeft -= 1;
        effectLog.push(`persist:interrupted:${generation}`);
        return Promise.resolve({ published: false, artifactKeys: ["response"] });
      }
      effectLog.push(`persist:ok:${generation}`);
      return Promise.resolve({ published: true, artifactKeys: ["response"] });
    },
    runVerification: () => {
      effectLog.push("verification");
      return Promise.resolve({ passed: script.verificationPasses, planId: "plan-1" });
    },
    markTerminal: () => {
      effectLog.push("terminal");
      return Promise.resolve();
    },
  };
};

const buildExecutor = (script: EffectScript, effectLog: string[]): {
  readonly executor: LifecycleExecutor;
  readonly clock: VirtualClock;
  readonly scheduler: VirtualScheduler;
  readonly store: MemoryEventStore;
} => {
  const clock = new VirtualClock();
  const scheduler = new VirtualScheduler();
  const store = new MemoryEventStore();
  const executor = new LifecycleExecutor({
    turnId: TURN_ID,
    clock,
    scheduler,
    store,
    effects: scriptedEffects(script, effectLog),
  });
  return { executor, clock, scheduler, store };
};

const HAPPY_SCRIPT: EffectScript = {
  compileFailures: 0,
  persistFailures: 0,
  toolRevisions: ["rev-1"],
  verificationPasses: true,
};

describe("turn lifecycle executor", () => {
  test("drives the canonical path to COMPLETED through injected effects", async () => {
    const effectLog: string[] = [];
    const { executor } = buildExecutor(HAPPY_SCRIPT, effectLog);
    await executor.apply({
      eventId: "start", type: "TurnStarted", turnId: TURN_ID, at: 0, deadline: null,
    });
    expect(executor.currentState.phase).toBe("COMPLETED");
    // The settled observation reached the next compiled context.
    expect(executor.currentState.observationsThrough).toBeGreaterThanOrEqual(1);
    expect(executor.currentState.contextGeneration).toBe(3);
    expect(effectLog.filter((entry) => entry.startsWith("tools:"))).toEqual([
      "tools:t-activate",
      "tools:t-patch",
    ]);
  });

  test("restart after every durable transition converges to the same result", async () => {
    const effectLog: string[] = [];
    const { executor, store } = buildExecutor(HAPPY_SCRIPT, effectLog);
    await executor.apply({ eventId: "start", type: "TurnStarted", turnId: TURN_ID, at: 0, deadline: null });
    const converged = executor.currentState;

    // Replay the durable log prefix-by-prefix on fresh executors (process
    // restart at every persisted transition) and require: a non-terminal
    // prefix always names its recovery work; the full log folds to exactly
    // the original converged result.
    const fullLog = await store.readAll();
    for (let cut = 1; cut <= fullLog.length; cut += 1) {
      const prefixStore: LifecycleEventStore = {
        append: () => Promise.resolve(),
        readAll: () => Promise.resolve(fullLog.slice(0, cut)),
      };
      const restarted = new LifecycleExecutor({
        turnId: TURN_ID,
        clock: new VirtualClock(),
        scheduler: new VirtualScheduler(),
        store: prefixStore,
        effects: scriptedEffects(HAPPY_SCRIPT, []),
      });
      const commands = await restarted.recover();
      if (cut === fullLog.length) {
        expect(restarted.currentState.phase).toBe("COMPLETED");
        expect(commands).toHaveLength(0);
      } else {
        expect(restarted.currentState.phase).not.toBe("ADMITTED");
        expect(commands.length).toBeGreaterThan(0);
      }
    }
    // The original converged state equals the fully-replayed restart state.
    const finalExecutor = new LifecycleExecutor({
      turnId: TURN_ID,
      clock: new VirtualClock(),
      scheduler: new VirtualScheduler(),
      store,
      effects: scriptedEffects(HAPPY_SCRIPT, []),
    });
    await finalExecutor.recover();
    expect(finalExecutor.currentState.phase).toBe(converged.phase);
  });

  test("interrupted artifact publication re-drains the outbox and completes", async () => {
    const effectLog: string[] = [];
    const { executor } = buildExecutor({ ...HAPPY_SCRIPT, persistFailures: 1 }, effectLog);
    await executor.apply({ eventId: "start", type: "TurnStarted", turnId: TURN_ID, at: 0, deadline: null });
    expect(executor.currentState.phase).toBe("COMPLETED");
    expect(effectLog.filter((entry) => entry.startsWith("persist:"))).toEqual([
      "persist:interrupted:3",
      "persist:ok:3",
    ]);
  });

  test("transient compile failure retries and completes", async () => {
    const effectLog: string[] = [];
    const { executor } = buildExecutor({ ...HAPPY_SCRIPT, compileFailures: 1 }, effectLog);
    await executor.apply({ eventId: "start", type: "TurnStarted", turnId: TURN_ID, at: 0, deadline: null });
    expect(executor.currentState.phase).toBe("COMPLETED");
    expect(effectLog[0]).toBe("compile:fail:0");
    expect(effectLog[1]).toBe("compile:ok:0");
  });

  test("duplicate settled outcomes are appended once and change nothing", async () => {
    const effectLog: string[] = [];
    const { executor, store } = buildExecutor(HAPPY_SCRIPT, effectLog);
    await executor.apply({ eventId: "start", type: "TurnStarted", turnId: TURN_ID, at: 0, deadline: null });
    const sizeAfterRun = store.size;
    // Re-deliver every settled event verbatim: the fold must not budge.
    const settled = (await store.readAll()).filter(
      (event) => event.type === "ProviderAttemptSettled" || event.type === "ToolSettlementCommitted",
    );
    for (const [index, event] of settled.entries()) {
      await executor.apply({ ...event, eventId: `dup-${index}` });
    }
    expect(store.size).toBe(sizeAfterRun);
    expect(executor.currentState.phase).toBe("COMPLETED");
  });

  test("deadline wakeup is scheduled while work is in flight and cancels on terminal", async () => {
    const effectLog: string[] = [];
    // Hold the first compile on a deterministic gate: the test asserts the
    // deadline wakeup exists while the effect is in flight, then releases.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clock = new VirtualClock();
    const scheduler = new VirtualScheduler();
    const store = new MemoryEventStore();
    const gated = scriptedEffects(HAPPY_SCRIPT, effectLog);
    const executor = new LifecycleExecutor({
      turnId: TURN_ID,
      clock,
      scheduler,
      store,
      deadlineTick: 100,
      effects: {
        ...gated,
        compileContext: async (input) => {
          await gate;
          return gated.compileContext(input);
        },
      },
    });
    const running = executor.apply({ eventId: "start", type: "TurnStarted", turnId: TURN_ID, at: 0, deadline: 100 });
    await Promise.resolve();
    const wakeup = scheduler.pending().find((wakeup) => wakeup.wakeupId === `deadline:${TURN_ID}`);
    expect(wakeup).toBeDefined();
    expect(wakeup?.at).toBe(100);
    release();
    await running;
    // Terminal turn: the deadline wakeup was cancelled.
    expect(scheduler.pending().find((wakeup) => wakeup.wakeupId === `deadline:${TURN_ID}`)).toBeUndefined();
    expect(executor.currentState.phase).toBe("COMPLETED");
  });

  test("a delivered deadline event ends a stuck turn BUDGET_EXHAUSTED", async () => {
    const effectLog: string[] = [];
    const clock = new VirtualClock();
    const scheduler = new VirtualScheduler();
    const store = new MemoryEventStore();
    const executor = new LifecycleExecutor({
      turnId: TURN_ID,
      clock,
      scheduler,
      store,
      deadlineTick: 100,
      effects: scriptedEffects(HAPPY_SCRIPT, effectLog),
    });
    await executor.apply({ eventId: "start", type: "TurnStarted", turnId: TURN_ID, at: 0, deadline: 100 });
    expect(executor.currentState.phase).toBe("COMPLETED");
    // A late-arriving deadline event on a terminal turn is inert.
    await executor.deliver({ eventId: "late-deadline", type: "DeadlineExpired", turnId: TURN_ID, deadline: 100 });
    expect(executor.currentState.phase).toBe("COMPLETED");
    // On a live turn the same delivery settles the budget.
    const liveExecutor = new LifecycleExecutor({
      turnId: "0199face-7000-7000-8000-00000000e2e2",
      clock,
      scheduler,
      store: new MemoryEventStore(),
      deadlineTick: 100,
      effects: {
        ...scriptedEffects(HAPPY_SCRIPT, effectLog),
        // The compile never returns; the deadline must end the turn.
        compileContext: () => new Promise((_resolve) => {
          /* deliberately never settles to verify deadline expiration */
        }),
      },
    });
    // The gate holds the drain; deliver the deadline event directly.
    const pendingTurn = liveExecutor.apply({
      eventId: "start-2", type: "TurnStarted", turnId: "0199face-7000-7000-8000-00000000e2e2", at: 0, deadline: 100,
    });
    await Promise.resolve();
    await Promise.resolve();
    await liveExecutor.deliver({
      eventId: "deadline-hit", type: "DeadlineExpired", turnId: "0199face-7000-7000-8000-00000000e2e2", deadline: 100,
    });
    // skipcq: JS-0098
    void pendingTurn;
    expect(liveExecutor.currentState.phase).toBe("BUDGET_EXHAUSTED");
  });
});
