import type {
  CanonicalRenderInput,
  ContextFragment,
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderResponse,
  ProviderToolSchema,
} from "../index.js";
import type {
  ArtifactUri,
  ConfidentialityLabel,
  ContentHash,
  Micros,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
  TrustLabel,
  Uuid7,
} from "@terminus/domain";
import type { GoldenEpisode } from "./types.js";

const DEFAULT_PROVIDER_CAPS: ProviderCapabilitySnapshot = {
  providerId: "mock",
  observedAt: "2026-08-24T00:00:00Z",
  source: "test",
  context: {
    advertisedTokens: 200_000,
    testedSafeTokens: 180_000,
    roleSupport: ["system", "user", "assistant", "tool", "developer"],
    imageInput: true,
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
  },
  continuation: {
    nativeId: true,
    crossRequest: true,
    compaction: true,
    compatibilityKey: "v1",
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
    inputMicrosPerMillion: 3_000_000n as Micros,
    cachedInputMicrosPerMillion: 750_000n as Micros,
    outputMicrosPerMillion: 15_000_000n as Micros,
    reasoningAccounting: true,
  },
  reliability: {
    toolCallSuccess: 0.99,
    structuredOutputSuccess: 0.99,
    editCohortSuccess: 0.95,
    latencyPercentiles: { p50: 250, p90: 800, p99: 1500 },
  },
  policy: {
    allowedConfidentiality: ["public", "workspace"] as readonly ConfidentialityLabel[],
    retentionMode: "organization_zdr",
    region: null,
  },
};

const DEFAULT_MODEL_KEY = "test-model-v1" as ModelKey;

const DEFAULT_MODEL_CAPS: ModelCapabilitySnapshot = {
  modelKey: DEFAULT_MODEL_KEY,
  providerId: "mock",
  snapshot: DEFAULT_PROVIDER_CAPS,
  observedAt: "2026-08-24T00:00:00Z",
};

const DUMMY_TOOL_EDIT: ProviderToolSchema = {
  id: "edit",
  version: "1.0.0",
  summary: "Apply transactional edit to workspace file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      targetContent: { type: "string" },
      replacementContent: { type: "string" },
    },
    required: ["path", "targetContent", "replacementContent"],
  },
  resultSchema: {
    type: "object",
    properties: {
      applied: { type: "boolean" },
      newHash: { type: "string" },
    },
  },
  sideEffectClass: "LOCAL_FS_WRITE",
  requiredCapabilities: ["fs_write"],
  trustLevel: "builtin",
  maximumModelResultBytes: 65536,
  maximumArtifactBytes: 1048576,
  defaultTimeoutMs: 5000,
  policyTags: ["file_edit"],
};

const DUMMY_TOOL_READ: ProviderToolSchema = {
  id: "read",
  version: "1.0.0",
  summary: "Read lines from file in workspace",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      startLine: { type: "number" },
      endLine: { type: "number" },
    },
    required: ["path"],
  },
  resultSchema: {
    type: "object",
    properties: {
      lines: { type: "string" },
    },
  },
  sideEffectClass: "READ_ONLY",
  requiredCapabilities: ["fs_read"],
  trustLevel: "builtin",
  maximumModelResultBytes: 65536,
  maximumArtifactBytes: 1048576,
  defaultTimeoutMs: 3000,
  policyTags: ["file_read"],
};

function makeFragment(
  id: string,
  kind: ContextFragment["kind"],
  textContent: string,
  exactness: ContextFragment["exactness"] = "exact",
): ContextFragment {
  return {
    id,
    kind,
    textContent,
    contentRef: {
      uri: `artifact://${id}` as ArtifactUri,
      hash: `sha256:dummy-${id}` as ContentHash,
      mediaType: "text/plain",
      bytes: 100n as any,
    },
    source: {
      uri: `test://${id}`,
      producer: "test",
      producerVersion: "1.0",
      observedAt: "2026-08-24T00:00:00Z" as Rfc3339Timestamp,
      observedBy: "control",
      evidenceRefs: [],
    },
    sourceVersion: null,
    authority: 100,
    priority: 1,
    trust: "trusted" as TrustLabel,
    confidentiality: "workspace" as ConfidentialityLabel,
    injectionRisk: "low",
    exactness,
    scope: { workspaceId: null, sessionId: null, taskId: null, pathPatterns: [] },
    freshness: {
      observedAt: "2026-08-24T00:00:00Z" as Rfc3339Timestamp,
      sourceVersion: null,
      stale: false,
      staleReason: null,
    },
    dependencies: [],
    invalidation: [],
    estimatedTokens: { [DEFAULT_MODEL_KEY]: 20 } as Readonly<Record<ModelKey, number>>,
    selectionFeatures: {
      relevance: 1,
      novelty: 1,
      coverage: 1,
      uncertaintyReduction: 1,
      riskReduction: 1,
      modelCompatibility: 1,
      redundancyPenalty: 0,
      injectionPenalty: 0,
    },
  };
}

