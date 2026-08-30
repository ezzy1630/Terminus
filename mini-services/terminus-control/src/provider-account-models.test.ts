/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { Micros, Rfc3339Timestamp } from "@terminus/domain";
import {
  accountMark,
  discoverAccountModels,
  foldReasoningEffort,
  foldReasoningEfforts,
  modelsFromCatalog,
  parseProviderAccountModels,
  providerAccountCapabilitySnapshot,
  providerAccountModelsJson,
  providerAccountModelsWire,
  toGatewayModel,
  type ProviderAccountModel,
  type ProviderAccountModelsResult,
} from "./provider-account-models.js";
import type { GatewayModel } from "@terminus/provider-zen";
import { providerAccountProviderId, type ProviderAccountRecord } from "./provider-accounts.js";

const OBSERVED_AT = "2026-08-28T12:00:00.000Z";

function account(overrides: Partial<ProviderAccountRecord> = {}): ProviderAccountRecord {
  const fingerprint = overrides.fingerprint ?? "0123456789abcdef".repeat(4);
  const baseUrl = overrides.baseUrl ?? "https://api.cerebras.ai/v1";
  const catalogDigest = overrides.catalogDigest ?? `sha256:${"1".repeat(64)}`;
  return {
    id: "account-1",
    source: "opencode:cerebras",
    displayName: "Cerebras",
    vendorId: "cerebras",
    authKind: "api",
    credentialUri: "secret://provider-account/account-1",
    fingerprint,
    baseUrl,
    catalogDigest,
    credentialFingerprint: overrides.credentialFingerprint ?? fingerprint,
    approvedBaseUrl: overrides.approvedBaseUrl ?? baseUrl,
    approvedCatalogDigest: overrides.approvedCatalogDigest ?? catalogDigest,
    secretState: overrides.secretState ?? "bound",
    secretOperationId: "",
    host: "api.cerebras.ai",
    protocol: "chat_completions",
    connectorId: "openai-compatible",
    renderProfile: "openai_compatible",
    status: "connected",
    statusDetail: "",
    billing: "unknown",
    metadataJson: "{}",
    isDefault: false,
    discoveredAt: new Date(OBSERVED_AT),
    lastVerifiedAt: null,
    expiresAt: null,
    revision: 1,
    ...overrides,
  };
}

function model(overrides: Partial<ProviderAccountModel> = {}): ProviderAccountModel {
  return {
    id: "llama-4",
    name: "Llama 4",
    free: false,
    reasoning: false,
    toolCalling: true,
    structuredOutput: true,
    imageInput: false,
    contextTokens: 128_000,
    outputTokens: 8_192,
    inputMicrosPerMillion: 3_000_000,
    cachedInputMicrosPerMillion: 300_000,
    outputMicrosPerMillion: 15_000_000,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    supportsParallelToolCalls: false,
    supportsReasoningSummaries: false,
    ...overrides,
  };
}

describe("modelsFromCatalog", () => {
  const catalog = {
    cerebras: {
      id: "cerebras",
      name: "Cerebras",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "llama-4": {
          id: "llama-4",
          name: "Llama 4",
          tool_call: true,
          reasoning: true,
          structured_output: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 128_000, output: 8_192 },
          cost: { input: 3, output: 15, cache_read: 0.3 },
        },
        "llama-3": { id: "llama-3", name: "Llama 3", status: "deprecated" },
        "free-model": { id: "free-model", name: "Free", cost: { input: 0, output: 0 } },
      },
    },
  };

  test("converts dollars per million into micros and keeps capabilities", () => {
    const { models } = modelsFromCatalog({ vendorId: "cerebras", catalog });
    const llama = models.find((entry) => entry.id === "llama-4");
    expect(llama).toMatchObject({
      name: "Llama 4",
      toolCalling: true,
      reasoning: true,
      imageInput: true,
      contextTokens: 128_000,
      outputTokens: 8_192,
      inputMicrosPerMillion: 3_000_000,
      cachedInputMicrosPerMillion: 300_000,
      outputMicrosPerMillion: 15_000_000,
      free: false,
    });
    expect(models.find((entry) => entry.id === "free-model")?.free).toBe(true);
  });

  test("rejects deprecated models with the reason instead of hiding them", () => {
    const { models, rejected } = modelsFromCatalog({ vendorId: "cerebras", catalog });
    expect(models.map((entry) => entry.id)).not.toContain("llama-3");
    expect(rejected).toContainEqual({
      modelId: "llama-3",
      reason: "models.dev marks the model deprecated",
    });
  });

  test("an absent vendor yields no models and says so", () => {
    const { models, rejected } = modelsFromCatalog({ vendorId: "nowhere", catalog });
    expect(models).toEqual([]);
    expect(rejected[0]?.reason).toContain("models.dev has no provider");
  });

  test("a reasoning model gets the profile's depth ladder, a plain model none", () => {
    const { models } = modelsFromCatalog({
      vendorId: "cerebras",
      catalog,
      renderProfile: "openai_compatible",
    });
    const reasoning = models.find((entry) => entry.id === "llama-4");
    expect(reasoning?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(reasoning?.defaultReasoningEffort).toBe("medium");
    // `max` is never invented: no catalogue claims a level above `high` here.
    expect(reasoning?.reasoningEfforts).not.toContain("max");
    const plain = models.find((entry) => entry.id === "free-model");
    expect(plain?.reasoningEfforts).toEqual([]);
    expect(plain?.defaultReasoningEffort).toBeNull();
  });

  test("a profile with no depth control gets no efforts at all", () => {
    const { models } = modelsFromCatalog({
      vendorId: "cerebras",
      catalog,
      renderProfile: "zen_gateway",
    });
    expect(models.find((entry) => entry.id === "llama-4")?.reasoningEfforts).toEqual([]);
  });
});

