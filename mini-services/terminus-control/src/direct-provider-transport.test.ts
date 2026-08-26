import { describe, expect, test } from "bun:test";
import { Observable } from "rxjs";
import type {
  CanonicalRenderInput,
  RenderedProviderRequest,
} from "@terminus/provider-core";
import type {
  ConnectorChunk,
  ConnectorService,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { DirectHttpRequest } from "./direct-provider-transport.js";
import {
  KernelDirectConnectorClient,
  createDirectRenderer,
  directEndpoint,
  directNetworkDestinations,
  executeDirectProviderRequest,
} from "./direct-provider-transport.js";
import { configuredDirectProviderSnapshot, parseDirectProviderConfiguration } from "./direct-provider-config.js";

const anthropicConfig = parseDirectProviderConfiguration(JSON.stringify({
  vendor: "anthropic",
  protocol: "messages",
  model: "claude-3-5-sonnet-20241022",
}));
if (anthropicConfig === null) throw new Error("anthropic fixture config failed to parse");

const openaiResponsesConfig = parseDirectProviderConfiguration(JSON.stringify({
  vendor: "openai",
  protocol: "responses",
  model: "gpt-4o",
}));
if (openaiResponsesConfig === null) throw new Error("openai fixture config failed to parse");

const ANTHROPIC_BODY = { model: "claude-3-5-sonnet-20241022", system: [], messages: [], max_tokens: 64 };

function fakeRendered(providerId: "anthropic" | "openai"): RenderedProviderRequest {
  const model = providerId === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o";
  return {
    providerId,
    model: model as never,
    request: {
      providerId,
      model: model as never,
      blocks: [],
      toolSchemas: [],
      continuationId: null,
      cachePlan: { breakpoints: [], stablePrefixHash: `sha256:${"0".repeat(64)}` as never },
      outputProfile: "terse",
      reasoningReserveTokens: 0n as never,
      outputReserveTokens: 1024n as never,
      hardInputLimit: 200_000n as never,
      signal: null,
    },
    predictedCachedTokens: 0n as never,
    body: providerId === "anthropic" ? ANTHROPIC_BODY : { model: "gpt-4o", input: [] },
  };
}

interface RecordedRequest {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly credentialBindingId: string;
}

function fakeClient(responseBody: string): { readonly recorded: RecordedRequest[]; readonly client: import("./direct-provider-transport.js").DirectConnectorClient } {
  const recorded: RecordedRequest[] = [];
  return {
    recorded,
    client: {
      stream(input: DirectHttpRequest): AsyncIterable<Uint8Array> {
        recorded.push(input);
        async function* chunks(): AsyncIterable<Uint8Array> {
          yield new TextEncoder().encode(responseBody);
        }
        return chunks();
      },
    },
  };
}

describe("direct endpoint admission", () => {
  test("maps vendor+protocol onto registered kernel connectors", () => {
    expect(directEndpoint(anthropicConfig)).toMatchObject({
      host: "api.anthropic.com",
      path: "/v1/messages",
      connectorId: "anthropic-messages",
    });
    expect(directEndpoint(openaiResponsesConfig)).toMatchObject({
      host: "api.openai.com",
      path: "/v1/responses",
      connectorId: "openai-responses",
    });
    const chat = parseDirectProviderConfiguration(JSON.stringify({ vendor: "openai", protocol: "chat_completions", model: "gpt-4o" }));
    if (chat === null) throw new Error("chat fixture config failed to parse");
    expect(directEndpoint(chat)).toMatchObject({ path: "/v1/chat/completions", connectorId: "openai-chat" });
  });

  test("network destinations cover every admitted endpoint once", () => {
    expect(directNetworkDestinations()).toEqual(["api.anthropic.com:443", "api.openai.com:443"]);
  });
});

describe("direct transport dispatch", () => {
  test("anthropic requests bind the secret URI and version header; auth stays kernel-side", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const { recorded, client } = fakeClient(sse);
    const response = await executeDirectProviderRequest(
      { rendered: fakeRendered("anthropic"), configuration: anthropicConfig },
      client,
    );
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toMatchObject({
      host: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      credentialBindingId: "secret://direct/anthropic",
    });
    expect(recorded[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(recorded[0]?.headers["content-type"]).toBe("application/json");
    // No credential header here — the kernel injects x-api-key at dispatch.
    expect(recorded[0]?.headers["authorization"]).toBeUndefined();
    const text = response.chunks
      .filter((chunk) => chunk.kind === "text")
      .map((chunk) => chunk.text ?? "")
      .join("");
    expect(text).toBe("hello");
  });

  test("responses requests carry prompt_cache_key and stream usage through", async () => {
    const sse = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cached_tokens":80}}}}\n\n',
    ].join("");
    const { recorded, client } = fakeClient(sse);
    const response = await executeDirectProviderRequest(
      { rendered: fakeRendered("openai"), configuration: openaiResponsesConfig, cacheKey: "epoch-123" },
      client,
    );
    const sent = JSON.parse(recorded[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent.prompt_cache_key).toBe("epoch-123");
    expect(sent.stream).toBe(true);
    const done = response.chunks.find((chunk) => chunk.kind === "done");
    if (done?.kind !== "done") throw new Error("expected done chunk");
    expect(done.usage?.cachedInputTokens as unknown as bigint).toBe(80n);
    expect(done.continuationId).toBe("resp_1");
  });

  test("dispatch failures surface the transport error and fabricate nothing", async () => {
    let calls = 0;
    const failingClient = {
      stream(): AsyncIterable<Uint8Array> {
        calls += 1;
        throw new Error("direct provider returned HTTP 401: invalid x-api-key");
      },
    };
    await expect(executeDirectProviderRequest(
      { rendered: fakeRendered("anthropic"), configuration: anthropicConfig },
      failingClient,
    )).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });

  test("oversized request bodies fail closed before dispatch", async () => {
    const hugeBody = { model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "x".repeat(5 * 1024 * 1024) }] };
    await expect(executeDirectProviderRequest(
      { rendered: { ...fakeRendered("anthropic"), body: hugeBody }, configuration: anthropicConfig },
      { stream() { throw new Error("must not be called"); } },
    )).rejects.toThrow(/exceeds/);
  });

  test("does not duplicate a request when a streaming RPC emits bytes before failing", async () => {
    let executeCalls = 0;
    const connectors = makeConnectorService({
      Execute: async () => {
        executeCalls += 1;
        return { receipt: makeReceipt(200), body: new Uint8Array() };
      },
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        subscriber.next({ bytes: new TextEncoder().encode("partial") });
        subscriber.error(new Error("UNIMPLEMENTED: stream method unavailable"));
      }),
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const received: Uint8Array[] = [];

    await expect((async () => {
      for await (const chunk of client.stream(makeDirectRequest())) received.push(chunk);
    })()).rejects.toThrow(/UNIMPLEMENTED/);
    expect(new TextDecoder().decode(received[0])).toBe("partial");
    expect(executeCalls).toBe(0);
  });

  test("falls back to unary dispatch when ExecuteStream is absent", async () => {
    let executeCalls = 0;
    const connectors = makeConnectorService({
      Execute: async () => {
        executeCalls += 1;
        return {
          receipt: makeReceipt(200),
          body: new TextEncoder().encode("data: {}\n\n"),
        };
      },
      ExecuteStream: undefined,
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const received: Uint8Array[] = [];
    for await (const chunk of client.stream(makeDirectRequest())) received.push(chunk);

    expect(executeCalls).toBe(1);
    expect(new TextDecoder().decode(received[0])).toBe("data: {}\n\n");
  });
});

describe("renderer factory", () => {
  test("returns protocol-correct renderers for each configuration", async () => {
    const canonicalInput = makeCanonicalInput("claude-3-5-sonnet-20241022");
    const anthropicRenderer = createDirectRenderer(anthropicConfig);
    expect(anthropicRenderer.providerId).toBe("anthropic");
    const anthropicRendered = await anthropicRenderer.render(canonicalInput);
    expect(anthropicRendered.body.stream).toBe(true);

    const responsesRenderer = createDirectRenderer(openaiResponsesConfig);
    expect(responsesRenderer.providerId).toBe("openai");
    const responsesRendered = await responsesRenderer.render(makeCanonicalInput("gpt-4o"));
    // Responses conversion keeps the model id and marks the stream.
    expect(responsesRendered.body.model).toBe("gpt-4o");
    expect(responsesRendered.body.stream).toBe(true);
  });
});

function makeCanonicalInput(modelKey: string): CanonicalRenderInput {
  const provider = configuredDirectProviderSnapshot(
    parseDirectProviderConfiguration(JSON.stringify({
      vendor: modelKey.startsWith("claude") ? "anthropic" : "openai",
      protocol: modelKey.startsWith("claude") ? "messages" : "responses",
      model: modelKey,
    })) ?? (() => { throw new Error("fixture config failed to parse"); })(),
    "2026-08-24T00:00:00Z" as never,
  );
  return {
    provider,
    model: {
      modelKey: modelKey as never,
      providerId: provider.providerId as never,
      snapshot: provider as never,
      observedAt: "2026-08-24T00:00:00Z" as never,
    },
    fragments: [{
      id: "authority",
      kind: "authority",
      uri: "prompt://authority",
      textContent: "system rules",
      contentRef: { hash: `sha256:${"0".repeat(64)}`, uri: "artifact://sha256/0", mediaType: "text/plain", bytes: 12n },
      confidentiality: "public",
      trust: "trusted",
      exactness: "exact",
      estimatedTokens: { [modelKey]: 3 },
    } as never],
    toolSchemas: [],
    cachePlan: { stablePrefixHash: `sha256:${"0".repeat(64)}` as never, breakpoints: [] },
    continuationId: null,
    outputProfile: "default" as never,
    reasoningReserveTokens: 0n as never,
    outputReserveTokens: 1024n as never,
    hardInputLimit: 200_000n as never,
    signal: null,
    manifestId: "manifest-test",
  };
}

function makeContext(): RequestContext {
  return {
    requestId: "00000000-0000-7000-8000-000000000001",
    idempotencyKey: "direct-test",
    sessionId: "session-1",
    taskId: "task-1",
    turnId: "turn-1",
    actorId: "test",
    traceparent: "00-00000000000000000000000000000000-0000000000000000-01",
    capabilityToken: "capability-token",
    workspaceId: "workspace-1",
    deadline: undefined,
    resourceBudgets: undefined,
    policyVersion: "test-policy",
  };
}

function makeReceipt(statusCode: number) {
  return {
    grantId: "grant-1",
    taskId: "task-1",
    effectId: "effect-1",
    connectorId: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    destination: "api.anthropic.com:443",
    requestSha256: "sha256:request",
    statusCode,
    responseSha256: "sha256:response",
    responseRedactions: 0,
    outcome: "ok",
  };
}

function makeConnectorService(overrides: {
  readonly Execute: ConnectorService["Execute"];
  readonly ExecuteStream: ConnectorService["ExecuteStream"] | undefined;
}): ConnectorService {
  return {
    MintGrant: async () => ({ encodedGrant: "encoded-grant", grantId: "grant-1", expiresAtUnix: 1_800_000_000 }),
    Execute: overrides.Execute,
    ExecuteStream: overrides.ExecuteStream as ConnectorService["ExecuteStream"],
  };
}

function makeDirectRequest(): DirectHttpRequest {
  return {
    method: "POST",
    host: "api.anthropic.com",
    port: 443,
    path: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: "{}",
    credentialBindingId: "secret://direct/anthropic",
  };
}
