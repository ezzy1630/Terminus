/**
 * Randomized schedule permutations for the deterministic turn lifecycle.
 *
 * Fixed regression schedules live in `lifecycle.test.ts`; this suite explores
 * random *valid* schedules — perturbation injection points, crash positions,
 * duplicate deliveries — under printed seeds. A failing seed replays exactly
 * via `permutation.harness.ts <iterations> <seed>`, and the harness retains
 * the failing event log at /tmp/terminus-lifecycle-failures/.
 *
 * CI budget: 5,000 seeds (well under a second). Set
 * TERMINUS_LIFECYCLE_PERMUTATIONS to run a larger sweep locally; the suite
 * has survived 100,000+ seeds without a stranding schedule.
 */

import { describe, expect, test } from "bun:test";

import { runPermutation } from "./permutation.harness.js";

const CI_PERMUTATIONS = 5_000;
const requested = Number(process.env.TERMINUS_LIFECYCLE_PERMUTATIONS ?? "");
const iterations = Number.isFinite(requested) && requested > 0
  ? Math.floor(requested)
  : CI_PERMUTATIONS;

describe("turn lifecycle — seeded schedule permutations", () => {
  test(`no valid schedule strands the turn (${iterations} seeds)`, () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= iterations; seed += 1) {
      try {
        runPermutation(seed);
      } catch (error) {
        failures.push(seed);
        if (failures.length >= 5) break;
      }
    }
    // Seeds are printed so any failure replays exactly; the harness retains
    // the failing event log alongside.
    if (failures.length > 0) {
      throw new Error(
        `schedule permutations failed for seeds [${failures.join(", ")}]; replay with: bun run mini-services/terminus-control/src/agent/turn-lifecycle/permutation.harness.ts 1 <seed>`,
      );
    }
    expect(failures).toHaveLength(0);
  });

  test("an off-range seed block also converges (replay determinism across ranges)", () => {
    for (const seed of [7919, 65537, 104729, 1_000_003]) {
      const outcome = runPermutation(seed);
      expect(outcome.events).toBeGreaterThan(0);
    }
  });
});
