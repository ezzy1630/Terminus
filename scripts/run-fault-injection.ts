#!/usr/bin/env bun
/**
 * Run SPEC §46.9 fault-injection matrix and write fault-injection.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "fault-injection.json");

/** Fixture-only boundaries in the in-memory matrix (SPEC §46.9). */
const BOUNDARIES = [
  "before_event_commit",
  "after_event_commit",
  "before_provider_send",
  "after_provider_send",
  "during_stream",
  "before_tool_authorization",
  "after_tool_authorization",
  "during_patch_application",
  "after_external_effect_starts",
  "during_artifact_ingestion",
  "during_checkpoint_replacement",
  "while_job_forks",
  "during_database_migration",
] as const;

const TEST_PATHS = [
  "tests/recovery/fault_injection_matrix.test.ts",
  "tests/recovery/repair_attempt_recovery.test.ts",
  "tests/recovery/checkpoint_publication_recovery.test.ts",
  "tests/recovery/completion_admission_recovery.test.ts",
  "tests/recovery/effect_recovery.test.ts",
  "tests/recovery/provider_attempt_identity.test.ts",
  "tests/recovery/provider_attempt_recovery.test.ts",
] as const;

const DB_BACKED_SCENARIOS = [
  {
    scenario: "repair_schedule_transaction",
    boundary: "before_event_commit",
    assertions: ["schedule intent and lifecycle event roll back together"],
  },
  {
    scenario: "repair_parent_child_replay",
    boundary: "after_event_commit",
    assertions: ["parent/child admission and lifecycle events are idempotent"],
  },
  {
    scenario: "repair_lease_fencing",
    boundary: "after_external_effect_starts",
    assertions: ["stale repair claim cannot settle after lease fencing"],
  },
  {
    scenario: "checkpoint_publication_replay",
    boundary: "during_checkpoint_replacement",
    assertions: ["prepared checkpoint publication and artifact linking are idempotent"],
  },
  {
    scenario: "checkpoint_terminal_publication",
    boundary: "during_checkpoint_replacement",
    assertions: ["checkpoint admission, terminal state, and publication events commit or roll back together"],
  },
  {
    scenario: "completion_record_admission_replay",
    boundary: "after_event_commit",
    assertions: ["an admitted completion intent replays without provider inference"],
  },
  {
    scenario: "effect_recovery_replay",
    boundary: "after_external_effect_starts",
    assertions: ["ambiguous effect recovery rolls back atomically and replays without duplicate evidence"],
  },
  {
    scenario: "provider_attempt_identity_replay",
    boundary: "before_provider_send",
    assertions: ["canonical request identity publishes atomically and duplicate provider idempotency keys are rejected"],
  },
  {
    scenario: "provider_attempt_recovery_replay",
    boundary: "after_provider_send",
    assertions: ["an in-flight provider attempt is interrupted and blocked atomically without a duplicate recovery event"],
  },
] as const;

mkdirSync(OUT_DIR, { recursive: true });

const proc = Bun.spawnSync(["bun", "test", ...TEST_PATHS], {
  cwd: ROOT,
  stdout: "pipe",
  stderr: "pipe",
});

const stdout = typeof proc.stdout === "string" ? proc.stdout : new TextDecoder().decode(proc.stdout);
const stderr = typeof proc.stderr === "string" ? proc.stderr : new TextDecoder().decode(proc.stderr);
const exitCode = proc.exitCode ?? 1;
const passed = exitCode === 0;

const evidence = {
  status: passed ? ("passed" as const) : ("failed" as const),
  generatedAt: new Date().toISOString(),
  exitCode,
  boundaries: BOUNDARIES.map((boundary) => ({
    boundary,
    status: "covered" as const,
    evidenceClass: "fixture_only" as const,
  })),
  coveredCount: BOUNDARIES.length,
  dbBackedScenarios: DB_BACKED_SCENARIOS,
  dbBackedCount: DB_BACKED_SCENARIOS.length,
  completeForRelease: false,
  stdoutTail: stdout.slice(-2000),
  stderrTail: stderr.slice(-2000),
};

writeFileSync(OUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`[fault-injection] status=${evidence.status} → ${OUT_PATH}`);
if (!passed) {
  process.exit(1);
}
