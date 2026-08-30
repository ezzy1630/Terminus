import { describe, expect, test } from "bun:test";
import type { ModelKey, TokenCount, ContentHash, Uuid7 } from "@terminus/domain";
import { micros } from "@terminus/domain";
import type {
  CanonicalRenderInput,
  ContextFragment,
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderResponseChunk,
  ProviderToolSchema,
} from "@terminus/provider-core";
import { ReasoningReplayLedger } from "@terminus/provider-core";
import {
  AnthropicRenderer,
  anthropicBetaHeader,
  anthropicRequiredBetas,
  anthropicSupportsEffort,
  anthropicThinkingGeneration,
  renderRequest,
  decodeAnthropicMessagesStream,
} from "./index.js";

const DEFAULT_PROVIDER_CAPS: ProviderCapabilitySnapshot = {
  providerId: "anthropic",
  observedAt: "2026-08-24T00:00:00Z",
  source: "test",
  context: {
    advertisedTokens: 200_000,
    testedSafeTokens: 180_000,
    roleSupport: ["system", "user", "assistant"],
    imageInput: true,
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
  },
  continuation: {
    nativeId: false,
    crossRequest: false,
    compaction: false,
    compatibilityKey: "anthropic-messages-v1",
  },
  caching: {
    mode: "explicit_breakpoints",
    exactPrefixRequired: true,
    minimumTokens: 1024,
    ttlOptions: ["5m"],
    toolOrderSensitive: true,
    usageReporting: true,
  },
  reasoning: {
    supported: true,
    budgetControl: true,
    summaryAvailable: true,
  },
  economics: {
    inputMicrosPerMillion: micros(3_000_000),
    cachedInputMicrosPerMillion: micros(300_000),
    outputMicrosPerMillion: micros(15_000_000),
    reasoningAccounting: true,
  },
  reliability: {
    toolCallSuccess: 0.95,
    structuredOutputSuccess: 0.96,
    editCohortSuccess: 0.90,
    latencyPercentiles: { p50: 1200, p95: 4000, p99: 8000 },
  },
  policy: {
    allowedConfidentiality: ["public", "workspace", "secret_adjacent", "secret"],
    retentionMode: "30d",
    region: "us-east-1",
  },
};

const DEFAULT_MODEL_KEY = "anthropic/claude-3-5-sonnet" as ModelKey;

const DEFAULT_MODEL_CAPS: ModelCapabilitySnapshot = {
  modelKey: DEFAULT_MODEL_KEY,
  providerId: "anthropic",
  snapshot: DEFAULT_PROVIDER_CAPS,
  observedAt: "2026-08-24T00:00:00Z",
};

const DUMMY_TOOL: ProviderToolSchema = {
  id: "read",
  version: "1.0.0",
  summary: "Read file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  resultSchema: { type: "object", properties: { content: { type: "string" } } },
  sideEffectClass: "READ_ONLY",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 4096,
  maximumArtifactBytes: 1048576,
  defaultTimeoutMs: 5000,
  policyTags: [],
};

function mkFragment(id: string, kind: string, text: string): ContextFragment {
  return {
    id,
    kind: kind as ContextFragment["kind"],
    textContent: text,
    contentRef: { uri: `artifact://${id}` as any, hash: `sha256:${id}` as ContentHash, mediaType: "text/plain", bytes: 100n as any },
    source: { uri: `test://${id}`, producer: "test", producerVersion: "1.0", observedAt: "2026-08-24T00:00:00Z" as any, observedBy: "control", evidenceRefs: [] },
    sourceVersion: null,
    authority: 100,
    priority: 1,
    trust: "trusted",
    confidentiality: "workspace",
    injectionRisk: "none",
    exactness: "exact",
    scope: { workspaceId: null, sessionId: null, taskId: null, pathPatterns: [] },
    freshness: { observedAt: "2026-08-24T00:00:00Z" as any, sourceVersion: null, stale: false, staleReason: null },
    dependencies: [],
    invalidation: [],
    estimatedTokens: { [DEFAULT_MODEL_KEY]: 25 } as any,
    selectionFeatures: { relevance: 1, novelty: 1, coverage: 1, uncertaintyReduction: 1, riskReduction: 1, modelCompatibility: 1, redundancyPenalty: 0, injectionPenalty: 0 },
  };
}

