import { describe, expect, test } from "bun:test";
import {
  AUTHORITY_DOCUMENT_PLATFORM_ID,
  AUTHORITY_DOCUMENT_SAFETY_ID,
  AUTHORITY_DOCUMENT_TOOL_USAGE_ID,
  AUTHORITY_TOKEN_BUDGET,
  standaloneAuthorityDocuments,
} from "./system-prompt.js";
import { collectRequiredFragments, resolveTokenizer } from "@terminus/context-compiler";

function compileFixtureInput(documents: ReturnType<typeof standaloneAuthorityDocuments>) {
  const now = new Date("2026-08-25T00:00:00.000Z").toISOString() as never;
  const tokenizer = resolveTokenizer("anthropic", "claude-test");
  return {
    task: {
      taskId: "018f0000-0000-7000-8000-000000000001" as never,
      contract: {
        version: 1,
        objective: "Fix the failing unit test",
        userOutcome: null,
        nonGoals: [],
        acceptanceCriteria: [
          { id: "ac-1", statement: "bun test passes", required: true, verificationHint: "bun test" },
        ],
        constraints: [],
        assumptions: [],
        unknowns: [],
      },
      changedFiles: [],
      failingTests: [],
      diagnostics: [],
    },
    thread: { sessionId: "018f0000-0000-7000-8000-000000000002" as never, activeContextEpochId: null },
    provider: { providerId: "anthropic", context: {} as never, observedAt: now },
    model: { modelKey: "claude-test", providerId: "anthropic", context: {} as never, observedAt: now },
    epoch: null,
    worldState: {
      observedAt: now,
      sourceVersions: {},
      sections: {},
    },
    recentEpisodes: [],
    episodeContent: new Map(),
    checkpoint: null,
    userDirectives: [],
    activeCapabilities: [],
    budget: { hardContextLimit: 100_000, optionalContextTarget: 60_000, minimumFreeTokens: 10_000 },
    experimentAssignments: [],
    renderer: {} as never,
    confidentialityPolicy: { allowedProviders: { public: [], workspace: [], secret_adjacent: [], secret: [] } },
    authorityDocuments: documents,
    store: {} as never,
    signal: null,
  } as never;
}

describe("R2 platform authority documents", () => {
  test("three stable-id documents: authority, safety, tool contract", () => {
    const documents = standaloneAuthorityDocuments();
    expect(documents.map((document) => document.id)).toEqual([
      AUTHORITY_DOCUMENT_PLATFORM_ID,
      AUTHORITY_DOCUMENT_SAFETY_ID,
      AUTHORITY_DOCUMENT_TOOL_USAGE_ID,
    ]);
    const ids = new Set(documents.map((document) => document.id));
    expect(ids.size).toBe(documents.length);
  });

  test("combined prefix stays inside the token budget (context discipline)", async () => {
    const documents = standaloneAuthorityDocuments();
    const combined = documents.map((document) => document.text).join("\n\n");
    const tokenizer = resolveTokenizer("anthropic", "claude-test");
    const estimate = tokenizer.estimateTextTokens(combined);
    expect(estimate).toBeLessThan(AUTHORITY_TOKEN_BUDGET);
  });

  test("tool contract documents the shipped read/patch hash flow verbatim anchors", () => {
    const toolDoc = standaloneAuthorityDocuments().find((d) => d.id === AUTHORITY_DOCUMENT_TOOL_USAGE_ID);
    expect(toolDoc?.text).toContain("file_sha256");
    expect(toolDoc?.text).toContain("PATCH_STALE_SOURCE");
    expect(toolDoc?.text).toContain("<line>→ ");
    expect(toolDoc?.text).toContain("exec_poll");
  });

  test("compiler renders supplied documents as hard-required authority fragments with dependency chain", async () => {
    const required = await collectRequiredFragments(compileFixtureInput(standaloneAuthorityDocuments()));
    expect(required.authority.length).toBe(3);
    for (const fragment of required.authority) {
      expect(fragment.kind).toBe("authority");
      expect(fragment.authority).toBe(100);
      expect(fragment.trust).toBe("trusted");
    }
    expect(required.authority[1]?.dependencies).toEqual([required.authority[0]?.id]);
    expect(required.authority[2]?.dependencies).toEqual([required.authority[0]?.id]);
    // Policy fragment must depend on the primary authority id, not the legacy stub id.
    expect(required.policy[0]?.dependencies).toEqual([required.authority[0]?.id]);
    expect(required.policy[0]?.dependencies).not.toContain("required:authority:secure-local-default");
  });

  test("fallback stub is preserved when no documents are supplied (back-compat)", async () => {
    const required = await collectRequiredFragments(compileFixtureInput([] as never));
    expect(required.authority.length).toBe(1);
    expect(required.authority[0]?.id).toBe("required:authority:secure-local-default");
  });
});
