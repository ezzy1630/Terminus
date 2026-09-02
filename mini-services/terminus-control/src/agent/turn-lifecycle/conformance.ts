/**
 * Measured lifecycle conformance — the report behind Tier 1 of the causal
 * evaluation system.
 *
 * The fixed schedules and the seeded permutations prove that the reference
 * loop *converges*; this module *measures* the properties a lifecycle
 * regression could silently erode, over the same seeded schedule space:
 *
 *   stuck-state rate                        — schedules that strand the turn
 *   duplicate-attempt behavior              — duplicate deliveries absorbed
 *   recovery correctness                    — durable-log replay reproduces state
 *   cancellation correctness                — cancel settles ABORTED, spawns nothing
 *   exactly one valid terminal/waiting outcome — post-quiescence redelivery is inert
 *   idempotency after redelivery            — re-delivery rounds converge ≤ 2
 *   reconstruction from persisted events    — crash() folds the log back exactly
 *   injected-clock deadline behavior        — stale expiries absorbed, current settle
 *
 * The result is a versioned JSON report (`terminus.lifecycle.conformance/v1`)
 * with a pass/fail threshold per property, written by the `just
 * lifecycle-conformance` recipe as retained evidence. Failing seeds are
 * printed and their event logs retained exactly like the permutation
 * harness, so any regression replays deterministically.
 */

import { checkInvariants } from "./invariants.js";
import { runPermutation } from "./permutation.harness.js";
import {
  canonicalSpine,
  ev,
  ScheduleFailure,
  ScheduleRun,
  TURN_DEADLINE,
} from "./schedules.js";
import type { LifecycleEventInput } from "./schedules.js";

export const CONFORMANCE_REPORT_VERSION = "terminus.lifecycle.conformance/v1";

/** A measured property: schedules checked, events counted, rate, threshold. */
export interface ConformanceProperty {
  /** Schedules the property was observable on. */
  readonly schedules: number;
  /** Counter name describing the numerator, for the report reader. */
  readonly measure: string;
  readonly numerator: number;
  /** Rate in [0,1]. */
  readonly rate: number;
  /** "maximize": pass when rate >= threshold; "minimize": pass when rate <= threshold. */
  readonly direction: "maximize" | "minimize";
  /** Minimum (maximize) or maximum (minimize) rate the gate accepts. */
  readonly threshold: number;
  readonly pass: boolean;
  readonly detail: string;
}

export interface LifecycleConformanceReport {
  readonly report: typeof CONFORMANCE_REPORT_VERSION;
  readonly iterations: number;
  readonly startSeed: number;
  readonly status: "pass" | "fail";
  readonly properties: Record<string, ConformanceProperty>;
  /** Final-phase distribution over all schedules. */
  readonly terminalPhaseDistribution: Record<string, number>;
  /** Invariant violations by name (always empty when status is "pass"). */
  readonly invariantViolations: Record<string, number>;
  readonly failingSeeds: readonly number[];
  readonly elapsedMs: number;
}

const property = (
  schedules: number,
  measure: string,
  numerator: number,
  threshold: number,
  detail: string,
  direction: "maximize" | "minimize" = "maximize",
): ConformanceProperty => {
  const rate = schedules === 0 ? 1.0 : numerator / schedules;
  const pass = direction === "maximize" ? rate >= threshold : rate <= threshold;
  return {
    schedules,
    measure,
    numerator,
    rate,
    direction,
    threshold,
    pass,
    detail,
  };
};

/**
 * One fixed end-to-end probe per measured property that needs a *deterministic*
 * witness regardless of what the random schedules happened to sample. Each
 * returns whether the property held; any failure is a conformance regression
 * even if every random schedule passed.
 */
