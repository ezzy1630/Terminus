import { randomUUID } from "node:crypto";
import type {
  ConnectorChunk,
  ConnectorService,
  ExecuteConnectorRequest,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { CredentialBoundGatewayClient, GatewayHttpRequest } from "@terminus/provider-zen";
import { isUnimplemented, observableToAsyncIterable } from "./direct-provider-transport.js";
import { ProviderTransportError } from "./providers/provider-retry.js";

const GATEWAY_HOST = "opencode.ai";
const GATEWAY_PORT = 443;
const ALLOWED_PATHS = new Set([
  "/zen/v1/chat/completions",
  "/zen/v1/responses",
  "/zen/v1/messages",
  // Model discovery. Read-only, same host and credential as the inference
  // paths above, so it needs no new connector or secret.
  "/zen/v1/models",
  "/zen/go/v1/chat/completions",
  "/zen/go/v1/responses",
  "/zen/go/v1/messages",
  "/zen/go/v1/models",
]);

export class KernelGatewayClient implements CredentialBoundGatewayClient {
  constructor(
    private readonly connectors: ConnectorService,
    private readonly context: RequestContext,
  ) {}

  async *stream(input: GatewayHttpRequest): AsyncIterable<Uint8Array> {
    assertNotAborted(input.signal, "gateway request was aborted");
    const anonymous = input.credentialBindingId === "";
    const expectedAuthStyle = anonymous ? "none" : "bearer";
    if (input.authStyle !== expectedAuthStyle) {
      throw new Error(`gateway auth style ${input.authStyle} does not match its credential binding`);
    }
    const url = admittedGatewayUrl(input.url);
    const effectId = randomUUID();
    const connectorId = anonymous ? "opencode-gateway-anonymous" : "opencode-gateway";
    const grant = await withAbortSignal(
      this.connectors.MintGrant({
        context: nextContext(this.context, `gateway-grant:${effectId}`),
        capabilityUri: input.credentialBindingId,
        binding: {
          connectorId,
          destinationHost: GATEWAY_HOST,
          destinationPort: GATEWAY_PORT,
          scheme: "https",
          method: input.method,
          pathClass: url.pathname,
          effectId,
          // Per-account destination allowlist; the gateway host is fixed.
          allowedHosts: [GATEWAY_HOST],
        },
        ttlSeconds: 60,
      }),
      input.signal,
      "gateway request was aborted",
    );
    if (grant.encodedGrant.length === 0) throw new Error("kernel returned an empty connector grant");
    assertNotAborted(input.signal, "gateway request was aborted before dispatch");
    const request: ExecuteConnectorRequest = {
      context: nextContext(this.context, `gateway-execute:${effectId}`),
      encodedGrant: grant.encodedGrant,
      operation: {
        method: input.method,
        scheme: "https",
        host: GATEWAY_HOST,
        port: GATEWAY_PORT,
        path: url.pathname,
        query: url.search.slice(1),
        headers: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
        body: input.body === undefined ? new Uint8Array() : new TextEncoder().encode(input.body),
      },
    };
    // H9: incremental dispatch. The unary `Execute` buffers the whole
    // response and only then re-slices it, so `turn.provider_text_delta`
    // could not arrive before the provider had finished generating — the
    // gateway path looked frozen for the entire turn. `ExecuteStream` hands
    // each body chunk over as the kernel receives it, which is what the
    // direct path already does.
    //
    // The kernel reports the HTTP status only in the terminal receipt, so a
    // non-2xx body is forwarded before its status is known. That is safe:
    // an error body is JSON, carries no `data:` field, and the SSE decoder
    // downstream discards it; the status then surfaces as the
    // ProviderTransportError thrown below, which is what H2's retry
    // classifier reads.
    let fallbackToUnary = false;
    let observedStream = false;
    let receipt: ConnectorChunk["receipt"] = undefined;
    let errorPrefix = new Uint8Array(new ArrayBuffer(0));
    try {
      for await (const chunk of this.eachChunk(request, input.signal)) {
        observedStream = true;
        if (chunk.bytes !== undefined && chunk.bytes.byteLength > 0) {
          assertNotAborted(input.signal, "gateway request was aborted during streaming");
          errorPrefix = appendBounded(errorPrefix, chunk.bytes);
          yield* splitSseChunks(chunk.bytes);
        }
        if (chunk.receipt !== undefined) receipt = chunk.receipt;
      }
    } catch (error) {
      // A kernel without ExecuteStream rejects before performing the
      // request, so the buffered call below is safe. Everything else is a
      // real failure and must not be retried against a live request.
      if (isUnimplemented(error) && !observedStream) fallbackToUnary = true;
      else throw error;
    }
    if (!fallbackToUnary) {
      const streamedStatus = receipt?.statusCode;
      if (streamedStatus === undefined) {
        throw new Error(
          `OpenCode gateway stream did not settle: ${receipt?.outcome ?? "missing receipt"}`,
        );
      }
      if (streamedStatus < 200 || streamedStatus > 299) {
        throw new ProviderTransportError(
          `OpenCode gateway returned HTTP ${streamedStatus}${providerErrorSuffix(errorPrefix)}`,
          { status: streamedStatus },
        );
      }
      return;
    }
    const response = await withAbortSignal(
      this.connectors.Execute(request),
      input.signal,
      "gateway request was aborted",
    );
    const status = response.receipt?.statusCode;
    if (status === undefined) {
      throw new Error(`OpenCode gateway dispatch did not settle: ${response.receipt?.outcome ?? "missing receipt"}`);
    }
    if (status < 200 || status > 299) {
      throw new ProviderTransportError(
        `OpenCode gateway returned HTTP ${status}${providerErrorSuffix(response.body)}`,
        { status },
      );
    }
    for (const chunk of splitSseChunks(response.body)) {
      assertNotAborted(input.signal, "gateway request was aborted during streaming");
      yield chunk;
    }
  }

  private eachChunk(
    request: ExecuteConnectorRequest,
    signal?: AbortSignal | null,
  ): AsyncIterable<ConnectorChunk> {
    if (typeof this.connectors.ExecuteStream !== "function") {
      throw new Error("UNIMPLEMENTED: ConnectorService.ExecuteStream is unavailable");
    }
    return observableToAsyncIterable(
      this.connectors.ExecuteStream(request),
      signal,
      "gateway request was aborted",
    );
  }
}

function assertNotAborted(signal: AbortSignal | null, message: string): void {
  if (signal?.aborted === true) throw new Error(message);
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  message: string,
): Promise<T> {
  if (signal?.aborted === true) {
    return Promise.reject(new Error(message));
  }
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Retains at most the first `ERROR_PREFIX_BYTES` of a streamed body so a
 * non-2xx receipt can still quote the provider's error message. Only that
 * prefix is kept, and only for the error message; the full body is always
 * forwarded to the caller untouched.
 */
const ERROR_PREFIX_BYTES = 8 * 1024;

function appendBounded(
  prefix: Uint8Array<ArrayBuffer>,
  chunk: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (prefix.byteLength >= ERROR_PREFIX_BYTES) return prefix;
  const take = Math.min(chunk.byteLength, ERROR_PREFIX_BYTES - prefix.byteLength);
  const next = new Uint8Array(new ArrayBuffer(prefix.byteLength + take));
  next.set(prefix, 0);
  next.set(chunk.subarray(0, take), prefix.byteLength);
  return next;
}

function* splitSseChunks(body: Uint8Array): Generator<Uint8Array> {
  if (body.byteLength === 0) return;
  const text = new TextDecoder().decode(body);
  if (!text.includes("data:") && !text.includes("event:")) {
    yield body;
    return;
  }
  const parts = text.split(/(?<=\r?\n\r?\n)/);
  const encoder = new TextEncoder();
  for (const part of parts) {
    if (part.length > 0) {
      yield encoder.encode(part);
    }
  }
}

function admittedGatewayUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:"
    || url.hostname !== GATEWAY_HOST
    || (url.port !== "" && url.port !== String(GATEWAY_PORT))
    || !ALLOWED_PATHS.has(url.pathname)
  ) {
    throw new Error("gateway URL is outside the admitted OpenCode Zen/Go endpoints");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("gateway URL may not contain user info or a fragment");
  }
  return url;
}

function nextContext(context: RequestContext, suffix: string): RequestContext {
  return {
    ...context,
    requestId: randomUUID(),
    idempotencyKey: `${context.idempotencyKey}:${suffix}`,
  };
}

function providerErrorSuffix(body: Uint8Array): string {
  if (body.byteLength === 0) return "";
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed: unknown = JSON.parse(decoded);
    if (!isRecord(parsed)) return "";
    const error = isRecord(parsed.error) ? parsed.error : parsed;
    if (typeof error.message !== "string" || error.message.length === 0) return "";
    return `: ${error.message.slice(0, 1_024)}`;
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
