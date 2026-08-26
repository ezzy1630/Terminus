/**
 * @terminus/aci — Truncation & Elision Boundary Tests.
 *
 * Validates SPEC §11.3, §34.4, §34.5 requirement that tool results NEVER
 * silently truncate. Ensures explicit elision markers, non-silent truncation envelopes,
 * valid continuation tokens, and artifact spill behavior.
 */
import { describe, test, expect } from "bun:test";
import type { Uuid7, ContentHash } from "@terminus/domain";
import {
  ProductionReadExecutor,
  ProductionExecExecutor,
  type ReadProvider,
  type ProcessKernelProvider,
  type WorkspaceFile,
  type ToolCallContext,
  computeSha256,
} from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function mkCtx(): ToolCallContext {
  return {
    toolCallId: "tc-trunc-1",
    traceId: "trace-trunc-1",
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

class MockReadProvider implements ReadProvider {
  async readFile(path: string): Promise<WorkspaceFile | null> {
    if (path === "large.ts") {
      const lines = Array.from({ length: 500 }, (_, i) => `const line${i + 1} = ${i + 1};`);
      return { path: "large.ts", content: lines.join("\n") };
    }
    return null;
  }

  async spillArtifact(input: {
    readonly content: string | Uint8Array;
    readonly mediaType: string;
    readonly sourceUri: string;
  }) {
    const bytes = typeof input.content === "string"
      ? Buffer.byteLength(input.content, "utf8")
      : input.content.byteLength;
    const hash = computeSha256(input.content);
    return {
      uri: `artifact://sha256/${hash.slice("sha256:".length)}`,
      mediaType: input.mediaType,
      bytes,
      hash,
      content: input.content,
    };
  }
}

class MockProcessProvider implements ProcessKernelProvider {
  async runCommand(): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    return {
      exitCode: 0,
      stdout: "X".repeat(30_000), // Exceeds default 16KB limit
      stderr: "",
      durationMs: 45,
    };
  }
}

describe("Truncation & Elision Boundary Tests", () => {
  test("read in range mode returns explicit elision markers", async () => {
    const readEx = new ProductionReadExecutor(new MockReadProvider());
    const ctx = mkCtx();

    const res = await readEx.execute(
      {
        path: "large.ts",
        mode: "range",
        ranges: [{ startLine: 10, endLine: 20 }],
      },
      ctx,
    );

    expect(res.status).toBe("success");
    expect(res.data?.elisions.length).toBeGreaterThan(0);
    expect(res.data?.elisions[0]!.range).toEqual([1, 9]);
    expect(res.data?.elisions[0]!.reason).toBe("not_requested");
  });

  test("read exceeding maxBytes sets truncation.occurred=true and returns continuation token", async () => {
    const readEx = new ProductionReadExecutor(new MockReadProvider());
    const ctx = mkCtx();

    const res = await readEx.execute(
      {
        path: "large.ts",
        mode: "full",
        maxBytes: 1000,
      },
      ctx,
    );

    expect(res.status).toBe("partial");
    expect(res.truncation.occurred).toBe(true);
    expect(res.truncation.continuation).not.toBeNull();
  });

  test("read continuation is bound to the original byte budget", async () => {
    const readEx = new ProductionReadExecutor(new MockReadProvider());
    const first = await readEx.execute(
      { path: "large.ts", mode: "full", maxBytes: 1000 },
      mkCtx(),
    );
    expect(first.truncation.continuation).not.toBeNull();

    const replay = await readEx.execute(
      {
        path: "large.ts",
        mode: "full",
        maxBytes: 1200,
        continuation: first.truncation.continuation,
      },
      mkCtx(),
    );
    expect(replay.status).toBe("error");
    expect(replay.summary).toContain("STALE_CONTINUATION");
  });

  test("oversized rendered projections spill as exact immutable artifacts", async () => {
    const readEx = new ProductionReadExecutor(new MockReadProvider());
    const res = await readEx.execute(
      { path: "large.ts", mode: "range", ranges: [{ startLine: 1, endLine: 100 }], maxBytes: 64 },
      mkCtx(),
    );
    expect(res.status).toBe("success");
    expect(res.data?.content).toBeNull();
    expect(res.data?.artifact?.uri).toMatch(/^artifact:\/\/sha256\/[0-9a-f]{64}$/);
    expect(res.artifacts).toHaveLength(1);
    expect(res.truncation.occurred).toBe(false);
  });

  test("artifact checksum mismatches fail closed", async () => {
    const provider: ReadProvider = {
      async readFile() { return null; },
      async readArtifact(uri) {
        return {
          uri,
          mediaType: "text/plain",
          bytes: 3,
          hash: ("sha256:" + "0".repeat(64)) as ContentHash,
          content: "bad",
        };
      },
    };
    const readEx = new ProductionReadExecutor(provider);
    const res = await readEx.execute({ path: "artifact://sha256/" + "1".repeat(64) }, mkCtx());
    expect(res.status).toBe("error");
    expect(res.summary).toContain("Artifact checksum mismatch");
  });

  test("exec stdout spill creates artifact descriptor and flags truncation", async () => {
    const execEx = new ProductionExecExecutor(new MockProcessProvider());
    const ctx = mkCtx();

    const res = await execEx.execute(
      {
        argv: ["cat", "huge.log"],
      },
      ctx,
    );

    expect(res.status).toBe("partial");
    expect(res.truncation.occurred).toBe(true);
    expect(res.artifacts.length).toBe(1);
    expect(res.artifacts[0]!.uri).toContain("artifact://spill-");
    expect(res.truncation.continuation).toBe(res.artifacts[0]!.uri);
  });
});