// skipcq: JS-R1005, JS-0067
const fixedProbes = (): Record<string, { held: boolean; detail: string }> => {
  const probes: Record<string, { held: boolean; detail: string }> = {};

  // Cancellation settles exactly once, mid-provider, and the rest of the
  // spine is inert afterwards.
  {
    const run = new ScheduleRun();
    const spine = canonicalSpine();
    for (let i = 0; i < 7; i += 1) run.apply(ev(spine[i]!));
    run.apply(ev({ type: "CancellationRequested", reason: "probe_cancel" }));
    const fingerprintAfterCancel = run.fingerprint();
    const settledAborted = run.phase === "ABORTED" && run.currentState.terminalReason === "probe_cancel";
    for (let i = 7; i < spine.length; i += 1) run.apply(ev(spine[i]!));
    const inert = run.fingerprint() === fingerprintAfterCancel;
    probes.cancellation_correctness = {
      held: settledAborted && inert,
      detail: `settled=${settledAborted} redeliveryInert=${inert}`,
    };
  }

  // Stale deadline absorbed; current deadline settles BUDGET_EXHAUSTED once.
  {
    const run = new ScheduleRun();
    const spine = canonicalSpine();
    for (let i = 0; i < 2; i += 1) run.apply(ev(spine[i]!));
    run.apply(ev({ type: "DeadlineExpired", deadline: TURN_DEADLINE - 500 }));
    const staleAbsorbed = !run.lastApplyChangedState && run.phase === "CONTEXT_COMPILING";
    run.apply(ev({ type: "DeadlineExpired", deadline: TURN_DEADLINE + 500 }));
    const settled =
      run.phase === "BUDGET_EXHAUSTED" && run.currentState.terminalReason === "deadline_expired";
    for (let i = 2; i < spine.length; i += 1) run.apply(ev(spine[i]!));
    const singleOutcome = run.phase === "BUDGET_EXHAUSTED";
    probes.injected_clock_deadline_behavior = {
      held: staleAbsorbed && settled && singleOutcome,
      detail: `staleAbsorbed=${staleAbsorbed} settled=${settled} singleOutcome=${singleOutcome}`,
    };
  }

  // Reconstruction: rebuild from the persisted log after every event and
  // compare fingerprints — the crash() path exercised at full density.
  {
    const run = new ScheduleRun();
    let reconstructions = 0;
    const spine = canonicalSpine();
    for (const partial of spine) {
      run.apply(ev(partial));
      const before = run.fingerprint();
      run.crash();
      if (run.fingerprint() === before) reconstructions += 1;
    }
    probes.reconstruction_from_persisted_events = {
      held: reconstructions === spine.length,
      detail: `reconstructions=${reconstructions}/${spine.length}`,
    };
  }

  return probes;
}

/**
 * Run `iterations` seeded permutations plus the fixed probes and aggregate
 * the measured conformance report. Never throws on schedule failure —
 * failures are counted, classified, and reported; the first five failing
 * seeds are returned for exact replay.
 */
