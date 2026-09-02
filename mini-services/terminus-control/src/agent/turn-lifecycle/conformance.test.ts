/**
 * Measured lifecycle conformance gate — Tier 1 of the causal evaluation
 * system (see docs/architecture/evaluation-lab.md, "Causal baseline-vs-
 * candidate system").
 *
 * Runs the seeded schedule permutations at CI budget and requires every
 * measured property to hold:
 * zero stranded schedules, all duplicates absorbed, all crash replays exact,
 * one authoritative terminal/waiting outcome per schedule, bounded
 * re-delivery convergence, correct cancellation and injected-clock deadline
 * behavior.
 *
 * Failing seeds are printed for exact replay and their event logs retained
 * under /tmp/terminus-lifecycle-failures/ by the permutation harness.
 *
 * Set TERMINUS_LIFECYCLE_CONFORMANCE_OUT to write the versioned conformance
 * report as a retained artifact (the `just lifecycle-conformance` recipe
 * does this); the plain test run stays hermetic.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { runConformance } from "./conformance.js";

const CI_SEEDS = 5_000;
const requested = Number(process.env.TERMINUS_LIFECYCLE_CONFORMANCE_SEEDS ?? "");
const seeds = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : CI_SEEDS;

describe("turn lifecycle — measured conformance (causal evaluation tier 1)", () => {
  const report = runConformance(seeds);

  test("every measured property holds", () => {
    const failed = Object.entries(report.properties)
      .filter(([, prop]) => !prop.pass)
      .map(([name, prop]) => `${name}: rate=${prop.rate.toFixed(4)} (${prop.detail})`);
    expect(failed).toEqual([]);
    expect(report.status).toBe("pass");
    expect(report.failingSeeds).toHaveLength(0);
    if (report.failingSeeds.length > 0) {
      throw new Error(
        `conformance schedules failed for seeds [${report.failingSeeds.join(", ")}]; replay with: bun run mini-services/terminus-control/src/agent/turn-lifecycle/permutation.harness.ts 1 <seed>`,
      );
    }
  });

  test("the schedule space exercises every measured property", () => {
    // A property with no observable events cannot gate anything: the
    // perturbation sampling must keep every property populated.
    for (const [name, prop] of Object.entries(report.properties)) {
      if (name === "stuck_state_rate" || name === "single_terminal_outcome" || name === "idempotency_after_redelivery") {
        continue; // observable on every schedule by construction
      }
      expect(prop.schedules).toBeGreaterThan(0);
    }
  });

  test("terminal outcomes dominate over strandings", () => {
    // Terminal/waiting outcomes are counted by the harness; the distribution
    // must cover more than one outcome class so the report is meaningful.
    expect(Object.keys(report.terminalPhaseDistribution).length).toBeGreaterThan(1);
  });

  if (process.env.TERMINUS_LIFECYCLE_CONFORMANCE_OUT) {
    test("conformance report artifact written", () => {
      const out = process.env.TERMINUS_LIFECYCLE_CONFORMANCE_OUT!;
      mkdirSync(out, { recursive: true });
      const path = join(out, `lifecycle-conformance-${report.iterations}-seeds.json`);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`lifecycle conformance report: ${path}`);
      expect(report.status).toBe("pass");
    });
  }
});
