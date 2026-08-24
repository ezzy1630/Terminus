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
    const url = admittedGatewayUrl(input.url);
    const effectId = randomUUID();
    const grant = await this.connectors.MintGrant({
      context: nextContext(this.context, `gateway-grant:${effectId}`),
      capabilityUri: input.credentialBindingId,
      binding: {
        connectorId: "opencode-gateway",
        destinationHost: GATEWAY_HOST,
        destinationPort: GATEWAY_PORT,
        scheme: "https",
        method: input.method,
        pathClass: url.pathname,
        effectId,
      },
      ttlSeconds: 60,
    });
    if (grant.encodedGrant.length === 0) throw new Error("kernel returned an empty connector grant");
    assertNotAborted(input.signal, "gateway request was aborted before dispatch");
    const response = await this.connectors.Execute({
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
    });
    const status = response.receipt?.statusCode;
    if (status === undefined) {
      throw new Error(`OpenCode gateway dispatch did not settle: ${response.receipt?.outcome ?? "missing receipt"}`);
    }
    if (status < 200 || status > 299) {
      throw new Error(`OpenCode gateway returned HTTP ${status}${providerErrorSuffix(response.body)}`);
    }
    yield response.body;
  }
}

function assertNotAborted(signal: AbortSignal | null, message: string): void {
  if (signal?.aborted === true) throw new Error(message);
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
