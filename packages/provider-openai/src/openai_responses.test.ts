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
  renderResponsesRequest,
  decodeOpenAiResponsesStream,
  decodeOpenAiChatStream,
  schemaSatisfiesStrictMode,
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
      signal: null,
    };

    const rendered = await renderResponsesRequest(input);
    const body = rendered.body as Record<string, unknown>;

    expect(body.model).toBe("openai/gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.previous_response_id).toBe("resp_12345");
    expect(body.max_output_tokens).toBe(4096);
    expect(body.store).toBe(false);

    const reasoning = body.reasoning as { effort: string; summary: string };
    expect(reasoning).toBeDefined();
    expect(reasoning.effort).toBe("medium");

    const tools = body.tools as Array<{ type: string; name: string; strict?: boolean }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.name).toBe("search");
    // The fixture schema satisfies strict mode, so the claim is made.
    expect(tools[0]!.strict).toBe(true);

    const inputItems = body.input as Array<{ role: string; content: string }>;
    expect(inputItems).toHaveLength(2);
    expect(inputItems[0]!.role).toBe("developer");
    expect(inputItems[0]!.content).toBe("System instructions.");
    expect(inputItems[1]!.role).toBe("user");
    expect(inputItems[1]!.content).toBe("Search for main.rs");
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
    expect(items[0]).toEqual({ role: "developer", content: "System instructions." });
  });

  test("streams and decodes Responses API SSE frames", async () => {
    async function* sseGenerator(): AsyncIterable<string> {
      yield "event: response.output_text.delta\ndata: {\"delta\":\"Hello \"}\n\n";
      yield "event: response.reasoning_text.delta\ndata: {\"delta\":\"Thinking...\"}\n\n";
      yield "event: response.output_text.delta\ndata: {\"delta\":\"world!\"}\n\n";
      yield "event: response.output_item.added\ndata: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"search\",\"arguments\":\"\"}}\n\n";
      yield "event: response.function_call_arguments.delta\ndata: {\"output_index\":0,\"delta\":\"{\\\"query\\\":\\\"term\\\"}\"}\n\n";
      yield "event: response.output_item.done\ndata: {\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"search\",\"arguments\":\"{\\\"query\\\":\\\"term\\\"}\"}}\n\n";
      yield "event: response.completed\ndata: {\"response\":{\"id\":\"resp_999\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20,\"input_tokens_details\":{\"cached_tokens\":40},\"output_tokens_details\":{\"reasoning_tokens\":15}}}}\n\n";
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
        cacheWriteTokens: 0n as TokenCount,
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
      yield "data: {\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":10,\"prompt_tokens_details\":{\"cached_tokens\":20}}}\n\n";
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
