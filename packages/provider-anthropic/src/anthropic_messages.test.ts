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
  AnthropicRenderer,
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
});
