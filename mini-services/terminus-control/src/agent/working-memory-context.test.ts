import { describe, expect, test } from "bun:test";
import type {
  ContentHash,
  Micros,
  PrincipalId,
  Rfc3339Timestamp,
  Task,
  Uuid7,
} from "@terminus/domain";
import type {
  WorkingMemoryBlocker,
  WorkingMemoryCriterion,
  WorkingMemoryDecision,
  WorkingMemoryFailedApproach,
  WorkingMemoryFileChange,
  WorkingMemoryJobRef,
} from "@terminus/memory";
import type { CheckpointContent } from "@terminus/context-compiler";
import {
  MAX_WORKING_MEMORY_SECTION_CHARS,
  buildWorkingMemoryContextSection,
  renderCheckpointSummary,
} from "./working-memory-context.js";

const NOW = "2026-08-30T12:00:00.000Z" as Rfc3339Timestamp;
const TASK_ID = "0199423d-9da7-7c12-bc28-f224ee1b9870" as Uuid7;

function task(): Task {
  return {
    id: TASK_ID,
    sessionId: "0199423d-9da7-7c12-bc28-f224ee1b9871" as Uuid7,
    threadId: "0199423d-9da7-7c12-bc28-f224ee1b9872" as Uuid7,
    contract: {
      id: TASK_ID,
      version: 3,
      objective: "Preserve the actual task state across provider attempts and turns.",
      userOutcome: null,
      nonGoals: [],
      acceptanceCriteria: [
        {
          id: "criterion-b",
          statement: "Second criterion",
          verificationHint: null,
          required: false,
        },
        {
          id: "criterion-a",
          statement: "First criterion",
          verificationHint: null,
          required: true,
        },
      ],
      constraints: [],
      assumptions: [],
      unknowns: [],
      allowedScope: { readPaths: ["**"], writePaths: ["**"], externalSystems: [] },
      riskClass: "normal",
      budget: {
        modelMicros: 10_000n as Micros,
        computeSeconds: 600,
        wallClockSeconds: 3_600,
        humanApprovals: 2,
      },
      changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    },
    status: "ACTIVE",
    phase: "IMPLEMENT",
    scopeLedgerId: null,
    verificationPlanId: null,
    createdAt: NOW,
    completedAt: null,
  };
}

function criterion(
  id: string,
  status: WorkingMemoryCriterion["status"],
): WorkingMemoryCriterion {
  return {
    id,
    statement: `${id} observed statement`,
    required: id === "criterion-a",
    status,
    lastObservedAt: NOW,
    evidence: ["artifact://sha256/" + "a".repeat(64)],
  };
}

