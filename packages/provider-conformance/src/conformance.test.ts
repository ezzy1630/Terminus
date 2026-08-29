/**
 * @terminus/provider-conformance — Conformance golden tests (§38.19).
 *
 * Tests: role ordering, tool schemas, tool-choice semantics, structured output,
 * continuation IDs, token accounting, error projection, cache controls,
 * confidentiality, compatibility, compilation authority, cancellation &
 * partial-stream settlement, exit gate.
 */
import { test, expect, describe } from "bun:test";
import type { ModelKey, TokenCount, ContentHash, ConfidentialityLabel, Micros } from "@terminus/domain";
import { micros } from "@terminus/domain";
import type {
  ProviderCapabilitySnapshot,
  ModelCapabilitySnapshot,
  CanonicalRenderInput,
  ProviderResponse,
  ProviderResponseChunk,
  ProviderToolSchema,
  ConfidentialityPolicy,
} from "@terminus/provider-core";
import { isConfidentialityAllowed, filterByConfidentiality, settlePartialStream } from "@terminus/provider-core";
import { OpenAiRenderer } from "@terminus/provider-openai";
import { AnthropicRenderer } from "@terminus/provider-anthropic";
import { GoogleRenderer } from "@terminus/provider-google";
import { LocalRenderer } from "@terminus/provider-local";
import { runExitGate, buildProviderGateResult } from "./exit-gate.js";
import type { ProviderGateResult } from "./exit-gate.js";

// ────────────────────────── Fixture factories ────────────────────────────────

function openAiCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    providerId: "openai", observedAt: "2026-07-23T00:00:00Z", source: "conformance",
    context: { advertisedTokens: 128_000, testedSafeTokens: 128_000, roleSupport: ["system","user","assistant","tool","developer"], imageInput: true, toolCalling: true, parallelToolCalls: true, structuredOutput: true },
    continuation: { nativeId: true, crossRequest: true, compaction: false, compatibilityKey: "openai-responses-v1" },
    caching: { mode: "automatic_prefix", exactPrefixRequired: true, minimumTokens: 1024, ttlOptions: ["5m","1h"], toolOrderSensitive: false, usageReporting: true },
    reasoning: { supported: true, budgetControl: true, summaryAvailable: true },
    economics: { inputMicrosPerMillion: micros(2_500_000), cachedInputMicrosPerMillion: micros(1_250_000), outputMicrosPerMillion: micros(10_000_000), reasoningAccounting: true },
    reliability: { toolCallSuccess: 0.96, structuredOutputSuccess: 0.97, editCohortSuccess: 0.88, latencyPercentiles: { p50: 800, p95: 3000, p99: 6000 } },
    policy: { allowedConfidentiality: ["public","workspace","secret_adjacent"], retentionMode: "organization_zdr", region: "us-east-1" },
  };
}

function anthropicCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    providerId: "anthropic", observedAt: "2026-07-23T00:00:00Z", source: "conformance",
    context: { advertisedTokens: 200_000, testedSafeTokens: 200_000, roleSupport: ["system","user","assistant"], imageInput: true, toolCalling: true, parallelToolCalls: true, structuredOutput: true },
    continuation: { nativeId: false, crossRequest: false, compaction: false, compatibilityKey: "anthropic-messages-v1" },
    caching: { mode: "explicit_breakpoints", exactPrefixRequired: true, minimumTokens: 1024, ttlOptions: ["5m"], toolOrderSensitive: true, usageReporting: true },
    reasoning: { supported: true, budgetControl: true, summaryAvailable: true },
    economics: { inputMicrosPerMillion: micros(3_000_000), cachedInputMicrosPerMillion: micros(300_000), outputMicrosPerMillion: micros(15_000_000), reasoningAccounting: true },
    reliability: { toolCallSuccess: 0.95, structuredOutputSuccess: 0.96, editCohortSuccess: 0.90, latencyPercentiles: { p50: 1200, p95: 4000, p99: 8000 } },
    policy: { allowedConfidentiality: ["public","workspace","secret_adjacent","secret"], retentionMode: "30d", region: "us-east-1" },
  };
}

function googleCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    providerId: "google", observedAt: "2026-07-23T00:00:00Z", source: "conformance",
    context: { advertisedTokens: 1_000_000, testedSafeTokens: 1_000_000, roleSupport: ["system","user","model","function"], imageInput: true, toolCalling: true, parallelToolCalls: false, structuredOutput: true },
    continuation: { nativeId: true, crossRequest: true, compaction: false, compatibilityKey: "gemini-v1" },
    caching: { mode: "explicit_resource", exactPrefixRequired: false, minimumTokens: 32768, ttlOptions: ["auto"], toolOrderSensitive: false, usageReporting: true },
    reasoning: { supported: true, budgetControl: true, summaryAvailable: true },
    economics: { inputMicrosPerMillion: micros(1_250_000), cachedInputMicrosPerMillion: micros(312_500), outputMicrosPerMillion: micros(5_000_000), reasoningAccounting: true },
    reliability: { toolCallSuccess: 0.92, structuredOutputSuccess: 0.93, editCohortSuccess: 0.82, latencyPercentiles: { p50: 1500, p95: 5000, p99: 10000 } },
    policy: { allowedConfidentiality: ["public","workspace"], retentionMode: "none", region: null },
  };
}

function localCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    providerId: "local", observedAt: "2026-07-23T00:00:00Z", source: "conformance",
    context: { advertisedTokens: 32_000, testedSafeTokens: 32_000, roleSupport: ["system","user","assistant","tool"], imageInput: false, toolCalling: true, parallelToolCalls: false, structuredOutput: false },
    continuation: { nativeId: false, crossRequest: false, compaction: false, compatibilityKey: "local-v1" },
    caching: { mode: "none", exactPrefixRequired: false, minimumTokens: 0, ttlOptions: [], toolOrderSensitive: false, usageReporting: false },
    reasoning: { supported: false, budgetControl: false, summaryAvailable: false },
    economics: { inputMicrosPerMillion: micros(0), cachedInputMicrosPerMillion: micros(0), outputMicrosPerMillion: micros(0), reasoningAccounting: false },
    reliability: { toolCallSuccess: 0.85, structuredOutputSuccess: 0.80, editCohortSuccess: 0.75, latencyPercentiles: { p50: 5000, p95: 15000, p99: 30000 } },
    policy: { allowedConfidentiality: ["public","workspace","secret_adjacent","secret"], retentionMode: "local_only", region: null },
  };
}

function mkModelSnapshot(providerId: string, modelKey: string, snap: ProviderCapabilitySnapshot): ModelCapabilitySnapshot {
  return { modelKey: `${providerId}/${modelKey}` as ModelKey, providerId, snapshot: snap, observedAt: "2026-07-23T00:00:00Z" };
}

function mkFragment(id: string, kind: string, text: string, confidentiality: ConfidentialityLabel = "workspace") {
  const modelKey = "openai/gpt-4o";
  return {
    id, kind, textContent: text,
    contentRef: { uri: `artifact://sha256/${"0".repeat(64)}`, hash: `sha256:${"0".repeat(64)}`, mediaType: "text/plain", bytes: BigInt(text.length) },
    confidentiality,
    estimatedTokens: { [modelKey]: Math.ceil(text.length / 4) },
    authority: kind === "authority" ? 100 : 50, priority: 50,
    trust: "trusted" as const, injectionRisk: "none" as const, exactness: "exact" as const,
    source: { uri: "terminus://test", producer: "test", producerVersion: "v1", observedAt: "2026-01-01T00:00:00Z", observedBy: "kernel" as const, evidenceRefs: [] },
    sourceVersion: null, scope: { workspaceId: null, sessionId: null, taskId: null, pathPatterns: [] },
    freshness: { observedAt: "2026-01-01T00:00:00Z", sourceVersion: null, stale: false, staleReason: null },
    dependencies: [] as readonly string[], invalidation: [] as readonly { readonly kind: string; readonly selector: string }[],
    selectionFeatures: { relevance: 1, novelty: 0, coverage: 1, uncertaintyReduction: 1, riskReduction: 1, modelCompatibility: 1, redundancyPenalty: 0, injectionPenalty: 0 },
  };
}

