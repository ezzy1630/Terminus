import { describe, expect, test } from "bun:test";
import type { ContextBudget } from "@terminus/context-ir";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ProviderToolSchema,
} from "@terminus/provider-core";
import type { Micros, ModelKey, TokenCount } from "@terminus/domain";
import { CalibratedModelTokenizer } from "./tokenizer.js";
import { deriveProviderAwareContextBudget } from "./budget-policy.js";

const MODEL_KEY = "test/model" as ModelKey;

function providerSnapshot(overrides: {
  readonly testedSafeTokens?: number;
  readonly toolCalling?: boolean;
  readonly reasoning?: boolean;
} = {}): ProviderCapabilitySnapshot {
  return {
    providerId: "test",
    observedAt: "2026-08-27T00:00:00Z",
    source: "test",
    context: {
      advertisedTokens: 128_000,
      testedSafeTokens: overrides.testedSafeTokens ?? 64_000,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: overrides.toolCalling ?? true,
      parallelToolCalls: true,
      structuredOutput: true,
    },
    continuation: {
      nativeId: false,
      crossRequest: false,
      compaction: false,
      compatibilityKey: "test-v1",
    },
    caching: {
      mode: "none",
      exactPrefixRequired: false,
      minimumTokens: 0,
      ttlOptions: [],
      toolOrderSensitive: false,
      usageReporting: false,
    },
    reasoning: {
      supported: overrides.reasoning ?? true,
      budgetControl: overrides.reasoning ?? true,
      summaryAvailable: overrides.reasoning ?? true,
    },
    economics: {
      inputMicrosPerMillion: 1n as Micros,
      cachedInputMicrosPerMillion: 1n as Micros,
      outputMicrosPerMillion: 1n as Micros,
      reasoningAccounting: overrides.reasoning ?? true,
    },
    reliability: {
      toolCallSuccess: 1,
      structuredOutputSuccess: 1,
      editCohortSuccess: 1,
      latencyPercentiles: { p50: 1, p99: 2 },
    },
    policy: {
      allowedConfidentiality: ["public", "workspace"],
      retentionMode: "none",
      region: null,
    },
  };
}

function modelSnapshot(provider: ProviderCapabilitySnapshot): ModelCapabilitySnapshot {
  return {
    modelKey: MODEL_KEY,
    providerId: provider.providerId,
    snapshot: provider,
    observedAt: provider.observedAt,
  };
}

function budget(overrides: Partial<ContextBudget> = {}): ContextBudget {
  return {
    modelAdvertisedTokens: 128_000n as TokenCount,
    testedSafeTokens: 64_000n as TokenCount,
    protocolOverheadTokens: 100n as TokenCount,
    exactContextTokens: 2_000n as TokenCount,
    optionalContextTarget: 8_000n as TokenCount,
    expectedToolResultReserve: 1_000n as TokenCount,
    outputReserve: 2_000n as TokenCount,
    reasoningReserve: 500n as TokenCount,
    recoveryMargin: 500n as TokenCount,
    hardInputLimit: 60_000n as TokenCount,
    hardCostMicros: 1_000n,
    ...overrides,
  };
}

function toolSchema(): ProviderToolSchema {
  return {
    id: "read",
    version: "1",
    summary: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    resultSchema: { type: "object" },
    sideEffectClass: "read",
    requiredCapabilities: [],
    trustLevel: "builtin",
    maximumModelResultBytes: 4_000,
    maximumArtifactBytes: 1_000_000,
    defaultTimeoutMs: 30_000,
    policyTags: [],
  };
}

function tokenizer() {
  return new CalibratedModelTokenizer("test", MODEL_KEY, {
    binding: {
      bindingId: "test-tokenizer",
      bindingVersion: "1",
      providerId: "test",
      modelKey: MODEL_KEY,
      estimateTextTokens: (text) => text.length,
      estimateToolSchemaTokens: () => 300,
      estimateEnvelopeTokens: (maxTokens) => Math.ceil(maxTokens / 10),
    },
  });
}

describe("provider-aware context budget policy", () => {
  test("caps optional context after safe limit, schemas, reserves, and envelope", () => {
    const provider = providerSnapshot();
    const result = deriveProviderAwareContextBudget({
      budget: budget(),
      provider,
      model: modelSnapshot(provider),
      tokenizer: tokenizer(),
      toolSchemas: [toolSchema()],
    });
    expect(result.budget.hardInputLimit).toBe(60_000n);
    expect(result.breakdown.toolSchemaTokens).toBe(300n);
    expect(result.breakdown.envelopeTokens).toBe(350n);
    expect(result.budget.optionalContextTarget).toBe(8_000n);
    expect(result.breakdown.policyVersion).toBe("terminus.context-budget-policy.v1");
  });

  test("removes unsupported reasoning and tool-result reserves before allocation", () => {
    const provider = providerSnapshot({ toolCalling: false, reasoning: false });
    const result = deriveProviderAwareContextBudget({
      budget: budget(),
      provider,
      model: modelSnapshot(provider),
      tokenizer: tokenizer(),
      toolSchemas: [toolSchema()],
    });
    expect(result.budget.reasoningReserve).toBe(0n);
    expect(result.budget.expectedToolResultReserve).toBe(0n);
    expect(result.breakdown.reasoningReserve).toBe(0n);
    expect(result.breakdown.expectedToolResultReserve).toBe(0n);
  });
});
