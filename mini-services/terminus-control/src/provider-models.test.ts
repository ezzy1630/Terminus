import { describe, expect, test } from "bun:test";
import {
  describeConfiguredModel,
  discoverProviderModels,
  fetchAvailableModels,
  fetchModelsDevCatalog,
  providerModelsWire,
  rememberProviderModels,
  resetProviderModelsCache,
} from "./provider-models.js";
import { configuredGatewayModel } from "./gateway-provider-config.js";
import type { Rfc3339Timestamp } from "@terminus/domain";
import type { GatewayHttpRequest } from "@terminus/provider-zen";

function gatewayClient(body: string, capture?: (input: GatewayHttpRequest) => void) {
  return {
    async *stream(input: GatewayHttpRequest): AsyncIterable<Uint8Array> {
      capture?.(input);
      yield new TextEncoder().encode(body);
    },
  };
}


describe("provider model discovery", () => {
  test("asks the gateway for its model list over the credential-bound connector", async () => {
    let seen: GatewayHttpRequest | null = null;
    const models = await fetchAvailableModels({
      client: gatewayClient(
        JSON.stringify({ object: "list", data: [{ id: "grok-code", owned_by: "xai" }] }),
        (input) => { seen = input; },
      ),
      deployment: "zen",
      secretUri: "secret://opencode/zen",
    });

    expect(models).toEqual([{ id: "grok-code", ownedBy: "xai" }]);
    // Discovery must not invent a second credential path: same binding as
    // inference, read-only method, and no body.
    expect(seen!.credentialBindingId).toBe("secret://opencode/zen");
    expect(seen!.method).toBe("GET");
    expect(seen!.body).toBeUndefined();
    expect(seen!.url).toBe("https://opencode.ai/zen/v1/models");
  });

  test("fetches models dev catalog with online fetch implementation", async () => {
    resetProviderModelsCache();
    const mockCatalogPayload = {
      opencode: {
        id: "opencode",
        name: "OpenCode Zen",
        api: "https://opencode.ai/zen/v1",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "mock-model": {
            id: "mock-model",
            name: "Mock Model",
            tool_call: true,
            structured_output: true,
            reasoning: false,
            limit: { context: 128_000, output: 16_000 },
            cost: { input: 1.0, output: 2.0, cache_read: 0.5 },
          },
        },
      },
    };

    const mockFetch = (async () => {
      return {
        ok: true,
        json: async () => mockCatalogPayload,
      } as unknown as Response;
    }) as typeof fetch;

    const catalog = await fetchModelsDevCatalog({ fetchFn: mockFetch });
    const opencode = catalog.providers.get("opencode");
    expect(opencode).toBeDefined();
    expect(opencode?.models.has("mock-model")).toBe(true);
  });

  test("falls back to committed offline catalog snapshot when online fetch fails", async () => {
    resetProviderModelsCache();
    const failingFetch = (async () => {
      throw new Error("Network unreachable");
    }) as typeof fetch;

    const catalog = await fetchModelsDevCatalog({ fetchFn: failingFetch });
    const opencode = catalog.providers.get("opencode");
    expect(opencode).toBeDefined();
    expect(opencode?.models.has("grok-code")).toBe(true);
  });

  test("forceOffline bypasses network fetch and returns committed snapshot", async () => {
    resetProviderModelsCache();
    let networkCalled = false;
    const mockFetch = (async () => {
      networkCalled = true;
      throw new Error("Should not be called");
    }) as typeof fetch;

    const catalog = await fetchModelsDevCatalog({ forceOffline: true, fetchFn: mockFetch });
    expect(networkCalled).toBe(false);
    expect(catalog.providers.get("opencode")?.models.has("grok-code")).toBe(true);
  });

  test("discovers provider models seamlessly offline", async () => {
    resetProviderModelsCache();
    const client = gatewayClient(
      JSON.stringify({
        object: "list",
        data: [{ id: "grok-code", owned_by: "xai" }, { id: "ghost", owned_by: "unknown" }],
      }),
    );

    const result = await discoverProviderModels({
      client,
      deployment: "zen",
      secretUri: "secret://opencode/zen",
      observedAt: "2026-08-24T00:00:00.000Z",
      forceOffline: true,
    });

    expect(result.models.length).toBe(1);
    expect(result.models[0].id).toBe("grok-code");
    expect(result.models[0].toolCalling).toBe(true);
    expect(result.models[0].contextTokens).toBe(256_000);
    expect(result.rejected).toEqual([
      { modelId: "ghost", reason: "model is absent from the decoded opencode catalog" },
    ]);
  });

  test("reports an empty inventory with its reason rather than failing the request", () => {
    const wire = providerModelsWire(null, "The OpenCode gateway has no credential configured.");
    expect(wire.models).toEqual([]);
    expect(wire.providers).toEqual([]);
    expect(wire.observed_at).toBeNull();
    expect(wire.error).toBe("The OpenCode gateway has no credential configured.");
  });

  test("projects capabilities the provider reported, and never a guessed one", () => {
    const wire = providerModelsWire({
      deployment: "zen",
      observedAt: "2026-08-24T00:00:00.000Z",
      models: [{
        id: "grok-code",
        name: "Grok Code",
        deployment: "zen",
        providerId: "open_code_zen",
        baseUrl: "https://opencode.ai/zen/v1",
        protocol: "chat_completions",
        free: true,
        toolCalling: true,
        structuredOutput: true,
        imageInput: false,
        reasoning: true,
        contextTokens: 256_000,
        outputTokens: 64_000,
        inputMicrosPerMillion: 0,
        cachedInputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
        observedAt: "2026-08-24T00:00:00.000Z",
      }],
      rejected: [{ modelId: "ghost", reason: "model is absent from the decoded opencode catalog" }],
    }, null);

    expect(wire.models).toEqual([expect.objectContaining({
      id: "grok-code",
      provider: "open_code_zen",
      label: "Grok Code",
      free: true,
      reasoning: true,
      context_tokens: 256_000,
      tool_calling: true,
    })]);
    // A model the catalogue could not describe is surfaced as rejected rather
    // than shipped with invented capabilities.
    expect(wire.rejected).toEqual([
      { model_id: "ghost", reason: "model is absent from the decoded opencode catalog" },
    ]);
  });
});