const CLAUDE_5_MODEL_KEY = "claude-opus-5" as ModelKey;

/** A render input pinned to a model on the adaptive-thinking generation. */
function claude5Input(): CanonicalRenderInput {
  return {
    provider: DEFAULT_PROVIDER_CAPS,
    model: { ...DEFAULT_MODEL_CAPS, modelKey: CLAUDE_5_MODEL_KEY },
    manifestId: "01934567-89ab-7000-8000-cdef0123456a" as Uuid7,
    fragments: [
      mkFragment("f1", "authority", "System instructions."),
      mkFragment("f2", "user_attachment", "Read a.ts"),
    ],
    toolSchemas: [],
    cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [] },
    continuationId: null,
    outputProfile: "terse",
    reasoningReserveTokens: 32_768n as TokenCount,
    outputReserveTokens: 128_000n as TokenCount,
    hardInputLimit: 900_000n as TokenCount,
    signal: null,
  };
}

describe("Anthropic Messages Connector", () => {
  test("renders valid Anthropic Messages API request body with thinking and cache control", async () => {
    const input: CanonicalRenderInput = {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [
        mkFragment("f1", "authority", "System instructions."),
        mkFragment("f2", "user_attachment", "Please read index.ts"),
      ],
      toolSchemas: [DUMMY_TOOL],
      cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [0] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 2048n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    };

    const rendered = await renderRequest(input);
    const body = rendered.body as Record<string, unknown>;

    expect(body.model).toBe("anthropic/claude-3-5-sonnet");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(4096);

    const system = body.system as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toBe("System instructions.");
    expect(system[0]!.cache_control?.type).toBe("ephemeral");

    const thinking = body.thinking as { type: string; budget_tokens: number };
    expect(thinking).toBeDefined();
    expect(thinking.type).toBe("enabled");
    expect(thinking.budget_tokens).toBe(2048);

    const tools = body.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("read");
    expect(tools[0]!.input_schema).toBeDefined();

    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Please read index.ts");
  });

  test("renders multi-turn tool interaction with linked tool_use and tool_result blocks", async () => {
    const input: CanonicalRenderInput = {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "01934567-89ab-7000-8000-cdef01234568" as Uuid7,
      fragments: [
        mkFragment("f1", "authority", "System instructions."),
        mkFragment("f2", "user_attachment", "Read index.ts"),
        mkFragment("f3", "recent_episode", JSON.stringify({
          protocol: "terminus.tool-call.v1",
          provider_call_id: "toolu_123",
          tool_name: "read",
          arguments: { path: "index.ts" },
        })),
        mkFragment("f4", "tool_result", JSON.stringify({
          protocol: "terminus.tool-result.v1",
          provider_call_id: "toolu_123",
          tool_name: "read",
          result: "console.log('hello');",
          is_error: false,
        })),
      ],
      toolSchemas: [DUMMY_TOOL],
      cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 0n as TokenCount,
      outputReserveTokens: 2048n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    };

    const rendered = await renderRequest(input);
    const body = rendered.body as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }>;

    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Read index.ts");

    expect(messages[1]!.role).toBe("assistant");
    const assistantContent = messages[1]!.content as Array<{ type: string; id: string; name: string; input: unknown }>;
    expect(assistantContent[0]!.type).toBe("tool_use");
    expect(assistantContent[0]!.id).toBe("toolu_123");
    expect(assistantContent[0]!.name).toBe("read");

    expect(messages[2]!.role).toBe("user");
    const userContent = messages[2]!.content as Array<{ type: string; tool_use_id: string; content: string; is_error?: boolean }>;
    expect(userContent[0]!.type).toBe("tool_result");
    expect(userContent[0]!.tool_use_id).toBe("toolu_123");
    expect(userContent[0]!.content).toBe("console.log('hello');");
  });

  test("streams and decodes Anthropic Messages API SSE frames with thinking and cache usage", async () => {
    async function* anthropicSseGenerator(): AsyncIterable<string> {
      yield "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_123\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-3-5-sonnet\",\"usage\":{\"input_tokens\":150,\"cache_read_input_tokens\":100,\"cache_creation_input_tokens\":50}}}\n\n";
      yield "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n";
      yield "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Analyzing code structure...\"}}\n\n";
      yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n";
      yield "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_abc\",\"name\":\"read\",\"input\":{}}}\n\n";
      yield "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\": \\\"src/main.rs\\\"}\"}}\n\n";
      yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n";
      yield "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":45}}\n\n";
      yield "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    }

    const chunks: any[] = [];
    for await (const chunk of decodeAnthropicMessagesStream(anthropicSseGenerator())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ kind: "text", reasoning: "Analyzing code structure..." });
    expect(chunks[1]).toEqual({
      kind: "tool_call",
      toolCall: {
        toolCallId: "toolu_abc",
        toolName: "read",
        arguments: { path: "src/main.rs" },
      },
    });
    expect(chunks[2]).toEqual({
      kind: "done",
      providerRequestId: "msg_123",
      stopReason: "tool_use",
      usage: {
        inputTokens: 150n as TokenCount,
        cachedInputTokens: 100n as TokenCount,
        cacheWriteTokens: 50n as TokenCount,
        outputTokens: 45n as TokenCount,
        reasoningTokens: 0n as TokenCount,
        toolSchemaTokens: 0n as TokenCount,
        latencyMs: 0,
        timeToFirstTokenMs: null,
      },
    });
  });

  test("classifies a model id by the thinking interface it accepts", () => {
    for (const id of [
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-mythos-5",
      "anthropic/claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]) {
      expect(anthropicThinkingGeneration(id)).toBe("adaptive");
      expect(anthropicSupportsEffort(id)).toBe(true);
    }
    // `-4-5` is a 4.x minor, not "version 5": it keeps `budget_tokens`.
    for (const id of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5", "claude-3-5-sonnet-20241022"]) {
      expect(anthropicThinkingGeneration(id)).toBe("budget");
      expect(anthropicSupportsEffort(id)).toBe(false);
    }
  });

  test("renders adaptive thinking and output_config.effort for a Claude 5 model", async () => {
    const rendered = await renderRequest(
      claude5Input(),
      { reasoningEffort: "max" },
    );
    const body = rendered.body as Record<string, unknown>;

    // `{type:"enabled", budget_tokens}` is a hard 400 on this generation, and
    // so is any sampling parameter sent alongside thinking.
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(JSON.stringify(body)).not.toContain("budget_tokens");
  });

  test("omits output_config when the user chose no effort", async () => {
    const rendered = await renderRequest(claude5Input());
    const body = rendered.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body).not.toHaveProperty("output_config");
  });

  test("asks for summarized thinking only when the caller wants to show it", async () => {
    const rendered = await renderRequest(claude5Input(), { thinkingDisplay: "summarized" });
    expect((rendered.body as Record<string, unknown>).thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  test("sends no thinking block for a pre-4.6 model that does not reason", async () => {
    const input = claude5Input();
    const provider = {
      ...DEFAULT_PROVIDER_CAPS,
      reasoning: { supported: false, budgetControl: false, summaryAvailable: false },
    };
    const legacyModelId = "claude-3-5-haiku-20241022" as ModelKey;
    const rendered = await renderRequest({
      ...input,
      provider,
      model: { ...DEFAULT_MODEL_CAPS, modelKey: legacyModelId, snapshot: provider },
      outputProfile: "terse",
    });
    const body = rendered.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("thinking");
    // With no thinking on the wire the sampling hint is legal again.
    expect(body.temperature).toBe(0.2);
  });

  test("surfaces a refusal as its own terminal stop kind", async () => {
    async function* refusalSse(): AsyncIterable<string> {
      yield "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_r\",\"usage\":{\"input_tokens\":10}}}\n\n";
      yield "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\",\"stop_details\":{\"type\":\"refusal\",\"category\":\"cyber\",\"explanation\":\"declined\"}},\"usage\":{\"output_tokens\":0}}\n\n";
      yield "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    }
    const chunks: ProviderResponseChunk[] = [];
    for await (const chunk of decodeAnthropicMessagesStream(refusalSse())) chunks.push(chunk);
    const done = chunks[chunks.length - 1]!;
    expect(done.stopReason).toBe("refusal");
    expect(done.stopDetail).toBe("cyber: declined");

    // A refusal is an HTTP 200, not an error chunk: nothing here throws, and
    // the loop is told plainly that the turn was declined.
    expect(chunks.some((chunk) => chunk.kind === "error")).toBe(false);
    const projected = await new AnthropicRenderer().projectResponse({
      providerId: "anthropic",
      model: "claude-opus-5" as ModelKey,
      chunks,
      observedAt: "2026-08-29T00:00:00Z",
    });
    expect(projected.finishReason).toBe("refusal");
    expect(projected.refusalReason).toBe("cyber: declined");
  });

  test("replays a thinking block, signature intact, ahead of the call it produced", async () => {
    async function* thinkingSse(): AsyncIterable<string> {
      yield "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n";
      yield "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"weigh options\"}}\n\n";
      yield "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"SIG-\"}}\n\n";
      yield "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"XYZ\"}}\n\n";
      yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n";
      yield "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_9\",\"name\":\"read\",\"input\":{\"path\":\"a.ts\"}}}\n\n";
      yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n";
      yield "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    }
    const chunks: ProviderResponseChunk[] = [];
    for await (const chunk of decodeAnthropicMessagesStream(thinkingSse())) chunks.push(chunk);

    const renderer = new AnthropicRenderer();
    await renderer.projectResponse({
      providerId: "anthropic",
      model: "claude-opus-5" as ModelKey,
      chunks,
      observedAt: "2026-08-29T00:00:00Z",
    });
    expect(renderer.reasoningReplay.itemsFor("toolu_9")).toEqual([
      { id: "thinking:0", encryptedContent: "SIG-XYZ", summary: ["weigh options"] },
    ]);

    const input = claude5Input();
    const rendered = await renderer.render({
      ...input,
      fragments: [
        ...input.fragments,
        mkFragment("f9", "recent_episode", JSON.stringify({
          protocol: "terminus.tool-call.v1",
          provider_call_id: "toolu_9",
          tool_name: "read",
          arguments: { path: "a.ts" },
        })),
      ],
    });
    const messages = (rendered.body as Record<string, unknown>).messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const assistant = messages.find((message) => message.role === "assistant")!;
    // The thinking block leads the turn and carries the signature byte for
    // byte: dropping or editing it is an ordering/signature 400.
    expect(assistant.content[0]).toEqual({
      type: "thinking",
      thinking: "weigh options",
      signature: "SIG-XYZ",
    });
    expect(assistant.content[1]!.type).toBe("tool_use");
  });

  test("asks for an anthropic-beta header only when a field needs one", () => {
    expect(anthropicRequiredBetas({ model: "claude-opus-5", thinking: { type: "adaptive" } })).toEqual([]);
    expect(anthropicBetaHeader({ model: "claude-opus-5", output_config: { effort: "high" } })).toBeNull();
    expect(anthropicRequiredBetas({
      context_management: { edits: [{ type: "clear_thinking_20251015" }, { type: "compact_20260112" }] },
      output_config: { task_budget: { type: "tokens", total: 64_000 } },
      fallbacks: "default",
    })).toEqual([
      "context-management-2025-06-27",
      "task-budgets-2026-03-13",
      "compact-2026-01-12",
      "server-side-fallback-2026-07-01",
    ]);
  });
});

describe("cache breakpoints are rendered, not ignored", () => {
  const toolCallFragment = mkFragment("f3", "recent_episode", JSON.stringify({
    protocol: "terminus.tool-call.v1",
    provider_call_id: "toolu_123",
    tool_name: "read",
    arguments: { path: "index.ts" },
  }));
  const toolResultFragment = mkFragment("f4", "tool_result", JSON.stringify({
    protocol: "terminus.tool-result.v1",
    provider_call_id: "toolu_123",
    tool_name: "read",
    result: "console.log('hello');",
    is_error: false,
  }));

  function planned(breakpoints: readonly number[]): CanonicalRenderInput {
    const base = claude5Input();
    return {
      ...base,
      fragments: [
        mkFragment("f1", "authority", "System instructions."),
        mkFragment("f2", "user_attachment", "Read index.ts"),
        toolCallFragment,
        toolResultFragment,
      ],
      cachePlan: { ...base.cachePlan, breakpoints: [...breakpoints] },
    };
  }

  test("the prefix breakpoint lands on the last system block and the tail on the last content block", async () => {
    // The compiler emits exactly this pair: last stable-prefix fragment, and
    // last fragment overall.
    const body = (await renderRequest(planned([0, 3]))).body as Record<string, unknown>;
    const system = body.system as Array<{ cache_control?: { type: string } }>;
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control?.type).toBe("ephemeral");

    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const tail = messages[messages.length - 1]!.content as Array<{ type: string; cache_control?: { type: string } }>;
    expect(tail[tail.length - 1]!.type).toBe("tool_result");
    // Without this the next turn re-processes the whole transcript at full
    // price and only the system prefix is ever read back.
    expect(tail[tail.length - 1]!.cache_control?.type).toBe("ephemeral");
  });

  test("a breakpoint index means the same fragment on the system and message sides", async () => {
    // Fragment 1 is the first *message* fragment; the marker must land there
    // and nowhere in `system`.
    const body = (await renderRequest(planned([1]))).body as Record<string, unknown>;
    const system = body.system as Array<{ cache_control?: { type: string } }>;
    expect(system[0]!.cache_control).toBeUndefined();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const first = messages[0]!.content as Array<{ type: string; text?: string; cache_control?: { type: string } }>;
    // A bare-string message is promoted to the one-block form so it can carry
    // the marker at all.
    expect(Array.isArray(first)).toBe(true);
    expect(first[0]!.type).toBe("text");
    expect(first[0]!.text).toBe("Read index.ts");
    expect(first[0]!.cache_control?.type).toBe("ephemeral");
  });

  test("no breakpoints means no markers anywhere", async () => {
    const body = (await renderRequest(planned([]))).body as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  test("the marker never lands on a thinking block", async () => {
    const ledger = new ReasoningReplayLedger();
    ledger.record("toolu_123", [{ id: "rs_1", encryptedContent: "sig-1", summary: ["weighing options"] }]);
    const input: CanonicalRenderInput = {
      ...planned([2]),
      // Breakpoint 2 is the tool-call fragment, which renders as a thinking
      // block followed by the tool_use block it produced.
      fragments: [
        mkFragment("f1", "authority", "System instructions."),
        mkFragment("f2", "user_attachment", "Read index.ts"),
        toolCallFragment,
      ],
    };
    const renderer = new AnthropicRenderer({ reasoningReplay: ledger });
    const body = (await renderer.render(input)).body as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const assistant = messages[messages.length - 1]!.content as Array<{ type: string; cache_control?: { type: string } }>;
    expect(assistant[0]!.type).toBe("thinking");
    expect(assistant[0]!.cache_control).toBeUndefined();
    expect(assistant[1]!.type).toBe("tool_use");
    expect(assistant[1]!.cache_control?.type).toBe("ephemeral");
  });
});