describe("Zen account discovery", () => {
  test("an anonymous account admits only free models", async () => {
    const gatewayModel = (id: string, free: boolean): GatewayModel => ({
      id,
      name: id,
      deployment: "zen",
      providerId: "open_code_zen",
      baseUrl: "https://opencode.ai/zen/v1",
      protocol: "chat_completions",
      free,
      toolCalling: true,
      structuredOutput: false,
      imageInput: false,
      reasoning: false,
      contextTokens: 128_000,
      outputTokens: 8_192,
      inputMicrosPerMillion: free ? 0 : 1,
      cachedInputMicrosPerMillion: 0,
      outputMicrosPerMillion: free ? 0 : 1,
      observedAt: OBSERVED_AT,
    });
    const result = await discoverAccountModels({
      account: account({
        source: "zen",
        authKind: "anonymous",
        credentialUri: "",
        renderProfile: "zen_gateway",
        billing: "free",
      }),
      client: {} as never,
      observedAt: OBSERVED_AT,
      discoverZen: async () => ({
        models: [gatewayModel("free-model", true), gatewayModel("paid-model", false)],
        rejected: [],
      }),
    });

    expect(result.models.map((entry) => entry.id)).toEqual(["free-model"]);
    expect(result.rejected).toContainEqual({
      modelId: "paid-model",
      reason: "anonymous OpenCode Zen accounts admit free models only",
    });
  });
});

describe("discovery persistence", () => {
  test("round-trips through the durable row", () => {
    const result: ProviderAccountModelsResult = {
      accountId: "account-1",
      observedAt: OBSERVED_AT,
      models: [model()],
      rejected: [{ modelId: "old", reason: "deprecated" }],
      reachable: true,
      reachabilityDetail: "",
    };
    expect(parseProviderAccountModels(providerAccountModelsJson(result))).toEqual(result);
  });

  test("an unreadable row is rejected rather than partially trusted", () => {
    expect(parseProviderAccountModels("not json")).toBeNull();
    expect(parseProviderAccountModels(JSON.stringify({ accountId: "a" }))).toBeNull();
  });
});