function mkToolSchema(id: string): ProviderToolSchema {
  return {
    id, version: "1.0.0", summary: `Tool: ${id}`,
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] },
    resultSchema: { type: "object", properties: { result: { type: "string" } } },
    sideEffectClass: "READ", requiredCapabilities: [], trustLevel: "builtin",
    maximumModelResultBytes: 4096, maximumArtifactBytes: 1048576, defaultTimeoutMs: 30000, policyTags: [],
  };
}

function mkRenderInput(
  provider: ProviderCapabilitySnapshot, model: ModelCapabilitySnapshot,
  fragments: readonly ReturnType<typeof mkFragment>[], overrides: Partial<CanonicalRenderInput> = {},
): CanonicalRenderInput {
  return {
    provider, model,
    fragments: fragments as unknown as CanonicalRenderInput["fragments"],
    toolSchemas: [],
    cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [] },
    continuationId: null, outputProfile: "terse",
    reasoningReserveTokens: 0n as TokenCount, outputReserveTokens: 4096n as TokenCount,
    hardInputLimit: 100000n as TokenCount, signal: null,
    manifestId: "01934567-89ab-7000-8000-cdef01234567",
    ...overrides,
  };
}

function mkChunk(kind: "text"|"tool_call"|"error"|"done", overrides: Partial<ProviderResponseChunk> = {}): ProviderResponseChunk {
  return {
    kind,
    text: kind === "text" ? "Hello" : undefined,
    ...overrides,
  };
}

// ───────────────────── 1. Role ordering ──────────────────────────────────────

describe("Provider conformance: role ordering (§38.6)", () => {
  test("OpenAI: system/developer/user/assistant ordering preserved", async () => {
    const renderer = new OpenAiRenderer();
    const fragments = [
      mkFragment("a","authority","System prompt."), mkFragment("p","project_rule","Rule text."),
      mkFragment("u","user_attachment","User msg."), mkFragment("r","recent_episode","Assistant reply."),
    ];
    const r = await renderer.render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), fragments));
    const msgs = (r.body as Record<string,unknown>)["messages"] as ReadonlyArray<{readonly role:string}>;
    expect(msgs[0]!.role).toBe("developer");
    expect(msgs[3]!.role).toBe("assistant");
  });

  test("Anthropic: system blocks separated from messages", async () => {
    const renderer = new AnthropicRenderer();
    const fragments = [mkFragment("a","authority","Sys."), mkFragment("u","user_attachment","User.")];
    const r = await renderer.render(mkRenderInput(anthropicCapabilitySnapshot(), mkModelSnapshot("anthropic","claude",anthropicCapabilitySnapshot()), fragments));
    const body = r.body as Record<string,unknown>;
    expect((body["system"] as ReadonlyArray<unknown>).length).toBe(1);
    expect(((body["messages"] as ReadonlyArray<{readonly role:string}>)[0]!).role).toBe("user");
  });

  test("Google: system instruction separated", async () => {
    const renderer = new GoogleRenderer();
    const r = await renderer.render(mkRenderInput(googleCapabilitySnapshot(), mkModelSnapshot("google","gemini",googleCapabilitySnapshot()), [mkFragment("a","authority","Sys."), mkFragment("u","user_attachment","User.")]));
    const body = r.body as Record<string,unknown>;
    expect(body["systemInstruction"]).toBeDefined();
  });

  test("Local: system message first", async () => {
    const renderer = new LocalRenderer();
    const r = await renderer.render(mkRenderInput(localCapabilitySnapshot(), mkModelSnapshot("local","llama3",localCapabilitySnapshot()), [mkFragment("a","authority","Sys."), mkFragment("u","user_attachment","User.")]));
    expect(((r.body as Record<string,unknown>)["messages"] as ReadonlyArray<{readonly role:string}>)[0]!.role).toBe("system");
  });
});