const discoveredGrok = {
  id: "grok-code",
  name: "Grok Code",
  deployment: "zen" as const,
  providerId: "open_code_zen" as const,
  baseUrl: "https://opencode.ai/zen/v1",
  protocol: "chat_completions" as const,
  free: false,
  toolCalling: true,
  structuredOutput: true,
  imageInput: false,
  reasoning: true,
  contextTokens: 256_000,
  outputTokens: 64_000,
  inputMicrosPerMillion: 3_000_000,
  cachedInputMicrosPerMillion: 750_000,
  outputMicrosPerMillion: 15_000_000,
  observedAt: "2026-08-24T00:00:00.000Z",
};

const configuredRow = {
  deployment: "zen",
  protocol: "responses",
  model: "grok-code",
  secretUri: "secret://opencode/zen",
  credentialConfigured: true,
  toolsEnabled: true,
  freeModel: false,
  workspaceAccess: false,
  privacyTermsAdmitted: false,
  privacyTermsVersion: null,
  revision: 3,
  updatedBy: "control",
  createdAt: new Date("2026-08-24T00:00:00Z"),
  updatedAt: new Date("2026-08-24T00:01:00Z"),
};

const observedAt = "2026-08-24T01:00:00.000Z" as Rfc3339Timestamp;

describe("configured gateway model capabilities", () => {
  test("fails closed when the model was never discovered", () => {
    resetProviderModelsCache();
    expect(() => configuredGatewayModel(
      configuredRow,
      observedAt,
      describeConfiguredModel("zen", "grok-code"),
    )).toThrow("has no admitted discovery record");
  });

  test("prefers discovered capabilities over placeholders", () => {
    resetProviderModelsCache();
    rememberProviderModels(
      { deployment: "zen", observedAt: "2026-08-24T00:00:00.000Z", models: [discoveredGrok], rejected: [] },
      Date.now(),
    );
    const model = configuredGatewayModel(configuredRow, observedAt, describeConfiguredModel("zen", "grok-code"));
    expect(model.reasoning).toBe(true);
    expect(model.contextTokens).toBe(256_000);
    expect(model.inputMicrosPerMillion).toBe(3_000_000);
    // Fields the operator owns still come from the configuration.
    expect(model.protocol).toBe("responses");
    expect(model.observedAt).toBe(observedAt);
  });

  test("never re-enables tools the operator turned off", () => {
    resetProviderModelsCache();
    rememberProviderModels(
      { deployment: "zen", observedAt: "2026-08-24T00:00:00.000Z", models: [discoveredGrok], rejected: [] },
      Date.now(),
    );
    const model = configuredGatewayModel(
      { ...configuredRow, toolsEnabled: false },
      observedAt,
      describeConfiguredModel("zen", "grok-code"),
    );
    expect(model.toolCalling).toBe(false);
  });

  test("ignores a discovered record for a different model", () => {
    resetProviderModelsCache();
    rememberProviderModels(
      { deployment: "zen", observedAt: "2026-08-24T00:00:00.000Z", models: [discoveredGrok], rejected: [] },
      Date.now(),
    );
    expect(() => configuredGatewayModel(
      { ...configuredRow, model: "something-else" },
      observedAt,
      describeConfiguredModel("zen", "something-else"),
    )).toThrow("has no admitted discovery record");
  });
});