describe("providerAccountModelsWire", () => {
  const codexAccount = account({
    id: "account-2",
    source: "codex-chatgpt",
    displayName: "ChatGPT Codex",
    vendorId: "openai",
    billing: "subscription",
    protocol: "responses",
    renderProfile: "chatgpt_codex",
    isDefault: true,
  });
  const brokenAccount = account({
    id: "account-3",
    source: "opencode:amazon-bedrock",
    displayName: "Amazon Bedrock",
    status: "unsupported",
    statusDetail: "OpenCode SDK @ai-sdk/amazon-bedrock has no Terminus transport yet",
  });

  const wire = providerAccountModelsWire([
    {
      account: account(),
      result: {
        accountId: "account-1",
        observedAt: OBSERVED_AT,
        models: [model()],
        rejected: [],
        reachable: true,
        reachabilityDetail: "",
      },
    },
    {
      account: codexAccount,
      result: {
        accountId: "account-2",
        observedAt: OBSERVED_AT,
        models: [model({
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
          reasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"],
          defaultReasoningEffort: "medium",
          inputMicrosPerMillion: 0,
          outputMicrosPerMillion: 0,
        })],
        rejected: [{ modelId: "gpt-reserve", reason: "hidden" }],
        reachable: true,
        reachabilityDetail: "",
      },
    },
    { account: brokenAccount, result: null },
  ], null);

  test("one provider entry per account, carrying its source and billing", () => {
    expect(wire.providers).toEqual([
      {
        id: "account-1",
        label: "Cerebras",
        mark: "CE",
        available: true,
        source: "opencode:cerebras",
        billing: "unknown",
        is_default: false,
        model_count: 1,
      },
      {
        id: "account-2",
        label: "ChatGPT Codex",
        mark: "CC",
        available: true,
        source: "codex-chatgpt",
        billing: "subscription",
        is_default: true,
        model_count: 1,
      },
      {
        id: "account-3",
        label: "Amazon Bedrock",
        mark: "AB",
        available: false,
        unavailable_reason: "OpenCode SDK @ai-sdk/amazon-bedrock has no Terminus transport yet",
        source: "opencode:amazon-bedrock",
        billing: "unknown",
        is_default: false,
        model_count: 0,
      },
    ]);
  });

  test("every model names exactly one account and reports its efforts", () => {
    expect(wire.models).toHaveLength(2);
    for (const entry of wire.models as Record<string, unknown>[]) {
      expect(wire.providers.some((provider) => (provider as { id: string }).id === entry.provider)).toBe(true);
      expect(Array.isArray(entry.reasoning_efforts)).toBe(true);
      expect(typeof entry.default_reasoning_effort).toBe("string");
    }
    const codexModel = (wire.models as Record<string, unknown>[]).find((entry) => entry.provider === "account-2");
    // Terminus preserves both account-advertised top rungs independently.
    expect(codexModel?.reasoning_efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "ultra",
    ]);
    expect(codexModel?.default_reasoning_effort).toBe("medium");
  });

  test("a subscription model quotes no per-token price", () => {
    const entries = wire.models as Record<string, unknown>[];
    const priced = entries.find((entry) => entry.provider === "account-1");
    expect(priced?.input_cost_micros).toBe(3_000_000);
    expect(priced?.output_cost_micros).toBe(15_000_000);
    const subscription = entries.find((entry) => entry.provider === "account-2");
    expect(subscription).not.toHaveProperty("input_cost_micros");
    expect(subscription).not.toHaveProperty("output_cost_micros");
  });

  test("the cached-input rate is published, not left to be assumed", () => {
    const priced = (wire.models as Record<string, unknown>[])
      .find((entry) => entry.provider === "account-1");
    // Assuming cache reads cost full input price overstates the cached
    // portion of a well-cached agent turn roughly tenfold.
    expect(priced?.cached_input_micros_per_million).toBe(300_000);
    expect(priced?.pricing).toEqual({
      input_micros_per_million: 3_000_000,
      cached_input_micros_per_million: 300_000,
      output_micros_per_million: 15_000_000,
    });
    expect(priced?.pricing_source).toBe("catalog");
  });

  test("a subscription account says why there is no price instead of omitting the field", () => {
    const subscription = (wire.models as Record<string, unknown>[])
      .find((entry) => entry.provider === "account-2");
    // Absent fields alone cannot distinguish "this plan has no per-token
    // rate" from "discovery has not reported one yet".
    expect(subscription).toHaveProperty("pricing");
    expect(subscription?.pricing).toBeNull();
    expect(subscription?.pricing_source).toBe("subscription");
    expect(subscription).not.toHaveProperty("cached_input_micros_per_million");
  });

  test("rejections keep the account they belong to", () => {
    expect(wire.rejected).toEqual([
      { provider: "account-2", model_id: "gpt-reserve", reason: "hidden" },
    ]);
    expect(wire.observed_at).toBe(OBSERVED_AT);
  });
});

