import { describe, expect, test } from "bun:test";
import type {
  ArtifactUri,
  ByteCount,
  ContentHash,
  ModelKey,
  Rfc3339Timestamp,
  TokenCount,
  Uuid7,
} from "@terminus/domain";
import type {
  CanonicalRenderInput,
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
} from "@terminus/provider-core";
import { GatewayRenderer } from "./renderer.js";
import { gatewayProfileBundles } from "./model_profiles.js";
import type { GatewayModel } from "./catalog.js";

function gatewayModel(protocol: GatewayModel["protocol"]): GatewayModel {
  return {
    id: `model-${protocol}`,
    name: protocol,
    deployment: "zen",
    providerId: "open_code_zen",
    baseUrl: "https://opencode.ai/zen/v1",
    protocol,
    free: protocol === "chat_completions",
    toolCalling: true,
    structuredOutput: true,
    imageInput: false,
    reasoning: protocol === "responses",
    contextTokens: 100_000,
    outputTokens: 8_000,
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    observedAt: "2026-08-24T00:00:00Z",
  };
}

function renderInput(model: GatewayModel): CanonicalRenderInput {
  const observedAt = model.observedAt as Rfc3339Timestamp;
  const provider: ProviderCapabilitySnapshot = {
    providerId: model.providerId,
    observedAt: model.observedAt,
    source: "test",
    context: {
      advertisedTokens: model.contextTokens,
      testedSafeTokens: 32_768,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: true,
      parallelToolCalls: false,
      structuredOutput: true,
    },
    continuation: { nativeId: false, crossRequest: false, compaction: true, compatibilityKey: model.protocol },
    caching: { mode: "none", exactPrefixRequired: false, minimumTokens: 0, ttlOptions: [], toolOrderSensitive: true, usageReporting: true },
    reasoning: { supported: model.reasoning, budgetControl: model.reasoning, summaryAvailable: false },
    economics: {
      inputMicrosPerMillion: 0n as ProviderCapabilitySnapshot["economics"]["inputMicrosPerMillion"],
      cachedInputMicrosPerMillion: 0n as ProviderCapabilitySnapshot["economics"]["cachedInputMicrosPerMillion"],
      outputMicrosPerMillion: 0n as ProviderCapabilitySnapshot["economics"]["outputMicrosPerMillion"],
      reasoningAccounting: false,
    },
    reliability: { toolCallSuccess: 0, structuredOutputSuccess: 0, editCohortSuccess: 0, latencyPercentiles: {} },
    policy: { allowedConfidentiality: ["public"], retentionMode: "gateway_declared", region: null },
  };
  const capability: ModelCapabilitySnapshot = {
    modelKey: model.id as ModelKey,
    providerId: model.providerId,
    snapshot: provider,
    observedAt: model.observedAt,
  };
  return {
    provider,
    model: capability,
    fragments: [{
      id: "fragment-1",
      kind: "task_contract",
      source: {
        uri: "task://test",
        producer: "test",
        producerVersion: "1",
        observedAt,
        observedBy: "user",
        evidenceRefs: [],
      },
      sourceVersion: "1",
      authority: 100,
      priority: 100,
      trust: "trusted",
      confidentiality: "public",
      injectionRisk: "none",
      exactness: "exact",
      scope: { workspaceId: null, sessionId: null, taskId: null, pathPatterns: [] },
      freshness: { observedAt, sourceVersion: "1", stale: false, staleReason: null },
      dependencies: [],
      invalidation: [],
      contentRef: {
        uri: "artifact://prompt" as ArtifactUri,
        hash: "sha256:prompt" as ContentHash,
        bytes: 4n as ByteCount,
        mediaType: "text/plain",
      },
      textContent: "Do the work",
      estimatedTokens: { [model.id]: 4 },
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
    }],
    toolSchemas: [],
    cachePlan: { stablePrefixHash: "sha256:prefix" as ContentHash, breakpoints: [] },
    continuationId: null,
    outputProfile: "terse",
    reasoningReserveTokens: 0n as TokenCount,
    outputReserveTokens: 128n as TokenCount,
    hardInputLimit: 1_024n as TokenCount,
    signal: null,
    manifestId: "018f0000-0000-7000-8000-000000000002" as Uuid7,
  };
}

describe("GatewayRenderer", () => {
  test("renders each gateway protocol without changing harness ownership", async () => {
    const chat = gatewayModel("chat_completions");
    const responses = gatewayModel("responses");
    const messages = gatewayModel("messages");
    const renderer = new GatewayRenderer([chat, responses, messages]);

    const chatBody = (await renderer.render(renderInput(chat))).body;
    expect(chatBody.messages).toBeArray();
    expect(chatBody.max_tokens).toBe(128);
    expect(chatBody.max_output_tokens).toBeUndefined();

    const responsesBody = (await renderer.render(renderInput(responses))).body;
    expect(responsesBody.input).toBeArray();
    expect(responsesBody.messages).toBeUndefined();

    const messagesBody = (await renderer.render(renderInput(messages))).body;
    expect(messagesBody.system).toBeArray();
    expect(messagesBody.messages).toBeArray();
  });

  test("builds conservative, immutable routing profiles from discovery", () => {
    const free = gatewayModel("chat_completions");
    const [bundle] = gatewayProfileBundles([free]);
    expect(bundle?.model.adapterRef).toBe("open_code_zen");
    expect(bundle?.model.allowedConfidentiality).toEqual(["public"]);
    expect(bundle?.model.capabilities.testedSafeContextTokens).toBe(32_768);
    expect(bundle?.rendering.toolDialect).toBe("openai_chat_completions");
  });
});

describe("H7 per-turn reasoning effort", () => {
  const reasoningInput = (model: GatewayModel): CanonicalRenderInput => ({
    ...renderInput(model),
    reasoningReserveTokens: 4_096n as TokenCount,
  });

  test("the requested effort reaches the Responses body", async () => {
    const responses = gatewayModel("responses");
    const renderer = new GatewayRenderer([responses], { reasoningEffort: "high" });
    const body = (await renderer.render(reasoningInput(responses))).body;
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("`max` saturates at the deepest level the vendor exposes", async () => {
    const responses = gatewayModel("responses");
    const renderer = new GatewayRenderer([responses], { reasoningEffort: "max" });
    const body = (await renderer.render(reasoningInput(responses))).body;
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("no requested effort keeps the previous default", async () => {
    const responses = gatewayModel("responses");
    const renderer = new GatewayRenderer([responses]);
    const body = (await renderer.render(reasoningInput(responses))).body;
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
  });

  test("a model that does not reason is never sent a reasoning control", async () => {
    const chat = gatewayModel("chat_completions");
    expect(chat.reasoning).toBe(false);
    const renderer = new GatewayRenderer([chat], { reasoningEffort: "high" });
    const body = (await renderer.render(reasoningInput(chat))).body;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  test("a reasoning chat_completions model keeps the flat field", async () => {
    const chat = { ...gatewayModel("chat_completions"), reasoning: true };
    const renderer = new GatewayRenderer([chat], { reasoningEffort: "low" });
    const body = (await renderer.render(reasoningInput(chat))).body;
    expect(body.reasoning_effort).toBe("low");
  });
});
