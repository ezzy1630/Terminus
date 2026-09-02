/**
 * Seeded permutation harness for the deterministic turn lifecycle.
 *
 * Explores random *valid* schedules over the canonical event alphabet:
 * permutation of injectable perturbations (duplicates, crashes, lease loss,
 * deadline pressure, revision churn) at random points of the canonical spine,
 * followed by full re-delivery until quiescence. Every schedule must end
 * terminal (or explicitly waiting on the writer lease) with every invariant
 * intact.
 *
 * A failing seed is printed and its retained event log is written to
 * `/tmp/terminus-lifecycle-failures/` for exact replay. This file also doubles
 * as a CLI: `bun run permutation.harness.ts <iterations> [seed]`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkInvariants } from "./invariants.js";
import {
  canonicalSpine,
  ev,
  makeRng,
  ScheduleFailure,
  ScheduleRun,
  TURN,
} from "./schedules.js";
import type { LifecycleEvent } from "./model.js";

interface Perturbation {
  readonly name: string;
  /** Events to inject when the schedule fires this perturbation. */
  readonly inject: (step: number) => readonly Omit<LifecycleEvent, "eventId" | "turnId">[];
  /** Safe only in these phases; the harness respects the filter. */
  readonly phases: readonly string[];
}

const PERTURBATIONS: readonly Perturbation[] = [
  {
    name: "duplicate_settlement",
    phases: ["TOOL_SETTLEMENT"],
    inject: () => [],
  },
  {
    name: "duplicate_provider_result",
    phases: ["TOOL_SETTLEMENT", "RESPONSE_VALIDATING", "VERIFYING"],
    inject: () => [],
  },
  {
    name: "lease_loss",
    phases: ["CONTEXT_COMPILING", "TOOL_SETTLEMENT", "RESPONSE_VALIDATING", "VERIFYING", "PROVIDER_RUNNING"],
    inject: () => [{ type: "WriterLeaseLost" }],
  },
  {
    name: "lease_restore",
    phases: ["CONTEXT_COMPILING", "TOOL_SETTLEMENT", "RESPONSE_VALIDATING", "VERIFYING", "PROVIDER_RUNNING"],
    inject: () => [{ type: "WriterLeaseLost" }, { type: "WriterLeaseRestored" }],
  },
  {
    name: "compile_failure_transient",
    phases: ["CONTEXT_COMPILING"],
    inject: () => [{ type: "ContextCompileFailed", retryable: true }],
  },
  {
    name: "revision_churn",
    phases: ["CONTEXT_COMPILING", "TOOL_SETTLEMENT"],
    inject: (step) => [{ type: "WorkspaceRevisionChanged", revision: `rev-${step}` }],
  },
  {
    name: "stale_dequeue",
    phases: ["CONTEXT_COMPILING", "TOOL_SETTLEMENT"],
    inject: () => [{ type: "CompileJobDequeued", generation: 1 }],
  },
  {
    name: "publication_interrupted",
    phases: ["RESPONSE_VALIDATING"],
    inject: () => [{ type: "ArtifactPublicationInterrupted", artifactKeys: ["response"] }],
  },
];

const FAILURE_DIR = "/tmp/terminus-lifecycle-failures";

interface PermutationOutcome {
  readonly seed: number;
  readonly scheduleName: string;
  readonly finalPhase: string;
  readonly events: number;
  readonly crashes: number;
}

function retentionPath(seed: number): string {
  return join(FAILURE_DIR, `schedule-${seed}.json`);
}

function retainFailure(seed: number, scheduleName: string, error: unknown, log: readonly LifecycleEvent[]): void {
  try {
    mkdirSync(FAILURE_DIR, { recursive: true });
    writeFileSync(
      retentionPath(seed),
      JSON.stringify(
        {
          seed,
          schedule: scheduleName,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          eventLog: log.map((event) => ({ type: event.type, eventId: event.eventId })),
        },
        null,
        2,
      ),
    );
  } catch {
    // Retention is best-effort; the printed seed already replays exactly.
  }
}

/**
 * Run one randomized schedule. The spine is applied in canonical order but
 * each step may inject perturbation events first; after the spine, full
 * re-delivery loops until the state stops changing (quiescence) — the model
 * equivalent of "the executor drains every durable outcome".
 */
