/** Provider-owned model and rendering profiles for the local adapter. */
import { micros, type ModelProfile } from "@terminus/domain";
import {
  defineProviderProfileBundle,
  type ProviderProfileBundle,
  type ProviderRenderingProfile,
} from "@terminus/provider-core";

export const LOCAL_ADAPTER_REF = "local";

export interface LocalRenderingProfile extends ProviderRenderingProfile {
  readonly adapterRef: typeof LOCAL_ADAPTER_REF;
  readonly systemPromptPlacement: "system_message";
  readonly toolDialect: "openai_compatible_function_tools";
  readonly continuationStrategy: "full_context_rerender";
  readonly caching: {
    readonly mode: "none";
    readonly minimumTokens: 0;
    readonly exactPrefixRequired: false;
  };
  readonly structuredOutputRepair: {
    readonly dialect: "grammar_constrained";
    readonly autoRepair: true;
    readonly retryPromptTemplate: string;
  };
  readonly chatTemplate: "model_default";
}

interface LocalProfileInput {
  readonly id: string;
  readonly modelKey: string;
  readonly modelFamilyRef: string;
  readonly advertisedContextTokens: number;
  readonly testedSafeContextTokens: number;
  readonly reasoningStrength: "none" | "high";
  readonly retryPromptTemplate: string;
  readonly knownFailureMitigations: readonly string[];
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p99Ms: number;
  readonly ttftMs: number;
  readonly toolReliability: "medium" | "high";
  readonly securityReasoning: "medium" | "high";
}

function localProfile(
  input: LocalProfileInput,
): ProviderProfileBundle<LocalRenderingProfile> {
  const version = "v1-local";
  const rendering: LocalRenderingProfile = {
    id: `rendering:local:${input.modelKey}:${version}`,
    adapterRef: LOCAL_ADAPTER_REF,
    modelKey: input.modelKey,
    version,
    systemPromptPlacement: "system_message",
    toolDialect: "openai_compatible_function_tools",
    editDialect: "hash_anchored_diff",
    reasoningEffort: input.reasoningStrength,
    continuationStrategy: "full_context_rerender",
    compactionStrategy: "structured_claims_with_evidence",
    caching: {
      mode: "none",
      minimumTokens: 0,
      exactPrefixRequired: false,
    },
    structuredOutputRepair: {
      dialect: "grammar_constrained",
      autoRepair: true,
      retryPromptTemplate: input.retryPromptTemplate,
    },
    knownFailureMitigations: input.knownFailureMitigations,
    chatTemplate: "model_default",
  };
  const model: ModelProfile = {
    id: input.id,
    adapterRef: LOCAL_ADAPTER_REF,
    renderingProfileRef: rendering.id,
    modelKey: input.modelKey,
    version,
    modelFamilyRef: input.modelFamilyRef,
    economics: {
      inputMicrosPerMillion: micros(0),
      cachedInputMicrosPerMillion: micros(0),
      outputMicrosPerMillion: micros(0),
      reasoningAccounting: input.reasoningStrength === "high",
    },
    latencyModel: {
      p50Ms: input.p50Ms,
      p90Ms: input.p90Ms,
      p99Ms: input.p99Ms,
      ttftMs: input.ttftMs,
    },
    allowedConfidentiality: [
      "public",
      "workspace",
      "secret_adjacent",
      "secret",
    ],
    capabilities: {
      codingQuality: "high",
      toolReliability: input.toolReliability,
      structuredOutput: true,
      imageInput: false,
      advertisedContextTokens: input.advertisedContextTokens,
      testedSafeContextTokens: input.testedSafeContextTokens,
      securityReasoning: input.securityReasoning,
      reasoningStrength: input.reasoningStrength,
      offlineExecution: true,
    },
  };
  return defineProviderProfileBundle(model, rendering);
}

export const LOCAL_LLAMA_3_3_70B_PROFILE_BUNDLE = localProfile({
  id: "profile-local-llama-3-3-70b-instruct-v1",
  modelKey: "llama-3.3-70b-instruct",
  modelFamilyRef: "llama-3",
  advertisedContextTokens: 128_000,
  testedSafeContextTokens: 64_000,
  reasoningStrength: "none",
  retryPromptTemplate:
    "Output strictly JSON according to the schema without preamble.",
  knownFailureMitigations: [
    "strip_markdown_json_fences",
    "repair_unclosed_json",
  ],
  p50Ms: 700,
  p90Ms: 1_500,
  p99Ms: 3_000,
  ttftMs: 200,
  toolReliability: "medium",
  securityReasoning: "medium",
});

export const LOCAL_QWEN_2_5_CODER_32B_PROFILE_BUNDLE = localProfile({
  id: "profile-local-qwen-2-5-coder-32b-v1",
  modelKey: "qwen-2.5-coder-32b",
  modelFamilyRef: "qwen-2.5",
  advertisedContextTokens: 128_000,
  testedSafeContextTokens: 64_000,
  reasoningStrength: "none",
  retryPromptTemplate:
    "Format code patch strictly according to tool specification.",
  knownFailureMitigations: ["strip_markdown_json_fences"],
  p50Ms: 400,
  p90Ms: 900,
  p99Ms: 1_800,
  ttftMs: 120,
  toolReliability: "high",
  securityReasoning: "medium",
});

export const LOCAL_DEEPSEEK_R1_DISTILL_32B_PROFILE_BUNDLE = localProfile({
  id: "profile-local-deepseek-r1-distill-qwen-32b-v1",
  modelKey: "deepseek-r1-distill-qwen-32b",
  modelFamilyRef: "deepseek-r1-distill",
  advertisedContextTokens: 64_000,
  testedSafeContextTokens: 32_000,
  reasoningStrength: "high",
  retryPromptTemplate:
    "Reasoning completed. Provide exact JSON tool call payload.",
  knownFailureMitigations: [
    "strip_markdown_json_fences",
    "strip_deepseek_think_tags",
  ],
  p50Ms: 1_100,
  p90Ms: 2_500,
  p99Ms: 5_000,
  ttftMs: 800,
  toolReliability: "medium",
  securityReasoning: "high",
});

export const LOCAL_PROFILE_BUNDLES = [
  LOCAL_LLAMA_3_3_70B_PROFILE_BUNDLE,
  LOCAL_QWEN_2_5_CODER_32B_PROFILE_BUNDLE,
  LOCAL_DEEPSEEK_R1_DISTILL_32B_PROFILE_BUNDLE,
] as const;

export const LOCAL_MODEL_PROFILES: readonly ModelProfile[] =
  LOCAL_PROFILE_BUNDLES.map(({ model }) => model);

export const LOCAL_RENDERING_PROFILES: readonly LocalRenderingProfile[] =
  LOCAL_PROFILE_BUNDLES.map(({ rendering }) => rendering);
