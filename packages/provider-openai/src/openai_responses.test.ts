import { describe, expect, test } from "bun:test";
import type { ModelKey, TokenCount, ContentHash, Uuid7 } from "@terminus/domain";
import { micros } from "@terminus/domain";
import type {
  CanonicalRenderInput,
  ContextFragment,
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderToolSchema,
} from "@terminus/provider-core";
import {
  OpenAiRenderer,
  ReasoningReplayLedger,
  renderResponsesRequest,
  decodeOpenAiResponsesStream,
  decodeOpenAiChatStream,
  schemaSatisfiesStrictMode,
  toResponsesInputItems,
  type OpenAiChatMessage,
} from "./index.js";

const DEFAULT_PROVIDER_CAPS: ProviderCapabilitySnapshot = {
  providerId: "openai",
  observedAt: "2026-08-24T00:00:00Z",
  source: "test",
  context: {
    advertisedTokens: 128_000,
    testedSafeTokens: 100_000,
    roleSupport: ["system", "user", "assistant", "tool", "developer"],
    imageInput: true,
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
  },
  continuation: {
    nativeId: true,
    crossRequest: true,
    compaction: false,
    compatibilityKey: "openai-responses-v1",
  },
  caching: {
    mode: "automatic_prefix",
    exactPrefixRequired: true,
    minimumTokens: 1024,
    ttlOptions: ["5m", "1h"],
    toolOrderSensitive: false,
    usageReporting: true,
  },
  reasoning: {
    supported: true,
    budgetControl: true,
    summaryAvailable: true,
  },
  economics: {
    inputMicrosPerMillion: micros(2_500_000),
    cachedInputMicrosPerMillion: micros(1_250_000),
    outputMicrosPerMillion: micros(10_000_000),
    reasoningAccounting: true,
  },
  reliability: {
    toolCallSuccess: 0.96,
    structuredOutputSuccess: 0.97,
    editCohortSuccess: 0.88,
    latencyPercentiles: { p50: 800, p95: 3000, p99: 6000 },
  },
  policy: {
    allowedConfidentiality: ["public", "workspace", "secret_adjacent"],
    retentionMode: "organization_zdr",
    region: "us-east-1",
  },
};

const DEFAULT_MODEL_KEY = "openai/gpt-4o" as ModelKey;

const DEFAULT_MODEL_CAPS: ModelCapabilitySnapshot = {
  modelKey: DEFAULT_MODEL_KEY,
  providerId: "openai",
  snapshot: DEFAULT_PROVIDER_CAPS,
  observedAt: "2026-08-24T00:00:00Z",
};

const DUMMY_TOOL: ProviderToolSchema = {
  id: "search",
  version: "1.0.0",
  summary: "Search workspace",
  // Strict-shaped on purpose: every property required, no open extension.
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  resultSchema: { type: "object", properties: { results: { type: "array" } } },
  sideEffectClass: "READ_ONLY",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 4096,
  maximumArtifactBytes: 1048576,
  defaultTimeoutMs: 5000,
  policyTags: [],
};

/**
 * The shape that broke a live Codex turn: a builtin tool whose optional
 * parameters carry defaults, so `required` cannot list every property.
 */
const OPTIONAL_PARAM_TOOL: ProviderToolSchema = {
  ...DUMMY_TOOL,
  id: "read",
  summary: "Read a bounded projection of one file",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string" },
      max_bytes: { type: "integer", minimum: 1, maximum: 30 * 1_024, default: 28 * 1_024 },
    },
  },
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