describe("working-memory context", () => {
  test("projects deterministic state through WorkingMemoryService in contract order", async () => {
    const section = await buildWorkingMemoryContextSection({
      task: task(),
      capturedAt: NOW,
      criterionStatuses: new Map([
        ["criterion-a", criterion("criterion-a", "PASS")],
        ["criterion-b", criterion("criterion-b", "FAIL")],
      ]),
      decisions: [{
        id: "0199423d-9da7-7c12-bc28-f224ee1b9880" as Uuid7,
        kind: "user_decision",
        summary: "Keep durable semantic memory disabled.",
        decidedAt: NOW,
        decidedBy: "user" as PrincipalId,
      }],
      failedApproaches: [],
      modifiedFiles: [],
      diagnosticState: { failingTests: [], errors: [], warnings: [], observedAt: NOW },
      runningJobs: [],
      budgetConsumption: {
        modelMicros: 1_250n as Micros,
        modelMicrosLimit: 10_000n as Micros,
        computeSeconds: 8,
        computeSecondsLimit: 600,
        wallClockSeconds: 20,
        wallClockSecondsLimit: 3_600,
        humanApprovals: 0,
        humanApprovalsLimit: 2,
      },
      blockers: [],
      sourceVersions: {
        "working-memory://decisions": "sha256:decisions",
        "task://active": "sha256:task",
      },
    });

    expect(section.schema_version).toBe("terminus.working-memory.v1");
    expect(section.acceptance_criteria.map((entry) => [entry.id, entry.status])).toEqual([
      ["criterion-b", "FAIL"],
      ["criterion-a", "PASS"],
    ]);
    expect(section.budget_consumption.model_micros).toBe("1250");
    expect(section.source_versions.map((entry) => entry.uri)).toEqual([
      "task://active",
      "working-memory://decisions",
    ]);
  });

  test("bounds every collection and reports omitted deterministic state", async () => {
    const decisions: WorkingMemoryDecision[] = [];
    const failedApproaches: WorkingMemoryFailedApproach[] = [];
    const modifiedFiles: WorkingMemoryFileChange[] = [];
    const runningJobs: WorkingMemoryJobRef[] = [];
    const blockers: WorkingMemoryBlocker[] = [];
    for (let index = 0; index < 100; index += 1) {
      const id = `0199423d-9da7-7c12-bc28-${String(index).padStart(12, "0")}` as Uuid7;
      decisions.push({
        id,
        kind: "model_decision",
        summary: `decision ${index} ${"x".repeat(2_000)}`,
        decidedAt: NOW,
        decidedBy: null,
      });
      failedApproaches.push({
        id,
        summary: `failed ${index} ${"x".repeat(2_000)}`,
        reason: `reason ${index} ${"x".repeat(2_000)}`,
        attemptedAt: NOW,
        evidenceRefs: [("sha256:" + "b".repeat(64)) as ContentHash],
      });
      modifiedFiles.push({
        path: `packages/${index}/${"p".repeat(2_000)}.ts`,
        changeKind: "modified",
        sourceVersion: "sha256:" + "c".repeat(64),
        observedAt: NOW,
      });
      runningJobs.push({ jobId: id, label: `job ${index} ${"x".repeat(2_000)}`, startedAt: NOW });
      blockers.push({ id, kind: "other", summary: `blocker ${index} ${"x".repeat(2_000)}`, raisedAt: NOW });
    }

    const section = await buildWorkingMemoryContextSection({
      task: task(),
      capturedAt: NOW,
      criterionStatuses: new Map(),
      decisions,
      failedApproaches,
      modifiedFiles,
      diagnosticState: {
        failingTests: Array.from({ length: 100 }, (_, index) => `test ${index} ${"x".repeat(2_000)}`),
        errors: [],
        warnings: [],
        observedAt: NOW,
      },
      runningJobs,
      budgetConsumption: {
        modelMicros: 0n as Micros,
        modelMicrosLimit: 10_000n as Micros,
        computeSeconds: 0,
        computeSecondsLimit: 600,
        wallClockSeconds: 0,
        wallClockSecondsLimit: 3_600,
        humanApprovals: 0,
        humanApprovalsLimit: 2,
      },
      blockers,
      sourceVersions: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`source://${index}/${"x".repeat(2_000)}`, `v${index}`]),
      ),
    });

    expect(JSON.stringify(section).length).toBeLessThanOrEqual(MAX_WORKING_MEMORY_SECTION_CHARS);
    expect(section.truncation?.omitted.decisions).toBeGreaterThan(0);
    expect(section.truncation?.omitted.modified_files).toBeGreaterThan(0);
    expect(section.truncation?.omitted.source_versions).toBeGreaterThan(0);
  });
});

describe("checkpoint context", () => {
  test("renders validated checkpoint facts instead of a generic success sentence", () => {
    const content: CheckpointContent = {
      objective: "Continue the memory integration",
      completedSteps: [{ description: "Added exact session recall", evidenceArtifactHashes: [] }],
      pendingSteps: ["Inject deterministic working memory"],
      requirements: [{
        id: "working-memory",
        statement: "Working memory is live",
        status: "unverified",
        evidence: [],
      }],
      assumptions: [],
      unknowns: ["runtime smoke result"],
      decisions: [{
        decision: "Keep semantic memory disabled",
        rationale: "The precision and harm gate has not passed",
        alternatives: ["Enable unverified semantic recall"],
      }],
      failures: [{ description: "The broad check has a pre-existing lint failure", artifactHash: null, resolved: false }],
      openQuestions: ["Can the packaged runtime reach the provider?"],
      sourceVersions: { "task://active": "sha256:task" },
      scope: { readPaths: ["**"], writePaths: ["mini-services/**"], externalSystems: [] },
    };

    const summary = renderCheckpointSummary(content);
    expect(summary).toContain("Added exact session recall");
    expect(summary).toContain("Inject deterministic working memory");
    expect(summary).toContain("Keep semantic memory disabled");
    expect(summary).toContain("pre-existing lint failure");
    expect(summary).not.toContain("validated from its immutable canonical artifact");
    expect(summary.length).toBeLessThanOrEqual(8_000);
  });
});
