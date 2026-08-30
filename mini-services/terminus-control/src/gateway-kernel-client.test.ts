import { describe, expect, test } from "bun:test";
import { Observable } from "rxjs";
import { KernelGatewayClient, OPENCODE_GATEWAY_USER_AGENT } from "./gateway-kernel-client.js";
import { isRetryableProviderError, ProviderTransportError } from "./providers/provider-retry.js";
import { ConnectorCancelledError, HEAD_RECEIPT_OUTCOME } from "./direct-provider-transport.js";
import { classifyLoopError } from "./agent/loop-contracts.js";
import { CodexTurnState, chatGptCodexRequestHeaders } from "@terminus/provider-openai";
import type {
  ConnectorChunk,
  ConnectorReceiptMessage,
  ConnectorService,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";

type BufferedConnectors = Pick<ConnectorService, "MintGrant" | "Execute">;

/**
 * A kernel that predates ExecuteStream. The client must fall back to the
 * buffered `Execute` for it, so the unary tests below keep exercising that
 * path exactly as they did before H9.
 */
function withoutStreaming(partial: BufferedConnectors): ConnectorService {
  return {
    ...partial,
    ExecuteStream: () =>
      new Observable<ConnectorChunk>((subscriber) => {
        subscriber.error(new Error("12 UNIMPLEMENTED: unknown method ExecuteStream"));
      }),
  };
}

function receipt(overrides: Partial<ConnectorReceiptMessage> = {}): ConnectorReceiptMessage {
  return {
    grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
    method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
    requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
    responseRedactions: 0, outcome: "accepted", responseHeaders: [],
    ...overrides,
  };
}

/** A kernel that streams: body chunks first, then the terminal receipt. */
function streamingConnectors(input: {
  readonly chunks: readonly string[];
  readonly receipt?: ConnectorReceiptMessage;
  readonly delayMs?: number;
  readonly onExecute?: () => void;
}): ConnectorService {
  return {
    MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
    Execute: async () => {
      input.onExecute?.();
      throw new Error("buffered Execute must not be used when ExecuteStream works");
    },
    ExecuteStream: () =>
      new Observable<ConnectorChunk>((subscriber) => {
        let cancelled = false;
        void (async () => {
          for (const chunk of input.chunks) {
            if (cancelled) return;
            if (input.delayMs !== undefined) {
              await new Promise((resolve) => setTimeout(resolve, input.delayMs));
            }
            subscriber.next({ bytes: new TextEncoder().encode(chunk), receipt: undefined });
          }
          if (cancelled) return;
          subscriber.next({ bytes: undefined, receipt: input.receipt ?? receipt() });
          subscriber.complete();
        })();
        return () => { cancelled = true; };
      }),
  };
}

const context: RequestContext = {
  requestId: "request",
  idempotencyKey: "attempt",
  sessionId: "session",
  taskId: "task",
  turnId: "turn",
  actorId: "control",
  traceparent: "",
  capabilityToken: "opaque",
  workspaceId: "workspace",
  deadline: undefined,
  resourceBudgets: undefined,
  policyVersion: "v1",
};

describe("KernelGatewayClient", () => {
  test("mints an exact grant and returns the scrubbed kernel body", async () => {
    const calls: unknown[] = [];
    const client = new KernelGatewayClient(withoutStreaming({
        MintGrant: async (request) => {
          calls.push(request);
          return { encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 };
        },
        Execute: async (request) => {
          calls.push(request);
          return {
            receipt: {
              grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
              method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
              requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
              responseRedactions: 0, outcome: "accepted", responseHeaders: [],
            },
            body: new TextEncoder().encode("data: [DONE]\n\n"),
            contentType: "text/event-stream",
          };
        },
    }), context);
    const chunks: Uint8Array[] = [];
    for await (const chunk of client.stream({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: "{}",
      credentialBindingId: "secret://opencode/zen",
      authStyle: "bearer",
      signal: null,
    })) chunks.push(chunk);
    expect(new TextDecoder().decode(chunks[0])).toBe("data: [DONE]\n\n");
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toContain("api-key");
  });

  // The gateway serves its anonymous free tier only to callers whose agent
  // names OpenCode; under the broker default every dispatch was a 429.
  test("names OpenCode in the user agent it sends to the gateway", async () => {
    let sent: readonly { readonly name: string; readonly value: string }[] = [];
    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async (request) => {
        sent = request.operation?.headers ?? [];
        return {
          receipt: receipt({ connectorId: "opencode-gateway-anonymous" }),
          body: new TextEncoder().encode("data: [DONE]\n\n"),
          contentType: "text/event-stream",
        };
      },
    }), context);
    for await (const _ of client.stream({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: "{}",
      credentialBindingId: "",
      authStyle: "none",
      signal: null,
    })) { /* drained */ }

    const agent = sent.find((header) => header.name.toLowerCase() === "user-agent");
    expect(agent?.value).toBe(OPENCODE_GATEWAY_USER_AGENT);
    expect(agent?.value.toLowerCase()).toContain("opencode");
  });

  test("leaves a caller-chosen user agent alone", async () => {
    let sent: readonly { readonly name: string; readonly value: string }[] = [];
    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async (request) => {
        sent = request.operation?.headers ?? [];
        return {
          receipt: receipt(),
          body: new TextEncoder().encode("data: [DONE]\n\n"),
          contentType: "text/event-stream",
        };
      },
    }), context);
    for await (const _ of client.stream({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: { accept: "text/event-stream", "user-agent": "terminus/9.9.9 (opencode)" },
      body: "{}",
      credentialBindingId: "secret://opencode/zen",
      authStyle: "bearer",
      signal: null,
    })) { /* drained */ }

    expect(sent.filter((header) => header.name.toLowerCase() === "user-agent")).toHaveLength(1);
    expect(sent.find((header) => header.name.toLowerCase() === "user-agent")?.value)
      .toBe("terminus/9.9.9 (opencode)");
  });

  test("selects the anonymous kernel connector for a public gateway binding", async () => {
    let connectorId: string | null = null;
    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async (request) => {
        connectorId = request.binding?.connectorId ?? null;
        return { encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 };
      },
      Execute: async () => ({
        receipt: {
          grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway-anonymous",
          method: "GET", path: "/zen/v1/models", destination: "https://opencode.ai:443",
          requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
          responseRedactions: 0, outcome: "accepted", responseHeaders: [],
        },
        body: new TextEncoder().encode("{}"),
        contentType: "application/json",
      }),
    }), context);

    const chunks: Uint8Array[] = [];
    for await (const chunk of client.stream({
      url: "https://opencode.ai/zen/v1/models",
      method: "GET",
      headers: { accept: "application/json" },
      credentialBindingId: "",
      authStyle: "none",
      signal: null,
    })) chunks.push(chunk);

    expect(connectorId).toBe("opencode-gateway-anonymous");
    expect(new TextDecoder().decode(chunks[0])).toBe("{}");
  });

  test("streams multiple SSE frames incrementally", async () => {
    const sseBody = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n";
    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async () => ({
        receipt: {
          grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
          method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
          requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
          responseRedactions: 0, outcome: "accepted", responseHeaders: [],
        },
        body: new TextEncoder().encode(sseBody),
        contentType: "text/event-stream",
      }),
    }), context);

    const chunks: string[] = [];
    for await (const chunk of client.stream({
      url: "https://opencode.ai/zen/v1/chat/completions",
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: "{}",
      credentialBindingId: "secret://opencode/zen",
      authStyle: "bearer",
      signal: null,
    })) {
      chunks.push(new TextDecoder().decode(chunk));
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n");
    expect(chunks[1]).toBe("data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n");
    expect(chunks[2]).toBe("data: [DONE]\n\n");
  });

  test("aborts immediately when signal is aborted prior to dispatch", async () => {
    const controller = new AbortController();
    controller.abort();

    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async () => { throw new Error("should not be called"); },
      Execute: async () => { throw new Error("should not be called"); },
    }), context);

    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream({
        url: "https://opencode.ai/zen/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
        credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer",
        signal: controller.signal,
      })) { /* unreachable */ }
    };

    await expect(consume()).rejects.toThrow("gateway request was aborted");
  });

  test("aborts immediately when signal triggers during Execute", async () => {
    const controller = new AbortController();
    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async () => {
        // Trigger abort while Execute is in-flight
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          receipt: {
            grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
            method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
            requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
            responseRedactions: 0, outcome: "accepted", responseHeaders: [],
          },
          body: new TextEncoder().encode("data: [DONE]\n\n"),
        };
      },
    }), context);

    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream({
        url: "https://opencode.ai/zen/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
        credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer",
        signal: controller.signal,
      })) { /* unreachable */ }
    };

    await expect(consume()).rejects.toThrow("gateway request was aborted");
  });

  test("aborts mid-stream between yielded chunks", async () => {
    const controller = new AbortController();
    const sseBody = "data: chunk1\n\ndata: chunk2\n\ndata: chunk3\n\n";
    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async () => ({
        receipt: {
          grantId: "grant", taskId: "task", effectId: "effect", connectorId: "opencode-gateway",
          method: "POST", path: "/zen/v1/chat/completions", destination: "https://opencode.ai:443",
          requestSha256: "a".repeat(64), statusCode: 200, responseSha256: "b".repeat(64),
          responseRedactions: 0, outcome: "accepted", responseHeaders: [],
        },
        body: new TextEncoder().encode(sseBody),
      }),
    }), context);

    const yielded: string[] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of client.stream({
        url: "https://opencode.ai/zen/v1/chat/completions",
        method: "POST",
        headers: {},
        body: "{}",
        credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer",
        signal: controller.signal,
      })) {
        yielded.push(new TextDecoder().decode(chunk));
        // Abort after consuming the first chunk
        controller.abort();
      }
    };

    await expect(consume()).rejects.toThrow("gateway request was aborted");
    expect(yielded).toHaveLength(1);
    expect(yielded[0]).toBe("data: chunk1\n\n");
  });

  test("rejects destination substitution before minting", async () => {
    let called = false;
    const client = new KernelGatewayClient(withoutStreaming({
      MintGrant: async () => { called = true; throw new Error("unexpected"); },
      Execute: async () => { called = true; throw new Error("unexpected"); },
    }), context);
    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream({
        url: "https://example.com/zen/v1/chat/completions",
        method: "POST", headers: {}, body: "{}", credentialBindingId: "secret://opencode/zen",
        authStyle: "bearer", signal: null,
      })) { /* unreachable */ }
    };
    await expect(consume()).rejects.toThrow("outside the admitted");
    expect(called).toBe(false);
  });
});