// ───────────────────── 2. Tool schemas ───────────────────────────────────────

describe("Provider conformance: tool schemas (§38.7)", () => {
  test("OpenAI: strict mode where the schema earns it", async () => {
    const renderer = new OpenAiRenderer();
    const r = await renderer.render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), [], { toolSchemas: [mkToolSchema("search")] }));
    const tools = (r.body as Record<string,unknown>)["tools"] as ReadonlyArray<{readonly function:{readonly strict:boolean}}>;
    expect(tools[0]!.function.strict).toBe(true);
  });

  test("OpenAI: no strict claim for a schema with an optional parameter", async () => {
    // OpenAI rejects `strict: true` unless `required` lists every property.
    // Trust level cannot make that true, so it does not decide the flag.
    const optional = mkToolSchema("read");
    const renderer = new OpenAiRenderer();
    const r = await renderer.render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), [], {
      toolSchemas: [{
        ...optional,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" }, max_bytes: { type: "integer", minimum: 1 } },
        },
      }],
    }));
    const tools = (r.body as Record<string,unknown>)["tools"] as ReadonlyArray<{readonly function:{readonly strict:boolean}}>;
    expect(tools[0]!.function.strict).toBe(false);
  });

  test("Anthropic: renders input_schema", async () => {
    const renderer = new AnthropicRenderer();
    const r = await renderer.render(mkRenderInput(anthropicCapabilitySnapshot(), mkModelSnapshot("anthropic","claude",anthropicCapabilitySnapshot()), [], { toolSchemas: [mkToolSchema("read")] }));
    expect(((r.body as Record<string,unknown>)["tools"] as ReadonlyArray<{readonly input_schema:unknown}>)[0]!.input_schema).toBeDefined();
  });

  test("Google: function declarations", async () => {
    const renderer = new GoogleRenderer();
    const r = await renderer.render(mkRenderInput(googleCapabilitySnapshot(), mkModelSnapshot("google","gemini",googleCapabilitySnapshot()), [], { toolSchemas: [mkToolSchema("search")] }));
    const tools = (r.body as Record<string,unknown>)["tools"] as ReadonlyArray<{readonly functionDeclarations:ReadonlyArray<{readonly name:string}>}>;
    expect(tools[0]!.functionDeclarations[0]!.name).toBe("search");
  });
});

// ───────────────────── 3. Continuation IDs ───────────────────────────────────

describe("Provider conformance: continuation IDs (§38.8)", () => {
  test("OpenAI: previous_response_id", async () => {
    const r = await new OpenAiRenderer().render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), [], { continuationId: "resp_abc" }));
    expect((r.body as Record<string,unknown>)["previous_response_id"]).toBe("resp_abc");
  });

  test("Anthropic: no native continuation field", async () => {
    const r = await new AnthropicRenderer().render(mkRenderInput(anthropicCapabilitySnapshot(), mkModelSnapshot("anthropic","claude",anthropicCapabilitySnapshot()), [], { continuationId: "x" }));
    expect((r.body as Record<string,unknown>)["previous_response_id"]).toBeUndefined();
  });

  test("Google: cachedContent", async () => {
    const r = await new GoogleRenderer().render(mkRenderInput(googleCapabilitySnapshot(), mkModelSnapshot("google","gemini",googleCapabilitySnapshot()), [], { continuationId: "cache-xyz" }));
    expect((r.body as Record<string,unknown>)["cachedContent"]).toBe("cache-xyz");
  });
});

// ───────────────────── 4. Token accounting ───────────────────────────────────