describe("OpenAI Responses Connector", () => {
  test("renders valid OpenAI Responses API request body", async () => {
    const input: CanonicalRenderInput = {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [
        mkFragment("f1", "authority", "System instructions."),
        mkFragment("f2", "user_attachment", "Search for main.rs"),
      ],
      toolSchemas: [DUMMY_TOOL],
      cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [] },
      continuationId: "resp_12345",
      outputProfile: "terse",
      reasoningReserveTokens: 500n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      estimatedInputTokens: 100n as TokenCount,
      predictedCacheWriteTokens: 75n as TokenCount,
      signal: null,
    };

    const rendered = await renderResponsesRequest(input);
    const body = rendered.body as Record<string, unknown>;

    expect(body.model).toBe("openai/gpt-4o");
    expect(body.stream).toBe(true);
    // Stateless by construction: `store: false` means the endpoint keeps
    // nothing to continue from, so a continuation id is never valid here.
    expect(body.previous_response_id).toBeUndefined();
    expect(body.max_output_tokens).toBe(4096);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.truncation).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.text).toEqual({ verbosity: "low" });
    // No explicit key was supplied, so the compiled prefix hash routes it.
    // The wire value stays within OpenAI's bounded cache-key field.
    expect(body.prompt_cache_key).toBe("0".repeat(64));
    expect(body.prompt_cache_options).toBeUndefined();

    const reasoning = body.reasoning as { effort: string; summary: string };
    expect(reasoning).toBeDefined();
    expect(reasoning.effort).toBe("medium");
    expect(reasoning.summary).toBe("auto");

    const tools = body.tools as Array<{ type: string; name: string; strict?: boolean }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.name).toBe("search");
    // The fixture schema satisfies strict mode, so the claim is made.
    expect(tools[0]!.strict).toBe(true);

    // The stable prefix travels as `instructions`, not as a leading developer
    // item inside the array that changes on every attempt.
    expect(body.instructions).toBe("System instructions.");
    const inputItems = body.input as Array<{ role: string; content: string }>;
    expect(inputItems).toHaveLength(1);
    expect(inputItems[0]!.role).toBe("user");
    expect(inputItems[0]!.content).toBe("Search for main.rs");
  });

  test("sends the reasoning effort the caller chose, unconditionally", async () => {
    const base: CanonicalRenderInput = {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [mkFragment("f1", "authority", "System instructions.")],
      toolSchemas: [],
      cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [] },
      continuationId: null,
      outputProfile: "terse",
      // The reserve used to gate the wire field; it is accounting only now.
      reasoningReserveTokens: 0n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    };

    const high = await renderResponsesRequest(base, { reasoningEffort: "high" });
    expect((high.body as Record<string, unknown>).reasoning).toEqual({ effort: "high", summary: "auto" });

    // `max` used to collapse to `high` for every model. A model whose family
    // publishes the top rungs keeps them.
    const solInput: CanonicalRenderInput = {
      ...base,
      model: { ...DEFAULT_MODEL_CAPS, modelKey: "gpt-5.6-sol" as ModelKey },
    };
    const sol = await renderResponsesRequest(solInput, { reasoningEffort: "max" });
    expect((sol.body as Record<string, unknown>).reasoning).toEqual({ effort: "max", summary: "auto" });

    // A model that advertises its own ladder is clamped into that ladder.
    const clamped = await renderResponsesRequest(base, {
      reasoningEffort: "max",
      reasoningLevels: ["low", "medium", "high", "xhigh"],
    });
    expect((clamped.body as Record<string, unknown>).reasoning).toEqual({ effort: "xhigh", summary: "auto" });

    // An unrecognised family saturates at `high` rather than guessing a rung
    // the endpoint would reject.
    const legacy = await renderResponsesRequest(base, { reasoningEffort: "max" });
    expect((legacy.body as Record<string, unknown>).reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("replays every banked reasoning item immediately before its tool call", async () => {
    const ledger = new ReasoningReplayLedger();
    ledger.ingest([
      { kind: "text", reasoningItem: { id: "rs_1", encryptedContent: "blob-1", summary: ["first"] } },
      {
        kind: "tool_call",
        toolCall: { toolCallId: "call_1", toolName: "search", arguments: { query: "x" } },
      },
      { kind: "text", reasoningItem: { id: "rs_2", encryptedContent: "blob-2", summary: [] } },
      {
        kind: "tool_call",
        toolCall: { toolCallId: "call_2", toolName: "search", arguments: { query: "y" } },
      },
    ]);

    const messages: OpenAiChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
    ];

    expect(toResponsesInputItems(messages, ledger)).toEqual([
      { role: "user", content: "go" },
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "blob-1",
        summary: [{ type: "summary_text", text: "first" }],
      },
      { type: "function_call", call_id: "call_1", name: "search", arguments: "{}" },
      { type: "reasoning", id: "rs_2", encrypted_content: "blob-2", summary: [] },
      { type: "function_call", call_id: "call_2", name: "search", arguments: "{}" },
    ]);
  });

  test("captures encrypted reasoning items off the Responses stream", async () => {
    async function* sse(): AsyncIterable<string> {
      yield "event: response.output_item.done\ndata: {\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_9\",\"encrypted_content\":\"gAAAA\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"planning\"}]}}\n\n";
      // An item with no blob is not replayable and must not be banked.
      yield "event: response.output_item.done\ndata: {\"output_index\":1,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_10\",\"summary\":[]}}\n\n";
      yield "event: response.output_item.done\ndata: {\"output_index\":2,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_7\",\"name\":\"search\",\"arguments\":\"{}\"}}\n\n";
      yield "event: response.completed\ndata: {\"response\":{\"id\":\"resp_1\"}}\n\n";
    }
    const chunks: any[] = [];
    for await (const chunk of decodeOpenAiResponsesStream(sse())) chunks.push(chunk);

    expect(chunks[0]).toEqual({
      kind: "text",
      reasoningItem: { id: "rs_9", encryptedContent: "gAAAA", summary: ["planning"] },
    });
    expect(chunks[1]!.kind).toBe("tool_call");

    const ledger = new ReasoningReplayLedger();
    ledger.ingest(chunks);
    expect(ledger.itemsFor("call_7")).toEqual([
      { id: "rs_9", encryptedContent: "gAAAA", summary: ["planning"] },
    ]);
  });

  /**
   * The native Responses path had the same leak as the ChatGPT Codex profile:
   * `renderMessages` stamps `cache_control` on the first cached block, and the
   * Responses API answers `Unknown parameter: 'input[N].cache_control'`.
   */
  test("never sends the chat prompt-cache marker on a Responses body", async () => {
    const input: CanonicalRenderInput = {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [
        mkFragment("f1", "authority", "System instructions."),
        mkFragment("f2", "user_attachment", "Search for main.rs"),
      ],
      toolSchemas: [DUMMY_TOOL],
      cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [0] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 500n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    };

    const chat = await new OpenAiRenderer().render(input);
    // The chat dialect still carries the marker: that is where it belongs.
    expect(JSON.stringify(chat.body)).toContain("cache_control");

    const rendered = await renderResponsesRequest(input);
    expect(JSON.stringify(rendered.body)).not.toContain("cache_control");
    const items = (rendered.body as Record<string, unknown>).input as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ role: "user", content: "Search for main.rs" });
  });

  test("uses compiler breakpoints to avoid cache writes for a changing GPT-5.6 suffix", async () => {
    const provider: ProviderCapabilitySnapshot = {
      ...DEFAULT_PROVIDER_CAPS,
      caching: {
        ...DEFAULT_PROVIDER_CAPS.caching,
        mode: "explicit_breakpoints",
        minimumTokens: 1_024,
        ttlOptions: ["30m"],
      },
    };
    const model: ModelCapabilitySnapshot = {
      ...DEFAULT_MODEL_CAPS,
      modelKey: "gpt-5.6-terra" as ModelKey,
      snapshot: provider,
    };
    const input: CanonicalRenderInput = {
      provider,
      model,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [
        mkFragment("authority", "authority", "Stable platform instructions."),
        mkFragment("contract", "task_contract", "Stable task contract."),
        mkFragment("latest", "user_attachment", "Changing current request."),
      ],
      toolSchemas: [DUMMY_TOOL],
      cachePlan: { stablePrefixHash: `sha256:${"a".repeat(64)}` as ContentHash, breakpoints: [1] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 500n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      estimatedInputTokens: 100n as TokenCount,
      predictedCacheWriteTokens: 75n as TokenCount,
      signal: null,
    };

    const rendered = await renderResponsesRequest(input);
    const body = rendered.body as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe("a".repeat(64));
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(rendered.estimatedInputTokens).toBe(100n as TokenCount);
    expect(rendered.predictedCacheWriteTokens).toBe(75n as TokenCount);
    expect(rendered.predictedCachedTokens).toBe(0n as TokenCount);
    expect(body.input).toEqual([
      {
        role: "developer",
        content: [{
          type: "input_text",
          text: "Stable task contract.",
          prompt_cache_breakpoint: { mode: "explicit" },
        }],
      },
      { role: "user", content: "Changing current request." },
    ]);
  });

  test("marks a tool result when the transcript breakpoint lands on it", async () => {
    const provider: ProviderCapabilitySnapshot = {
      ...DEFAULT_PROVIDER_CAPS,
      caching: {
        ...DEFAULT_PROVIDER_CAPS.caching,
        mode: "explicit_breakpoints",
        minimumTokens: 1_024,
        ttlOptions: ["30m"],
      },
    };
    const model: ModelCapabilitySnapshot = {
      ...DEFAULT_MODEL_CAPS,
      modelKey: "gpt-5.6-sol" as ModelKey,
      snapshot: provider,
    };
    const input: CanonicalRenderInput = {
      provider,
      model,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [
        mkFragment("authority", "authority", "Stable platform instructions."),
        mkFragment("call", "recent_episode", JSON.stringify({
          protocol: "terminus.tool-call.v1",
          provider_call_id: "call_1",
          tool_name: "search",
          arguments: { query: "cache" },
        })),
        mkFragment("result", "tool_result", JSON.stringify({
          protocol: "terminus.tool-result.v1",
          provider_call_id: "call_1",
          result: "cached evidence",
        })),
      ],
      toolSchemas: [DUMMY_TOOL],
      cachePlan: { stablePrefixHash: `sha256:${"b".repeat(64)}` as ContentHash, breakpoints: [2] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 500n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    };

    const rendered = await renderResponsesRequest(input);
    const body = rendered.body as Record<string, unknown>;
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "search", arguments: "{\"query\":\"cache\"}" },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{
          type: "input_text",
          text: "cached evidence",
          prompt_cache_breakpoint: { mode: "explicit" },
        }],
      },
    ]);
  });

  test("bounds an oversized caller cache key deterministically", async () => {
    const base: CanonicalRenderInput = {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [mkFragment("f1", "authority", "System instructions.")],
      toolSchemas: [],
      cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 0n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    };
    const key = "workspace:customer-visible-name:" + "x".repeat(80);

    const first = await renderResponsesRequest(base, { promptCacheKey: key });
    const second = await renderResponsesRequest(base, { promptCacheKey: key });
    const firstKey = (first.body as Record<string, unknown>).prompt_cache_key;
    expect(firstKey).toBe((second.body as Record<string, unknown>).prompt_cache_key);
    expect(typeof firstKey).toBe("string");
    expect((firstKey as string).length).toBeLessThanOrEqual(64);
    expect(firstKey).not.toContain("customer-visible-name");
  });

  test("streams and decodes Responses API SSE frames", async () => {
    async function* sseGenerator(): AsyncIterable<string> {
      yield "event: response.output_text.delta\ndata: {\"delta\":\"Hello \"}\n\n";
      yield "event: response.reasoning_text.delta\ndata: {\"delta\":\"Thinking...\"}\n\n";
      yield "event: response.output_text.delta\ndata: {\"delta\":\"world!\"}\n\n";
      yield "event: response.output_item.added\ndata: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"search\",\"arguments\":\"\"}}\n\n";
      yield "event: response.function_call_arguments.delta\ndata: {\"output_index\":0,\"delta\":\"{\\\"query\\\":\\\"term\\\"}\"}\n\n";
      yield "event: response.output_item.done\ndata: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"search\",\"arguments\":\"{\\\"query\\\":\\\"term\\\"}\"}}\n\n";
      yield "event: response.completed\ndata: {\"response\":{\"id\":\"resp_999\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20,\"input_tokens_details\":{\"cached_tokens\":40,\"cache_write_tokens\":30},\"output_tokens_details\":{\"reasoning_tokens\":15}}}}\n\n";
    }

    const chunks: any[] = [];
    for await (const chunk of decodeOpenAiResponsesStream(sseGenerator())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toEqual({ kind: "text", text: "Hello " });
    expect(chunks[1]).toEqual({ kind: "text", reasoning: "Thinking..." });
    expect(chunks[2]).toEqual({ kind: "text", text: "world!" });
    expect(chunks[3]).toEqual({
      kind: "tool_call",
      toolCall: {
        toolCallId: "call_1",
        toolName: "search",
        arguments: { query: "term" },
      },
    });
    expect(chunks[4]).toEqual({
      kind: "done",
      continuationId: "resp_999",
      providerRequestId: "resp_999",
      usage: {
        inputTokens: 100n as TokenCount,
        cachedInputTokens: 40n as TokenCount,
        cacheWriteTokens: 30n as TokenCount,
        outputTokens: 20n as TokenCount,
        reasoningTokens: 15n as TokenCount,
        toolSchemaTokens: 0n as TokenCount,
        latencyMs: 0,
        timeToFirstTokenMs: null,
      },
    });
  });

  test("streams and decodes Chat Completions SSE frames", async () => {
    async function* chatSseGenerator(): AsyncIterable<string> {
      yield "data: {\"id\":\"chat_123\",\"choices\":[{\"delta\":{\"content\":\"Hi!\"}}]}\n\n";
      yield "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"reasoning...\"}}]}\n\n";
      yield "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":10,\"prompt_tokens_details\":{\"cached_tokens\":20}}}\n\n";
      yield "data: [DONE]\n\n";
    }

    const chunks: any[] = [];
    for await (const chunk of decodeOpenAiChatStream(chatSseGenerator())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ kind: "text", text: "Hi!" });
    expect(chunks[1]).toEqual({ kind: "text", reasoning: "reasoning..." });
    expect(chunks[2]).toEqual({
      kind: "done",
      providerRequestId: "chat_123",
      stopReason: "length",
      usage: {
        inputTokens: 50n as TokenCount,
        cachedInputTokens: 20n as TokenCount,
        cacheWriteTokens: 0n as TokenCount,
        outputTokens: 10n as TokenCount,
        reasoningTokens: 0n as TokenCount,
        toolSchemaTokens: 0n as TokenCount,
        latencyMs: 0,
        timeToFirstTokenMs: null,
      },
    });
  });

  test("never claims strict function calling for a schema with an optional parameter", async () => {
    // Live 400 on 2026-08-29: "Invalid schema for function 'read': …
    // 'required' is required to be supplied and to be an array including
    // every key in properties. Missing 'max_bytes'." Strict is a claim about
    // the schema, and this schema does not meet it.
    expect(schemaSatisfiesStrictMode(OPTIONAL_PARAM_TOOL.inputSchema)).toBe(false);

    const input: CanonicalRenderInput = {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "01934567-89ab-7000-8000-cdef01234567" as Uuid7,
      fragments: [mkFragment("f1", "authority", "System instructions.")],
      toolSchemas: [OPTIONAL_PARAM_TOOL],
      cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as ContentHash, breakpoints: [] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 500n as TokenCount,
      outputReserveTokens: 4096n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    };

    const rendered = await renderResponsesRequest(input);
    const tools = (rendered.body as Record<string, unknown>).tools as Array<{
      name: string;
      strict: boolean;
      parameters: Record<string, unknown>;
    }>;

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("read");
    expect(tools[0]!.strict).toBe(false);
    // Non-strict means the schema travels as written: the optional parameter
    // keeps its bounds and its default rather than being forced into
    // `required` and made nullable.
    expect(tools[0]!.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        max_bytes: { type: "integer", minimum: 1, maximum: 30 * 1_024, default: 28 * 1_024 },
      },
    });
  });

  test("recognises the schema shapes strict mode actually accepts", () => {
    expect(
      schemaSatisfiesStrictMode({
        type: "object",
        additionalProperties: false,
        required: ["a"],
        properties: { a: { type: "string" } },
      }),
    ).toBe(true);
    // An open object accepts keys the model was never told about.
    expect(
      schemaSatisfiesStrictMode({ type: "object", required: ["a"], properties: { a: { type: "string" } } }),
    ).toBe(false);
    // A nested object has to hold the line too.
    expect(
      schemaSatisfiesStrictMode({
        type: "object",
        additionalProperties: false,
        required: ["a"],
        properties: { a: { type: "object", properties: { b: { type: "string" } }, required: [] } },
      }),
    ).toBe(false);
    // `default` is not a strict-mode keyword anywhere in the tree.
    expect(
      schemaSatisfiesStrictMode({
        type: "object",
        additionalProperties: false,
        required: ["a"],
        properties: { a: { type: "string", default: "x" } },
      }),
    ).toBe(false);
    // A nullable optional-by-convention property is strict-shaped.
    expect(
      schemaSatisfiesStrictMode({
        type: "object",
        additionalProperties: false,
        required: ["a"],
        properties: { a: { type: ["string", "null"] } },
      }),
    ).toBe(true);
  });
});
