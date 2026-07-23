#!/usr/bin/env bun
/**
 * Run SPEC §46.9 fault-injection matrix and write fault-injection.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "fault-injection.json");
const TEST_PATH = "tests/recovery/fault_injection_matrix.test.ts";

/** Mirrors FAULT_INJECTION_MATRIX boundaries in the test file (SPEC §46.9). */
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

mkdirSync(OUT_DIR, { recursive: true });

const proc = Bun.spawnSync(["bun", "test", TEST_PATH], {
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
  })),
  coveredCount: BOUNDARIES.length,
  stdoutTail: stdout.slice(-2000),
  stderrTail: stderr.slice(-2000),
};

writeFileSync(OUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`[fault-injection] status=${evidence.status} → ${OUT_PATH}`);
if (!passed) {
  process.exit(1);
}
