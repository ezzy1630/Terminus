/**
 * @terminus/aci — Patch Transaction & Property Tests.
 *
 * Validates kernel-owned transactions, baseline hash binding, stale/ambiguous
 * anchor rejection, preview patch mode, isolated invalid syntax handling,
 * atomic multi-file commit, and forced-crash rollback.
 */
import { describe, test, expect } from "bun:test";
import type { Uuid7, ContentHash } from "@terminus/domain";
import {
  ProductionPatchExecutor,
  computeSha256,
  type PatchProvider,
  type PatchTargetFile,
  type ToolCallContext,
  type Diagnostic,
} from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function mkCtx(): ToolCallContext {
  return {
    toolCallId: "tc-patch-1",
    traceId: "trace-patch-1",
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

class MockPatchProvider implements PatchProvider {
  files = new Map<string, PatchTargetFile>();
  committedFiles = new Map<string, string>();
  failCommit = false;

  constructor() {
    const mainContent = "function alpha() {\n  return 1;\n}\n";
    this.files.set("src/main.ts", {
      path: "src/main.ts",
      content: mainContent,
      hash: computeSha256(mainContent),
    });
  }

  async getFile(path: string): Promise<PatchTargetFile | null> {
    return this.files.get(path) ?? null;
  }

  async commitFiles(files: ReadonlyMap<string, { content: string; hash: ContentHash }>): Promise<void> {
    if (this.failCommit) {
      throw new Error("Simulated filesystem transaction crash during commit");
    }
    for (const [p, val] of files.entries()) {
      this.committedFiles.set(p, val.content);
      this.files.set(p, { path: p, content: val.content, hash: val.hash });
    }
  }

  async rollbackFiles(files: ReadonlyMap<string, PatchTargetFile | null>): Promise<void> {
    for (const [path, file] of files) {
      if (file === null) {
        this.files.delete(path);
      } else {
        this.files.set(path, file);
      }
      this.committedFiles.delete(path);
    }
  }

  async validateSemanticDiff(
    _files: ReadonlyMap<string, { content: string; hash: ContentHash }>,
  ): Promise<readonly Diagnostic[]> {
    return [];
  }
}

describe("Patch Transactions & Anchors", () => {
  test("successful exact_text replace updates file and hashes", async () => {
    const provider = new MockPatchProvider();
    const executor = new ProductionPatchExecutor(provider);
    const ctx = mkCtx();

    const file = await provider.getFile("src/main.ts");
    const res = await executor.execute(
      {
        operations: [
          {
            op: "exact_text",
            path: "src/main.ts",
            observed_hash: file!.hash,
            old_text: "return 1;",
            new_text: "return 42;",
          },
        ],
      },
      ctx,
    );

    expect(res.status).toBe("success");
    expect(res.data?.files.length).toBe(1);
    expect(provider.committedFiles.get("src/main.ts")).toContain("return 42;");
  });

  test("rejects stale observed_hash with ANCHOR_STALE error", async () => {
    const provider = new MockPatchProvider();
    const executor = new ProductionPatchExecutor(provider);
    const ctx = mkCtx();

    const res = await executor.execute(
      {
        operations: [
          {
            op: "exact_text",
            path: "src/main.ts",
            observed_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            old_text: "return 1;",
            new_text: "return 42;",
          },
        ],
      },
      ctx,
    );

    expect(res.status).toBe("error");
    expect(res.summary).toContain("ANCHOR_STALE");
  });

  test("rejects ambiguous text replacement with ANCHOR_AMBIGUOUS error", async () => {
    const provider = new MockPatchProvider();
    const dupContent = "const x = 1;\nconst x = 1;\n";
    provider.files.set("src/dup.ts", {
      path: "src/dup.ts",
      content: dupContent,
      hash: computeSha256(dupContent),
    });

    const executor = new ProductionPatchExecutor(provider);
    const ctx = mkCtx();

    const res = await executor.execute(
      {
        operations: [
          {
            op: "exact_text",
            path: "src/dup.ts",
            observed_hash: computeSha256(dupContent),
            old_text: "const x = 1;",
            new_text: "const x = 2;",
          },
        ],
      },
      ctx,
    );

    expect(res.status).toBe("error");
    expect(res.summary).toContain("ANCHOR_AMBIGUOUS");
  });

  test("preview_only mode returns diff without mutating active worktree", async () => {
    const provider = new MockPatchProvider();
    const executor = new ProductionPatchExecutor(provider);
    const ctx = mkCtx();

    const file = await provider.getFile("src/main.ts");
    const res = await executor.execute(
      {
        operations: [
          {
            op: "exact_text",
            path: "src/main.ts",
            observed_hash: file!.hash,
            old_text: "return 1;",
            new_text: "return 99;",
          },
        ],
        commitMode: "preview_only",
      },
      ctx,
    );

    expect(res.status).toBe("success");
    expect(res.data?.commit_mode).toBe("preview_only");
    // Worktree should remain unchanged
    expect(provider.committedFiles.has("src/main.ts")).toBe(false);
  });

  test("simulated forced-crash during commit triggers transaction rollback", async () => {
    const provider = new MockPatchProvider();
    provider.failCommit = true;
    const executor = new ProductionPatchExecutor(provider);
    const ctx = mkCtx();

    const file = await provider.getFile("src/main.ts");
    const res = await executor.execute(
      {
        operations: [
          {
            op: "exact_text",
            path: "src/main.ts",
            observed_hash: file!.hash,
            old_text: "return 1;",
            new_text: "return 100;",
          },
        ],
      },
      ctx,
    );

    expect(res.status).toBe("error");
    expect(res.summary).toContain("rollback completed");
    expect((await provider.getFile("src/main.ts"))!.content).toContain("return 1;");
  });

  test("rejects an operation that the selected edit dialect cannot represent", async () => {
    const provider = new MockPatchProvider();
    const executor = new ProductionPatchExecutor(provider);
    const file = await provider.getFile("src/main.ts");
    const res = await executor.execute(
      {
        dialect: "unified_diff",
        operations: [{
          op: "exact_text",
          path: "src/main.ts",
          observed_hash: file!.hash,
          old_text: "return 1;",
          new_text: "return 2;",
        }],
      },
      mkCtx(),
    );
    expect(res.status).toBe("error");
    expect(res.summary).toContain("PATCH_DIALECT_MISMATCH");
  });

  test("applies a hash-anchored unified diff", async () => {
    const provider = new MockPatchProvider();
    const executor = new ProductionPatchExecutor(provider);
    const file = await provider.getFile("src/main.ts");
    const res = await executor.execute(
      {
        dialect: "unified_diff",
        operations: [{
          op: "unified_diff",
          path: "src/main.ts",
          observed_hash: file!.hash,
          diff: "@@ -1,3 +1,3 @@\n function alpha() {\n-  return 1;\n+  return 2;\n }\n",
        }],
      },
      mkCtx(),
    );
    expect(res.status).toBe("success");
    expect(provider.committedFiles.get("src/main.ts")).toContain("return 2;");
  });

  test("semantic validation rejects a candidate before commit", async () => {
    const provider = new MockPatchProvider();
    provider.validateSemanticDiff = async () => [{
      severity: "error",
      code: "semantic",
      message: "import graph is inconsistent",
      path: "src/main.ts",
      range: { startLine: 1, endLine: 1 },
    }];
    const executor = new ProductionPatchExecutor(provider);
    const file = await provider.getFile("src/main.ts");
    const res = await executor.execute(
      {
        operations: [{
          op: "exact_text",
          path: "src/main.ts",
          observed_hash: file!.hash,
          old_text: "return 1;",
          new_text: "return 2;",
        }],
      },
      mkCtx(),
    );
    expect(res.status).toBe("error");
    expect(res.summary).toContain("semantic validation failed");
    expect(provider.committedFiles.has("src/main.ts")).toBe(false);
  });
});
