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
  ConnectorCancelledError,
  HEAD_RECEIPT_OUTCOME,
  KernelDirectConnectorClient,
  asCancellation,
  createDirectRenderer,
  createStreamTelemetry,
  directEndpoint,
  directNetworkDestinations,
  executeDirectProviderRequest,
  isGrpcCancelled,
  isHeadReceipt,
  responseHeaderMap,
  retryAfterMsFromReceipt,
  timeToFirstBodyMs,
} from "./direct-provider-transport.js";
import { classifyLoopError } from "./agent/loop-contracts.js";
import { ProviderTransportError } from "./providers/provider-retry.js";
import { ReasoningReplayLedger, parseReasoningReplay } from "@terminus/provider-core";
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

/** An assistant tool call as the compiler emits it into the fragment array. */
function toolCallFragment(callId: string): CanonicalRenderInput["fragments"][number] {
  const text = JSON.stringify({
    protocol: "terminus.tool-call.v1",
    provider_call_id: callId,
    tool_name: "read",
    arguments: { path: "a.ts" },
  });
  return {
    id: `episode:${callId}`,
    kind: "recent_episode",
    uri: `prompt://${callId}`,
    textContent: text,
    contentRef: { hash: `sha256:${"1".repeat(64)}`, uri: "artifact://sha256/1", mediaType: "text/plain", bytes: BigInt(text.length) },
    confidentiality: "public",
    trust: "trusted",
    exactness: "exact",
    estimatedTokens: { "gpt-5.6-sol": 20 },
  } as never;
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

function makeReceipt(statusCode: number, responseHeaders: { name: string; value: string }[] = []) {
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
    responseHeaders,
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

describe("the provider's own Retry-After reaches the retry policy", () => {
  test("both header forms parse; anything else yields no hint", () => {
    const now = Date.parse("2026-08-29T12:00:00Z");
    // delta-seconds
    expect(retryAfterMsFromReceipt(makeReceipt(429, [{ name: "retry-after", value: "45" }]), now)).toBe(45_000);
    expect(retryAfterMsFromReceipt(makeReceipt(429, [{ name: "Retry-After", value: " 1.5 " }]), now)).toBe(1_500);
    // HTTP-date
    expect(retryAfterMsFromReceipt(
      makeReceipt(503, [{ name: "retry-after", value: "Sat, 29 Aug 2026 12:00:30 GMT" }]),
      now,
    )).toBe(30_000);
    // A date already in the past means "now", never a negative sleep.
    expect(retryAfterMsFromReceipt(
      makeReceipt(503, [{ name: "retry-after", value: "Sat, 29 Aug 2026 11:59:00 GMT" }]),
      now,
    )).toBe(0);
    // Absent, blank, and unparseable all mean "no hint" — never a fabricated one.
    expect(retryAfterMsFromReceipt(makeReceipt(429), now)).toBeNull();
    expect(retryAfterMsFromReceipt(makeReceipt(429, [{ name: "retry-after", value: "  " }]), now)).toBeNull();
    expect(retryAfterMsFromReceipt(makeReceipt(429, [{ name: "retry-after", value: "soon" }]), now)).toBeNull();
    expect(retryAfterMsFromReceipt(undefined, now)).toBeNull();
  });

  test("a 429 receipt on the streaming path throws a hint-carrying transport error", async () => {
    const connectors = makeConnectorService({
      Execute: async () => ({ receipt: makeReceipt(200), body: new Uint8Array() }),
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        subscriber.next({ receipt: makeReceipt(429, [{ name: "retry-after", value: "30" }]) });
        subscriber.complete();
      }),
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const failure = await (async () => {
      try {
        for await (const _ of client.stream(makeDirectRequest())) { /* drain */ }
        return null;
      } catch (error: unknown) { return error; }
    })();
    expect(failure).toBeInstanceOf(ProviderTransportError);
    expect((failure as ProviderTransportError).status).toBe(429);
    // Without this the retry policy invents an 8s backoff and burns the turn.
    expect((failure as ProviderTransportError).retryAfterMs).toBe(30_000);
  });

  test("a 429 receipt on the unary fallback path carries the hint too", async () => {
    const connectors = makeConnectorService({
      Execute: async () => ({
        receipt: makeReceipt(429, [{ name: "retry-after", value: "17" }]),
        body: new TextEncoder().encode("rate limited"),
      }),
      ExecuteStream: undefined,
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const failure = await (async () => {
      try {
        for await (const _ of client.stream(makeDirectRequest())) { /* drain */ }
        return null;
      } catch (error: unknown) { return error; }
    })();
    expect(failure).toBeInstanceOf(ProviderTransportError);
    expect((failure as ProviderTransportError).retryAfterMs).toBe(17_000);
  });
});

describe("renderer options reach the wire", () => {
  test("the requested reasoning effort survives into the Anthropic body", async () => {
    const renderer = createDirectRenderer(anthropicConfig, { reasoningEffort: "max" });
    const body = (await renderer.render(makeCanonicalInput("claude-opus-5"))).body as Record<string, unknown>;
    // Previously constructed as `new AnthropicRenderer()`, which dropped the
    // turn's effort on the floor.
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body.thinking).toEqual({ type: "adaptive" });
    // Sampling parameters are rejected alongside thinking.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test("a seeded ledger replays reasoning for a call made before this process started", async () => {
    // The resume case: the tool call is still in `episodes` and gets rendered
    // again, but the renderer that captured its reasoning is gone.
    const ledger = new ReasoningReplayLedger();
    ledger.seed(parseReasoningReplay(JSON.stringify([{
      call_id: "call_a",
      items: [{ id: "rs_1", encrypted_content: "gAAAAA-opaque", summary: ["checking the file first"] }],
    }])));
    const renderer = createDirectRenderer(openaiResponsesConfig, { reasoningEffort: "high", reasoningReplay: ledger });
    const input = makeCanonicalInput("gpt-5.6-sol");
    const body = (await renderer.render({
      ...input,
      fragments: [
        ...input.fragments,
        toolCallFragment("call_a"),
      ],
    })).body as Record<string, unknown>;
    const items = body.input as Array<Record<string, unknown>>;
    const callIndex = items.findIndex((item) => item.type === "function_call");
    expect(callIndex).toBeGreaterThan(0);
    // Immediately before, not merely present.
    expect(items[callIndex - 1]).toEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "gAAAAA-opaque",
      summary: [{ type: "summary_text", text: "checking the file first" }],
    });
  });

  test("an unseeded renderer renders the same call with no reasoning in front of it", async () => {
    const renderer = createDirectRenderer(openaiResponsesConfig, { reasoningEffort: "high" });
    const input = makeCanonicalInput("gpt-5.6-sol");
    const body = (await renderer.render({
      ...input,
      fragments: [...input.fragments, toolCallFragment("call_a")],
    })).body as Record<string, unknown>;
    const items = body.input as Array<Record<string, unknown>>;
    expect(items.some((item) => item.type === "reasoning")).toBe(false);
  });

  test("the Responses body carries the stateless-replay fields", async () => {
    const renderer = createDirectRenderer(openaiResponsesConfig, { reasoningEffort: "high", promptCacheKey: "session-9" });
    const body = (await renderer.render(makeCanonicalInput("gpt-5.6-sol"))).body as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(body.truncation).toBe("auto");
    expect(body.prompt_cache_key).toBe("session-9");
    expect(body.instructions).toBe("system rules");
  });
});

/** A head receipt: status + headers, emitted before any body byte. */
function makeHead(statusCode: number, responseHeaders: { name: string; value: string }[] = []) {
  return { ...makeReceipt(statusCode, responseHeaders), outcome: HEAD_RECEIPT_OUTCOME };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the head frame is read before the body", () => {
  test("a head receipt is distinguished from a terminal one", () => {
    expect(isHeadReceipt(makeHead(200))).toBe(true);
    expect(isHeadReceipt(makeReceipt(200))).toBe(false);
    // An older kernel emits no outcome at all; that is not a head frame.
    expect(isHeadReceipt({ outcome: undefined })).toBe(false);
    expect(isHeadReceipt(undefined)).toBe(false);
  });

  test("header names are lowercased and values are bounded", () => {
    const map = responseHeaderMap(makeHead(200, [
      { name: "X-Codex-Turn-State", value: "opaque-token" },
      { name: "Retry-After", value: "12" },
      { name: "oversized", value: "z".repeat(9000) },
    ]));
    expect(map["x-codex-turn-state"]).toBe("opaque-token");
    expect(map["retry-after"]).toBe("12");
    expect(map.oversized?.length).toBe(4096);
  });

  test("a 2xx head does not end the stream; the body still arrives", async () => {
    const telemetry = createStreamTelemetry();
    const connectors = makeConnectorService({
      Execute: async () => { throw new Error("buffered Execute must not be used"); },
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        subscriber.next({ receipt: makeHead(200, [{ name: "X-Request-Id", value: "req-1" }]) });
        subscriber.next({ bytes: encode("data: one\n\n") });
        subscriber.next({ bytes: encode("data: [DONE]\n\n") });
        subscriber.next({ receipt: makeReceipt(200) });
        subscriber.complete();
      }),
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const decoded: string[] = [];
    for await (const chunk of client.stream({ ...makeDirectRequest(), telemetry })) {
      decoded.push(new TextDecoder().decode(chunk));
    }
    expect(decoded).toEqual(["data: one\n\n", "data: [DONE]\n\n"]);
    expect(telemetry.status).toBe(200);
    expect(telemetry.responseHeaders["x-request-id"]).toBe("req-1");
  });

  test("a 429 head fails before a single body byte is forwarded", async () => {
    let bodyFramesSent = 0;
    const connectors = makeConnectorService({
      Execute: async () => { throw new Error("buffered Execute must not be used"); },
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        subscriber.next({ receipt: makeHead(429, [{ name: "retry-after", value: "30" }]) });
        bodyFramesSent += 1;
        subscriber.next({ bytes: encode('{"error":{"message":"slow down"}}') });
        subscriber.next({ receipt: makeReceipt(429) });
        subscriber.complete();
      }),
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const decoded: string[] = [];
    const failure = await (async () => {
      try {
        for await (const chunk of client.stream(makeDirectRequest())) {
          decoded.push(new TextDecoder().decode(chunk));
        }
        return null;
      } catch (error: unknown) { return error; }
    })();
    expect(failure).toBeInstanceOf(ProviderTransportError);
    expect((failure as ProviderTransportError).status).toBe(429);
    // The whole point of the head frame: the backoff hint is honoured without
    // waiting the error body out first.
    expect((failure as ProviderTransportError).retryAfterMs).toBe(30_000);
    expect(decoded).toEqual([]);
    expect(bodyFramesSent).toBe(1);
  });

  test("streamRaw reports first-body TTFT, not the head frame's arrival", async () => {
    const telemetry = createStreamTelemetry();
    const connectors = makeConnectorService({
      Execute: async () => { throw new Error("buffered Execute must not be used"); },
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        void (async () => {
          subscriber.next({ receipt: makeHead(200) });
          await new Promise((resolve) => setTimeout(resolve, 25));
          subscriber.next({ bytes: encode("data: hi\n\n") });
          subscriber.next({ receipt: makeReceipt(200) });
          subscriber.complete();
        })();
        return () => { /* no teardown needed */ };
      }),
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    for await (const _ of client.streamRaw({
      host: "api.anthropic.com", port: 443, path: "/v1/messages",
      headers: { "content-type": "application/json" }, body: "{}",
      context: makeContext(), credentialBindingId: "secret://direct/anthropic",
      signal: null, telemetry,
    })) { /* drain */ }
    const ttft = timeToFirstBodyMs(telemetry);
    expect(ttft).not.toBeNull();
    // The head frame arrived immediately; only the body waited.
    expect(ttft ?? 0).toBeGreaterThanOrEqual(20);
    expect(timeToFirstBodyMs(createStreamTelemetry())).toBeNull();
  });

  test("a head-only stream with no body is still an explicit failure", async () => {
    const connectors = makeConnectorService({
      Execute: async () => { throw new Error("buffered Execute must not be used"); },
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        subscriber.next({ receipt: makeHead(200) });
        subscriber.next({ receipt: makeReceipt(200) });
        subscriber.complete();
      }),
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const consume = async (): Promise<void> => {
      for await (const _ of client.stream(makeDirectRequest())) { /* drain */ }
    };
    await expect(consume()).rejects.toThrow("settled without response bytes");
  });
});

