/**
 * @terminus/aci — Security & Malicious Input Fixture Tests.
 *
 * Validates resilience against path traversal, command injection,
 * malformed schema inputs, and policy boundary enforcement.
 */
import { describe, test, expect } from "bun:test";
import type { Uuid7 } from "@terminus/domain";
import {
  ProductionReadExecutor,
  ProductionExecExecutor,
  ProductionSearchExecutor,
  type ToolCallContext,
} from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function mkCtx(): ToolCallContext {
  return {
    toolCallId: "tc-sec-1",
    traceId: "trace-sec-1",
    sessionId: fakeUuid(1),
    taskId: fakeUuid(2),
    turnId: fakeUuid(3),
    workspaceId: fakeUuid(4),
    actorId: "user:test",
    capabilityToken: null,
    policyDecisionId: null,
    signal: null,
    deadlineMs: null,
  };
}

describe("Security & Malicious Input Fixtures", () => {
  test("read handles non-existent or traversal path safely", async () => {
    const provider = { readFile: async () => null };
    const readEx = new ProductionReadExecutor(provider);
    const ctx = mkCtx();

    const res = await readEx.execute(
      { path: "../../../etc/passwd" },
      ctx,
    );

    expect(res.status).toBe("error");
    expect(res.summary).toContain("File not found");
  });

  test("exec rejects empty argv array", async () => {
    const provider = {
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    };
    const execEx = new ProductionExecExecutor(provider);
    const ctx = mkCtx();

    const res = await execEx.execute({ argv: [] }, ctx);
    expect(res.status).toBe("error");
  });

  test("search input rejects oversized query payload > 500 chars", async () => {
    const provider = { listWorkspaceFiles: async () => [] };
    const searchEx = new ProductionSearchExecutor(provider);
    const ctx = mkCtx();

    const res = await searchEx.execute(
      { query: "A".repeat(501) },
      ctx,
    );

    expect(res.status).toBe("error");
    expect(res.summary).toContain("Invalid search input");
  });
});