export function runPermutation(seed: number): PermutationOutcome {
  const rng = makeRng(seed);
  const run = new ScheduleRun();
  const spine = canonicalSpine();
  let crashes = 0;
  let applied = 0;
  let scheduleName = "none";

  // Phase 1: spine with random perturbations and random crash points.
  for (let step = 0; step < spine.length; step += 1) {
    const phase = run.phase;
    const candidates = PERTURBATIONS.filter(
      (perturbation) => perturbation.phases.includes(phase) && rng() < 0.28,
    );
    for (const perturbation of candidates) {
      scheduleName = perturbation.name;
      if (perturbation.name === "duplicate_settlement") {
        // Re-deliver the last settlement event verbatim.
        const last = run.eventLog[run.eventLog.length - 1];
        if (last !== undefined && last.type === "ToolSettlementCommitted") {
          const duplicate: LifecycleEvent = { ...last, eventId: `dup-${seed}-${step}` };
          run.apply(duplicate);
          applied += 1;
        }
      } else if (perturbation.name === "duplicate_provider_result") {
        // Re-deliver the most recent provider result verbatim.
        const lastSettled = [...run.eventLog]
          .reverse()
          .find((event) => event.type === "ProviderAttemptSettled");
        if (lastSettled !== undefined) {
          const duplicate: LifecycleEvent = { ...lastSettled, eventId: `dup-${seed}-${step}` };
          run.apply(duplicate);
          applied += 1;
        }
      } else {
        for (const partial of perturbation.inject(step)) {
          run.apply(ev(partial));
          applied += 1;
        }
      }
    }
    if (rng() < 0.06) {
      // Crash: in-memory state is lost; the durable log must fold back to
      // exactly the same logical state, and recovery must name the next work.
      const beforeCrash = run.fingerprint();
      run.crash();
      if (run.fingerprint() !== beforeCrash) {
        const failure = new Error(`seed ${seed}: crash replay diverged at step ${step}`);
        retainFailure(seed, "crash_replay", failure, run.eventLog);
        throw failure;
      }
      crashes += 1;
    }
    run.apply(ev(spine[step]!));
    applied += 1;
  }

  // Phase 2: re-delivery until quiescence (bounded so a true livelock fails).
  let previousFingerprint = "";
  for (let round = 0; round < 32; round += 1) {
    for (const partial of canonicalSpine()) {
      run.apply(ev(partial));
      applied += 1;
    }
    run.apply(ev({ type: "RecoveryRequested", reason: "quiescence_probe" }));
    applied += 1;
    const fingerprint = run.fingerprint();
    if (fingerprint === previousFingerprint) break;
    previousFingerprint = fingerprint;
  }

  const violation = checkInvariants(run.currentState, run.eventLog);
  const terminalPhases = new Set([
    "COMPLETED", "FAILED", "BUDGET_EXHAUSTED", "POLICY_DENIED", "ABORTED",
    "INTERRUPTED", "BLOCKED", "USER_ACTION_REQUIRED",
  ]);
  const waitingExplicitly = run.currentState.waitReason === "writer_lease_lost";
  if (violation !== null || (!terminalPhases.has(run.phase) && !waitingExplicitly)) {
    const failure = violation
      ? new ScheduleFailure(violation, run.eventLog)
      : new Error(`seed ${seed}: stranded in ${run.phase}`);
    retainFailure(seed, scheduleName, failure, run.eventLog);
    throw failure;
  }
  return {
    seed,
    scheduleName,
    finalPhase: run.phase,
    events: applied,
    crashes,
  };
}

/** Batch runner with printed seeds; used by the unit test and the CLI. */
export function runPermutations(iterations: number, startSeed = 1): {
  readonly passed: number;
  readonly seeds: readonly number[];
} {
  const seeds: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const seed = startSeed + index;
    runPermutation(seed);
    seeds.push(seed);
  }
  return { passed: seeds.length, seeds };
}

const isDirectRun = process.argv[1] !== undefined && import.meta.path === process.argv[1];
if (isDirectRun) {
  const iterations = Number(process.argv[2] ?? "1000");
  const startSeed = Number(process.argv[3] ?? "1");
  const started = Date.now();
  const { passed } = runPermutations(iterations, startSeed);
  console.log(
    JSON.stringify({
      permutations: passed,
      startSeed,
      elapsedMs: Date.now() - started,
      status: "passed",
    }),
  );
}
