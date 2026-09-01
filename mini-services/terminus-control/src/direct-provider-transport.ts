/**
 * Kernel-backed transports for direct Anthropic/OpenAI API access
 * (audit P0-2, ADR-0039 §10).
 *
 * Every request mints a short-lived connector grant bound to exactly one
 * documented endpoint and dispatches through `terminus.kernel.v1`
 * ConnectorService. Credential material never enters this module: the kernel
 * injects the secret capability's key at dispatch time (Bearer for OpenAI,
 * x-api-key for Anthropic).
 */
import { randomUUID } from "node:crypto";
import type {
  CanonicalRenderInput,
  ReasoningEffort,
  CompatibilityResult,
  ContinuationInput,
  ContinuationDecision,
  ProviderRenderer,
  ProviderResponse,
  ProviderResponseChunk,
  RenderCompatibilityInput,
  RenderedProviderRequest,
  UsageRecord,
} from "@terminus/provider-core";
import type { Rfc3339Timestamp } from "@terminus/domain";
import { ReasoningReplayLedger } from "@terminus/provider-core";
import {
  AnthropicRenderer,
  anthropicBetaHeader,
  decodeAnthropicMessagesStream,
} from "@terminus/provider-anthropic";
import { OpenAiRenderer, decodeOpenAiStream, renderResponsesRequest } from "@terminus/provider-openai";
import type {
  ConnectorChunk,
  ConnectorHeaderMessage,
  ConnectorReceiptMessage,
  ConnectorService,
  ExecuteConnectorRequest,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { DirectProviderConfiguration } from "./direct-provider-config.js";
import { ProviderTransportError } from "./providers/provider-retry.js";

export const DIRECT_ENDPOINTS = {
  anthropic: { host: "api.anthropic.com", port: 443, connectorId: "anthropic-messages", path: "/v1/messages" },
  openai_responses: { host: "api.openai.com", port: 443, connectorId: "openai-responses", path: "/v1/responses" },
  openai_chat: { host: "api.openai.com", port: 443, connectorId: "openai-chat", path: "/v1/chat/completions" },
} as const;

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * The kernel's pre-body receipt.
 *
 * `ExecuteStream` now emits a receipt with `outcome == "head"` before the
 * first body byte, for error statuses as well as 2xx. It carries the HTTP
 * status and the lowercased response headers the connector allowlist admits.
 * It is emphatically *not* terminal: the stream continues after it, and the
 * real receipt (`accepted` | `rejected_non_retryable` | `dispatch_uncertain`
 * | `not_dispatched`) still arrives at the end.
 *
 * Treating it as terminal would end every successful stream at zero bytes;
 * ignoring it would keep the old behaviour where `retry-after` only became
 * readable after the whole response had already been waited out.
 */
export const HEAD_RECEIPT_OUTCOME = "head";

export function isHeadReceipt(
  receipt: { readonly outcome?: string | undefined } | undefined,
): boolean {
  return (receipt?.outcome ?? "") === HEAD_RECEIPT_OUTCOME;
}

/** Response-header value cap; the kernel bounds these, this is defence in depth. */
const MAX_HEADER_VALUE_CHARS = 4096;

/**
 * The receipt's response headers as a lowercased map.
 *
 * The kernel already lowercases and bounds them (≤32 headers, ≤4096 bytes
 * each); doing it again here means a consumer never has to care which side of
 * the boundary normalised what.
 */
export function responseHeaderMap(
  receipt: { readonly responseHeaders?: readonly ConnectorHeaderMessage[] | undefined } | undefined,
): Readonly<Record<string, string>> {
  const collected: Record<string, string> = {};
  for (const header of receipt?.responseHeaders ?? []) {
    if (typeof header.name !== "string" || typeof header.value !== "string") continue;
    collected[header.name.toLowerCase()] = header.value.slice(0, MAX_HEADER_VALUE_CHARS);
  }
  return collected;
}

/**
 * What one dispatch observed, filled by the transport and read by the caller.
 *
 * Time-to-first-token has to be measured where the bytes arrive. Measuring it
 * at the head frame would report the kernel's own round trip — a number near
 * zero that says nothing about the provider — and measuring it at the first
 * *decoded* chunk skips whatever leading SSE events produced no token, so the
 * two disagree by however long the provider spent on `response.created`.
 * The first body frame is the honest boundary, and only the transport sees it.
 */
export interface ConnectorStreamTelemetry {
  /** HTTP status from the head frame, or the terminal receipt on old kernels. */
  status: number | null;
  /** Lowercased response headers from the head frame. */
  responseHeaders: Readonly<Record<string, string>>;
  /** `Date.now()` when the request was handed to the kernel. */
  dispatchedAtMs: number | null;
  /** `Date.now()` at the first body frame; null when none ever arrived. */
  firstBodyAtMs: number | null;
}

export function createStreamTelemetry(): ConnectorStreamTelemetry {
  return { status: null, responseHeaders: {}, dispatchedAtMs: null, firstBodyAtMs: null };
}

/** Dispatch → first body frame, in milliseconds. Null when never measured. */
export function timeToFirstBodyMs(telemetry: ConnectorStreamTelemetry | undefined): number | null {
  if (telemetry?.dispatchedAtMs == null || telemetry.firstBodyAtMs === null) return null;
  return Math.max(0, telemetry.firstBodyAtMs - telemetry.dispatchedAtMs);
}

/**
 * Turn teardown, as an error the loop already knows how to read.
 *
 * Cancelling the client side of the RPC is what tells the kernel to abort the
 * upstream request, and the kernel answers by ending the stream with gRPC
 * `CANCELLED`. Both directions used to surface as a bare `Error`, which
 * `classifyLoopError` files under `internal`/`unknown` — so a turn the user
 * interrupted was reported as a crash. `CancelledError`/`CANCELLED` is the
 * shape that classifier already maps to the interrupted outcome.
 */
export class ConnectorCancelledError extends Error {
  readonly code = "CANCELLED";
  constructor(message = "provider request was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** gRPC status 1, however grpc-js chose to surface it. */
export function isGrpcCancelled(error: unknown): boolean {
  if (error instanceof ConnectorCancelledError) return true;
  if (typeof error !== "object" || error === null) return false;
  const record = error as { readonly code?: unknown; readonly message?: unknown };
  if (record.code === 1 || record.code === "CANCELLED") return true;
  return typeof record.message === "string" && /\b1 CANCELLED\b/.test(record.message);
}

/**
 * Re-file a cancellation; anything else passes through untouched.
 *
 * An error that is already a `ConnectorCancelledError` is returned as-is: it
 * was raised at the abort site and its message names where teardown happened,
 * which a generic re-wrap would throw away.
 */
export function asCancellation(error: unknown, message: string): unknown {
  if (error instanceof ConnectorCancelledError) return error;
  return isGrpcCancelled(error) ? new ConnectorCancelledError(message) : error;
}

/**
 * The `Retry-After` the provider sent, in milliseconds.
 *
 * Connector receipts carry the response headers the connector descriptor's
 * allowlist admitted, `retry-after` among them. Every throw site below reads
 * it, because the alternative — the state this replaced — was to discard the
 * one number the provider gave us about when to come back and guess instead.
 * Both header forms are accepted: delta-seconds and an HTTP date.
 */
export function retryAfterMsFromReceipt(
  receipt: { readonly responseHeaders?: readonly ConnectorHeaderMessage[] | undefined } | undefined,
  now: number = Date.now(),
): number | null {
  for (const header of receipt?.responseHeaders ?? []) {
    if (header.name.toLowerCase() !== "retry-after") continue;
    const raw = header.value.trim();
    if (raw === "") continue;
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.ceil(Number.parseFloat(raw) * 1_000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return null;
}

/** The structured init for a non-2xx receipt, hint included. */
export function transportErrorInit(
  receipt: ConnectorReceiptMessage | undefined,
  status: number | null,
): { readonly status: number | null; readonly retryAfterMs?: number } {
  const retryAfterMs = retryAfterMsFromReceipt(receipt);
  return { status, ...(retryAfterMs === null ? {} : { retryAfterMs }) };
}

export function directEndpoint(configuration: DirectProviderConfiguration) {
  switch (configuration.vendor) {
    case "anthropic":
      return DIRECT_ENDPOINTS.anthropic;
    case "openai":
      return configuration.protocol === "responses" ? DIRECT_ENDPOINTS.openai_responses : DIRECT_ENDPOINTS.openai_chat;
  }
}

/** Network destinations a direct turn must be authorized for. */
export function directNetworkDestinations(): readonly string[] {
  return [...new Set(Object.values(DIRECT_ENDPOINTS).map((endpoint) => `${endpoint.host}:${endpoint.port}`))];
}

export interface DirectHttpRequest {
  /** Filled in by the transport: head-frame status/headers and first-body time. */
  readonly telemetry?: ConnectorStreamTelemetry | undefined;
  readonly method: "POST";
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Opaque kernel secret capability URI; key material never passes here. */
  readonly credentialBindingId: string;
  readonly signal?: AbortSignal | null;
}

/**
 * Trusted higher layers implement this through the kernel connector. The
 * credential binding is opaque; raw key material never enters this package.
 */
export interface DirectConnectorClient {
  stream(input: DirectHttpRequest): AsyncIterable<Uint8Array>;
}

export class KernelDirectConnectorClient implements DirectConnectorClient {
  constructor(
    private readonly connectors: ConnectorService,
    private readonly context: RequestContext,
  ) {}

  async *stream(input: DirectHttpRequest): AsyncIterable<Uint8Array> {
    const effectId = randomUUID();
    assertNotAborted(input.signal, "direct provider request was aborted");
    const grant = await withAbortSignal(
      this.connectors.MintGrant({
        context: nextContext(this.context, `direct-grant:${effectId}`),
        capabilityUri: input.credentialBindingId,
        binding: {
          connectorId: connectorIdForEndpoint(input),
          destinationHost: input.host,
          destinationPort: input.port,
          scheme: "https",
          method: input.method,
          pathClass: input.path,
          effectId,
          // Exactly the endpoint this request dispatches to; the kernel
          // re-checks it against the global egress union.
          allowedHosts: [input.host],
        },
        ttlSeconds: 60,
      }),
      input.signal,
      "direct provider request was aborted",
    );
    if (grant.encodedGrant.length === 0) throw new Error("kernel returned an empty connector grant");
    const request: ExecuteConnectorRequest = {
      context: nextContext(this.context, `direct-execute:${effectId}`),
      encodedGrant: grant.encodedGrant,
      operation: {
        method: input.method,
        scheme: "https",
        host: input.host,
        port: input.port,
        path: input.path,
        query: "",
        headers: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
        body: new TextEncoder().encode(input.body),
      },
    };
    // R6: prefer the incremental stream so tokens reach the client as they
    // arrive; fall back to the buffered unary Execute when talking to an
    // older kernel that predates ExecuteStream.
    let fallbackToUnary = false;
    let observedStream = false;
    let streamed = false;
    let headValidated = false;
    const telemetry = input.telemetry;
    if (telemetry !== undefined) telemetry.dispatchedAtMs = Date.now();
    try {
      for await (const chunk of this.eachChunk(request, input.signal)) {
        observedStream = true;
        if (chunk.bytes !== undefined && chunk.bytes.byteLength > 0) {
          // Only a non-empty body frame counts as "the provider answered".
          // Receipts used to set this too, which made the empty-stream guard
          // below dead code; the contract also promises no zero-length frame,
          // and forwarding one would end an SSE decoder's event early.
          if (!streamed && telemetry !== undefined) telemetry.firstBodyAtMs = Date.now();
          streamed = true;
          yield chunk.bytes;
        } else if (chunk.receipt !== undefined) {
          const status = chunk.receipt.statusCode;
          const outcomeText = chunk.receipt.outcome ?? "";
          if (isHeadReceipt(chunk.receipt)) {
            // Status and `retry-after` are readable before the body, which is
            // the whole point of the head frame: a 429 no longer has to be
            // waited out before its backoff hint can be read.
            headValidated = true;
            if (telemetry !== undefined) {
              telemetry.status = status ?? null;
              telemetry.responseHeaders = responseHeaderMap(chunk.receipt);
            }
            if (status === undefined || status < 200 || status > 299) {
              throw new ProviderTransportError(
                `direct provider returned HTTP ${status ?? 0}`,
                transportErrorInit(chunk.receipt, status ?? null),
              );
            }
            continue;
          }
          // Terminal receipt. A kernel that already sent a head frame has had
          // its status checked; one that never did (pre-head kernels) is
          // checked here, as before.
          if (telemetry !== undefined && telemetry.status === null && status !== undefined) {
            telemetry.status = status;
          }
          if (!headValidated && (status === undefined || status < 200 || status > 299)) {
            throw new ProviderTransportError(
              `direct provider returned HTTP ${status ?? 0}${outcomeText.length > 0 ? ` (${outcomeText})` : ""}`,
              transportErrorInit(chunk.receipt, status ?? null),
            );
          }
        }
      }
    } catch (error) {
      if (isUnimplemented(error) && !observedStream) {
        // Legacy kernel: buffered dispatch below.
        fallbackToUnary = true;
      } else {
        throw asCancellation(error, "direct provider request was cancelled");
      }
    }
    // ExecuteStream already performed the request when it produced a receipt
    // or body. Never issue a second provider request merely because an older
    // kernel returned a receipt without body chunks.
    if (observedStream && !fallbackToUnary) {
      if (!streamed) throw new Error("direct provider stream settled without response bytes");
      return;
    }
    if (!fallbackToUnary) throw new Error("direct provider stream ended without a response");
    const response = await withAbortSignal(
      this.connectors.Execute(request),
      input.signal,
      "direct provider request was aborted",
    );
    const status = response.receipt?.statusCode;
    if (status === undefined) {
      throw new Error(`direct provider dispatch did not settle: ${response.receipt?.outcome ?? "missing receipt"}`);
    }
    if (status < 200 || status > 299) {
      throw new ProviderTransportError(
        `direct provider returned HTTP ${status}${providerErrorSuffix(response.body)}`,
        transportErrorInit(response.receipt, status),
      );
    }
    yield* splitSseChunks(response.body);
  }

  private eachChunk(request: ExecuteConnectorRequest, signal?: AbortSignal | null): AsyncIterable<ConnectorChunk> {
    if (typeof this.connectors.ExecuteStream !== "function") {
      throw new Error("UNIMPLEMENTED: ConnectorService.ExecuteStream is unavailable");
    }
    return observableToAsyncIterable(this.connectors.ExecuteStream(request), signal);
  }

  /**
   * Raw SSE streaming for the native provider runtimes: mints a grant for
   * the given destination and yields response bytes as they arrive. The
   * caller owns headers (minus credentials, which stay connector-side).
   */
  async *streamRaw(input: {
    readonly host: string;
    readonly port: number;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly context: RequestContext;
    /** Opaque secret capability binding; required for vendor connectors. */
    readonly credentialBindingId: string;
    readonly signal?: AbortSignal | null;
    /** Filled in by the transport: head-frame status/headers, first-body time. */
    readonly telemetry?: ConnectorStreamTelemetry | undefined;
  }): AsyncIterable<Uint8Array> {
    const effectId = randomUUID();
    assertNotAborted(input.signal, "direct provider request was aborted");
    const grant = await withAbortSignal(
      this.connectors.MintGrant({
        context: nextContext(input.context, `native-grant:${effectId}`),
        capabilityUri: input.credentialBindingId,
        binding: {
          connectorId: connectorIdForRawPath(input.host, input.path),
          destinationHost: input.host,
          destinationPort: input.port,
          scheme: "https",
          method: "POST",
          pathClass: input.path,
          allowedHosts: [input.host],
          effectId,
        },
        ttlSeconds: 60,
      }),
      input.signal,
      "direct provider request was aborted",
    );
    if (grant.encodedGrant.length === 0) throw new Error("kernel returned an empty connector grant");
    const request: ExecuteConnectorRequest = {
      context: nextContext(input.context, `native-execute:${effectId}`),
      encodedGrant: grant.encodedGrant,
      operation: {
        method: "POST",
        scheme: "https",
        host: input.host,
        port: input.port,
        path: input.path,
        query: "",
        headers: Object.entries(input.headers).map(([name, value]) => ({ name, value })),
        body: new TextEncoder().encode(input.body),
      },
    };
    let sawReceipt: ConnectorReceiptMessage | undefined;
    let sawReceiptStatus: number | null = null;
    let headValidated = false;
    let fallbackToUnary = false;
    let observedStream = false;
    let streamed = false;
    const telemetry = input.telemetry;
    if (telemetry !== undefined) telemetry.dispatchedAtMs = Date.now();
    try {
      for await (const chunk of this.eachChunk(request, input.signal)) {
        observedStream = true;
        if (chunk.bytes !== undefined && chunk.bytes.byteLength > 0) {
          if (!streamed && telemetry !== undefined) telemetry.firstBodyAtMs = Date.now();
          streamed = true;
          yield chunk.bytes;
        } else if (chunk.receipt !== undefined) {
          if (isHeadReceipt(chunk.receipt)) {
            const status = chunk.receipt.statusCode;
            headValidated = true;
            if (telemetry !== undefined) {
              telemetry.status = status ?? null;
              telemetry.responseHeaders = responseHeaderMap(chunk.receipt);
            }
            if (status === undefined || status < 200 || status > 299) {
              throw new ProviderTransportError(
                `direct provider returned HTTP ${status ?? 0}`,
                transportErrorInit(chunk.receipt, status ?? null),
              );
            }
            continue;
          }
          sawReceipt = chunk.receipt;
          sawReceiptStatus = chunk.receipt.statusCode ?? null;
          if (telemetry !== undefined && telemetry.status === null && sawReceiptStatus !== null) {
            telemetry.status = sawReceiptStatus;
          }
        }
      }
    } catch (error) {
      if (isUnimplemented(error) && !observedStream) fallbackToUnary = true;
      else throw asCancellation(error, "direct provider request was cancelled");
    }
    if (fallbackToUnary) {
      // Legacy kernel: ExecuteStream was not implemented, so the request has
      // not happened and the buffered unary call is safe.
      const response = await withAbortSignal(
        this.connectors.Execute(request),
        input.signal,
        "direct provider request was aborted",
      );
      const status = response.receipt?.statusCode;
      if (status === undefined || status < 200 || status > 299) {
        throw new ProviderTransportError(
          `direct provider returned HTTP ${status ?? 0}${providerErrorSuffix(response.body)}`,
          transportErrorInit(response.receipt, status ?? null),
        );
      }
      yield* splitSseChunks(response.body);
      return;
    }
    if (!observedStream) throw new Error("direct provider stream ended without a response");
    if (!streamed) throw new Error("direct provider stream settled without response bytes");
    // A head frame already carried the status, so a terminal receipt without
    // one is no longer a missing-status failure.
    if (sawReceiptStatus === null && !headValidated) {
      throw new Error("direct provider stream ended without a receipt");
    }
    if (sawReceiptStatus !== null && (sawReceiptStatus < 200 || sawReceiptStatus > 299)) {
      throw new ProviderTransportError(
        `direct provider returned HTTP ${sawReceiptStatus}`,
        transportErrorInit(sawReceipt, sawReceiptStatus),
      );
    }
  }
}

/** Map a raw vendor destination onto the registered anonymous connectors. */
function connectorIdForRawPath(host: string, path: string): string {
  for (const endpoint of Object.values(DIRECT_ENDPOINTS)) {
    if (endpoint.host === host && endpoint.path === path) return endpoint.connectorId;
  }
  throw new Error(`no registered connector admits https://${host}${path}`);
}

function assertNotAborted(signal: AbortSignal | null | undefined, message: string): void {
  if (signal?.aborted === true) throw new ConnectorCancelledError(message);
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  message: string,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new ConnectorCancelledError(message));
  if (signal === null || signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new ConnectorCancelledError(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(asCancellation(error, message));
      },
    );
  });
}

/** Minimal Observable→AsyncIterable bridge. */
// skipcq: JS-0067
export function observableToAsyncIterable<T>(
  source: import("rxjs").Observable<T>,
  signal?: AbortSignal | null,
  abortMessage = "direct provider request was aborted",
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = [];
      let done = false;
      let failure: unknown = null;
      let wake: (() => void) | null = null;
      let subscription: import("rxjs").Subscription | null = null;
      const notify = (): void => {
        if (wake !== null) {
          const resolve = wake;
          wake = null;
          resolve();
        }
      };
      const onAbort = (): void => {
        if (done) return;
        // A shape `classifyLoopError` files as `cancelled`, so an interrupted
        // turn is reported as interrupted rather than as an internal fault.
        failure = new ConnectorCancelledError(abortMessage);
        done = true;
        queue.length = 0;
        // Unsubscribing is what actually cancels the gRPC call, which is what
        // tells the kernel to abort the upstream request. Without it the
        // provider keeps generating (and billing) after the user has stopped.
        subscription?.unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        notify();
      };
      if (signal?.aborted === true) {
        onAbort();
      } else {
        subscription = source.subscribe({
          next: (value: T) => {
            queue.push(value);
            notify();
          },
          error: (err: unknown) => {
            if (done) return;
            // The kernel ends an aborted stream with gRPC CANCELLED; that is
            // the teardown this client asked for, not a provider failure.
            failure = asCancellation(err, abortMessage);
            done = true;
            signal?.removeEventListener("abort", onAbort);
            notify();
          },
          complete: () => {
            if (done) return;
            done = true;
            signal?.removeEventListener("abort", onAbort);
            notify();
          },
        });
        if (signal !== null && signal !== undefined && !done) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      return {
        next: async (): Promise<IteratorResult<T>> => {
          // skipcq: JS-0092
          while (!done && queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          if (failure !== null) throw failure;
          return { value: undefined as never, done: true };
        },
        return: async (): Promise<IteratorResult<T>> => {
          subscription?.unsubscribe();
          done = true;
          signal?.removeEventListener("abort", onAbort);
          notify();
          return { value: undefined as never, done: true };
        },
      };
    },
  };
}

/** grpc-js surfaces UNIMPLEMENTED as a details-bearing error string. */
export function isUnimplemented(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unimplemented/i.test(message);
}

function connectorIdForEndpoint(input: DirectHttpRequest): string {
  if (input.host === DIRECT_ENDPOINTS.anthropic.host && input.path === DIRECT_ENDPOINTS.anthropic.path) {
    return DIRECT_ENDPOINTS.anthropic.connectorId;
  }
  if (input.host === DIRECT_ENDPOINTS.openai_responses.host && input.path === DIRECT_ENDPOINTS.openai_responses.path) {
    return DIRECT_ENDPOINTS.openai_responses.connectorId;
  }
  if (input.host === DIRECT_ENDPOINTS.openai_chat.host && input.path === DIRECT_ENDPOINTS.openai_chat.path) {
    return DIRECT_ENDPOINTS.openai_chat.connectorId;
  }
  throw new Error(`no registered connector admits https://${input.host}${input.path}`);
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
    if (part.length > 0) yield encoder.encode(part);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `anthropic-beta`, or nothing at all.
 *
 * The header name is `anthropic-beta` exactly — that is the name the kernel
 * connector allowlist admits, and a header the allowlist does not know is
 * dropped rather than sent.
 */
function anthropicBetaHeaders(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const value = anthropicBetaHeader(body);
  return value === null ? {} : { "anthropic-beta": value };
}

export interface ExecuteDirectProviderInput {
  readonly rendered: RenderedProviderRequest;
  readonly configuration: DirectProviderConfiguration;
  /** Stable cache-routing key (e.g. the context epoch id); Responses API only. */
  readonly cacheKey?: string | undefined;
}

/**
 * Dispatch one rendered provider request to the vendor's first-party API via
 * the kernel connector and normalize the SSE stream into chunks.
 */
export async function executeDirectProviderRequest(
  input: ExecuteDirectProviderInput,
  client: DirectConnectorClient,
): Promise<ProviderResponse> {
  const { rendered, configuration } = input;
  const endpoint = directEndpoint(configuration);
  let bodyObject = rendered.body as Readonly<Record<string, unknown>>;
  if (configuration.vendor === "openai" && configuration.protocol === "responses" && input.cacheKey !== undefined) {
    bodyObject = { ...bodyObject, prompt_cache_key: input.cacheKey };
  }
  const serialized = JSON.stringify({ ...bodyObject, stream: true });
  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
    throw new Error(`direct request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(configuration.vendor === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
    // Only when a field in this exact body needs one. Adaptive thinking,
    // `output_config.effort`, interleaved thinking and strict tools are all
    // GA; announcing a beta the request does not use opts the call into that
    // beta's semantics for nothing.
    ...(configuration.vendor === "anthropic" ? anthropicBetaHeaders(bodyObject) : {}),
  };
  const chunks: ProviderResponseChunk[] = [];
  const events = client.stream({
    method: "POST",
    host: endpoint.host,
    port: endpoint.port,
    path: endpoint.path,
    headers,
    body: serialized,
    credentialBindingId: configuration.secretUri,
    signal: rendered.request.signal,
  });
  switch (configuration.vendor) {
    case "anthropic":
      for await (const chunk of decodeAnthropicMessagesStream(events, rendered.model)) chunks.push(chunk);
      break;
    case "openai":
      for await (
        const chunk of decodeOpenAiStream(
          events,
          configuration.protocol === "responses" ? "responses" : "chat_completions",
          rendered.model,
        )
      ) chunks.push(chunk);
      break;
  }
  const providerError = chunks.find((chunk) => chunk.kind === "error");
  if (providerError?.kind === "error") {
    throw ProviderTransportError.fromProviderErrorChunk({
      errorCode: providerError.errorCode,
      errorMessage: providerError.errorMessage,
      retryAfterMs: providerError.retryAfterMs,
      fallbackMessage: "direct provider failed",
    });
  }
  return {
    providerId: rendered.providerId,
    model: rendered.model,
    chunks,
    observedAt: new Date().toISOString() as Rfc3339Timestamp,
  };
}

/**
 * Renderer for a configured direct provider. Anthropic Messages and OpenAI
 * Chat Completions map straight onto the vendor renderer; the OpenAI
 * Responses API reuses the chat rendering converted to Responses input items.
 */
export interface DirectRendererOptions {
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
  /** Stable cache-routing key for the OpenAI-shaped protocols. */
  readonly promptCacheKey?: string | null | undefined;
  /** `text.verbosity` for the Responses protocol; `low` by default. */
  readonly textVerbosity?: "low" | "medium" | "high" | undefined;
  /**
   * Reasoning chain to replay. Supplying a pre-seeded ledger is how a turn
   * resumed after a restart still leads each replayed call with the reasoning
   * that produced it; without one the renderer starts empty.
   */
  readonly reasoningReplay?: ReasoningReplayLedger | undefined;
}

export function createDirectRenderer(
  configuration: DirectProviderConfiguration,
  options: DirectRendererOptions = {},
): ProviderRenderer {
  const reasoningEffort = options.reasoningEffort ?? null;
  // Anthropic renders the depth as `output_config.effort`. It used to be
  // dropped here — the comment claimed the path had no depth control, which
  // stopped being true when `budget_tokens` was replaced by `effort`, and the
  // effect was that a user's choice of Max on a direct Anthropic turn reached
  // nothing at all.
  const reasoningReplay = options.reasoningReplay ?? new ReasoningReplayLedger();
  if (configuration.vendor === "anthropic") return new AnthropicRenderer({ reasoningEffort, reasoningReplay });
  const rendererOptions = {
    reasoningEffort,
    ...(options.promptCacheKey === undefined || options.promptCacheKey === null
      ? {}
      : { promptCacheKey: options.promptCacheKey }),
    ...(options.textVerbosity === undefined ? {} : { textVerbosity: options.textVerbosity }),
  };
  if (configuration.protocol === "chat_completions") return new OpenAiRenderer(rendererOptions);
  // One ledger for the life of this renderer: the control plane builds it once
  // per turn, so an encrypted reasoning item captured on one attempt is
  // replayed before its own tool call on the next — and a seeded one carries
  // the calls made before a restart.
  const responsesOptions = { ...rendererOptions, reasoningReplay };
  const delegate = new OpenAiRenderer(responsesOptions);
  return {
    providerId: delegate.providerId,
    version: delegate.version,
    compatibility: (input: RenderCompatibilityInput): CompatibilityResult => delegate.compatibility(input),
    render: async (input: CanonicalRenderInput): Promise<RenderedProviderRequest> =>
      renderResponsesRequest(input, responsesOptions),
    projectResponse: (response: ProviderResponse) => delegate.projectResponse(response),
    extractUsage: (response: ProviderResponse): UsageRecord => delegate.extractUsage(response),
    // `store: false` leaves the endpoint nothing to continue from, so this
    // path never claims a native continuation; the prefix and the reasoning
    // items are replayed instead.
    continuationPolicy: (input: ContinuationInput): ContinuationDecision => ({
      canContinue: !input.stablePrefixHashChanged,
      reason: input.stablePrefixHashChanged
        ? "OpenAI Responses replays the prefix and the stable prefix changed"
        : "OpenAI Responses is stateless (store: false); the client replays the prefix",
      requiresRerender: input.stablePrefixHashChanged,
      requiresUserConsent: false,
      newContinuationId: null,
    }),
  };
}
