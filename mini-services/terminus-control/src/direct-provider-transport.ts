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
import { AnthropicRenderer, decodeAnthropicMessagesStream } from "@terminus/provider-anthropic";
import { OpenAiRenderer, decodeOpenAiStream, renderResponsesRequest } from "@terminus/provider-openai";
import type {
  ConnectorChunk,
  ConnectorService,
  ExecuteConnectorRequest,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { DirectProviderConfiguration } from "./direct-provider-config.js";

export const DIRECT_ENDPOINTS = {
  anthropic: { host: "api.anthropic.com", port: 443, connectorId: "anthropic-messages", path: "/v1/messages" },
  openai_responses: { host: "api.openai.com", port: 443, connectorId: "openai-responses", path: "/v1/responses" },
  openai_chat: { host: "api.openai.com", port: 443, connectorId: "openai-chat", path: "/v1/chat/completions" },
} as const;

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

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
    try {
      for await (const chunk of this.eachChunk(request, input.signal)) {
        observedStream = true;
        streamed = true;
        if (chunk.bytes !== undefined) {
          yield chunk.bytes;
        } else if (chunk.receipt !== undefined) {
          const status = chunk.receipt.statusCode;
          const outcomeText = chunk.receipt.outcome ?? "";
          if (status === undefined || status < 200 || status > 299) {
            throw new Error(
              `direct provider returned HTTP ${status ?? 0}${outcomeText.length > 0 ? ` (${outcomeText})` : ""}`,
            );
          }
        }
      }
    } catch (error) {
      if (isUnimplemented(error) && !observedStream) {
        // Legacy kernel: buffered dispatch below.
        fallbackToUnary = true;
      } else {
        throw error;
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
      // Connector receipts do not carry response headers yet; retry pacing
      // falls back to exponential backoff with jitter in provider-retry.ts.
      throw new Error(`direct provider returned HTTP ${status}${providerErrorSuffix(response.body)}`);
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
    let sawReceiptStatus: number | null = null;
    let fallbackToUnary = false;
    let observedStream = false;
    let streamed = false;
    try {
      for await (const chunk of this.eachChunk(request, input.signal)) {
        observedStream = true;
        if (chunk.bytes !== undefined) {
          streamed = true;
          yield chunk.bytes;
        } else if (chunk.receipt !== undefined) {
          sawReceiptStatus = chunk.receipt.statusCode ?? null;
        }
      }
    } catch (error) {
      if (isUnimplemented(error) && !observedStream) fallbackToUnary = true;
      else throw error;
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
        throw new Error(`direct provider returned HTTP ${status ?? 0}${providerErrorSuffix(response.body)}`);
      }
      yield* splitSseChunks(response.body);
      return;
    }
    if (!observedStream) throw new Error("direct provider stream ended without a response");
    if (!streamed) throw new Error("direct provider stream settled without response bytes");
    if (sawReceiptStatus === null) throw new Error("direct provider stream ended without a receipt");
    if (sawReceiptStatus < 200 || sawReceiptStatus > 299) {
      throw new Error(`direct provider returned HTTP ${sawReceiptStatus}`);
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
  if (signal?.aborted === true) throw new Error(message);
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  message: string,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new Error(message));
  if (signal === null || signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Minimal Observable→AsyncIterable bridge. */
function observableToAsyncIterable<T>(
  source: import("rxjs").Observable<T>,
  signal?: AbortSignal | null,
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
        failure = new Error("direct provider request was aborted");
        done = true;
        queue.length = 0;
        subscription?.unsubscribe();
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
            failure = err;
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
function isUnimplemented(error: unknown): boolean {
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
    throw new Error(`${providerError.errorCode ?? "PROVIDER_ERROR"}: ${providerError.errorMessage ?? "direct provider failed"}`);
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
export function createDirectRenderer(configuration: DirectProviderConfiguration): ProviderRenderer {
  if (configuration.vendor === "anthropic") return new AnthropicRenderer();
  if (configuration.protocol === "chat_completions") return new OpenAiRenderer();
  const delegate = new OpenAiRenderer();
  return {
    providerId: delegate.providerId,
    version: delegate.version,
    compatibility: (input: RenderCompatibilityInput): CompatibilityResult => delegate.compatibility(input),
    render: async (input: CanonicalRenderInput): Promise<RenderedProviderRequest> => renderResponsesRequest(input),
    projectResponse: (response: ProviderResponse) => delegate.projectResponse(response),
    extractUsage: (response: ProviderResponse): UsageRecord => delegate.extractUsage(response),
    continuationPolicy: (input: ContinuationInput): ContinuationDecision => delegate.continuationPolicy(input),
  };
}
