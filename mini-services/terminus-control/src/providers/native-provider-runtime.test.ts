import { describe, expect, test } from "bun:test";
import { dispatchNativeRequest, type NativeTransportDeps } from "./native-provider-runtime.js";
import type {
  ProviderEconomics,
  ProviderResponseChunk,
  RenderedProviderRequest,
} from "@terminus/provider-core";

function renderedRequest(overrides: Partial<RenderedProviderRequest> = {}): RenderedProviderRequest {
  return {
    providerId: "openai",
    model: "openai/gpt-4o" as never,
    request: {
      providerId: "openai",
      model: "openai/gpt-4o" as never,
      blocks: [],
      toolSchemas: [],
      continuationId: null,
      cachePlan: { stablePrefixHash: "sha256:" + "0".repeat(64) as never, breakpoints: [] },
      outputProfile: "terse",
    },
    predictedCachedTokens: 1_000n as never,
    body: { model: "gpt-4o", input: [] },
    ...overrides,
  };
}

const economics: ProviderEconomics = {
  inputMicrosPerMillion: 2_500n as never,
  cachedInputMicrosPerMillion: 1_250n as never,
  outputMicrosPerMillion: 10_000n as never,
  reasoningAccounting: false,
} as unknown as ProviderEconomics;

function depsWith(chunks: readonly ProviderResponseChunk[], captured?: { headers?: Record<string,string> }): NativeTransportDeps {
  const encoder = new TextEncoder();
  async function* stream(): AsyncIterable<Uint8Array> {
    yield encoder.encode("data: x\n\n");
  }
  return {
    postSse: async (input) => {
      if (captured) captured.headers = { ...input.headers };
      return stream();
    },
    decode: async function* (): AsyncIterable<ProviderResponseChunk> {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const baseInput = {
  manifestId: "manifest-1",
  economics,
  budgetLimits: {
    requestMicros: 100_000_000n as never,
    taskMicros: 100_000_000n as never,
    sessionMicros: 100_000_000n as never,
  },
};

describe("dispatchNativeRequest", () => {
  test("surfaces continuation id and reconciles usage/cost after the stream", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const chunks: ProviderResponseChunk[] = [
      { kind: "text", text: "hello" },
      {
        kind: "done",
        usage: {
          inputTokens: 5_000n as never,
          cachedInputTokens: 1_000n as never,
          cacheWriteTokens: 0n as never,
          outputTokens: 200n as never,
          reasoningTokens: 0n as never,
          toolSchemaTokens: 0n as never,
          latencyMs: 0,
          timeToFirstTokenMs: null,
        },
        continuationId: "resp_123",
      },
    ];
    const result = await dispatchNativeRequest(
      {
        providerId: "openai",
        baseUrl: "https://api.openai.test/v1",
        auth: { kind: "env-bearer", apiKeyEnv: "OPENAI_API_KEY" },
        endpointPath: "/responses",
      },
      depsWith(chunks),
      { ...baseInput, rendered: renderedRequest() },
    );
    expect(result.continuationId).toBe("resp_123");
    expect(result.usage?.outputTokens).toBe(200n);
    expect(result.cacheObservation?.cacheReads).toBe(1000n);
    expect(result.costReconciliationMicros).not.toBeNull();
    expect(result.budgetStateAfter?.requestSpent).not.toBe(0n);
    delete process.env.OPENAI_API_KEY;
  });

  test("refuses before dispatch when the budget guard denies", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let called = false;
    const deps = depsWith([]);
    deps.postSse = async () => {
      called = true;
      throw new Error("must not be called");
    };
    await expect(
      dispatchNativeRequest(
        {
          providerId: "openai",
          baseUrl: "https://x/v1",
          auth: { kind: "env-bearer", apiKeyEnv: "OPENAI_API_KEY" },
          endpointPath: "",
        },
        deps,
        {
          ...baseInput,
          rendered: renderedRequest({ predictedCachedTokens: 999_999_999_999n as never }),
          budgetLimits: {
            requestMicros: 1n as never,
            taskMicros: 1n as never,
            sessionMicros: 1n as never,
          },
        },
      ),
    ).rejects.toThrow("budget guard");
    expect(called).toBe(false);
    delete process.env.OPENAI_API_KEY;
  });

  test("fails closed without credentials", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      dispatchNativeRequest(
        { providerId: "openai", baseUrl: "https://x", auth: { kind: "env-bearer", apiKeyEnv: "OPENAI_API_KEY" }, endpointPath: "" },
        depsWith([]),
        { ...baseInput, rendered: renderedRequest() },
      ),
    ).rejects.toThrow("OPENAI_API_KEY is not set");
  });

  test("error chunks settle the partial stream explicitly", async () => {
    process.env.OPENAI_API_KEY = "k";
    const result = await dispatchNativeRequest(
      { providerId: "openai", baseUrl: "https://x", auth: { kind: "env-bearer", apiKeyEnv: "OPENAI_API_KEY" }, endpointPath: "" },
      depsWith([
        { kind: "text", text: "partial" },
        { kind: "error", errorCode: "TRUNCATED_STREAM", errorMessage: "cut" },
      ]),
      { ...baseInput, rendered: renderedRequest() },
    );
    expect(result.partialSettlement).toBeDefined();
    expect(result.usage).toBeNull();
    delete process.env.OPENAI_API_KEY;
  });

  test("a completed stream without a usage frame returns cleanly (no TDZ crash, no fabricated cost)", async () => {
    process.env.OPENAI_API_KEY = "k";
    const result = await dispatchNativeRequest(
      { providerId: "openai", baseUrl: "https://x", auth: { kind: "env-bearer", apiKeyEnv: "OPENAI_API_KEY" }, endpointPath: "" },
      depsWith([{ kind: "text", text: "no usage frame" }]),
      { ...baseInput, rendered: renderedRequest() },
    );
    expect(result.usage).toBeNull();
    expect(result.continuationId).toBeNull();
    expect(result.cacheObservation).toBeNull();
    expect(result.costReconciliationMicros).toBeNull();
    expect(result.budgetStateAfter).not.toBeNull();
    expect(result.budgetStateAfter?.requestSpent).toBe(0n);
    delete process.env.OPENAI_API_KEY;
  });

  test("dispatchAnthropic requires an explicit transport and passes it through", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    let transportUsed = false;
    const { dispatchAnthropic } = await import("./anthropic-runtime.js");
    const result = await dispatchAnthropic({
      manifestId: "manifest-2",
      economics,
      budgetLimits: baseInput.budgetLimits,
      canonicalRenderInput: {
        providerId: "anthropic",
        model: "claude-test" as never,
        manifestId: "manifest-2",
        fragments: [],
        toolSchemas: [],
        continuationId: null,
        cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as never, breakpoints: [] },
        outputProfile: "terse",
      } as never,
      postSse: async () => {
        transportUsed = true;
        const encoder = new TextEncoder();
        async function* stream(): AsyncIterable<Uint8Array> {
          yield encoder.encode("event: ping\n\n");
        }
        return stream();
      },
    });
    expect(result.chunks.length).toBeGreaterThanOrEqual(0);
    expect(transportUsed).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
  });
});
