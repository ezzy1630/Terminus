import { randomUUID } from "node:crypto";
import type {
  ConnectorChunk,
  ConnectorService,
  ExecuteConnectorRequest,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { CredentialBoundGatewayClient, GatewayHttpRequest } from "@terminus/provider-zen";
import {
  asCancellation,
  ConnectorCancelledError,
  isHeadReceipt,
  isUnimplemented,
  observableToAsyncIterable,
  transportErrorInit,
} from "./direct-provider-transport.js";
import { ProviderTransportError } from "./providers/provider-retry.js";

const GATEWAY_HOST = "opencode.ai";
const GATEWAY_PORT = 443;
/** Matches the kernel's own per-value response-header bound. */
const MAX_RESPONSE_HEADER_CHARS = 4096;

/**
 * One connected account's HTTPS surface, as the kernel connector sees it.
 *
 * Everything the client is allowed to reach is stated here rather than
 * hard-coded, because a connected provider account picks its own host: the
 * client must not be able to widen its own destination. `allowedPaths` is an
 * exact set; `allowedPathPrefixes` admits a subtree. A descriptor that sets
 * neither admits nothing.
 */
export interface KernelConnectorEndpoint {
  /** Connector used when a credential is bound. */
  readonly connectorId: string;
  /** Connector used for an explicitly anonymous request; defaults to none. */
  readonly anonymousConnectorId?: string | undefined;
  readonly host: string;
  readonly port?: number | undefined;
  readonly allowedPaths?: readonly string[] | undefined;
  readonly allowedPathPrefixes?: readonly string[] | undefined;
  /** Prefix for transport error messages, e.g. "OpenCode gateway". */
  readonly label?: string | undefined;
  /**
   * `user-agent` to present when the caller does not set one. Only endpoints
   * that actually gate on it declare a value; everything else keeps the
   * kernel connector's own default.
   */
  readonly userAgent?: string | undefined;
}

/**
 * How Terminus identifies itself to the OpenCode gateway.
 *
 * The Zen gateway grants its anonymous free tier only to clients whose
 * `user-agent` names OpenCode. Under the kernel connector's default agent
 * (`terminus-connector/<version>`) every anonymous dispatch came back
 * `429 FreeUsageLimitError` — "Rate limit exceeded", which read as an upstream
 * outage and sent the user off to wait or switch models, while the same model
 * answered from the `opencode` CLI on the same machine and the same second.
 * Measured 2026-08-28: identical requests alternating only in this header
 * returned 200 and 429 three times running.
 *
 * The value identifies Terminus honestly and names the gateway it is speaking
 * to. It does not impersonate the OpenCode CLI, matching the stance already
 * taken on the Codex endpoint.
 */
export const OPENCODE_GATEWAY_USER_AGENT = "terminus (opencode-gateway-client)";

/**
 * The OpenCode Zen/Go surface. Exact paths, not prefixes: the deployment has a
 * fixed, known set of endpoints and nothing else on `opencode.ai` is in scope.
 */
export const ZEN_GATEWAY_ENDPOINT: KernelConnectorEndpoint = {
  connectorId: "opencode-gateway",
  anonymousConnectorId: "opencode-gateway-anonymous",
  host: GATEWAY_HOST,
  port: GATEWAY_PORT,
  allowedPaths: [
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
  ],
  label: "OpenCode gateway",
  userAgent: OPENCODE_GATEWAY_USER_AGENT,
};

/**
 * Kernel-brokered HTTPS for exactly one connected account.
 *
 * The credential never enters this process: the client hands the kernel an
 * opaque capability URI, the kernel injects the bearer, and the grant is
 * minted per request against a single host.
 */
export class KernelConnectorClient implements CredentialBoundGatewayClient {
  private readonly endpoint: KernelConnectorEndpoint;
  private readonly port: number;
  private readonly label: string;
  private readonly userAgent: string | null;
  /** Receipt headers from the last settled response, for status reporting. */
  private lastResponseHeaders: Readonly<Record<string, string>> = {};
  /** `Date.now()` at dispatch and at the first body frame of the last request. */
  private lastDispatchedAtMs: number | null = null;
  private lastFirstBodyAtMs: number | null = null;

  constructor(
    private readonly connectors: ConnectorService,
    private readonly context: RequestContext,
    endpoint: KernelConnectorEndpoint = ZEN_GATEWAY_ENDPOINT,
  ) {
    if (endpoint.host.trim() === "") throw new Error("connector endpoint requires a host");
    if (endpoint.connectorId.trim() === "") throw new Error("connector endpoint requires a connector id");
    this.endpoint = endpoint;
    this.port = endpoint.port ?? 443;
    this.label = endpoint.label ?? "provider account";
    this.userAgent = endpoint.userAgent ?? null;
  }

  /**
   * Response headers the connector admitted on the last settled request
   * (`x-codex-*`, `retry-after`, …). Lower-cased, never credential material.
   */
  responseHeaders(): Readonly<Record<string, string>> {
    return this.lastResponseHeaders;
  }

  /**
   * Dispatch → first body frame for the last request, in milliseconds.
   *
   * Only the transport sees the body frames. The caller's first *decoded*
   * chunk is later by however long the provider spent on leading SSE events
   * that produced no token, and the head frame is earlier — it measures the
   * kernel's own round trip, not the provider's.
   */
  timeToFirstBodyMs(): number | null {
    if (this.lastDispatchedAtMs === null || this.lastFirstBodyAtMs === null) return null;
    return Math.max(0, this.lastFirstBodyAtMs - this.lastDispatchedAtMs);
  }

  async *stream(input: GatewayHttpRequest): AsyncIterable<Uint8Array> {
    assertNotAborted(input.signal, `${this.label} request was aborted`);
    // Per request, not per client: a stale `x-codex-turn-state` from the
    // previous dispatch must never be echoed as if this one had returned it.
    this.lastResponseHeaders = {};
    this.lastDispatchedAtMs = null;
    this.lastFirstBodyAtMs = null;
    const anonymous = input.credentialBindingId === "";
    const expectedAuthStyle = anonymous ? "none" : "bearer";
    if (input.authStyle !== expectedAuthStyle) {
      throw new Error(`${this.label} auth style ${input.authStyle} does not match its credential binding`);
    }
    const url = this.admittedUrl(input.url);
    const effectId = randomUUID();
    const connectorId = anonymous ? this.endpoint.anonymousConnectorId : this.endpoint.connectorId;
    if (connectorId === undefined || connectorId === "") {
      throw new Error(`${this.label} has no anonymous connector; a credential is required`);
    }
    const grant = await withAbortSignal(
      this.connectors.MintGrant({
        context: nextContext(this.context, `gateway-grant:${effectId}`),
        capabilityUri: input.credentialBindingId,
        binding: {
          connectorId,
          destinationHost: this.endpoint.host,
          destinationPort: this.port,
          scheme: "https",
          method: input.method,
          pathClass: url.pathname,
          effectId,
          // Per-account destination allowlist; one host, chosen here.
          allowedHosts: [this.endpoint.host],
        },
        ttlSeconds: 60,
      }),
      input.signal,
      `${this.label} request was aborted`,
    );
    if (grant.encodedGrant.length === 0) throw new Error("kernel returned an empty connector grant");
    assertNotAborted(input.signal, `${this.label} request was aborted before dispatch`);
    const request: ExecuteConnectorRequest = {
      context: nextContext(this.context, `gateway-execute:${effectId}`),
      encodedGrant: grant.encodedGrant,
      operation: {
        method: input.method,
        scheme: "https",
        host: this.endpoint.host,
        port: this.port,
        path: url.pathname,
        query: url.search.slice(1),
        headers: Object.entries(this.withUserAgent(input.headers)).map(([name, value]) => ({ name, value })),
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
    // "Last receipt wins" still yields the terminal one: the head frame is
    // consumed by its own branch and never assigned here.
    let receipt: ConnectorChunk["receipt"];
    let head: ConnectorChunk["receipt"];
    let errorPrefix = new Uint8Array(new ArrayBuffer(0));
    this.lastDispatchedAtMs = Date.now();
    try {
      for await (const chunk of this.eachChunk(request, input.signal)) {
        observedStream = true;
        if (chunk.bytes !== undefined && chunk.bytes.byteLength > 0) {
          if (this.lastFirstBodyAtMs === null) this.lastFirstBodyAtMs = Date.now();
          assertNotAborted(input.signal, `${this.label} request was aborted during streaming`);
          errorPrefix = appendBounded(errorPrefix, chunk.bytes);
          yield* splitSseChunks(chunk.bytes);
        }
        if (chunk.receipt === undefined) continue;
        if (isHeadReceipt(chunk.receipt)) {
          // Rate-limit headers are readable before the body now, so a 429 no
          // longer has to be streamed to completion before its `retry-after`
          // can be honoured.
          head = chunk.receipt;
          this.rememberResponseHeaders(chunk.receipt);
          const headStatus = chunk.receipt.statusCode;
          if (headStatus !== undefined && (headStatus < 200 || headStatus > 299)) {
            throw new ProviderTransportError(
              `${this.label} returned HTTP ${headStatus}`,
              transportErrorInit(chunk.receipt, headStatus),
            );
          }
          continue;
        }
        receipt = chunk.receipt;
      }
    } catch (error) {
      // A kernel without ExecuteStream rejects before performing the
      // request, so the buffered call below is safe. Everything else is a
      // real failure and must not be retried against a live request.
      if (isUnimplemented(error) && !observedStream) fallbackToUnary = true;
      else throw asCancellation(error, `${this.label} request was cancelled`);
    }
    if (!fallbackToUnary) {
      this.rememberResponseHeaders(receipt);
      const streamedStatus = receipt?.statusCode ?? head?.statusCode;
      if (streamedStatus === undefined) {
        throw new Error(
          `${this.label} stream did not settle: ${receipt?.outcome ?? "missing receipt"}`,
        );
      }
      if (streamedStatus < 200 || streamedStatus > 299) {
        throw new ProviderTransportError(
          `${this.label} returned HTTP ${streamedStatus}${providerErrorSuffix(errorPrefix)}`,
          transportErrorInit(receipt ?? head, streamedStatus),
        );
      }
      return;
    }
    const response = await withAbortSignal(
      this.connectors.Execute(request),
      input.signal,
      `${this.label} request was aborted`,
    );
    this.rememberResponseHeaders(response.receipt);
    if (response.body.byteLength > 0) this.lastFirstBodyAtMs = Date.now();
    const status = response.receipt?.statusCode;
    if (status === undefined) {
      throw new Error(`${this.label} dispatch did not settle: ${response.receipt?.outcome ?? "missing receipt"}`);
    }
    if (status < 200 || status > 299) {
      throw new ProviderTransportError(
        `${this.label} returned HTTP ${status}${providerErrorSuffix(response.body)}`,
        transportErrorInit(response.receipt, status),
      );
    }
    for (const chunk of splitSseChunks(response.body)) {
      assertNotAborted(input.signal, `${this.label} request was aborted during streaming`);
      yield chunk;
    }
  }

  /**
   * The endpoint's `user-agent`, unless the caller already chose one. The
   * kernel connector only fills in its own default when the header is absent,
   * so declaring it here is what actually reaches the wire.
   */
  private withUserAgent(
    headers: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    if (this.userAgent === null) return headers;
    if (Object.keys(headers).some((name) => name.toLowerCase() === "user-agent")) return headers;
    return { ...headers, "user-agent": this.userAgent };
  }

  /**
   * Merges rather than replaces: the head frame carries the headers and the
   * terminal receipt may carry none, so replacing would discard what the
   * head just delivered. `stream()` clears the map per request, which is what
   * keeps one dispatch's headers out of the next.
   *
   * The value cap matches the kernel's own bound (4096 bytes). It used to be
   * 256, which silently truncated `x-codex-turn-state` — echoing a corrupted
   * token is worse than echoing none.
   */
  private rememberResponseHeaders(receipt: ConnectorChunk["receipt"]): void {
    const headers = receipt?.responseHeaders ?? [];
    if (headers.length === 0) return;
    const collected: Record<string, string> = { ...this.lastResponseHeaders };
    for (const header of headers) {
      if (typeof header.name !== "string" || typeof header.value !== "string") continue;
      collected[header.name.toLowerCase()] = header.value.slice(0, MAX_RESPONSE_HEADER_CHARS);
    }
    this.lastResponseHeaders = collected;
  }

  /**
   * The URL must be on this account's host and inside its admitted paths. A
   * request that is not is a programming error, not a policy decision to
   * forward to the kernel.
   */
  private admittedUrl(raw: string): URL {
    const url = new URL(raw);
    const admittedPath = this.endpoint.allowedPaths?.includes(url.pathname) === true
      || (this.endpoint.allowedPathPrefixes ?? []).some((prefix) => url.pathname.startsWith(prefix));
    if (
      url.protocol !== "https:"
      || url.hostname !== this.endpoint.host
      || (url.port !== "" && url.port !== String(this.port))
      || !admittedPath
    ) {
      throw new Error(`request URL is outside the admitted ${this.label} endpoints`);
    }
    if (url.username !== "" || url.password !== "" || url.hash !== "") {
      throw new Error("request URL may not contain user info or a fragment");
    }
    return url;
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

/**
 * The OpenCode Zen/Go client. Preserved as its own name because the legacy
 * gateway configuration path and its tests bind to it directly; behaviour is
 * exactly the generalised client pinned to the Zen endpoint.
 */
export class KernelGatewayClient extends KernelConnectorClient {
  constructor(connectors: ConnectorService, context: RequestContext) {
    super(connectors, context, ZEN_GATEWAY_ENDPOINT);
  }
}

function assertNotAborted(signal: AbortSignal | null, message: string): void {
  // ConnectorCancelledError, not a bare Error: turn teardown must classify as
  // `cancelled` (an interrupted turn) rather than as an internal fault.
  if (signal?.aborted === true) throw new ConnectorCancelledError(message);
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  message: string,
): Promise<T> {
  if (signal?.aborted === true) {
    return Promise.reject(new ConnectorCancelledError(message));
  }
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new ConnectorCancelledError(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(asCancellation(err, message));
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