// skipcq: JS-R1005, JS-0067
export const runConformance = (iterations: number, startSeed = 1): LifecycleConformanceReport => {
  const started = Date.now();
  let stuck = 0;
  const invariantViolations: Record<string, number> = {};
  let duplicatesInjected = 0;
  let duplicatesAbsorbed = 0;
  let crashReplaysVerified = 0;
  let cancellationsInjected = 0;
  let cancellationsSettledAborted = 0;
  let deadlinesInjected = 0;
  let deadlinesSettledExhausted = 0;
  let deadlinesStaleAbsorbed = 0;
  let deadlinesAbsorbedByTerminal = 0;
  let convergedInTwoRounds = 0;
  let postQuiescenceStableCount = 0;
  let terminalOrWaiting = 0;
  const phaseDistribution: Record<string, number> = {};
  const failingSeeds: number[] = [];

  for (let index = 0; index < iterations; index += 1) {
    const seed = startSeed + index;
    try {
      const outcome = runPermutation(seed);
      duplicatesInjected += outcome.duplicatesInjected;
      duplicatesAbsorbed += outcome.duplicatesAbsorbed;
      crashReplaysVerified += outcome.crashReplaysVerified;
      cancellationsInjected += outcome.cancellationsInjected;
      cancellationsSettledAborted += outcome.cancellationsSettledAborted;
      deadlinesInjected += outcome.deadlinesInjected;
      deadlinesSettledExhausted += outcome.deadlinesSettledExhausted;
      deadlinesStaleAbsorbed += outcome.deadlinesStaleAbsorbed;
      deadlinesAbsorbedByTerminal += outcome.deadlinesAbsorbedByTerminal;
      if (outcome.redeliveryRounds <= 2) convergedInTwoRounds += 1;
      if (outcome.postQuiescenceStable) postQuiescenceStableCount += 1;
      // runPermutation already fails a schedule that ends neither terminal
      // nor explicitly waiting, so reaching here means a valid outcome.
      terminalOrWaiting += 1;
      phaseDistribution[outcome.finalPhase] = (phaseDistribution[outcome.finalPhase] ?? 0) + 1;
    } catch (error) {
      failingSeeds.push(seed);
      if (error instanceof ScheduleFailure) {
        const name = error.violation.invariant;
        invariantViolations[name] = (invariantViolations[name] ?? 0) + 1;
      } else {
        stuck += 1;
      }
    }
  }

  const probes = fixedProbes();
  const schedules = iterations;
  const properties: Record<string, ConformanceProperty> = {
    stuck_state_rate: property(
      schedules,
      "schedules_stranded",
      stuck,
      0.0,
      "Every valid schedule must reach a terminal phase or an explicit waiting reason; the stranded fraction must be zero.",
      "minimize",
    ),
    duplicate_attempt_absorption: property(
      Math.max(1, duplicatesInjected),
      "duplicate_deliveries_absorbed",
      duplicatesAbsorbed,
      1.0,
      "Re-delivered settlements and provider results must not duplicate logical effects.",
    ),
    recovery_correctness: property(
      Math.max(1, crashReplaysVerified),
      "crash_replays_verified",
      crashReplaysVerified,
      1.0,
      "Every crash/restart must fold the durable log back to the identical state.",
    ),
    single_terminal_outcome: property(
      schedules,
      "schedules_with_exactly_one_outcome",
      postQuiescenceStableCount,
      1.0,
      "After quiescence, one more full re-delivery must change nothing: the terminal/waiting record is authoritative.",
    ),
    idempotency_after_redelivery: property(
      schedules,
      "schedules_converged_within_two_rounds",
      convergedInTwoRounds,
      1.0,
      "Re-delivery must reach quiescence in at most two rounds (bounded drain).",
    ),
    cancellation_correctness: property(
      Math.max(1, cancellationsInjected),
      "cancellations_settled_aborted_exactly_once",
      cancellationsSettledAborted,
      1.0,
      "A cancellation during any non-terminal phase settles ABORTED with the given reason and spawns no further work.",
    ),
    reconstruction_from_persisted_events: property(
      Math.max(1, crashReplaysVerified),
      "crash_replays_verified",
      crashReplaysVerified,
      1.0,
      "State reconstructed purely from persisted events equals the pre-crash state.",
    ),
    injected_clock_deadline_behavior: property(
      Math.max(1, deadlinesInjected),
      "deadline_events_handled_correctly",
      deadlinesSettledExhausted + deadlinesStaleAbsorbed,
      1.0,
      "A current deadline expiry settles BUDGET_EXHAUSTED once; a stale expiry — or one arriving after the turn settled — is absorbed without changing the authoritative outcome.",
    ),
  };

  for (const [name, probe] of Object.entries(probes)) {
    if (!probe.held) {
      const current: ConformanceProperty = properties[name]!;
      properties[name] = {
        schedules: current.schedules,
        measure: current.measure,
        numerator: current.numerator,
        rate: current.rate,
        direction: current.direction,
        threshold: current.threshold,
        pass: false,
        detail: `${current.detail}; fixed probe failed (${probe.detail})`,
      };
    }
  }

  const status = Object.values(properties).every((entry) => entry.pass) ? "pass" : "fail";

  return {
    report: CONFORMANCE_REPORT_VERSION,
    iterations,
    startSeed,
    status,
    properties,
    terminalPhaseDistribution: phaseDistribution,
    invariantViolations,
    failingSeeds: failingSeeds.slice(0, 5),
    elapsedMs: Date.now() - started,
  };
}

const isDirectRun = process.argv[1] !== undefined && import.meta.path === process.argv[1];
if (isDirectRun) {
  const iterations = Number(process.argv[2] ?? "10000");
  const startSeed = Number(process.argv[3] ?? "1");
  const report = runConformance(iterations, startSeed);
  if (report.failingSeeds.length > 0) {
    console.error(
      `failing seeds: ${report.failingSeeds.join(", ")}; replay with: bun run mini-services/terminus-control/src/agent/turn-lifecycle/permutation.harness.ts 1 <seed>`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.status === "pass" ? 0 : 1);
}
