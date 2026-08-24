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
    readonly mode: "automatic_prefix";
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
      mode: "automatic_prefix",
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
      codingQuality: "high",
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

export const GPT_4O_PROFILE_BUNDLE = openAiProfile({
  id: "profile-openai-gpt-4o-2024-11-20-v1",
  modelKey: "gpt-4o-2024-11-20",
  version: "2024-11-20-v1",
  modelFamilyRef: "gpt-4o",
  advertisedContextTokens: 128_000,
  testedSafeContextTokens: 100_000,
  imageInput: true,
  editDialect: "search_replace_blocks",
  reasoningStrength: "none",
  retryPromptTemplate: "Fix invalid JSON parameters for function call.",
  knownFailureMitigations: [
    "strip_markdown_json_fences",
    "normalize_newline_escapes",
  ],
  inputMicrosPerMillion: 2_500_000,
  cachedInputMicrosPerMillion: 1_250_000,
  outputMicrosPerMillion: 10_000_000,
  p50Ms: 650,
  p90Ms: 1_400,
  p99Ms: 2_800,
  ttftMs: 280,
});

export const O3_MINI_PROFILE_BUNDLE = openAiProfile({
  id: "profile-openai-o3-mini-2025-01-31-v1",
  modelKey: "o3-mini-2025-01-31",
  version: "2025-01-31-v1",
  modelFamilyRef: "o-series",
  advertisedContextTokens: 200_000,
  testedSafeContextTokens: 160_000,
  imageInput: false,
  editDialect: "hash_anchored_diff",
  reasoningStrength: "high",
  retryPromptTemplate:
    "Reasoning model structured error. Fix function argument JSON.",
  knownFailureMitigations: ["strip_markdown_json_fences"],
  inputMicrosPerMillion: 1_100_000,
  cachedInputMicrosPerMillion: 550_000,
  outputMicrosPerMillion: 4_400_000,
  p50Ms: 1_200,
  p90Ms: 3_200,
  p99Ms: 6_000,
  ttftMs: 900,
});

export const OPENAI_PROFILE_BUNDLES = [
  GPT_4O_PROFILE_BUNDLE,
  O3_MINI_PROFILE_BUNDLE,
] as const;

export const OPENAI_MODEL_PROFILES: readonly ModelProfile[] =
  OPENAI_PROFILE_BUNDLES.map(({ model }) => model);

export const OPENAI_RENDERING_PROFILES: readonly OpenAiRenderingProfile[] =
  OPENAI_PROFILE_BUNDLES.map(({ rendering }) => rendering);
