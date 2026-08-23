import { describe, test, expect } from "bun:test";
import type { Uuid7 } from "@terminus/domain";
import { ProductionSearchExecutor, type SearchProvider } from "./index.js";

function ctx() {
  return {
    toolCallId: "search-contract",
    traceId: "search-contract-trace",
    sessionId: "018f0000-0000-7000-8000-000000000001" as Uuid7,
    taskId: null,
    turnId: null,
    workspaceId: "018f0000-0000-7000-8000-000000000002" as Uuid7,
    actorId: "test",
    capabilityToken: null,
    policyDecisionId: null,
    signal: null,
    deadlineMs: null,
  };
}

const files = [
  { path: "src/alpha.ts", content: "export function alpha() { return 1; }" },
  { path: "src/nested/beta.ts", content: "export function beta() { return alpha(); }" },
  { path: "tests/alpha.test.ts", content: "test('alpha', () => alpha());" },
] as const;

describe("search identity and retrieval contracts", () => {
  test("auto lexical results are not mislabeled as AST retrieval", async () => {
    const provider: SearchProvider = { listWorkspaceFiles: async () => files };
    const result = await new ProductionSearchExecutor(provider).execute(
      { query: "alpha", mode: "auto" },
      ctx(),
    );
    expect(result.status).toBe("success");
    expect(result.data?.matches.some((match) => match.matchedBy === "treesitter_ast")).toBe(false);
    expect(result.data?.matches.every((match) => match.version?.startsWith("sha256:"))).toBe(true);
  });

  test("structural retrieval fails closed without an AST provider", async () => {
    const provider: SearchProvider = { listWorkspaceFiles: async () => files };
    const result = await new ProductionSearchExecutor(provider).execute(
      { query: "alpha", mode: "structural" },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("AST structural retrieval is unavailable");
  });

  test("scope and exclude matching respect path boundaries", async () => {
    const provider: SearchProvider = { listWorkspaceFiles: async () => files };
    const result = await new ProductionSearchExecutor(provider).execute(
      { query: "alpha", mode: "text", scope: ["src"], exclude: ["src/nested"] },
      ctx(),
    );
    expect(result.status).toBe("success");
    expect(result.data?.matches.every((match) => match.path === "src/alpha.ts")).toBe(true);
  });

  test("structural results come from the provider and are source-bound", async () => {
    const provider: SearchProvider = {
      listWorkspaceFiles: async () => files,
      getTreeSitterSymbols: async () => [{
        path: "src/alpha.ts",
        line: 1,
        matchedBy: "treesitter_ast",
        score: 9,
        symbolKind: "function",
      }],
    };
    const result = await new ProductionSearchExecutor(provider).execute(
      { query: "alpha", mode: "structural" },
      ctx(),
    );
    expect(result.status).toBe("success");
    expect(result.data?.matches[0]?.matchedBy).toBe("treesitter_ast");
    expect(result.data?.matches[0]?.version).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