describe("foldReasoningEfforts", () => {
  test("preserves xhigh and ultra separately while folding aliases, in order", () => {
    expect(foldReasoningEfforts(["ultra", "low", "xhigh", "medium", "minimal", "high", "max"]))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("drops a level with no Terminus equivalent rather than offering it", () => {
    expect(foldReasoningEfforts(["turbo", "medium"])).toEqual(["medium"]);
    expect(foldReasoningEffort("turbo")).toBeNull();
  });
});

describe("provider entries", () => {
  test("a connected account carries no unavailable_reason, however chatty its detail", () => {
    const wire = providerAccountModelsWire([{
      account: account({
        status: "connected",
        statusDetail: "model probe unsupported (HTTP 405); using the models.dev catalogue",
      }),
      result: null,
    }], null);
    expect(wire.providers[0]).not.toHaveProperty("unavailable_reason");
    expect((wire.providers[0] as { available: boolean }).available).toBe(true);
  });

  test("an unusable account still explains itself", () => {
    const wire = providerAccountModelsWire([{
      account: account({ status: "expired", statusDetail: "The ChatGPT login expired." }),
      result: null,
    }], null);
    expect(wire.providers[0]).toMatchObject({
      available: false,
      unavailable_reason: "The ChatGPT login expired.",
    });
  });
});

describe("accountMark", () => {
  test("uses initials for a multi-word account and letters for a single word", () => {
    expect(accountMark("OpenCode Zen", "zen")).toBe("OZ");
    expect(accountMark("Cerebras", "cerebras")).toBe("CE");
    expect(accountMark("", "nv")).toBe("NV");
  });
});

describe("transport projection", () => {
  test("an account model carries the account's own base URL and protocol", () => {
    const source = account({ protocol: "responses", baseUrl: "https://api.openai.com/v1" });
    const gatewayModel = toGatewayModel({
      account: source,
      model: model(),
      providerId: providerAccountProviderId(source),
      observedAt: OBSERVED_AT,
    });
    expect(gatewayModel).toMatchObject({
      id: "llama-4",
      providerId: "account:opencode:cerebras",
      baseUrl: "https://api.openai.com/v1",
      protocol: "responses",
    });
  });

  test("unsupported Codex accounts expose no native continuation or transport", () => {
    const codex = account({
      source: "codex-chatgpt",
      protocol: "chat_completions",
      renderProfile: "chatgpt_codex",
      baseUrl: "",
      host: "",
      status: "unsupported",
    });
    const snapshot = providerAccountCapabilitySnapshot({
      account: codex,
      model: model({ reasoning: true, reasoningEfforts: ["low", "high"], supportsReasoningSummaries: true }),
      providerId: providerAccountProviderId(codex),
      observedAt: OBSERVED_AT as Rfc3339Timestamp,
      workspaceAccess: true,
    });
    expect(snapshot.continuation.nativeId).toBe(false);
    expect(snapshot.continuation.crossRequest).toBe(false);
    expect(snapshot.reasoning).toEqual({ supported: true, budgetControl: true, summaryAvailable: true });
    expect(snapshot.policy.allowedConfidentiality).toEqual(["public", "workspace"]);
  });

  test("the ChatGPT subscription path gets the whole GPT-5.6 window up to the billing cliff", () => {
    const codex = account({ source: "chatgpt:codex", protocol: "responses", renderProfile: "chatgpt_codex" });
    const snapshot = providerAccountCapabilitySnapshot({
      account: codex,
      // What the Codex catalogue actually advertises.
      model: model({ id: "gpt-5.6-sol", contextTokens: 1_050_000, outputTokens: 0 }),
      providerId: providerAccountProviderId(codex),
      observedAt: OBSERVED_AT as Rfc3339Timestamp,
      workspaceAccess: true,
    });
    expect(snapshot.context.advertisedTokens).toBe(1_050_000);
    // 270_000, not the old blanket 32_768 (3% of the window) and not the full
    // 1.05M (past 272K the whole request is billed at 2x/1.5x).
    expect(snapshot.context.testedSafeTokens).toBe(270_000);
    // The Codex catalogue reports no output limit, so the family ceiling is
    // the only source; the old code left this undefined and the budget then
    // reserved 1,024 tokens for every response.
    expect(snapshot.context.maxOutputTokens).toBe(128_000);
  });

  test("a non-family model keeps its own window, clamped to the 200k default ceiling", () => {
    const cerebras = account();
    const snapshot = providerAccountCapabilitySnapshot({
      account: cerebras,
      model: model({ id: "llama-4", contextTokens: 128_000, outputTokens: 8_192 }),
      providerId: providerAccountProviderId(cerebras),
      observedAt: OBSERVED_AT as Rfc3339Timestamp,
      workspaceAccess: true,
    });
    expect(snapshot.context.testedSafeTokens).toBe(128_000);
    expect(snapshot.context.maxOutputTokens).toBe(8_192);
  });

  test("a Responses account is stateless (store:false) and can be public-only", () => {
    const openai = account({ source: "opencode:openai", protocol: "responses", renderProfile: "openai_responses" });
    const snapshot = providerAccountCapabilitySnapshot({
      account: openai,
      model: model(),
      providerId: providerAccountProviderId(openai),
      observedAt: OBSERVED_AT as Rfc3339Timestamp,
      workspaceAccess: false,
    });
    // Every Responses request now carries `store: false`, so there is no
    // server-side state for a `previous_response_id` to point at: claiming
    // native continuation here would make the loop drop history it must send.
    expect(snapshot.continuation.nativeId).toBe(false);
    expect(snapshot.continuation.crossRequest).toBe(false);
    expect(snapshot.policy.allowedConfidentiality).toEqual(["public"]);
    expect(snapshot.economics.inputMicrosPerMillion).toBe(3_000_000n as Micros);
  });
});