describe("H9 the gateway path streams", () => {
  const inference = {
    url: "https://opencode.ai/zen/v1/chat/completions",
    method: "POST" as const,
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: "{}",
    credentialBindingId: "secret://opencode/zen",
    authStyle: "bearer" as const,
    signal: null,
  };

  test("delivers each kernel chunk before the stream terminates", async () => {
    let bufferedExecuteCalls = 0;
    const client = new KernelGatewayClient(
      streamingConnectors({
        chunks: ["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"],
        delayMs: 5,
        onExecute: () => { bufferedExecuteCalls += 1; },
      }),
      context,
    );

    const arrivals: number[] = [];
    const started = Date.now();
    const decoded: string[] = [];
    for await (const chunk of client.stream(inference)) {
      decoded.push(new TextDecoder().decode(chunk));
      arrivals.push(Date.now() - started);
    }

    expect(decoded).toEqual(["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"]);
    expect(bufferedExecuteCalls).toBe(0);
    // The last chunk is only produced after the first two have been awaited,
    // so a buffered implementation would have reported identical arrivals.
    expect(arrivals.length).toBe(3);
    expect(arrivals[2] ?? 0).toBeGreaterThan(arrivals[0] ?? 0);
  });

  test("re-slices a single buffered kernel chunk into its SSE frames", async () => {
    // A credentialed grant still degrades to one scrubbed chunk inside the
    // kernel, so the client must keep framing that chunk itself.
    const client = new KernelGatewayClient(
      streamingConnectors({ chunks: ["data: a\n\ndata: b\n\ndata: [DONE]\n\n"] }),
      context,
    );
    const decoded: string[] = [];
    for await (const chunk of client.stream(inference)) {
      decoded.push(new TextDecoder().decode(chunk));
    }
    expect(decoded).toEqual(["data: a\n\n", "data: b\n\n", "data: [DONE]\n\n"]);
  });

  test("a non-2xx receipt raises a retryable ProviderTransportError with its status", async () => {
    const client = new KernelGatewayClient(
      streamingConnectors({
        chunks: ['{"error":{"message":"upstream is overloaded"}}'],
        receipt: receipt({ statusCode: 503, outcome: "accepted" }),
      }),
      context,
    );
    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream(inference)) { /* drained */ }
    };
    let caught: unknown = null;
    try { await consume(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProviderTransportError);
    const transport = caught as ProviderTransportError;
    expect(transport.status).toBe(503);
    expect(isRetryableProviderError(transport)).toBe(true);
    expect(transport.message).toContain("upstream is overloaded");
  });

  test("a stream that ends without a receipt is an explicit failure", async () => {
    const client = new KernelGatewayClient(
      {
        MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
        Execute: async () => { throw new Error("buffered Execute must not be used"); },
        ExecuteStream: () =>
          new Observable<ConnectorChunk>((subscriber) => {
            subscriber.next({ bytes: new TextEncoder().encode("data: partial\n\n"), receipt: undefined });
            subscriber.complete();
          }),
      },
      context,
    );
    const consume = async (): Promise<void> => {
      for await (const _chunk of client.stream(inference)) { /* drained */ }
    };
    await expect(consume()).rejects.toThrow("did not settle");
  });

  test("falls back to buffered Execute only when the kernel lacks ExecuteStream", async () => {
    let executed = 0;
    const client = new KernelGatewayClient(
      withoutStreaming({
        MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
        Execute: async () => {
          executed += 1;
          return { receipt: receipt(), body: new TextEncoder().encode("data: [DONE]\n\n"), contentType: "text/event-stream" };
        },
      }),
      context,
    );
    const decoded: string[] = [];
    for await (const chunk of client.stream(inference)) {
      decoded.push(new TextDecoder().decode(chunk));
    }
    expect(executed).toBe(1);
    expect(decoded).toEqual(["data: [DONE]\n\n"]);
  });

  test("a mid-stream kernel failure is never replayed against the buffered path", async () => {
    let executed = 0;
    const client = new KernelGatewayClient(
      {
        MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
        Execute: async () => { executed += 1; throw new Error("unexpected replay"); },
        ExecuteStream: () =>
          new Observable<ConnectorChunk>((subscriber) => {
            subscriber.next({ bytes: new TextEncoder().encode("data: one\n\n"), receipt: undefined });
            subscriber.error(new Error("14 UNAVAILABLE: kernel socket closed"));
          }),
      },
      context,
    );
    const decoded: string[] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of client.stream(inference)) {
        decoded.push(new TextDecoder().decode(chunk));
      }
    };
    await expect(consume()).rejects.toThrow("kernel socket closed");
    expect(decoded).toEqual(["data: one\n\n"]);
    expect(executed).toBe(0);
  });

  test("aborting mid-stream stops the kernel subscription and names the gateway", async () => {
    const controller = new AbortController();
    let unsubscribed = false;
    const client = new KernelGatewayClient(
      {
        MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
        Execute: async () => { throw new Error("buffered Execute must not be used"); },
        ExecuteStream: () =>
          new Observable<ConnectorChunk>((subscriber) => {
            let cancelled = false;
            void (async () => {
              for (let index = 0; index < 20 && !cancelled; index += 1) {
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (cancelled) return;
                subscriber.next({ bytes: new TextEncoder().encode(`data: ${index}\n\n`), receipt: undefined });
              }
            })();
            return () => { cancelled = true; unsubscribed = true; };
          }),
      },
      context,
    );
    const decoded: string[] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of client.stream({ ...inference, signal: controller.signal })) {
        decoded.push(new TextDecoder().decode(chunk));
        controller.abort();
      }
    };
    await expect(consume()).rejects.toThrow("gateway request was aborted");
    expect(decoded).toEqual(["data: 0\n\n"]);
    expect(unsubscribed).toBe(true);
  });
});

