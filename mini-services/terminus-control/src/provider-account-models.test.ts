/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import type { Micros, Rfc3339Timestamp } from "@terminus/domain";
import {
  accountMark,
  decodeCodexCatalog,
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
import { providerAccountProviderId, type ProviderAccountRecord } from "./provider-accounts.js";

const OBSERVED_AT = "2026-08-28T12:00:00.000Z";

function account(overrides: Partial<ProviderAccountRecord> = {}): ProviderAccountRecord {
  return {
    id: "account-1",
    source: "opencode:cerebras",
    displayName: "Cerebras",
    vendorId: "cerebras",
    authKind: "api",
    credentialUri: "secret://provider-account/account-1",
    fingerprint: "0123456789ab",
    baseUrl: "https://api.cerebras.ai/v1",
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

describe("decodeCodexCatalog", () => {
  const raw = {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        visibility: "list",
        context_window: 272_000,
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "high", "ultra"],
        supports_reasoning_summaries: true,
        supports_parallel_tool_calls: true,
        input_modalities: ["text", "image"],
      },
      {
        slug: "gpt-reserve",
        display_name: "Reserve",
        visibility: "hidden",
        context_window: 272_000,
        supported_reasoning_levels: ["medium"],
      },
    ],
  };

  test("keeps listed slugs with their advertised reasoning levels and zero micros", () => {
    const { models } = decodeCodexCatalog(raw);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextTokens: 272_000,
      reasoningEfforts: ["low", "medium", "high", "ultra"],
      defaultReasoningEffort: "medium",
      supportsParallelToolCalls: true,
      supportsReasoningSummaries: true,
      toolCalling: true,
      imageInput: true,
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      // A subscription turn is not free; it draws on a plan window.
      free: false,
    });
  });

  test("excludes hidden slugs but records why", () => {
    const { rejected } = decodeCodexCatalog(raw);
    expect(rejected).toEqual([{ modelId: "gpt-reserve", reason: "the Codex catalogue marks the model hidden" }]);
  });

  /**
   * The live catalogue does not answer with a plain string array — the first
   * real run decoded every model as non-reasoning with an empty effort list.
   * Object entries are the shape that actually arrives.
   */
  test("reads reasoning levels from object entries as well as strings", () => {
    const { models } = decodeCodexCatalog({
      models: [{
        slug: "gpt-5.4-mini",
        display_name: "GPT-5.4-Mini",
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", display_name: "Low" },
          { effort: "medium" },
          { effort: "high" },
          { effort: "xhigh" },
        ],
        supports_reasoning_summaries: true,
      }],
    });
    expect(models[0]?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[0]?.defaultReasoningEffort).toBe("medium");
    expect(models[0]?.reasoning).toBe(true);
  });

  test("accepts the alternate key names and the `level`/`slug` fields", () => {
    const { models } = decodeCodexCatalog({
      models: [{
        slug: "gpt-5.5",
        visibility: "list",
        supported_reasoning_efforts: [{ level: "medium" }, { slug: "high" }],
      }],
    });
    expect(models[0]?.reasoningEfforts).toEqual(["medium", "high"]);
  });

  test("a default the model does not advertise is not sent back", () => {
    const { models } = decodeCodexCatalog({
      models: [{
        slug: "gpt-5.5",
        visibility: "list",
        default_reasoning_level: "turbo",
        supported_reasoning_levels: ["low", "medium"],
      }],
    });
    expect(models[0]?.defaultReasoningEffort).toBe("medium");
  });

  test("summaries alone still mark a model as reasoning", () => {
    const { models } = decodeCodexCatalog({
      models: [{ slug: "gpt-5.4", visibility: "list", supports_reasoning_summaries: true }],
    });
    expect(models[0]?.reasoning).toBe(true);
    expect(models[0]?.reasoningEfforts).toEqual([]);
  });

  test("a document that is not a catalogue fails closed", () => {
    expect(() => decodeCodexCatalog({ data: [] })).toThrow("models array");
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
          reasoningEfforts: ["low", "medium", "high", "ultra"],
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
    // `ultra` has no Terminus rung of its own; it folds onto `max`.
    expect(codexModel?.reasoning_efforts).toEqual(["low", "medium", "high", "max"]);
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

  test("rejections keep the account they belong to", () => {
    expect(wire.rejected).toEqual([
      { provider: "account-2", model_id: "gpt-reserve", reason: "hidden" },
    ]);
    expect(wire.observed_at).toBe(OBSERVED_AT);
  });
});

describe("foldReasoningEfforts", () => {
  test("folds provider level names onto the four Terminus efforts, in order", () => {
    expect(foldReasoningEfforts(["ultra", "low", "xhigh", "medium", "minimal", "high"]))
      .toEqual(["low", "medium", "high", "max"]);
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

  test("ChatGPT Codex advertises no native continuation, because it stores nothing", () => {
    const codex = account({
      source: "codex-chatgpt",
      protocol: "responses",
      renderProfile: "chatgpt_codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
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

  test("a Responses account keeps native continuation and can be public-only", () => {
    const openai = account({ source: "opencode:openai", protocol: "responses", renderProfile: "openai_responses" });
    const snapshot = providerAccountCapabilitySnapshot({
      account: openai,
      model: model(),
      providerId: providerAccountProviderId(openai),
      observedAt: OBSERVED_AT as Rfc3339Timestamp,
      workspaceAccess: false,
    });
    expect(snapshot.continuation.nativeId).toBe(true);
    expect(snapshot.policy.allowedConfidentiality).toEqual(["public"]);
    expect(snapshot.economics.inputMicrosPerMillion).toBe(3_000_000n as Micros);
  });
});
