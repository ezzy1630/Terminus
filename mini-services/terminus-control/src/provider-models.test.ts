import { describe, expect, test } from "bun:test";
import {
  describeConfiguredModel,
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
    // eslint-disable-next-line require-yield
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

  test("fails closed until the kernel exposes a bounded public catalogue fetch", async () => {
    await expect(fetchModelsDevCatalog()).rejects.toThrow(/kernel-owned bounded public-fetch connector/);
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
  revision: 3,
  updatedBy: "control",
  createdAt: new Date("2026-08-24T00:00:00Z"),
  updatedAt: new Date("2026-08-24T00:01:00Z"),
};

const observedAt = "2026-08-24T01:00:00.000Z" as Rfc3339Timestamp;

describe("configured gateway model capabilities", () => {
  test("asserts conservative placeholders when the model was never discovered", () => {
    resetProviderModelsCache();
    const model = configuredGatewayModel(configuredRow, observedAt, describeConfiguredModel("zen", "grok-code"));
    // Nothing in the stored configuration describes the model, so the turn
    // path must not claim capabilities it cannot know.
    expect(model.reasoning).toBe(false);
    expect(model.contextTokens).toBe(32_768);
    expect(model.inputMicrosPerMillion).toBe(0);
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
    const model = configuredGatewayModel(
      { ...configuredRow, model: "something-else" },
      observedAt,
      describeConfiguredModel("zen", "something-else"),
    );
    expect(model.reasoning).toBe(false);
    expect(model.contextTokens).toBe(32_768);
  });
});