describe("the gateway path reads the head frame", () => {
  const inference = {
    url: "https://opencode.ai/zen/v1/chat/completions",
    method: "POST" as const,
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: "{}",
    credentialBindingId: "secret://opencode/zen",
    authStyle: "bearer" as const,
    signal: null,
  };

  /** Emits a head receipt, then the given frames, then a terminal receipt. */
  function headThen(input: {
    readonly head: ConnectorReceiptMessage;
    readonly chunks?: readonly string[];
    readonly terminal?: ConnectorReceiptMessage | null;
    readonly bodyDelayMs?: number;
  }): ConnectorService {
    return {
      MintGrant: async () => ({ encodedGrant: "opaque-grant", grantId: "grant", expiresAtUnix: 1 }),
      Execute: async () => { throw new Error("buffered Execute must not be used"); },
      ExecuteStream: () =>
        new Observable<ConnectorChunk>((subscriber) => {
          let stopped = false;
          void (async () => {
            subscriber.next({ bytes: undefined, receipt: input.head });
            for (const chunk of input.chunks ?? []) {
              if (input.bodyDelayMs !== undefined) {
                await new Promise((resolve) => setTimeout(resolve, input.bodyDelayMs));
              }
              if (stopped) return;
              subscriber.next({ bytes: new TextEncoder().encode(chunk), receipt: undefined });
            }
            if (stopped) return;
            if (input.terminal !== null) {
              subscriber.next({ bytes: undefined, receipt: input.terminal ?? receipt() });
            }
            subscriber.complete();
          })();
          return () => { stopped = true; };
        }),
    };
  }

  const head = (statusCode: number, headers: { name: string; value: string }[] = []): ConnectorReceiptMessage =>
    receipt({ statusCode, outcome: HEAD_RECEIPT_OUTCOME, responseHeaders: headers });

  test("a 2xx head is not terminal: the body still streams through", async () => {
    const client = new KernelGatewayClient(
      headThen({ head: head(200), chunks: ["data: one\n\n", "data: [DONE]\n\n"] }),
      context,
    );
    const decoded: string[] = [];
    for await (const chunk of client.stream(inference)) decoded.push(new TextDecoder().decode(chunk));
    expect(decoded).toEqual(["data: one\n\n", "data: [DONE]\n\n"]);
  });

  test("a 429 head carries retry-after before any body byte is read", async () => {
    const client = new KernelGatewayClient(
      headThen({
        head: head(429, [{ name: "Retry-After", value: "30" }]),
        chunks: ['{"error":{"message":"slow down"}}'],
      }),
      context,
    );
    const decoded: string[] = [];
    const caught = await (async () => {
      try {
        for await (const chunk of client.stream(inference)) decoded.push(new TextDecoder().decode(chunk));
        return null;
      } catch (error: unknown) { return error; }
    })();
    expect(caught).toBeInstanceOf(ProviderTransportError);
    expect((caught as ProviderTransportError).status).toBe(429);
    expect((caught as ProviderTransportError).retryAfterMs).toBe(30_000);
    expect(isRetryableProviderError(caught as ProviderTransportError)).toBe(true);
    expect(decoded).toEqual([]);
  });

  test("head headers survive a terminal receipt that carries none", async () => {
    const client = new KernelGatewayClient(
      headThen({
        head: head(200, [
          { name: "X-Codex-Turn-State", value: "turn-token-1" },
          { name: "X-Models-Etag", value: 'W/"catalogue-7"' },
        ]),
        chunks: ["data: [DONE]\n\n"],
      }),
      context,
    );
    for await (const _ of client.stream(inference)) { /* drain */ }
    expect(client.responseHeaders()["x-codex-turn-state"]).toBe("turn-token-1");
    expect(client.responseHeaders()["x-models-etag"]).toBe('W/"catalogue-7"');
  });

  test("a header value longer than the old 256-byte cap is not truncated", async () => {
    // A truncated `x-codex-turn-state` would be echoed corrupted, which is
    // worse than echoing nothing at all.
    const token = "t".repeat(1200);
    const client = new KernelGatewayClient(
      headThen({ head: head(200, [{ name: "x-codex-turn-state", value: token }]), chunks: ["data: [DONE]\n\n"] }),
      context,
    );
    for await (const _ of client.stream(inference)) { /* drain */ }
    expect(client.responseHeaders()["x-codex-turn-state"]).toBe(token);
  });

  test("a later request without headers does not inherit the previous one's", async () => {
    const client = new KernelGatewayClient(
      headThen({ head: head(200, [{ name: "x-codex-turn-state", value: "stale" }]), chunks: ["data: [DONE]\n\n"] }),
      context,
    );
    for await (const _ of client.stream(inference)) { /* drain */ }
    expect(client.responseHeaders()["x-codex-turn-state"]).toBe("stale");
    const second = new KernelGatewayClient(headThen({ head: head(200), chunks: ["data: [DONE]\n\n"] }), context);
    for await (const _ of second.stream(inference)) { /* drain */ }
    expect(second.responseHeaders()["x-codex-turn-state"]).toBeUndefined();
  });

  test("time-to-first-token is measured to the body, not to the head frame", async () => {
    const client = new KernelGatewayClient(
      headThen({ head: head(200), chunks: ["data: [DONE]\n\n"], bodyDelayMs: 25 }),
      context,
    );
    expect(client.timeToFirstBodyMs()).toBeNull();
    for await (const _ of client.stream(inference)) { /* drain */ }
    expect(client.timeToFirstBodyMs() ?? 0).toBeGreaterThanOrEqual(20);
  });

  test("a head frame supplies the status when the terminal receipt has none", async () => {
    // "Last receipt wins" must still yield the terminal one; the head is only
    // the fallback for a kernel that reports status once.
    const client = new KernelGatewayClient(
      headThen({
        head: head(200),
        chunks: ["data: [DONE]\n\n"],
        terminal: receipt({ statusCode: undefined, outcome: "accepted" }),
      }),
      context,
    );
    const decoded: string[] = [];
    for await (const chunk of client.stream(inference)) decoded.push(new TextDecoder().decode(chunk));
    expect(decoded).toEqual(["data: [DONE]\n\n"]);
  });

  test("a head-frame turn-state token becomes the next request's echo header", async () => {
    // The two halves of the Codex turn-state loop, composed: the transport
    // captures the token off the head frame, the dialect echoes it back.
    const turnState = new CodexTurnState();
    const identity = { originator: "terminus", userAgent: "terminus/test", threadId: "thread-1" } as const;
    expect(chatGptCodexRequestHeaders({ ...identity, turnState })["x-codex-turn-state"]).toBeUndefined();

    const client = new KernelGatewayClient(
      headThen({
        head: head(200, [{ name: "X-Codex-Turn-State", value: "opaque-turn-token" }]),
        chunks: ["data: [DONE]\n\n"],
      }),
      context,
    );
    for await (const _ of client.stream(inference)) { /* drain */ }
    turnState.observe(client.responseHeaders());
    expect(chatGptCodexRequestHeaders({ ...identity, turnState })["x-codex-turn-state"])
      .toBe("opaque-turn-token");
  });

  test("teardown mid-stream surfaces as cancellation, not a provider fault", async () => {
    const controller = new AbortController();
    const client = new KernelGatewayClient(
      headThen({ head: head(200), chunks: ["data: 0\n\n", "data: 1\n\n", "data: 2\n\n"], bodyDelayMs: 5 }),
      context,
    );
    const caught = await (async () => {
      try {
        for await (const _ of client.stream({ ...inference, signal: controller.signal })) controller.abort();
        return null;
      } catch (error: unknown) { return error; }
    })();
    expect(caught).toBeInstanceOf(ConnectorCancelledError);
    expect(classifyLoopError(caught).kind).toBe("cancelled");
  });
});