describe("Provider conformance: token accounting (§38.14)", () => {
  test("OpenAI: extracts usage from last chunk", () => {
    const u = new OpenAiRenderer().extractUsage({ providerId:"openai", model:"gpt-4o" as ModelKey, chunks:[
      mkChunk("text",{text:"Hi"}), mkChunk("done",{usage:{inputTokens:50n as TokenCount,cachedInputTokens:10n as TokenCount,cacheWriteTokens:5n as TokenCount,outputTokens:20n as TokenCount,reasoningTokens:0n as TokenCount,toolSchemaTokens:5n as TokenCount,latencyMs:300,timeToFirstTokenMs:100}})], observedAt:"2026-01-01T00:00:00Z"});
    expect(u.inputTokens).toBe(50n as TokenCount);
    expect(u.cachedInputTokens).toBe(10n as TokenCount);
  });

  test("Anthropic: extracts reasoning tokens", () => {
    const u = new AnthropicRenderer().extractUsage({ providerId:"anthropic", model:"claude" as ModelKey, chunks:[
      mkChunk("done",{usage:{inputTokens:100n as TokenCount,cachedInputTokens:20n as TokenCount,cacheWriteTokens:10n as TokenCount,outputTokens:30n as TokenCount,reasoningTokens:15n as TokenCount,toolSchemaTokens:3n as TokenCount,latencyMs:500,timeToFirstTokenMs:150}})], observedAt:"2026-01-01T00:00:00Z"});
    expect(u.reasoningTokens).toBe(15n as TokenCount);
  });
});

// ───────────────────── 5. Error projection ───────────────────────────────────

describe("Provider conformance: error projection (§38.11)", () => {
  test("OpenAI: error → finishReason=error", async () => {
    const p = await new OpenAiRenderer().projectResponse({ providerId:"openai", model:"gpt-4o" as ModelKey, chunks:[mkChunk("error",{errorCode:"RATE_LIMITED"})], observedAt:"2026-01-01T00:00:00Z"});
    expect(p.finishReason).toBe("error");
  });

  test("Anthropic: error → finishReason=error", async () => {
    const p = await new AnthropicRenderer().projectResponse({ providerId:"anthropic", model:"claude" as ModelKey, chunks:[mkChunk("error",{errorCode:"OVERLOADED"})], observedAt:"2026-01-01T00:00:00Z"});
    expect(p.finishReason).toBe("error");
  });
});

// ───────────────────── 6. Reasoning + tool calls ─────────────────────────────

describe("Provider conformance: projected response (§38.10)", () => {
  test("OpenAI: projects tool calls and reasoning", async () => {
    const p = await new OpenAiRenderer().projectResponse({ providerId:"openai", model:"gpt-4o" as ModelKey, chunks:[
      mkChunk("text",{text:"Let me search...",reasoning:"I need the file."}),
      mkChunk("tool_call",{toolCall:{toolCallId:"c1",toolName:"search",arguments:{query:"x"}}}),
      mkChunk("done",{continuationId:"cont-123"}),
    ], observedAt:"2026-01-01T00:00:00Z"});
    expect(p.text).toContain("Let me search");
    expect(p.reasoning).toContain("I need the file");
    expect(p.toolCalls.length).toBe(1);
    expect(p.finishReason).toBe("tool_use");
    expect(p.continuationId).toBe("cont-123");
  });
});

// ───────────────────── 7. Cache controls ─────────────────────────────────────

describe("Provider conformance: cache controls (§38.9)", () => {
  test("OpenAI: cache_control at breakpoint", async () => {
    const r = await new OpenAiRenderer().render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), [
      mkFragment("a","authority","Sys."), mkFragment("u","user_attachment","User."),
    ], { cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [1] } }));
    const msgs = (r.body as Record<string,unknown>)["messages"] as ReadonlyArray<{readonly cache_control?:string}>;
    expect(msgs[1]!["cache_control"]).toBe("ephemeral");
  });
});

// ───────────────────── 8. Confidentiality ────────────────────────────────────

