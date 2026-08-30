import { describe, expect, test } from "bun:test";
import {
  AUTHORITY_DOCUMENT_MODEL_INSTRUCTIONS_ID,
  AUTHORITY_DOCUMENT_PLATFORM_ID,
  AUTHORITY_DOCUMENT_SAFETY_ID,
  AUTHORITY_DOCUMENT_WORKING_AGREEMENT_ID,
  AUTHORITY_TOKEN_BUDGET,
  initialResponseAuthorityDocuments,
  modelInstructionDocument,
  resolveModelInstructionFamily,
  standaloneAuthorityDocuments,
  type ModelInstructionFamily,
} from "./system-prompt.js";
import { collectRequiredFragments, resolveTokenizer } from "@terminus/context-compiler";

function compileFixtureInput(documents: ReturnType<typeof standaloneAuthorityDocuments>) {
  const now = new Date("2026-08-25T00:00:00.000Z").toISOString() as never;
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

function promptTokens(modelKey: string): number {
  const tokenizer = resolveTokenizer("openai", "gpt-5.6-sol");
  return tokenizer.estimateTextTokens(
    standaloneAuthorityDocuments(modelKey).map((document) => document.text).join("\n\n"),
  );
}

const FAMILIES: readonly ModelInstructionFamily[] = ["openai", "anthropic", "open-weight"];

describe("prompt v1: shared prefix", () => {
  test("four stable-id documents, family layer last", () => {
    const documents = standaloneAuthorityDocuments("gpt-5.6-sol");
    expect(documents.map((document) => document.id)).toEqual([
      AUTHORITY_DOCUMENT_PLATFORM_ID,
      AUTHORITY_DOCUMENT_SAFETY_ID,
      AUTHORITY_DOCUMENT_WORKING_AGREEMENT_ID,
      AUTHORITY_DOCUMENT_MODEL_INSTRUCTIONS_ID,
    ]);
    expect(new Set(documents.map((document) => document.id)).size).toBe(documents.length);
  });

  test("the whole prefix fits the 700-token budget on every family", () => {
    for (const modelKey of ["gpt-5.6-sol", "claude-opus-5", "big-pickle", "deepseek-v4-flash-free"]) {
      expect(promptTokens(modelKey)).toBeLessThanOrEqual(AUTHORITY_TOKEN_BUDGET);
    }
  });

  test("the shared documents are byte-identical across families", () => {
    const shared = (modelKey: string): string => standaloneAuthorityDocuments(modelKey)
      .filter((document) => document.id !== AUTHORITY_DOCUMENT_MODEL_INSTRUCTIONS_ID)
      .map((document) => document.text)
      .join("\n\n");
    expect(shared("claude-opus-5")).toBe(shared("gpt-5.6-sol"));
    expect(shared("big-pickle")).toBe(shared("gpt-5.6-sol"));
  });

  test("names no mechanism the harness does not have", () => {
    const combined = FAMILIES
      .map((family) => modelInstructionDocument(family))
      .concat(standaloneAuthorityDocuments("gpt-5.6-sol").map((document) => document.text))
      .join("\n")
      .toLowerCase();
    for (const absent of [
      "skill",
      "organization policy",
      "secret value",
      "brokered",
      "action hash",
      "output profile",
      "memory",
      "capability card",
      "checkpoint",
      "delegat",
    ]) {
      expect(combined).not.toContain(absent);
    }
  });

  test("names no tool and no tool parameter — the schemas are the declaration", () => {
    const combined = FAMILIES
      .map((family) => modelInstructionDocument(family))
      .concat(standaloneAuthorityDocuments("gpt-5.6-sol").map((document) => document.text))
      .join("\n");
    for (const toolName of [
      "exec_poll",
      "exec(",
      "read(",
      "patch(",
      "grep(",
      "glob(",
      "write(",
      "file_sha256",
      "expected_sha256",
      "offset_line",
      "PATCH_STALE_SOURCE",
      "timeout_ms",
    ]) {
      expect(combined).not.toContain(toolName);
    }
  });

  test("carries the behavioural block the audit found missing", () => {
    const shared = standaloneAuthorityDocuments("gpt-5.6-sol")
      .filter((document) => document.id !== AUTHORITY_DOCUMENT_MODEL_INSTRUCTIONS_ID)
      .map((document) => document.text)
      .join("\n");
    // persistence / when to stop
    expect(shared).toContain("Keep going until the task is done");
    expect(shared).toContain("Stop when the objective is met");
    // parallel tool calls
    expect(shared).toContain("Issue independent tool calls in one message");
    // read before edit
    expect(shared).toContain("Read a file before editing it");
    // search rather than list via exec
    expect(shared).toContain("do not list directories");
    // never fabricate
    expect(shared).toContain("Never claim a command passed");
    // final-message shape and the no-tool-call stop condition
    expect(shared).toContain("Your final message is the whole report");
    expect(shared).toContain("no tool calls");
  });

  test("direct-answer requests do not become coding jobs", () => {
    const shared = standaloneAuthorityDocuments("big-pickle")
      .filter((document) => document.id !== AUTHORITY_DOCUMENT_MODEL_INSTRUCTIONS_ID)
      .map((document) => document.text)
      .join("\n");
    expect(shared).toContain("Otherwise answer the user directly");
    expect(shared).toContain("Use tools only when the requested outcome depends on workspace facts or changes");
  });
});

describe("initial-response prompt", () => {
  test("lets the model choose direct response or workspace activation", () => {
    const documents = initialResponseAuthorityDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]?.text).toContain("Answer directly");
    expect(documents[0]?.text).toContain("call the capability tool once");
    expect(documents[0]?.text).not.toMatch(/test|ping|greeting/i);
  });
});

