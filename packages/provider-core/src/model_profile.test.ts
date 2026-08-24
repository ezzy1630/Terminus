import { describe, expect, test } from "bun:test";
import { micros, type ModelProfile } from "@terminus/domain";
import {
  defineProviderProfileBundle,
  type ProviderRenderingProfile,
} from "./model_profile.js";

const MODEL: ModelProfile = {
  id: "profile:test",
  adapterRef: "adapter:test",
  renderingProfileRef: "rendering:test",
  modelKey: "model-test",
  version: "v1",
  modelFamilyRef: "family:test",
  economics: {
    inputMicrosPerMillion: micros(1),
    cachedInputMicrosPerMillion: micros(0),
    outputMicrosPerMillion: micros(2),
    reasoningAccounting: false,
  },
  latencyModel: { p50Ms: 1, p90Ms: 2, p99Ms: 3, ttftMs: 1 },
  allowedConfidentiality: ["public"],
  capabilities: {
    codingQuality: "medium",
    toolReliability: "medium",
    structuredOutput: true,
    imageInput: false,
    advertisedContextTokens: 1_000,
    testedSafeContextTokens: 900,
    securityReasoning: "medium",
    reasoningStrength: "none",
    offlineExecution: false,
  },
};

const RENDERING: ProviderRenderingProfile = {
  id: "rendering:test",
  adapterRef: "adapter:test",
  modelKey: "model-test",
  version: "v1",
  systemPromptPlacement: "provider-owned-placement",
  toolDialect: "provider-owned-tools",
  editDialect: "provider-owned-edits",
  reasoningEffort: "provider-owned-reasoning",
  continuationStrategy: "provider-owned-continuation",
  compactionStrategy: "provider-owned-compaction",
  caching: {
    mode: "provider-owned-cache",
    minimumTokens: 0,
    exactPrefixRequired: false,
  },
  structuredOutputRepair: {
    dialect: "provider-owned-output",
    autoRepair: false,
    retryPromptTemplate: "retry",
  },
  knownFailureMitigations: [],
};

describe("defineProviderProfileBundle", () => {
  test("binds matching opaque references", () => {
    expect(defineProviderProfileBundle(MODEL, RENDERING)).toEqual({
      model: MODEL,
      rendering: RENDERING,
    });
  });

  test("rejects a mismatched rendering reference", () => {
    expect(() =>
      defineProviderProfileBundle(MODEL, {
        ...RENDERING,
        id: "rendering:other",
      }),
    ).toThrow("renderingProfileRef does not match");
  });

  test("rejects a mismatched rendering version", () => {
    expect(() =>
      defineProviderProfileBundle(MODEL, {
        ...RENDERING,
        version: "v2",
      }),
    ).toThrow("version does not match");
  });
});
