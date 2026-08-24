import { describe, expect, test } from "bun:test";
import type { ContentHash, Rfc3339Timestamp, Uuid7 } from "@terminus/domain";
import { buildHandoffBundle, formatHandoffBundle } from "./handoff.js";

const NOW = "2026-08-24T00:00:00Z" as Rfc3339Timestamp;
const TASK_ID = "00000000-0000-7000-8000-000000000021" as Uuid7;
const EVIDENCE_HASH = `sha256:${"a".repeat(64)}` as ContentHash;

function evidence(label: string) {
  return {
    kind: "artifact" as const,
    uri: `artifact://${label}`,
    hash: EVIDENCE_HASH,
    label,
  };
}

describe("reviewable handoff bundles", () => {
  test("preserves objective, acceptance, actions, files, questions, verification, and evidence", () => {
    const bundle = buildHandoffBundle({
      taskId: TASK_ID,
      objective: "Finish the context compiler contract",
      acceptance: [{
        id: "calibration",
        statement: "Provider usage is reconciled",
        status: "unverified",
        evidenceHandles: [evidence("usage-report")],
      }],
      completedActions: [{
        id: "inspect",
        description: "Inspected the existing interfaces",
        status: "completed",
        evidenceHandles: [evidence("inspection")],
      }],
      changedFiles: [{
        path: "packages/context-compiler/src/tokenizer.ts",
        change: "modified",
        revision: "working-tree",
        evidenceHandles: [evidence("diff")],
      }],
      openQuestions: ["Which provider binding will be installed?"],
      verificationState: {
        status: "in_progress",
        summary: "Focused tests remain to run",
        checks: [{
          id: "focused-tests",
          description: "Context compiler tests",
          status: "unverified",
          command: "bun test packages/context-compiler/src/*.test.ts",
          evidenceHandles: [evidence("test-command")],
        }],
      },
      evidenceHandles: [evidence("manifest")],
      sourceRevision: "working-tree",
      recommendedNextRole: "reviewer",
      createdAt: NOW,
    });

    expect(bundle.contentHash).toMatch(/^sha256:/);
    expect(bundle.acceptance).toEqual(bundle.acceptanceCriteria);
    expect(bundle.acceptance[0]?.status).toBe("unverified");
    expect(bundle.completedActions[0]?.description).toContain("existing interfaces");
    expect(bundle.changedFiles[0]?.path).toBe("packages/context-compiler/src/tokenizer.ts");
    expect(bundle.openQuestions).toEqual(["Which provider binding will be installed?"]);
    expect(bundle.verificationState.status).toBe("in_progress");
    expect(bundle.verificationState.checks[0]?.evidenceHandles[0]?.uri).toBe("artifact://test-command");

    const review = formatHandoffBundle(bundle);
    expect(review).toContain("[unverified] calibration");
    expect(review).toContain("Which provider binding will be installed?");
    expect(review).toContain("artifact://test-command");
  });

  test("is deterministic and rejects duplicate identity records", () => {
    const input = {
      objective: "Review this handoff",
      acceptanceCriteria: [],
      completedActions: [],
      changedFiles: [],
      openQuestions: [],
      verificationState: { status: "unverified" as const, summary: null, checks: [] },
      evidenceHandles: [],
      createdAt: NOW,
    };
    expect(buildHandoffBundle(input).contentHash).toBe(buildHandoffBundle(input).contentHash);
    expect(() => buildHandoffBundle({
      ...input,
      completedActions: [
        { id: "same", description: "one", status: "completed", evidenceHandles: [] },
        { id: "same", description: "two", status: "failed", evidenceHandles: [] },
      ],
    })).toThrow("duplicated");
  });
});
