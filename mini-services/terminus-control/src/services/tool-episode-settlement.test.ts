import { describe, expect, test } from "bun:test";
import {
  observedSourceVersionsOf,
  toolArgumentsExcerpt,
  TOOL_ARGUMENTS_EXCERPT_MAX_CHARS,
  type StandaloneToolSettlementInput,
} from "./tool-episode-settlement.js";
import type { ToolResult } from "@terminus/aci";

const result = (overrides: Partial<ToolResult<unknown>>): ToolResult<unknown> => ({
  ok: true,
  status: "success",
  summary: "done",
  data: {},
  ...overrides,
} as ToolResult<unknown>);

describe("tool episode settlement core", () => {
  test("observed source versions keep only bounded, clean sha256 observations", () => {
    const settled = observedSourceVersionsOf(result({
      status: "success",
      sourceVersions: {
        "src/a.ts": "sha256:" + "a".repeat(64),
        "": "sha256:" + "b".repeat(64), // empty path dropped
        [("x".repeat(4_100))]: "sha256:" + "c".repeat(64), // oversized path dropped
        "src/b.ts": "not-a-hash", // malformed hash dropped
        "src/c.ts": "sha256:" + "z".repeat(64), // non-hex dropped
      },
    }));
    expect(Object.keys(settled)).toEqual(["src/a.ts"]);

    // A failed result proves no observation: it contributes nothing.
    expect(observedSourceVersionsOf(result({ status: "error" }))).toEqual({});
  });

  test("argument excerpts carry operands, never contents, and stay bounded", () => {
    expect(toolArgumentsExcerpt({
      providerCallId: "pc1",
      toolId: "read",
      toolVersion: null,
      arguments: { path: "src/a.ts" },
    } as never)).toBe("src/a.ts");
    // patch reports only the path: its arguments hold whole file bodies.
    expect(toolArgumentsExcerpt({
      providerCallId: "pc1",
      toolId: "patch",
      toolVersion: null,
      arguments: { path: "src/b.ts", edits: [{ old: "x".repeat(10_000), new: "y" }] },
    } as never)).toBe("src/b.ts");
    const long = "x".repeat(TOOL_ARGUMENTS_EXCERPT_MAX_CHARS + 50);
    const excerpt = toolArgumentsExcerpt({
      providerCallId: "pc1",
      toolId: "grep",
      toolVersion: null,
      arguments: { pattern: long, path: "." },
    } as never);
    expect(excerpt.length).toBe(TOOL_ARGUMENTS_EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("the settlement input contract keeps artifact, capability, and revision hooks explicit", () => {
    // The type is structural; assert the documented required fields exist by
    // constructing a minimal value.
    const minimal: StandaloneToolSettlementInput = {
      callChunk: { toolCallId: "c1", toolName: "read", arguments: {} } as never,
      providerAttemptId: "a1",
      turnId: "t1",
      threadId: "th1",
      turnSequence: 1,
      taskId: "task1",
      sessionId: "s1",
      workspaceId: "w1",
      contractVersion: 1,
      contractHash: "sha256:" + "0".repeat(64),
      artifactClient: {} as never,
      observedSources: {} as never,
      capabilitySession: {} as never,
      nextWorkspaceToolIds: () => [],
    };
    expect(minimal.nextWorkspaceToolIds()).toEqual([]);
  });
});