describe("Provider conformance: confidentiality (§38.18)", () => {
  test("filterByConfidentiality: admits allowed, omits disallowed", () => {
    const policy: ConfidentialityPolicy = { allowedProviders: { public:["openai"], workspace:["openai"], secret_adjacent:[], secret:[] } };
    const frags = [mkFragment("a","authority","Public.","public"), mkFragment("b","code","Secret.","secret")];
    const f = filterByConfidentiality(policy, "openai", frags as unknown as Parameters<typeof filterByConfidentiality>[2]);
    expect(f.admitted.length).toBe(1);
    expect(f.omitted.length).toBe(1);
  });

  test("isConfidentialityAllowed: correct boolean", () => {
    const policy: ConfidentialityPolicy = { allowedProviders: { public:["openai"], workspace:["openai","anthropic"], secret_adjacent:["anthropic"], secret:[] } };
    expect(isConfidentialityAllowed(policy,"openai","workspace")).toBe(true);
    expect(isConfidentialityAllowed(policy,"openai","secret")).toBe(false);
    expect(isConfidentialityAllowed(policy,"anthropic","secret_adjacent")).toBe(true);
  });
});

// ───────────────────── 9. Tool-choice semantics ──────────────────────────────

describe("Provider conformance: tool-choice (§38.7)", () => {
  test("OpenAI: no tool_choice by default", async () => {
    const r = await new OpenAiRenderer().render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), [], { toolSchemas: [mkToolSchema("s")] }));
    expect((r.body as Record<string,unknown>)["tool_choice"]).toBeUndefined();
  });

  test("Google: toolConfig AUTO when tools present", async () => {
    const r = await new GoogleRenderer().render(mkRenderInput(googleCapabilitySnapshot(), mkModelSnapshot("google","gemini",googleCapabilitySnapshot()), [], { toolSchemas: [mkToolSchema("s")] }));
    const tc = (r.body as Record<string,unknown>)["toolConfig"] as {readonly functionCallingConfig:{readonly mode:string}};
    expect(tc.functionCallingConfig.mode).toBe("AUTO");
  });

  test("Google: no toolConfig without tools", async () => {
    const r = await new GoogleRenderer().render(mkRenderInput(googleCapabilitySnapshot(), mkModelSnapshot("google","gemini",googleCapabilitySnapshot()), [], { toolSchemas: [] }));
    expect((r.body as Record<string,unknown>)["toolConfig"]).toBeUndefined();
  });
});

// ───────────────────── 10. Structured output ─────────────────────────────────

describe("Provider conformance: structured output (§38.7)", () => {
  test("OpenAI: structured → temperature=0", async () => {
    const r = await new OpenAiRenderer().render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), [], { outputProfile:"structured" }));
    expect((r.body as Record<string,unknown>)["temperature"]).toBe(0);
  });

  test("OpenAI: reasoning → reasoning_effort", async () => {
    const r = await new OpenAiRenderer().render(mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), [], { reasoningReserveTokens: 1000n as TokenCount }));
    expect((r.body as Record<string,unknown>)["reasoning_effort"]).toBe("medium");
  });

  test("Google: reasoning → thinkingConfig", async () => {
    const r = await new GoogleRenderer().render(mkRenderInput(googleCapabilitySnapshot(), mkModelSnapshot("google","gemini",googleCapabilitySnapshot()), [], { reasoningReserveTokens: 5000n as TokenCount }));
    const gc = (r.body as Record<string,unknown>)["generationConfig"] as {readonly thinkingConfig?:{readonly includeThoughts:boolean}};
    expect(gc.thinkingConfig!.includeThoughts).toBe(true);
  });
});

// ───────────────────── 11. Cancellation & partial-stream ─────────────────────

