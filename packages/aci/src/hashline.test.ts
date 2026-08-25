import { describe, expect, test } from "bun:test";
import { ProductionReadExecutor, computeLineHash, computeSha256 } from "./read.js";
import { ProductionPatchExecutor, type PatchProvider, type PatchTargetFile } from "./patch.js";
import type { ToolCallContext, Diagnostic } from "./index.js";
import type { ContentHash, Uuid7 } from "@terminus/domain";

function makeContext(): ToolCallContext {
  return {
    toolCallId: "call-hashline-test-1",
    traceId: "trace-hashline-test-1",
    sessionId: "018f0000-0000-7000-8000-000000000001" as Uuid7,
    taskId: "018f0000-0000-7000-8000-000000000002" as Uuid7,
    turnId: "018f0000-0000-7000-8000-000000000003" as Uuid7,
    workspaceId: "018f0000-0000-7000-8000-000000000004" as Uuid7,
    actorId: "user-test",
    capabilityToken: null,
    policyDecisionId: null,
    signal: new AbortController().signal,
    deadlineMs: null,
  };
}

class InMemoryWorkspace implements PatchProvider {
  readonly files = new Map<string, { content: string; hash: ContentHash }>();
  diagnostics: Diagnostic[] = [];

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, {
        content,
        hash: computeSha256(content),
      });
    }
  }

  async readFile(path: string) {
    const file = this.files.get(path);
    if (!file) return null;
    return {
      path,
      content: file.content,
      version: file.hash,
    };
  }

  async getFile(path: string): Promise<PatchTargetFile | null> {
    const file = this.files.get(path);
    if (!file) return null;
    return {
      path,
      content: file.content,
      hash: file.hash,
    };
  }

  async commitFiles(files: ReadonlyMap<string, { content: string; hash: ContentHash }>): Promise<void> {
    for (const [path, data] of files.entries()) {
      this.files.set(path, data);
    }
  }

  async rollbackFiles(files: ReadonlyMap<string, PatchTargetFile | null>): Promise<void> {
    for (const [path, target] of files.entries()) {
      if (target === null) {
        this.files.delete(path);
      } else {
        this.files.set(path, { content: target.content, hash: target.hash });
      }
    }
  }

  async validateSyntax(path: string, _content: string): Promise<readonly Diagnostic[]> {
    return this.diagnostics.filter((d) => d.path === path || d.path === null);
  }
}

describe("Minimal Coding ACI v1 - Hashline & Diagnostics", () => {
  test("read tool with mode=hashline emits line numbers and short SHA-256 line hashes", async () => {
    const ws = new InMemoryWorkspace({
      "src/index.ts": "const a = 1;\nconst b = 2;\nconsole.log(a + b);",
    });
    const readExecutor = new ProductionReadExecutor(ws);
    const res = await readExecutor.execute({ path: "src/index.ts", mode: "hashline" }, makeContext());

    expect(res.status).toBe("success");
    const content = res.data?.content;
    expect(content).toBeDefined();
    if (content === undefined || content === null) throw new Error("hashline read returned no content");
    const lines = content.split("\n");
    expect(lines.length).toBe(3);

    const hash1 = computeLineHash("const a = 1;");
    const hash2 = computeLineHash("const b = 2;");
    const hash3 = computeLineHash("console.log(a + b);");

    expect(lines[0]).toBe(`1:${hash1}:const a = 1;`);
    expect(lines[1]).toBe(`2:${hash2}:const b = 2;`);
    expect(lines[2]).toBe(`3:${hash3}:console.log(a + b);`);
  });

  test("patch tool with replace_hashline applies when line hashes match", async () => {
    const original = "function add(a: number, b: number): number {\n  return a + b;\n}\n";
    const ws = new InMemoryWorkspace({ "src/math.ts": original });
    const patchExecutor = new ProductionPatchExecutor(ws);

    const line2 = "  return a + b;";
    const line2Hash = computeLineHash(line2);

    const res = await patchExecutor.execute(
      {
        operations: [
          {
            op: "replace_hashline",
            path: "src/math.ts",
            observed_hash: computeSha256(original),
            range: { startLine: 2, endLine: 2 },
            line_hashes: [line2Hash],
            new_text: "  return Number(a) + Number(b);",
          },
        ],
        dialect: "hashline",
      },
      makeContext(),
    );

    expect(res.status).toBe("success");
    const updated = ws.files.get("src/math.ts")?.content;
    expect(updated).toBe("function add(a: number, b: number): number {\n  return Number(a) + Number(b);\n}\n");
  });

  test("patch tool with replace_hashline rejects with ANCHOR_STALE when line hash mismatches", async () => {
    const original = "line 1\nline 2\nline 3\n";
    const ws = new InMemoryWorkspace({ "file.txt": original });
    const patchExecutor = new ProductionPatchExecutor(ws);

    const res = await patchExecutor.execute(
      {
        operations: [
          {
            op: "replace_hashline",
            path: "file.txt",
            observed_hash: computeSha256(original),
            range: { startLine: 2, endLine: 2 },
            line_hashes: ["00000000"],
            new_text: "line 2 modified",
          },
        ],
      },
      makeContext(),
    );

    expect(res.status).toBe("error");
    expect(res.summary).toContain("ANCHOR_STALE: Line hash mismatch");
    expect(ws.files.get("file.txt")?.content).toBe(original);
  });

  test("patch tool batches and returns post-write diagnostics", async () => {
    const original = "export const x = 1;\n";
    const ws = new InMemoryWorkspace({ "src/app.ts": original });
    ws.diagnostics = [
      {
        severity: "warning",
        code: "TS6133",
        message: "'x' is declared but its value is never read.",
        path: "src/app.ts",
        range: { startLine: 1, endLine: 1 },
      },
    ];
    const patchExecutor = new ProductionPatchExecutor(ws);

    const res = await patchExecutor.execute(
      {
        operations: [
          {
            op: "replace_hashline",
            path: "src/app.ts",
            observed_hash: computeSha256(original),
            range: { startLine: 1, endLine: 1 },
            line_hashes: [computeLineHash("export const x = 1;")],
            new_text: "export const x = 2;",
          },
        ],
      },
      makeContext(),
    );

    expect(res.status).toBe("success");
    expect(res.diagnostics).toBeDefined();
    expect(res.diagnostics?.length).toBe(1);
    expect(res.diagnostics?.[0]?.code).toBe("TS6133");
  });

  test("multi-file patch transaction with replace_hashline rolls back completely on conflict", async () => {
    const f1 = "foo\nbar\nbaz\n";
    const f2 = "111\n222\n333\n";
    const ws = new InMemoryWorkspace({
      "f1.txt": f1,
      "f2.txt": f2,
    });
    const patchExecutor = new ProductionPatchExecutor(ws);

    const res = await patchExecutor.execute(
      {
        operations: [
          {
            op: "replace_hashline",
            path: "f1.txt",
            observed_hash: computeSha256(f1),
            range: { startLine: 2, endLine: 2 },
            line_hashes: [computeLineHash("bar")],
            new_text: "BAR",
          },
          {
            op: "replace_hashline",
            path: "f2.txt",
            observed_hash: computeSha256(f2),
            range: { startLine: 2, endLine: 2 },
            line_hashes: ["badhash0"],
            new_text: "222_modified",
          },
        ],
      },
      makeContext(),
    );

    expect(res.status).toBe("error");
    expect(res.summary).toContain("ANCHOR_STALE");
    // Both files remain untouched
    expect(ws.files.get("f1.txt")?.content).toBe(f1);
    expect(ws.files.get("f2.txt")?.content).toBe(f2);
  });
});
