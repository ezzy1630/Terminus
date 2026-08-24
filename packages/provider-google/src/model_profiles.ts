/** Provider-owned model and rendering profiles for the Google adapter. */
import { micros, type ModelProfile } from "@terminus/domain";
import {
  defineProviderProfileBundle,
  type ProviderProfileBundle,
  type ProviderRenderingProfile,
} from "@terminus/provider-core";

export const GOOGLE_ADAPTER_REF = "google";

export interface GoogleRenderingProfile extends ProviderRenderingProfile {
  readonly adapterRef: typeof GOOGLE_ADAPTER_REF;
  readonly systemPromptPlacement: "system_instruction";
  readonly toolDialect: "function_declarations";
  readonly continuationStrategy: "cached_content_resource";
  readonly caching: {
    readonly mode: "explicit_resource";
    readonly minimumTokens: 32_768;
    readonly exactPrefixRequired: true;
  };
  readonly structuredOutputRepair: {
    readonly dialect: "strict_json_schema";
    readonly autoRepair: true;
    readonly retryPromptTemplate: string;
  };
  readonly maximumToolDefinitions: 128;
}

interface GoogleProfileInput {
  readonly id: string;
  readonly modelKey: string;
  readonly version: string;
  readonly modelFamilyRef: string;
  readonly advertisedContextTokens: number;
  readonly testedSafeContextTokens: number;
  readonly reasoningStrength: "none" | "medium";
  readonly compactionStrategy:
    "rolling_summary" | "structured_claims_with_evidence";
  readonly knownFailureMitigations: readonly string[];
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p99Ms: number;
  readonly ttftMs: number;
  readonly securityReasoning: "medium" | "high";
}

function googleProfile(
  input: GoogleProfileInput,
): ProviderProfileBundle<GoogleRenderingProfile> {
  const rendering: GoogleRenderingProfile = {
    id: `rendering:google:${input.modelKey}:${input.version}`,
    adapterRef: GOOGLE_ADAPTER_REF,
    modelKey: input.modelKey,
    version: input.version,
    systemPromptPlacement: "system_instruction",
    toolDialect: "function_declarations",
    editDialect: "search_replace_blocks",
    reasoningEffort: input.reasoningStrength,
    continuationStrategy: "cached_content_resource",
    compactionStrategy: input.compactionStrategy,
    caching: {
      mode: "explicit_resource",
      minimumTokens: 32_768,
      exactPrefixRequired: true,
    },
    structuredOutputRepair: {
      dialect: "strict_json_schema",
      autoRepair: true,
      retryPromptTemplate:
        "Format Gemini function arguments strictly as JSON schema.",
    },
    knownFailureMitigations: input.knownFailureMitigations,
    maximumToolDefinitions: 128,
  };
  const model: ModelProfile = {
    id: input.id,
    adapterRef: GOOGLE_ADAPTER_REF,
    renderingProfileRef: rendering.id,
    modelKey: input.modelKey,
    version: input.version,
    modelFamilyRef: input.modelFamilyRef,
    economics: {
      inputMicrosPerMillion: micros(input.inputMicrosPerMillion),
      cachedInputMicrosPerMillion: micros(input.cachedInputMicrosPerMillion),
      outputMicrosPerMillion: micros(input.outputMicrosPerMillion),
      reasoningAccounting: false,
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

export const GEMINI_2_0_FLASH_PROFILE_BUNDLE = googleProfile({
  id: "profile-google-gemini-2-0-flash-001-v1",
  modelKey: "gemini-2.0-flash-001",
  version: "001-v1",
  modelFamilyRef: "gemini-2",
  advertisedContextTokens: 1_048_576,
  testedSafeContextTokens: 500_000,
  reasoningStrength: "none",
  compactionStrategy: "rolling_summary",
  knownFailureMitigations: [
    "strip_markdown_json_fences",
    "sanitize_gemini_thought_blocks",
  ],
  inputMicrosPerMillion: 100_000,
  cachedInputMicrosPerMillion: 25_000,
  outputMicrosPerMillion: 400_000,
  p50Ms: 220,
  p90Ms: 500,
  p99Ms: 1_100,
  ttftMs: 140,
  securityReasoning: "medium",
});

export const GEMINI_1_5_PRO_PROFILE_BUNDLE = googleProfile({
  id: "profile-google-gemini-1-5-pro-002-v1",
  modelKey: "gemini-1.5-pro-002",
  version: "002-v1",
  modelFamilyRef: "gemini-1.5",
  advertisedContextTokens: 2_097_152,
  testedSafeContextTokens: 1_000_000,
  reasoningStrength: "medium",
  compactionStrategy: "structured_claims_with_evidence",
  knownFailureMitigations: ["strip_markdown_json_fences"],
  inputMicrosPerMillion: 1_250_000,
  cachedInputMicrosPerMillion: 312_500,
  outputMicrosPerMillion: 5_000_000,
  p50Ms: 950,
  p90Ms: 2_200,
  p99Ms: 4_500,
  ttftMs: 400,
  securityReasoning: "high",
});

export const GOOGLE_PROFILE_BUNDLES = [
  GEMINI_2_0_FLASH_PROFILE_BUNDLE,
  GEMINI_1_5_PRO_PROFILE_BUNDLE,
] as const;

export const GOOGLE_MODEL_PROFILES: readonly ModelProfile[] =
  GOOGLE_PROFILE_BUNDLES.map(({ model }) => model);

export const GOOGLE_RENDERING_PROFILES: readonly GoogleRenderingProfile[] =
  GOOGLE_PROFILE_BUNDLES.map(({ rendering }) => rendering);