describe("Provider conformance: partial-stream settlement (§38.12)", () => {
  test("settlePartialStream: records text, computes cost", () => {
    const chunks = [mkChunk("text",{text:"Partial"}), mkChunk("done",{usage:{inputTokens:100n as TokenCount,cachedInputTokens:0n as TokenCount,cacheWriteTokens:0n as TokenCount,outputTokens:5n as TokenCount,reasoningTokens:0n as TokenCount,toolSchemaTokens:0n as TokenCount,latencyMs:200,timeToFirstTokenMs:50}})];
    const r = settlePartialStream(chunks, "user", openAiCapabilitySnapshot().economics);
    expect(r.textReceived).toBe("Partial");
    expect(r.continuationPossible).toBe(true);
  });

  test("settlePartialStream: tool calls in flight block continuation", () => {
    const r = settlePartialStream([mkChunk("tool_call",{toolCall:{toolCallId:"t1",toolName:"search",arguments:{}}})], "timeout", openAiCapabilitySnapshot().economics);
    expect(r.continuationPossible).toBe(false);
  });

  test("settlePartialStream: zero cost with no usage", () => {
    const r = settlePartialStream([mkChunk("text",{text:"x"})], "budget", openAiCapabilitySnapshot().economics);
    expect(r.costAccrued).toBe(0n as Micros);
  });
});

// ───────────────────── 12. Compatibility ─────────────────────────────────────

describe("Provider conformance: compatibility (§38.3)", () => {
  test("OpenAI: rejects >128 tools", () => {
    const tools = Array.from({length:129},(_,i)=>mkToolSchema(`t${i}`));
    const r = new OpenAiRenderer().compatibility({ provider:openAiCapabilitySnapshot(), model:mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), fragments:[] as unknown as Parameters<OpenAiRenderer["compatibility"]>[0]["fragments"], toolSchemas:tools, hardInputLimit:100000n as TokenCount });
    expect(r.compatible).toBe(false);
    expect(r.incompatibilities).toContain("OpenAI supports at most 128 tools");
  });

  test("Anthropic: rejects >200 tools", () => {
    const tools = Array.from({length:201},(_,i)=>mkToolSchema(`t${i}`));
    const r = new AnthropicRenderer().compatibility({ provider:anthropicCapabilitySnapshot(), model:mkModelSnapshot("anthropic","claude",anthropicCapabilitySnapshot()), fragments:[] as unknown as Parameters<AnthropicRenderer["compatibility"]>[0]["fragments"], toolSchemas:tools, hardInputLimit:200000n as TokenCount });
    expect(r.compatible).toBe(false);
  });
});

// ───────────────────── 13. Compilation authority ─────────────────────────────

describe("Provider conformance: compilation authority (§33.13)", () => {
  test("OpenAI: throws without manifestId", async () => {
    const input = mkRenderInput(openAiCapabilitySnapshot(), mkModelSnapshot("openai","gpt-4o",openAiCapabilitySnapshot()), []);
    await expect(new OpenAiRenderer().render({...input, manifestId:undefined})).rejects.toThrow("bypassed Context Compiler");
  });

  test("Anthropic: throws without manifestId", async () => {
    const input = mkRenderInput(anthropicCapabilitySnapshot(), mkModelSnapshot("anthropic","claude",anthropicCapabilitySnapshot()), []);
    await expect(new AnthropicRenderer().render({...input, manifestId:undefined})).rejects.toThrow("bypassed Context Compiler");
  });
});

// ───────────────────── 14. Exit gate ─────────────────────────────────────────

describe("Exit gate", () => {
  test("passes when all providers meet gates", async () => {
    const results: Record<string, ProviderGateResult> = {};
    for (const pid of ["openai","anthropic","google","local"]) {
      results[pid] = buildProviderGateResult(pid, { rendersParseable:true, costsReconcile:true, cacheBehavesUnderFailure:true, fallbackPolicyCompliant:true, confidentialityEnforced:true, errorsProjectCorrectly:true });
    }
    expect((await runExitGate(results)).passed).toBe(true);
  });

  test("fails with reconciliation gap", async () => {
    const results: Record<string, ProviderGateResult> = { openai: buildProviderGateResult("openai", { rendersParseable:true, costsReconcile:false, cacheBehavesUnderFailure:true, fallbackPolicyCompliant:true, confidentialityEnforced:true, errorsProjectCorrectly:true }, ["pricing outdated"]) };
    const gate = await runExitGate(results);
    expect(gate.passed).toBe(false);
    expect(gate.failedTests).toContain("openai: costs did not reconcile");
  });
});
