import { randomUUID } from "node:crypto";
import type {
  ConnectorService,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { CredentialBoundGatewayClient, GatewayHttpRequest } from "@terminus/provider-zen";

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
        },
        ttlSeconds: 60,
      }),
      input.signal,
      "gateway request was aborted",
    );
    if (grant.encodedGrant.length === 0) throw new Error("kernel returned an empty connector grant");
    assertNotAborted(input.signal, "gateway request was aborted before dispatch");
    const response = await withAbortSignal(
      this.connectors.Execute({
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
      }),
      input.signal,
      "gateway request was aborted",
    );
    const status = response.receipt?.statusCode;
    if (status === undefined) {
      throw new Error(`OpenCode gateway dispatch did not settle: ${response.receipt?.outcome ?? "missing receipt"}`);
    }
    if (status < 200 || status > 299) {
      throw new Error(`OpenCode gateway returned HTTP ${status}${providerErrorSuffix(response.body)}`);
    }
    for (const chunk of splitSseChunks(response.body)) {
      assertNotAborted(input.signal, "gateway request was aborted during streaming");
      yield chunk;
    }
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
