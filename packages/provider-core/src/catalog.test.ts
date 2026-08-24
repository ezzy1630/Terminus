import { describe, expect, test } from "bun:test";
import {
  admitModelRecord,
  getOfflineCatalogSnapshotDigest,
  getOfflineCatalogSnapshotJson,
  loadOfflineCatalogSnapshot,
  parseModelsDevCatalogUniversal,
  type UniversalCatalogModel,
} from "./catalog/index.js";

describe("Models.dev catalog snapshot & universal parser", () => {
  test("loads offline catalog snapshot with standard providers", () => {
    const catalog = loadOfflineCatalogSnapshot();
    expect(catalog.providers.has("openai")).toBe(true);
    expect(catalog.providers.has("anthropic")).toBe(true);
    expect(catalog.providers.has("ollama")).toBe(true);
    expect(catalog.providers.has("opencode")).toBe(true);
    expect(catalog.providers.has("opencode-go")).toBe(true);

    const openai = catalog.providers.get("openai")!;
    expect(openai.models.has("gpt-4o")).toBe(true);
    expect(openai.models.get("gpt-4o")?.toolCalling).toBe(true);
    expect(openai.models.get("gpt-4o")?.contextTokens).toBe(128_000);

    const anthropic = catalog.providers.get("anthropic")!;
    expect(anthropic.models.has("claude-3-5-sonnet-20241022")).toBe(true);

    const ollama = catalog.providers.get("ollama")!;
    expect(ollama.models.has("llama3.3:70b")).toBe(true);
    expect(ollama.models.get("llama3.3:70b")?.inputCost).toBe(0);
  });

  test("computes deterministic SHA-256 digest of offline catalog snapshot", () => {
    const digest1 = getOfflineCatalogSnapshotDigest();
    const digest2 = getOfflineCatalogSnapshotDigest();
    expect(digest1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest1).toBe(digest2);


    const rawJson = getOfflineCatalogSnapshotJson();
    expect(typeof rawJson).toBe("object");
    expect(rawJson).not.toBeNull();
  });

  test("universal parser parses custom provider catalog correctly", () => {
    const raw = {
      custom_provider: {
        id: "custom_provider",
        name: "Custom Provider",
        api: "https://custom.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "custom-model-1": {
            id: "custom-model-1",
            name: "Custom Model 1",
            tool_call: true,
            structured_output: true,
            reasoning: false,
            limit: { context: 64_000, output: 8_000 },
            cost: { input: 1.0, output: 2.0, cache_read: 0.5 },
          },
        },
      },
    };

    const parsed = parseModelsDevCatalogUniversal(raw);
    expect(parsed.providers.size).toBe(1);
    const provider = parsed.providers.get("custom_provider")!;
    expect(provider.id).toBe("custom_provider");
    expect(provider.api).toBe("https://custom.ai/v1");
    expect(provider.models.size).toBe(1);
    const model = provider.models.get("custom-model-1")!;
    expect(model.id).toBe("custom-model-1");
    expect(model.name).toBe("Custom Model 1");
    expect(model.contextTokens).toBe(64_000);
    expect(model.inputCost).toBe(1.0);
    expect(model.cachedInputCost).toBe(0.5);
  });

  test("universal parser rejects malformed inputs fail-closed", () => {
    expect(() => parseModelsDevCatalogUniversal(null)).toThrow("Models.dev catalog must be an object");
    expect(() => parseModelsDevCatalogUniversal([])).toThrow("Models.dev catalog must be an object");
    expect(() => parseModelsDevCatalogUniversal({})).toThrow("contains no valid providers");

    expect(() => parseModelsDevCatalogUniversal({
      broken: {
        id: "broken",
        api: "https://broken.ai/v1",
        npm: "@ai-sdk/broken",
        models: {
          m1: {
            id: "m2", // Key mismatch
            name: "Mismatched",
          },
        },
      },
    })).toThrow("does not match model id");
  });
});

describe("Model admission records & capability probes", () => {
  const fullModel: UniversalCatalogModel = {
    id: "test-frontier",
    name: "Test Frontier",
    protocolPackage: "@ai-sdk/openai",
    toolCalling: true,
    structuredOutput: true,
    imageInput: true,
    reasoning: true,
    contextTokens: 128_000,
    outputTokens: 16_384,
    inputCost: 2.5,
    cachedInputCost: 1.25,
    outputCost: 10.0,
  };

  test("admits fully capable model with admitted status", () => {
    const admission = admitModelRecord(fullModel, "openai", {
      minContextTokens: 32_000,
      requireToolCalling: true,
      requireStructuredOutput: true,
    });

    expect(admission.status).toBe("admitted");
    expect(admission.downgrades).toEqual([]);
    expect(admission.rejectionReasons).toEqual([]);
    expect(admission.inputMicrosPerMillion).toBe(2_500_000);
    expect(admission.cachedInputMicrosPerMillion).toBe(1_250_000);
    expect(admission.outputMicrosPerMillion).toBe(10_000_000);
    expect(admission.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("records downgrades for missing non-strict capabilities", () => {
    const basicModel: UniversalCatalogModel = {
      id: "test-basic",
      name: "Test Basic",
      protocolPackage: "@ai-sdk/openai-compatible",
      toolCalling: false,
      structuredOutput: false,
      imageInput: false,
      reasoning: false,
      contextTokens: 4_000,
      outputTokens: 2_000,
      inputCost: 1.0,
      cachedInputCost: 0,
      outputCost: 2.0,
    };

    const admission = admitModelRecord(basicModel, "custom", {
      minContextTokens: 8_000,
      requireToolCalling: false,
      strict: false,
    });

    expect(admission.status).toBe("downgraded");
    expect(admission.downgrades).toContain("missing_native_tool_calling");
    expect(admission.downgrades).toContain("missing_structured_output");
    expect(admission.downgrades).toContain("missing_prompt_caching");
    expect(admission.downgrades).toContain("constrained_context_window");
    expect(admission.rejectionReasons).toEqual([]);
  });

  test("rejects model when strict requirement fails", () => {
    const noToolModel: UniversalCatalogModel = {
      ...fullModel,
      toolCalling: false,
    };

    const admission = admitModelRecord(noToolModel, "openai", {
      requireToolCalling: true,
      strict: true,
    });

    expect(admission.status).toBe("rejected");
    expect(admission.rejectionReasons.length).toBeGreaterThan(0);
    expect(admission.rejectionReasons[0]).toContain("does not support required native tool calling");
  });

  test("rejects model with zero context tokens unconditionally", () => {
    const zeroContextModel: UniversalCatalogModel = {
      ...fullModel,
      contextTokens: 0,
    };

    const admission = admitModelRecord(zeroContextModel, "openai");
    expect(admission.status).toBe("rejected");
    expect(admission.rejectionReasons).toContain("Model 'test-frontier' advertises 0 context tokens");
  });
});