export const GOLDEN_EPISODES: readonly GoldenEpisode[] = [
  // 1. Basic Conversation
  {
    id: "ep_basic_01",
    title: "Basic Developer & User Turn",
    description: "Standard developer/system instruction followed by user turn and assistant text response.",
    input: {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "018f0000-0000-7000-8000-000000000001" as Uuid7,
      fragments: [
        makeFragment("frag_auth", "authority", "You are Terminus, a provider-neutral coding agent operating system."),
        makeFragment("frag_user", "user_attachment", "Fix the typo in README.md."),
      ],
      toolSchemas: [],
      cachePlan: { stablePrefixHash: "sha256:stable-1" as ContentHash, breakpoints: [0] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 0n as TokenCount,
      outputReserveTokens: 2048n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    },
    simulatedResponse: {
      providerId: "mock",
      model: DEFAULT_MODEL_KEY,
      chunks: [
        { kind: "text", text: "I have identified the typo and fixed it in README.md." },
        {
          kind: "done",
          usage: {
            inputTokens: 50n as TokenCount,
            cachedInputTokens: 0n as TokenCount,
            cacheWriteTokens: 50n as TokenCount,
            outputTokens: 15n as TokenCount,
            reasoningTokens: 0n as TokenCount,
            toolSchemaTokens: 0n as TokenCount,
            latencyMs: 120,
            timeToFirstTokenMs: 40,
          },
        },
      ],
      observedAt: "2026-08-24T00:00:00Z",
    },
    expectedProjection: {
      text: "I have identified the typo and fixed it in README.md.",
      toolCalls: [],
      reasoning: null,
      continuationId: null,
      finishReason: "stop",
    },
    expectedUsage: {
      inputTokens: 50n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      cacheWriteTokens: 50n as TokenCount,
      outputTokens: 15n as TokenCount,
      reasoningTokens: 0n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 120,
      timeToFirstTokenMs: 40,
    },
    expectations: {
      openai: { roles: ["developer", "user"], hasCacheControl: true },
      anthropic: { roles: ["user"], hasCacheControl: true },
    },
  },

  // 2. Reasoning & Thinking
  {
    id: "ep_reasoning_02",
    title: "Extended Reasoning & Thinking Stream",
    description: "Provider outputs reasoning deltas before text deltas; reasoning tokens accounted in usage.",
    input: {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "018f0000-0000-7000-8000-000000000002" as Uuid7,
      fragments: [
        makeFragment("frag_auth", "authority", "You are Terminus."),
        makeFragment("frag_user", "user_attachment", "Refactor the algorithm to O(n log n)."),
      ],
      toolSchemas: [],
      cachePlan: { stablePrefixHash: "sha256:stable-2" as ContentHash, breakpoints: [] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 1024n as TokenCount,
      outputReserveTokens: 2048n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    },
    simulatedResponse: {
      providerId: "mock",
      model: DEFAULT_MODEL_KEY,
      chunks: [
        { kind: "text", reasoning: "Analyzing array sorting constraints. Merge sort achieves O(n log n)." },
        { kind: "text", text: "Here is the O(n log n) implementation using merge sort." },
        {
          kind: "done",
          usage: {
            inputTokens: 60n as TokenCount,
            cachedInputTokens: 0n as TokenCount,
            cacheWriteTokens: 0n as TokenCount,
            outputTokens: 25n as TokenCount,
            reasoningTokens: 40n as TokenCount,
            toolSchemaTokens: 0n as TokenCount,
            latencyMs: 450,
            timeToFirstTokenMs: 120,
          },
        },
      ],
      observedAt: "2026-08-24T00:00:00Z",
    },
    expectedProjection: {
      text: "Here is the O(n log n) implementation using merge sort.",
      toolCalls: [],
      reasoning: "Analyzing array sorting constraints. Merge sort achieves O(n log n).",
      continuationId: null,
      finishReason: "stop",
    },
    expectedUsage: {
      inputTokens: 60n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      cacheWriteTokens: 0n as TokenCount,
      outputTokens: 25n as TokenCount,
      reasoningTokens: 40n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 450,
      timeToFirstTokenMs: 120,
    },
    expectations: {
      openai: { roles: ["developer", "user"], hasReasoning: true },
      anthropic: { roles: ["user"], hasReasoning: true },
    },
  },

  // 3. Single Tool Call & Result Linking
  {
    id: "ep_tool_single_03",
    title: "Single Tool Call with Result Linking",
    description: "Assistant requests tool execution and subsequent turn binds tool_result to provider call ID.",
    input: {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "018f0000-0000-7000-8000-000000000003" as Uuid7,
      fragments: [
        makeFragment("frag_auth", "authority", "System instructions."),
        makeFragment("frag_user", "user_attachment", "Replace foo with bar in main.ts"),
        makeFragment(
          "frag_assistant_call",
          "recent_episode",
          JSON.stringify({
            protocol: "terminus.tool-call.v1",
            provider_call_id: "call_edit_991",
            tool_name: "edit",
            arguments: { path: "main.ts", targetContent: "foo", replacementContent: "bar" },
          }),
        ),
        makeFragment(
          "frag_tool_res",
          "tool_result",
          JSON.stringify({
            protocol: "terminus.tool-result.v1",
            provider_call_id: "call_edit_991",
            tool_name: "edit",
            result: { applied: true, newHash: "sha256:main-updated" },
          }),
        ),
      ],
      toolSchemas: [DUMMY_TOOL_EDIT],
      cachePlan: { stablePrefixHash: "sha256:stable-3" as ContentHash, breakpoints: [] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 0n as TokenCount,
      outputReserveTokens: 2048n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    },
    simulatedResponse: {
      providerId: "mock",
      model: DEFAULT_MODEL_KEY,
      chunks: [
        {
          kind: "tool_call",
          toolCall: {
            toolCallId: "call_edit_991",
            toolName: "edit",
            arguments: { path: "main.ts", targetContent: "foo", replacementContent: "bar" },
          },
        },
        { kind: "done" },
      ],
      observedAt: "2026-08-24T00:00:00Z",
    },
    expectedProjection: {
      text: "",
      toolCalls: [
        {
          toolCallId: "call_edit_991",
          toolName: "edit",
          arguments: { path: "main.ts", targetContent: "foo", replacementContent: "bar" },
        },
      ],
      reasoning: null,
      continuationId: null,
      finishReason: "tool_use",
    },
    expectedUsage: {
      inputTokens: 0n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      cacheWriteTokens: 0n as TokenCount,
      outputTokens: 0n as TokenCount,
      reasoningTokens: 0n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 0,
      timeToFirstTokenMs: null,
    },
    expectations: {
      openai: { roles: ["developer", "user", "assistant", "tool"], hasToolCalls: true, hasToolResults: true },
      anthropic: { roles: ["user", "assistant", "user"], hasToolCalls: true, hasToolResults: true },
    },
  },

  // 4. Parallel Tool Calls
  {
    id: "ep_tool_parallel_04",
    title: "Parallel Tool Invocations",
    description: "Assistant invokes multiple tools in parallel, receiving distinct result blocks.",
    input: {
      provider: DEFAULT_PROVIDER_CAPS,
      model: DEFAULT_MODEL_CAPS,
      manifestId: "018f0000-0000-7000-8000-000000000004" as Uuid7,
      fragments: [
        makeFragment("frag_auth", "authority", "System instructions."),
        makeFragment("frag_user", "user_attachment", "Check index.ts and package.json."),
      ],
      toolSchemas: [DUMMY_TOOL_READ, DUMMY_TOOL_EDIT],
      cachePlan: { stablePrefixHash: "sha256:stable-4" as ContentHash, breakpoints: [] },
      continuationId: null,
      outputProfile: "terse",
      reasoningReserveTokens: 0n as TokenCount,
      outputReserveTokens: 2048n as TokenCount,
      hardInputLimit: 100000n as TokenCount,
      signal: null,
    },
    simulatedResponse: {
      providerId: "mock",
      model: DEFAULT_MODEL_KEY,
      chunks: [
        {
          kind: "tool_call",
          toolCall: {
            toolCallId: "call_read_1",
            toolName: "read",
            arguments: { path: "index.ts" },
          },
        },
        {
          kind: "tool_call",
          toolCall: {
            toolCallId: "call_read_2",
            toolName: "read",
            arguments: { path: "package.json" },
          },
        },
        { kind: "done" },
      ],
      observedAt: "2026-08-24T00:00:00Z",
    },
    expectedProjection: {
      text: "",
      toolCalls: [
        {
          toolCallId: "call_read_1",
          toolName: "read",
          arguments: { path: "index.ts" },
        },
        {
          toolCallId: "call_read_2",
          toolName: "read",
          arguments: { path: "package.json" },
        },
      ],
      reasoning: null,
      continuationId: null,
      finishReason: "tool_use",
    },
    expectedUsage: {
      inputTokens: 0n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      cacheWriteTokens: 0n as TokenCount,
      outputTokens: 0n as TokenCount,
      reasoningTokens: 0n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 0,
      timeToFirstTokenMs: null,
    },
    expectations: {
      openai: { roles: ["developer", "user"], hasToolCalls: true },
      anthropic: { roles: ["user"], hasToolCalls: true },
    },
  },
];
