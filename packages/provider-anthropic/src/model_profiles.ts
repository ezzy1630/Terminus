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
  readonly modelFamilyRef: string;
  readonly advertisedContextTokens: number;
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
    modelFamilyRef: input.modelFamilyRef,
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
      advertisedContextTokens: input.advertisedContextTokens,
      testedSafeContextTokens: input.testedSafeContextTokens,
      securityReasoning: input.securityReasoning,
      reasoningStrength: input.reasoningStrength,
      offlineExecution: false,
    },
  };
  return defineProviderProfileBundle(model, rendering);
}

/**
 * The Claude 5 family. One shape for all three tiers:
 *
 *   - 1M context as both default and maximum, with no long-context premium,
 *     so the tested-safe window is the whole window;
 *   - 128k max output;
 *   - adaptive thinking with `output_config.effort` (`budget_tokens` is a 400);
 *   - a 512-token prompt-cache minimum, down from 1,024 on Opus 4.8 — which
 *     is why `cachingMinimumTokens` is not the old 1,024/2,048 here: a short
 *     stable prefix that used to fall below the floor now caches.
 *
 * Latency percentiles are zero because none have been measured on this
 * harness, and the router must not weigh a fabricated one.
 */
function claude5Profile(input: {
  readonly slug: string;
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly codingQuality: "medium" | "high";
}): ProviderProfileBundle<AnthropicRenderingProfile> {
  return anthropicProfile({
    id: `profile-anthropic-${input.slug}-v1`,
    modelKey: input.slug,
    version: "2026-07-24-v1",
    modelFamilyRef: "claude-5",
    advertisedContextTokens: 1_000_000,
    testedSafeContextTokens: 1_000_000,
    reasoningStrength: "high",
    compactionStrategy: "structured_claims_with_evidence",
    cachingMinimumTokens: 512,
    retryPromptTemplate:
      "The previous tool input did not match the schema. Re-emit the call with input that matches it exactly.",
    knownFailureMitigations: [
      "strip_markdown_json_fences",
      "normalize_relative_file_paths",
    ],
    inputMicrosPerMillion: input.inputMicrosPerMillion,
    cachedInputMicrosPerMillion: input.cachedInputMicrosPerMillion,
    outputMicrosPerMillion: input.outputMicrosPerMillion,
    p50Ms: 0,
    p90Ms: 0,
    p99Ms: 0,
    ttftMs: 0,
    codingQuality: input.codingQuality,
    securityReasoning: "high",
  });
}

/** `claude-opus-5` — complex agentic coding at half Fable 5's price. */
export const CLAUDE_OPUS_5_PROFILE_BUNDLE = claude5Profile({
  slug: "claude-opus-5",
  inputMicrosPerMillion: 5_000_000,
  cachedInputMicrosPerMillion: 500_000,
  outputMicrosPerMillion: 25_000_000,
  codingQuality: "high",
});

/**
 * `claude-fable-5` — the most capable tier. Requires 30-day retention (it is
 * not available under zero data retention), so it is deliberately *not*
 * admitted for `secret_adjacent` context here.
 */
export const CLAUDE_FABLE_5_PROFILE_BUNDLE = claude5Profile({
  slug: "claude-fable-5",
  inputMicrosPerMillion: 10_000_000,
  cachedInputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 50_000_000,
  codingQuality: "high",
});

/** `claude-sonnet-5` — near-Opus coding quality at Sonnet-tier price. */
export const CLAUDE_SONNET_5_PROFILE_BUNDLE = claude5Profile({
  slug: "claude-sonnet-5",
  inputMicrosPerMillion: 2_000_000,
  cachedInputMicrosPerMillion: 200_000,
  outputMicrosPerMillion: 10_000_000,
  codingQuality: "high",
});

export const ANTHROPIC_PROFILE_BUNDLES = [
  CLAUDE_OPUS_5_PROFILE_BUNDLE,
  CLAUDE_FABLE_5_PROFILE_BUNDLE,
  CLAUDE_SONNET_5_PROFILE_BUNDLE,
] as const;

export const ANTHROPIC_MODEL_PROFILES: readonly ModelProfile[] =
  ANTHROPIC_PROFILE_BUNDLES.map(({ model }) => model);

export const ANTHROPIC_RENDERING_PROFILES: readonly AnthropicRenderingProfile[] =
  ANTHROPIC_PROFILE_BUNDLES.map(({ rendering }) => rendering);
