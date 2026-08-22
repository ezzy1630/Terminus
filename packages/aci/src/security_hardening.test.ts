import { describe, it, expect } from "vitest";
import type { Uuid7 } from "@terminus/domain";
import { ProductionReadExecutor } from "./read.js";
import { ProductionExecExecutor } from "./exec_job.js";
import { ProductionSearchExecutor } from "./search.js";

describe("ACI Security Hardening & Edge-Case Tests", () => {
  it("rejects path traversal attempts in read tool", async () => {
    const mockProvider = {
      readFile: async (path: string) => {
        if (path.includes("..")) {
          return null;
        }
        return { path, content: "safe content" };
      },
    };
    const executor = new ProductionReadExecutor(mockProvider);
    const res = await executor.execute(
      { path: "../../../etc/passwd", mode: "full" },
      { toolCallId: "call-1", traceId: "trace-1", sessionId: "018f0000-0000-7000-8000-000000000001" as Uuid7, taskId: null, turnId: null, workspaceId: "018f0000-0000-7000-8000-000000000009" as Uuid7, actorId: "test-actor", capabilityToken: null, policyDecisionId: null, signal: null, deadlineMs: 5000 },
    );
    expect(res.status).toBe("error");
    expect(res.summary).toContain("File not found");
  });

  it("handles huge command output by spilling to artifact", async () => {
    const hugeOutput = "A".repeat(50_000);
    const mockProcessProvider = {
      runCommand: async () => ({
        exitCode: 0,
        stdout: hugeOutput,
        stderr: "",
        durationMs: 10,
      }),
    };
    const executor = new ProductionExecExecutor(mockProcessProvider);
    const res = await executor.execute(
      { argv: ["echo", "huge"], timeout_ms: 5000 },
      { toolCallId: "call-2", traceId: "trace-2", sessionId: "018f0000-0000-7000-8000-000000000002" as Uuid7, taskId: null, turnId: null, workspaceId: "018f0000-0000-7000-8000-000000000009" as Uuid7, actorId: "test-actor", capabilityToken: null, policyDecisionId: null, signal: null, deadlineMs: 5000 },
    );
    expect(res.status).toBe("partial");
    expect(res.data?.artifactSpill).not.toBeNull();
    expect(res.data?.artifactSpill?.uri).toContain("artifact://spill-call-2-stdout");
  });

  it("gracefully handles binary / invalid encodings", async () => {
    const mockProvider = {
      listWorkspaceFiles: async () => [
        {
          path: "src/binary.dat",
          content: "\x00\x01\x02\xFF\xFE",
          version: "sha256:bin123" as any,
        },
      ],
    };
    const executor = new ProductionSearchExecutor(mockProvider);
    const res = await executor.execute(
      { query: "search", mode: "text" },
      { toolCallId: "call-3", traceId: "trace-3", sessionId: "018f0000-0000-7000-8000-000000000003" as Uuid7, taskId: null, turnId: null, workspaceId: "018f0000-0000-7000-8000-000000000009" as Uuid7, actorId: "test-actor", capabilityToken: null, policyDecisionId: null, signal: null, deadlineMs: 5000 },
    );
    expect(res.status).toBe("success");
    expect(res.data?.matches).toBeDefined();
  });

  it("handles continuation tokens gracefully on pagination", async () => {
    const mockProvider = {
      listWorkspaceFiles: async () => [
        { path: "src/a.ts", content: "export const a = 1;", version: "sha256:a" as any },
        { path: "src/b.ts", content: "export const b = 2;", version: "sha256:b" as any },
        { path: "src/c.ts", content: "export const c = 3;", version: "sha256:c" as any },
      ],
    };
    const executor = new ProductionSearchExecutor(mockProvider);
    const res = await executor.execute(
      { query: "export", mode: "text", limit: 2 },
      { toolCallId: "call-4", traceId: "trace-4", sessionId: "018f0000-0000-7000-8000-000000000004" as Uuid7, taskId: null, turnId: null, workspaceId: "018f0000-0000-7000-8000-000000000009" as Uuid7, actorId: "test-actor", capabilityToken: null, policyDecisionId: null, signal: null, deadlineMs: 5000 },
    );
    expect(res.status).toBe("partial");
    expect(res.truncation?.occurred).toBe(true);
    expect(res.truncation?.continuation).not.toBeNull();
  });
});