describe("caller teardown reads as cancellation, not a provider fault", () => {
  test("gRPC CANCELLED is recognised in every shape the runtime produces", () => {
    expect(isGrpcCancelled({ code: 1 })).toBe(true);
    expect(isGrpcCancelled({ code: "CANCELLED" })).toBe(true);
    expect(isGrpcCancelled(new Error("1 CANCELLED: Call cancelled"))).toBe(true);
    // Not cancellation: UNIMPLEMENTED (12) is the legacy-kernel fallback.
    expect(isGrpcCancelled({ code: 12 })).toBe(false);
    expect(isGrpcCancelled(new Error("boom"))).toBe(false);
  });

  test("asCancellation rewrites CANCELLED and leaves real failures alone", () => {
    const rewritten = asCancellation({ code: 1 }, "turn was cancelled");
    expect(rewritten).toBeInstanceOf(ConnectorCancelledError);
    expect((rewritten as Error).name).toBe("CancelledError");
    const untouched = new Error("upstream reset");
    expect(asCancellation(untouched, "turn was cancelled")).toBe(untouched);
  });

  test("the loop classifies a cancelled stream as cancelled, not internal", () => {
    // Before this mapping a user-interrupted turn was filed as a crash.
    expect(classifyLoopError(new ConnectorCancelledError()).kind).toBe("cancelled");
    expect(classifyLoopError({ code: 1 }).kind).toBe("cancelled");
    expect(classifyLoopError(new Error("upstream reset")).kind).not.toBe("cancelled");
  });

  test("aborting mid-stream unsubscribes the gRPC call", async () => {
    const controller = new AbortController();
    let unsubscribed = false;
    const producerState: { error?: unknown } = {};
    const connectors = makeConnectorService({
      Execute: async () => { throw new Error("buffered Execute must not be used"); },
      ExecuteStream: () => new Observable<ConnectorChunk>((subscriber) => {
        let stopped = false;
        (async () => {
          subscriber.next({ receipt: makeHead(200) });
          // skipcq: JS-0092
          for (let index = 0; index < 20 && !stopped; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (stopped) return;
            subscriber.next({ bytes: encode(`data: ${index}\n\n`) });
          }
        })().catch((error: unknown) => {
          // The producer stops before publishing to a torn-down stream, so a
          // rejection here is unexpected; capturing it lets the assertions
          // below fail the test instead of swallowing the error silently.
          producerState.error = error;
        });
        return () => { stopped = true; unsubscribed = true; };
      }),
    });
    const client = new KernelDirectConnectorClient(connectors, makeContext());
    const decoded: string[] = [];
    const failure = await (async () => {
      try {
        for await (const chunk of client.stream({ ...makeDirectRequest(), signal: controller.signal })) {
          decoded.push(new TextDecoder().decode(chunk));
          controller.abort();
        }
        return null;
      } catch (error: unknown) { return error; }
    })();
    expect(failure).toBeInstanceOf(ConnectorCancelledError);
    expect(producerState.error).toBeUndefined();
    // Dropping the subscription is what tells the kernel to abort upstream.
    expect(unsubscribed).toBe(true);
    expect(classifyLoopError(failure).kind).toBe("cancelled");
    expect(decoded).toHaveLength(1);
  });
});
