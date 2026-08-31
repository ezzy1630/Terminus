#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[eval-runtime-smoke] ${message}`);
}

function object(value: unknown, label: string): JsonObject {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  return value;
}

function count(value: unknown, label: string): number {
  invariant(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
  return value;
}

function optionalCount(value: unknown): number {
  return value === undefined ? 0 : count(value, "optional event count");
}

function artifact(record: JsonObject, kind: string): JsonObject[] {
  return array(record.artifacts, "artifacts")
    .map((value, index) => object(value, `artifacts[${index}]`))
    .filter((value) => value.kind === kind);
}

async function main(): Promise<void> {
  const resultsDir = process.argv[2];
  invariant(resultsDir !== undefined, "usage: assert-runtime-eval-smoke.ts <results-dir>");
  const entries = (await readdir(resultsDir)).filter((entry) => /^run-.*\.json$/.test(entry));
  invariant(entries.length === 1, `expected one JSON run record, found ${entries.length}`);

  const recordPath = resolve(resultsDir, entries[0]!);
  const record = object(await Bun.file(recordPath).json(), "run record");
  const expectedProfile = process.env.TERMINUS_E2E_EXPECT_PROFILE === "adaptive"
    ? "adaptive"
    : "minimal";
  const expectedInspect = process.env.TERMINUS_E2E_EXPECT_INSPECT === "1";
  const expectedProviderAttempts = expectedProfile === "adaptive"
    ? expectedInspect ? 4 : 3
    : 4;
  const expectedToolSettlements = expectedProfile === "adaptive"
    ? expectedInspect ? 3 : 2
    : 3;
  invariant(record.harness === "terminus-live", "run did not use TerminusHarness");
  invariant(record.outcome === "completed", `run outcome was ${String(record.outcome)}`);
  invariant(record.success === true, "declared task grader did not pass");
  invariant(record.evidence_class === "fixture_only", "local provider evidence was overstated");

  const model = object(record.model_capability_snapshot, "model_capability_snapshot");
  invariant(model.model === "local/e2e-model", `unexpected model ${String(model.model)}`);
  invariant(
    text(model.provider, "model_capability_snapshot.provider").toLowerCase().includes("local"),
    `unexpected provider ${String(model.provider)}`,
  );

  invariant(
    /^sha256:[0-9a-f]{64}$/.test(text(record.environment_digest, "environment_digest")),
    "environment digest is not content-addressed",
  );
  invariant(
    /^[0-9a-f]{40}$/.test(text(record.workspace_base_commit, "workspace_base_commit")),
    "workspace baseline is not an immutable Git commit",
  );

  const graders = array(record.grader_results, "grader_results").map((value, index) =>
    object(value, `grader_results[${index}]`)
  );
  invariant(graders.length === 1, `expected one declared grader, found ${graders.length}`);
  invariant(graders[0]!.grader_id === "task:build-001", "fixture/no-op grader was used");
  invariant(graders[0]!.passed === true && graders[0]!.score === 1, "behavioral grader failed");

  const attempts = array(record.attempts, "attempts");
  invariant(
    attempts.length === expectedProviderAttempts,
    `${expectedProfile} profile expected ${expectedProviderAttempts} provider attempts, found ${attempts.length}`,
  );
  invariant(
    count(record.steps, "steps") === expectedToolSettlements,
    `${expectedProfile} profile expected ${expectedToolSettlements} model-facing tool steps`,
  );

  const patchArtifacts = artifact(record, "workspace_patch");
  invariant(
    patchArtifacts.some((entry) => typeof entry.diff_chars === "number" && entry.diff_chars > 0),
    "run record has no non-empty workspace patch",
  );

  const summaries = artifact(record, "control_event_summary");
  invariant(summaries.length === 1, "run record has no bounded control event summary");
  const summary = summaries[0]!;
  const eventCounts = object(summary.event_counts, "control_event_summary.event_counts");
  invariant(summary.source === "task_transcript", "event summary did not come from the task transcript");
  invariant(summary.source_available === true, "task transcript was unavailable");
  invariant(summary.truncated === false, "task transcript summary was truncated");
  invariant(summary.continuation_cursor === null, "complete transcript exposed a continuation cursor");
  invariant(summary.artifact_refs_available === false, "transcript overstated artifact-ref availability");
  invariant(
    count(eventCounts["tool.proposed"], "tool.proposed count") === expectedToolSettlements,
    "tool proposal count does not match the profile",
  );
  const expectedKernelOperations = expectedProfile === "adaptive"
    ? expectedInspect ? 3 : 2
    : 2;
  invariant(
    count(eventCounts["tool.authorized"], "tool.authorized count") >= expectedKernelOperations,
    "kernel authorizations are missing",
  );
  invariant(
    count(eventCounts["tool.started"], "tool.started count") >= expectedKernelOperations,
    "kernel starts are missing",
  );
  invariant(
    count(eventCounts["tool.settled"], "tool.settled count") === expectedToolSettlements,
    "tool settlement count does not match the profile",
  );
  invariant(
    count(summary.successful_tool_settlements, "successful_tool_settlements") === expectedToolSettlements,
    "successful tool settlements are missing",
  );
  invariant(
    optionalCount(eventCounts["capability.activated"]) === (expectedProfile === "adaptive" ? 0 : 1),
    `${expectedProfile} profile used the wrong workspace activation path`,
  );
  invariant(
    count(eventCounts["context.manifest_persisted"], "context.manifest_persisted count") >= 1,
    "context manifest persistence is missing",
  );
  const workspaces = artifact(record, "task_workspace");
  invariant(workspaces.length === 1, "materialized task workspace evidence is missing");
  const graderAssets = object(workspaces[0]!.grader_assets, "task_workspace.grader_assets");
  invariant(graderAssets.path_separated === true, "hidden grader assets were not path-separated");
  invariant(
    graderAssets.access_isolation_verified === false,
    "local path separation was incorrectly presented as verified isolation",
  );

  const notes = object(JSON.parse(text(record.notes, "notes")) as unknown, "notes");
  invariant(notes.mode === "runtime_fixture", `unexpected evidence mode ${String(notes.mode)}`);
  invariant(notes.evaluation === "graded", "declared grader execution was not recorded");
  array(record.context_manifests, "context_manifests");

  console.log(JSON.stringify({
    schema: "terminus.runtime-eval-smoke.v1",
    status: "passed",
    profile: expectedProfile,
    inspect: expectedInspect,
    run_id: text(record.run_id, "run_id"),
    evidence_class: record.evidence_class,
    provider_attempts: attempts.length,
    tool_settlements: eventCounts["tool.settled"],
    grader: graders[0]!.grader_id,
  }));
}

await main();
