/** Provider-owned model and rendering profiles for the OpenAI adapter. */
import { micros, type ModelProfile } from "@terminus/domain";
import {
  defineProviderProfileBundle,
  type ProviderProfileBundle,
  type ProviderRenderingProfile,
} from "@terminus/provider-core";

export const OPENAI_ADAPTER_REF = "openai";

export interface OpenAiRenderingProfile extends ProviderRenderingProfile {
  readonly adapterRef: typeof OPENAI_ADAPTER_REF;
  readonly systemPromptPlacement: "developer_message";
  readonly toolDialect: "responses_function_tools";
  readonly continuationStrategy: "server_history";
  readonly caching: {
    readonly mode: "explicit_breakpoints";
    readonly minimumTokens: number;
    readonly exactPrefixRequired: true;
  };
  readonly structuredOutputRepair: {
    readonly dialect: "strict_json_schema";
    readonly autoRepair: true;
    readonly retryPromptTemplate: string;
  };
  readonly maximumToolDefinitions: 128;
}

interface OpenAiProfileInput {
  readonly id: string;
  readonly modelKey: string;
  readonly version: string;
  readonly modelFamilyRef: string;
  readonly advertisedContextTokens: number;
  readonly testedSafeContextTokens: number;
  readonly imageInput: boolean;
  readonly editDialect: "hash_anchored_diff" | "search_replace_blocks";
  readonly reasoningStrength: "none" | "high";
  readonly codingQuality?: "low" | "medium" | "high" | undefined;
  readonly retryPromptTemplate: string;
  readonly knownFailureMitigations: readonly string[];
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p99Ms: number;
  readonly ttftMs: number;
}

function openAiProfile(
  input: OpenAiProfileInput,
): ProviderProfileBundle<OpenAiRenderingProfile> {
  const rendering: OpenAiRenderingProfile = {
    id: `rendering:openai:${input.modelKey}:${input.version}`,
    adapterRef: OPENAI_ADAPTER_REF,
    modelKey: input.modelKey,
    version: input.version,
    systemPromptPlacement: "developer_message",
    toolDialect: "responses_function_tools",
    editDialect: input.editDialect,
    reasoningEffort: input.reasoningStrength,
    continuationStrategy: "server_history",
    compactionStrategy: "structured_claims_with_evidence",
    caching: {
      mode: "explicit_breakpoints",
      minimumTokens: 1_024,
      exactPrefixRequired: true,
    },
    structuredOutputRepair: {
      dialect: "strict_json_schema",
      autoRepair: true,
      retryPromptTemplate: input.retryPromptTemplate,
    },
    knownFailureMitigations: input.knownFailureMitigations,
    maximumToolDefinitions: 128,
  };
  const model: ModelProfile = {
    id: input.id,
    adapterRef: OPENAI_ADAPTER_REF,
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
      codingQuality: input.codingQuality ?? "high",
      toolReliability: "high",
      structuredOutput: true,
      imageInput: input.imageInput,
      advertisedContextTokens: input.advertisedContextTokens,
      testedSafeContextTokens: input.testedSafeContextTokens,
      securityReasoning: "high",
      reasoningStrength: input.reasoningStrength,
      offlineExecution: false,
    },
  };
  return defineProviderProfileBundle(model, rendering);
}

/**
 * The GPT-5.6 family, GA 2026-07-09. Three tiers of one model, not three
 * models: they share the window, the output cap, the effort ladder and the
 * wire shape, and differ only in price and depth. There is no separate
 * `-codex` SKU — Codex drives these same slugs.
 *
 * `testedSafeContextTokens` is 270,000 for all three, and that is a *pricing*
 * ceiling rather than a capability one: past 272,000 input tokens the whole
 * request is billed at 2x input / 1.5x output. `resolveTestedSafeContextTokens`
 * in `@terminus/provider-core` is the same number for the runtime path.
 *
 * Latency percentiles are zero because none have been measured on this
 * harness. A fabricated percentile is worse than an absent one: the router
 * weighs this field.
 */
function gpt56Profile(input: {
  readonly slug: string;
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly codingQuality: "medium" | "high";
}): ProviderProfileBundle<OpenAiRenderingProfile> {
  return openAiProfile({
    id: `profile-openai-${input.slug}-v1`,
    modelKey: input.slug,
    version: "2026-07-09-v1",
    modelFamilyRef: "gpt-5.6",
    advertisedContextTokens: 1_050_000,
    testedSafeContextTokens: 270_000,
    imageInput: true,
    // GPT-family models are measurably better with a grammar-constrained
    // freeform patch than with a JSON-encoded diff.
    editDialect: "hash_anchored_diff",
    reasoningStrength: "high",
    retryPromptTemplate:
      "The previous function call arguments were not valid JSON. Re-emit the call with arguments that match the schema exactly.",
    knownFailureMitigations: ["strip_markdown_json_fences"],
    inputMicrosPerMillion: input.inputMicrosPerMillion,
    cachedInputMicrosPerMillion: input.cachedInputMicrosPerMillion,
    outputMicrosPerMillion: input.outputMicrosPerMillion,
    codingQuality: input.codingQuality,
    p50Ms: 0,
    p90Ms: 0,
    p99Ms: 0,
    ttftMs: 0,
  });
}

/** `gpt-5.6-sol` — the top tier; the `gpt-5.6` alias resolves here. */
export const GPT_5_6_SOL_PROFILE_BUNDLE = gpt56Profile({
  slug: "gpt-5.6-sol",
  inputMicrosPerMillion: 4_000_000,
  cachedInputMicrosPerMillion: 400_000,
  outputMicrosPerMillion: 20_000_000,
  codingQuality: "high",
});

/** `gpt-5.6-terra` — the daily driver. */
export const GPT_5_6_TERRA_PROFILE_BUNDLE = gpt56Profile({
  slug: "gpt-5.6-terra",
  inputMicrosPerMillion: 2_000_000,
  cachedInputMicrosPerMillion: 200_000,
  outputMicrosPerMillion: 12_000_000,
  codingQuality: "high",
});

/** `gpt-5.6-luna` — scouts, summaries and eval labour. */
export const GPT_5_6_LUNA_PROFILE_BUNDLE = gpt56Profile({
  slug: "gpt-5.6-luna",
  inputMicrosPerMillion: 200_000,
  cachedInputMicrosPerMillion: 20_000,
  outputMicrosPerMillion: 1_200_000,
  codingQuality: "medium",
});

export const OPENAI_PROFILE_BUNDLES = [
  GPT_5_6_SOL_PROFILE_BUNDLE,
  GPT_5_6_TERRA_PROFILE_BUNDLE,
  GPT_5_6_LUNA_PROFILE_BUNDLE,
] as const;

export const OPENAI_MODEL_PROFILES: readonly ModelProfile[] =
  OPENAI_PROFILE_BUNDLES.map(({ model }) => model);

export const OPENAI_RENDERING_PROFILES: readonly OpenAiRenderingProfile[] =
  OPENAI_PROFILE_BUNDLES.map(({ rendering }) => rendering);
