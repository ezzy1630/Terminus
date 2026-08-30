import { describe, expect, test } from "bun:test";
import {
  discoverGatewayModels,
  parseAvailableModels,
  parseModelsDevCatalog,
} from "./catalog.js";

const available = {
  object: "list",
  data: [
    { id: "free-chat", object: "model", owned_by: "opencode" },
    { id: "paid-responses", object: "model", owned_by: "opencode" },
    { id: "messages-model", object: "model", owned_by: "opencode" },
    { id: "deprecated-model", object: "model", owned_by: "opencode" },
    { id: "unknown-model", object: "model", owned_by: "opencode" },
  ],
};

const modelsDev = {
  opencode: {
    id: "opencode",
    api: "https://opencode.ai/zen/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "free-chat": {
        id: "free-chat",
        name: "Free Chat",
        tool_call: true,
        structured_output: true,
        limit: { context: 100_000, output: 8_000 },
        cost: { input: 0, output: 0 },
      },
      "paid-responses": {
        id: "paid-responses",
        name: "Paid Responses",
        provider: { npm: "@ai-sdk/openai" },
        tool_call: true,
        limit: { context: 200_000, output: 32_000 },
        cost: { input: 1, output: 4, cache_read: 0.1 },
      },
      "messages-model": {
        id: "messages-model",
        name: "Messages Model",
        provider: { npm: "@ai-sdk/anthropic" },
        tool_call: true,
        limit: { context: 128_000, output: 16_000 },
        cost: { input: 0.3, output: 1.2 },
      },
      "deprecated-model": {
        id: "deprecated-model",
        name: "Deprecated Model",
        status: "deprecated",
        tool_call: true,
        limit: { context: 128_000, output: 16_000 },
        cost: { input: 0, output: 0 },
      },
    },
  },
};

describe("Zen and Go catalog discovery", () => {
  test("intersects live availability with typed protocol metadata", () => {
    const result = discoverGatewayModels({
      deployment: "zen",
      available: parseAvailableModels(available),
      catalog: parseModelsDevCatalog(modelsDev),
      observedAt: "2026-08-24T00:00:00Z",
    });

    expect(result.models.map((model) => [model.id, model.protocol, model.free])).toEqual([
      ["free-chat", "chat_completions", true],
      ["messages-model", "messages", false],
      ["paid-responses", "responses", false],
    ]);
    expect(result.rejected).toEqual([
      { modelId: "deprecated-model", reason: "model is deprecated in the decoded opencode catalog" },
      { modelId: "unknown-model", reason: "model is absent from the decoded opencode catalog" },
    ]);
  });

  test("uses the Go provider snapshot for Go accounts", () => {
    const goCatalog = {
      ...modelsDev,
      "opencode-go": {
        ...modelsDev.opencode,
        id: "opencode-go",
        api: "https://opencode.ai/zen/go/v1",
      },
    };
    const result = discoverGatewayModels({
      deployment: "go",
      available: parseAvailableModels(available),
      catalog: parseModelsDevCatalog(goCatalog),
      observedAt: "2026-08-24T00:00:00Z",
    });
    expect(result.models[0]?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  });

  test("rejects malformed external payloads", () => {
    expect(() => parseAvailableModels({ object: "list", data: [{ id: "" }] })).toThrow();
    expect(() => parseModelsDevCatalog({ opencode: { models: [] } })).toThrow();
  });
});
