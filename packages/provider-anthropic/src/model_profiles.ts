/** Provider-owned model and rendering profiles for the Anthropic adapter. */
import { micros, type ModelProfile } from "@terminus/domain";
import {
  defineProviderProfileBundle,
  type ProviderProfileBundle,
  type ProviderRenderingProfile,
} from "@terminus/provider-core";

export const ANTHROPIC_ADAPTER_REF = "anthropic";

export interface AnthropicRenderingProfile extends ProviderRenderingProfile {
  readonly adapterRef: typeof ANTHROPIC_ADAPTER_REF;
  readonly systemPromptPlacement: "top_level_system_blocks";
  readonly toolDialect: "messages_tools";
  readonly continuationStrategy: "client_replay_with_cache_breakpoints";
  readonly caching: {
    readonly mode: "explicit_breakpoints";
    readonly minimumTokens: number;
    readonly exactPrefixRequired: true;
  };
  readonly structuredOutputRepair: {
    readonly dialect: "prompt_guided_json";
    readonly autoRepair: true;
    readonly retryPromptTemplate: string;
  };
  readonly maximumToolDefinitions: 200;
}

interface AnthropicProfileInput {
  readonly id: string;
  readonly modelKey: string;
  readonly version: string;
  readonly testedSafeContextTokens: number;
  readonly reasoningStrength: "none" | "high";
  readonly compactionStrategy:
    "rolling_summary" | "structured_claims_with_evidence";
  readonly cachingMinimumTokens: number;
  readonly retryPromptTemplate: string;
  readonly knownFailureMitigations: readonly string[];
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p99Ms: number;
  readonly ttftMs: number;
  readonly codingQuality: "medium" | "high";
  readonly securityReasoning: "medium" | "high";
}

function anthropicProfile(
  input: AnthropicProfileInput,
): ProviderProfileBundle<AnthropicRenderingProfile> {
  const rendering: AnthropicRenderingProfile = {
    id: `rendering:anthropic:${input.modelKey}:${input.version}`,
    adapterRef: ANTHROPIC_ADAPTER_REF,
    modelKey: input.modelKey,
    version: input.version,
    systemPromptPlacement: "top_level_system_blocks",
    toolDialect: "messages_tools",
    editDialect: "hash_anchored_diff",
    reasoningEffort: input.reasoningStrength,
    continuationStrategy: "client_replay_with_cache_breakpoints",
    compactionStrategy: input.compactionStrategy,
    caching: {
      mode: "explicit_breakpoints",
      minimumTokens: input.cachingMinimumTokens,
      exactPrefixRequired: true,
    },
    structuredOutputRepair: {
      dialect: "prompt_guided_json",
      autoRepair: true,
      retryPromptTemplate: input.retryPromptTemplate,
    },
    knownFailureMitigations: input.knownFailureMitigations,
    maximumToolDefinitions: 200,
  };
  const model: ModelProfile = {
    id: input.id,
    adapterRef: ANTHROPIC_ADAPTER_REF,
    renderingProfileRef: rendering.id,
    modelKey: input.modelKey,
    version: input.version,
    modelFamilyRef: "claude-3",
    economics: {
      inputMicrosPerMillion: micros(input.inputMicrosPerMillion),
      cachedInputMicrosPerMillion: micros(input.cachedInputMicrosPerMillion),
      outputMicrosPerMillion: micros(input.outputMicrosPerMillion),
      reasoningAccounting: input.reasoningStrength === "high",
    },
    latencyModel: {
      p50Ms: input.p50Ms,
      p90Ms: input.p90Ms,
      p99Ms: input.p99Ms,
      ttftMs: input.ttftMs,
    },
    allowedConfidentiality: ["public", "workspace", "secret_adjacent"],
    capabilities: {
      codingQuality: input.codingQuality,
      toolReliability: "high",
      structuredOutput: true,
      imageInput: true,
      advertisedContextTokens: 200_000,
      testedSafeContextTokens: input.testedSafeContextTokens,
      securityReasoning: input.securityReasoning,
      reasoningStrength: input.reasoningStrength,
      offlineExecution: false,
    },
  };
  return defineProviderProfileBundle(model, rendering);
}

export const CLAUDE_3_7_SONNET_PROFILE_BUNDLE = anthropicProfile({
  id: "profile-anthropic-claude-3-7-sonnet-20250219-v1",
  modelKey: "claude-3-7-sonnet-20250219",
  version: "2025-02-19-v1",
  testedSafeContextTokens: 160_000,
  reasoningStrength: "high",
  compactionStrategy: "structured_claims_with_evidence",
  cachingMinimumTokens: 1_024,
  retryPromptTemplate:
    "Format error in tool parameters. Output valid JSON matching the exact schema definition.",
  knownFailureMitigations: [
    "strip_markdown_json_fences",
    "deduplicate_parallel_tool_calls",
    "normalize_relative_file_paths",
  ],
  inputMicrosPerMillion: 3_000_000,
  cachedInputMicrosPerMillion: 300_000,
  outputMicrosPerMillion: 15_000_000,
  p50Ms: 850,
  p90Ms: 1_800,
  p99Ms: 3_500,
  ttftMs: 350,
  codingQuality: "high",
  securityReasoning: "high",
});

export const CLAUDE_3_5_HAIKU_PROFILE_BUNDLE = anthropicProfile({
  id: "profile-anthropic-claude-3-5-haiku-20241022-v1",
  modelKey: "claude-3-5-haiku-20241022",
  version: "2024-10-22-v1",
  testedSafeContextTokens: 128_000,
  reasoningStrength: "none",
  compactionStrategy: "rolling_summary",
  cachingMinimumTokens: 2_048,
  retryPromptTemplate: "Return strictly valid JSON according to schema.",
  knownFailureMitigations: ["strip_markdown_json_fences"],
  inputMicrosPerMillion: 800_000,
  cachedInputMicrosPerMillion: 80_000,
  outputMicrosPerMillion: 4_000_000,
  p50Ms: 250,
  p90Ms: 600,
  p99Ms: 1_200,
  ttftMs: 150,
  codingQuality: "medium",
  securityReasoning: "medium",
});

export const ANTHROPIC_PROFILE_BUNDLES = [
  CLAUDE_3_7_SONNET_PROFILE_BUNDLE,
  CLAUDE_3_5_HAIKU_PROFILE_BUNDLE,
] as const;

export const ANTHROPIC_MODEL_PROFILES: readonly ModelProfile[] =
  ANTHROPIC_PROFILE_BUNDLES.map(({ model }) => model);

export const ANTHROPIC_RENDERING_PROFILES: readonly AnthropicRenderingProfile[] =
  ANTHROPIC_PROFILE_BUNDLES.map(({ rendering }) => rendering);