describe("prompt v1: per-family layer", () => {
  test("family resolves from the model id, not the transport", () => {
    expect(resolveModelInstructionFamily("claude-opus-5")).toBe("anthropic");
    expect(resolveModelInstructionFamily("claude-fable-5")).toBe("anthropic");
    expect(resolveModelInstructionFamily("anthropic/claude-haiku-5")).toBe("anthropic");
    expect(resolveModelInstructionFamily("gpt-5.6-sol")).toBe("openai");
    expect(resolveModelInstructionFamily("openai/gpt-5.6-terra")).toBe("openai");
    expect(resolveModelInstructionFamily("gpt-5.6-luna")).toBe("openai");
    expect(resolveModelInstructionFamily("big-pickle")).toBe("open-weight");
    expect(resolveModelInstructionFamily("deepseek-ai/DeepSeek-V4-Flash-0731")).toBe("open-weight");
    expect(resolveModelInstructionFamily("nemotron-3-ultra-free")).toBe("open-weight");
    expect(resolveModelInstructionFamily(null)).toBe("open-weight");
  });

  test("verification follows workspace changes for GPT-5.6 and open weights, and is absent for Claude 5", () => {
    expect(modelInstructionDocument("openai")).toContain("After changing the workspace, run the check");
    expect(modelInstructionDocument("openai")).toContain("Do not run a check when you made no change");
    expect(modelInstructionDocument("open-weight")).toContain("After changing the workspace, run the project's");
    expect(modelInstructionDocument("open-weight")).toContain("Do not run a check when you made no change");
    // Anthropic's own guidance: do not tell Claude 5 to verify — it
    // over-verifies. Verification is a tool, not a ritual.
    expect(modelInstructionDocument("anthropic").toLowerCase()).not.toContain("verify");
    expect(modelInstructionDocument("anthropic").toLowerCase()).not.toContain("before finishing");
    expect(modelInstructionDocument("anthropic").toLowerCase()).not.toContain("double-check");
  });

  test("open weights are told to call one tool at a time", () => {
    expect(modelInstructionDocument("open-weight")).toContain("one tool call at a time");
    expect(modelInstructionDocument("openai")).not.toContain("one tool call at a time");
    expect(modelInstructionDocument("anthropic")).not.toContain("one tool call at a time");
  });

  test("every family layer stays small enough to be a cheap cache tail", () => {
    const tokenizer = resolveTokenizer("openai", "gpt-5.6-sol");
    for (const family of FAMILIES) {
      expect(tokenizer.estimateTextTokens(modelInstructionDocument(family))).toBeLessThan(120);
    }
  });
});

describe("prompt v1: compiler integration", () => {
  test("documents render as hard-required authority fragments with a dependency chain", async () => {
    const required = await collectRequiredFragments(
      compileFixtureInput(standaloneAuthorityDocuments("claude-opus-5")),
    );
    expect(required.authority.length).toBe(4);
    for (const fragment of required.authority) {
      expect(fragment.kind).toBe("authority");
      expect(fragment.authority).toBe(100);
      expect(fragment.trust).toBe("trusted");
    }
    for (const index of [1, 2, 3]) {
      expect(required.authority[index]?.dependencies).toEqual([required.authority[0]?.id]);
    }
    expect(required.policy[0]?.dependencies).toEqual([required.authority[0]?.id]);
    expect(required.policy[0]?.dependencies).not.toContain("required:authority:secure-local-default");
  });

  test("fallback stub is preserved when no documents are supplied (back-compat)", async () => {
    const required = await collectRequiredFragments(compileFixtureInput([] as never));
    expect(required.authority.length).toBe(1);
    expect(required.authority[0]?.id).toBe("required:authority:secure-local-default");
  });
});
