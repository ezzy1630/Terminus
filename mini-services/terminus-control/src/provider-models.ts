/**
 * Terminus Control — provider model discovery.
 *
 * Two sources, because neither alone is sufficient:
 *
 *   - The OpenCode gateway's `/models` says which models this credential may
 *     actually reach. It reports only ids.
 *   - The Models.dev catalogue says what those ids *are* — reasoning support,
 *     context window, tool calling, price. It has no idea what you can access.
 *
 * `discoverGatewayModels` in @terminus/provider-zen is the intersection, and
 * it rejects anything present in one source but not the other rather than
 * guessing. That rejection list is returned so an operator can see why a model
 * they expected is missing.
 *
 * Before this route existed the only model metadata Terminus had was whatever
 * an operator hand-typed into the gateway configuration. That input is now
 * configuration-only: a turn cannot construct a runnable gateway model until
 * this exact deployment/model pair has been discovered.
 *
 * Egress: the gateway call reuses the existing credential-bound connector (same
 * host, same secret, read-only path). Models.dev is public, but a decision RPC
 * is not an HTTP transport. Until the kernel exposes a bounded public-fetch
 * connector, catalogue discovery fails closed instead of falling through to a
 * TypeScript fetch.
 */
import {
  discoverGatewayModels,
  parseAvailableModels,
  parseModelsDevCatalog,
  type GatewayDeployment,
  type GatewayDiscoveryResult,
  type GatewayModel,
} from "@terminus/provider-zen";
import { createHash } from "node:crypto";
import type { CredentialBoundGatewayClient } from "@terminus/provider-zen";
import { getOfflineCatalogSnapshotJson } from "@terminus/provider-core";
import { z } from "zod";

const MAX_GATEWAY_LIST_BYTES = 1 * 1024 * 1024;

const GATEWAY_BASE_URLS: Readonly<Record<GatewayDeployment, string>> = {
  zen: "https://opencode.ai/zen/v1",
  go: "https://opencode.ai/zen/go/v1",
};

export interface ProviderModelsResult extends GatewayDiscoveryResult {
  readonly deployment: GatewayDeployment;
  readonly observedAt: string;
}

/**
 * Discovery costs two network round trips, and the composer asks on every
 * mount. The reachable-model set changes on the order of days.
 *
 * The cache is also what lets the turn path use real capabilities: it reads
 * this synchronously and never triggers discovery itself, because adding a
 * network call — and a new failure mode — to every turn to improve a metadata
 * field is not a trade worth making.
 */
const CACHE_TTL_MS = 5 * 60 * 1_000;

let cache: {
  readonly deployment: GatewayDeployment;
  readonly result: ProviderModelsResult;
  readonly expiresAt: number;
} | null = null;

let catalogCache: {
  readonly catalog: ReturnType<typeof parseModelsDevCatalog>;
  readonly expiresAt: number;
} | null = null;

/**
 * The undecoded catalogue document.
 *
 * `parseModelsDevCatalog` decodes the two OpenCode gateway providers and
 * asserts their base URLs, which is exactly right for gateway discovery and
 * useless for a connected provider account: the account may be any of the 200+
 * providers the document lists. Connected accounts therefore read the raw
 * document and decode the one provider they care about.
 */
let rawCatalogCache: {
  readonly raw: unknown;
  readonly offline: boolean;
} | null = null;

/** Immutable identity of the reviewed provider metadata shipped in this build. */
export function modelsDevCatalogDigest(): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(getOfflineCatalogSnapshotJson()))
    .digest("hex")}`;
}

// ─────────────── Durable discovery (H4) ────────────────
//
// The in-memory cache above is warmed only by a live discovery. A restarted
// control plane therefore knew nothing and failed every turn with "configured
// gateway model <id> has no admitted discovery record". The last successful
// result is persisted verbatim so a restart can serve it until it refreshes.

const gatewayModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  deployment: z.enum(["zen", "go"]),
  providerId: z.enum(["open_code_zen", "open_code_go"]),
  baseUrl: z.string(),
  protocol: z.enum(["chat_completions", "responses", "messages"]),
  free: z.boolean(),
  toolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  imageInput: z.boolean(),
  reasoning: z.boolean(),
  contextTokens: z.number(),
  outputTokens: z.number(),
  inputMicrosPerMillion: z.number(),
  cachedInputMicrosPerMillion: z.number(),
  outputMicrosPerMillion: z.number(),
  observedAt: z.string().min(1),
});

const providerModelsResultSchema = z.object({
  deployment: z.enum(["zen", "go"]),
  observedAt: z.string().min(1),
  models: z.array(gatewayModelSchema),
  rejected: z.array(z.object({ modelId: z.string(), reason: z.string() })),
});

/** Canonical JSON for the durable discovery row. Never contains credentials. */
export function providerModelsResultJson(result: ProviderModelsResult): string {
  return JSON.stringify({
    deployment: result.deployment,
    observedAt: result.observedAt,
    models: result.models,
    rejected: result.rejected,
  });
}

/**
 * Decode a persisted discovery row. A row that no longer matches the shape is
 * rejected rather than partially trusted: routing decisions are made from it.
 */
export function parseProviderModelsResult(json: string): ProviderModelsResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = providerModelsResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    deployment: parsed.data.deployment,
    observedAt: parsed.data.observedAt,
    models: parsed.data.models,
    rejected: parsed.data.rejected,
  };
}

/** Seed the process cache from a durable row without marking it fresh. */
export function restoreProviderModels(result: ProviderModelsResult): void {
  // `expiresAt` in the past: the record is usable for routing but a caller
  // asking for a *fresh* list still triggers discovery.
  cache = { deployment: result.deployment, result, expiresAt: 0 };
}

export function cachedProviderModels(deployment: GatewayDeployment, now: number): ProviderModelsResult | null {
  if (cache === null || cache.deployment !== deployment) return null;
  return cache.expiresAt > now ? cache.result : null;
}

/** The last discovery for this deployment, fresh or not. */
export function lastProviderModels(deployment: GatewayDeployment): ProviderModelsResult | null {
  return cache !== null && cache.deployment === deployment ? cache.result : null;
}

export function rememberProviderModels(result: ProviderModelsResult, now: number): void {
  cache = { deployment: result.deployment, result, expiresAt: now + CACHE_TTL_MS };
}

/** Test seam: discovery caches process-wide and would leak between cases. */
export function resetProviderModelsCache(): void {
  cache = null;
  catalogCache = null;
  rawCatalogCache = null;
}

/**
 * The discovered record for a configured model id, if one has been seen.
 *
 * A missing record is a fail-closed routing condition. The stored configuration
 * proves only the operator's selected id and wire protocol; it does not prove
 * that this deployment exposes the model or what capabilities it has.
 */
export function describeConfiguredModel(
  deployment: GatewayDeployment,
  modelId: string,
): GatewayModel | null {
  const known = lastProviderModels(deployment);
  return known?.models.find((model) => model.id === modelId) ?? null;
}

async function readAll(stream: AsyncIterable<string | Uint8Array>, limit: number, what: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text.length > limit) throw new Error(`${what} exceeded ${limit} bytes`);
  }
  return text + decoder.decode();
}

/**
 * Ask the gateway which models this credential can reach. An empty secret URI
 * means an explicitly anonymous request for a public Zen deployment.
 *
 * Runs through the same credential-bound connector as inference, so the bearer
 * stays inside the kernel and the path allowlist still applies.
 */
export async function fetchAvailableModels(input: {
  readonly client: CredentialBoundGatewayClient;
  readonly deployment: GatewayDeployment;
  readonly secretUri: string;
  readonly signal?: AbortSignal | null | undefined;
}): Promise<readonly { readonly id: string; readonly ownedBy: string }[]> {

  const body = await readAll(
    input.client.stream({
      url: `${GATEWAY_BASE_URLS[input.deployment]}/models`,
      method: "GET",
      headers: { accept: "application/json" },
      credentialBindingId: input.secretUri,
      authStyle: input.secretUri === "" ? "none" : "bearer",
      signal: input.signal ?? null,
    }),
    MAX_GATEWAY_LIST_BYTES,
    "gateway model list",
  );
  return parseAvailableModels(JSON.parse(body) as unknown);
}

export interface FetchModelsDevCatalogOptions {
  readonly signal?: AbortSignal | null | undefined;
  readonly timeoutMs?: number | undefined;
  readonly forceOffline?: boolean | undefined;
}

/**
 * Read the reviewed Models.dev snapshot without decoding it. Product code
 * never refreshes this through ambient TypeScript networking; updating the
 * snapshot is an explicit source and review operation.
 */
export async function fetchModelsDevRaw(
  _options?: FetchModelsDevCatalogOptions,
): Promise<{ readonly catalog: unknown; readonly offline: boolean }> {
  if (rawCatalogCache !== null) {
    return { catalog: rawCatalogCache.raw, offline: rawCatalogCache.offline };
  }
  const raw = getOfflineCatalogSnapshotJson();
  rawCatalogCache = { raw, offline: true };
  return { catalog: raw, offline: true };
}

/**
 * Decode the reviewed Models.dev catalogue shipped with this build.
 */
export async function fetchModelsDevCatalog(
  options?: FetchModelsDevCatalogOptions,
): Promise<ReturnType<typeof parseModelsDevCatalog>> {
  const now = Date.now();
  if (catalogCache !== null && catalogCache.expiresAt > now && !options?.forceOffline) {
    return catalogCache.catalog;
  }
  await fetchModelsDevRaw(options);
  const offlineCatalog = parseModelsDevCatalog(getOfflineCatalogSnapshotJson());
  // The checked-in snapshot changes only with the build. A process-local
  // cache therefore needs no wall-clock expiry or ambient refresh path.
  catalogCache = { catalog: offlineCatalog, expiresAt: Number.POSITIVE_INFINITY };
  return offlineCatalog;
}

export interface DiscoverProviderModelsInput {
  readonly client: CredentialBoundGatewayClient;
  readonly deployment: GatewayDeployment;
  readonly secretUri: string;
  readonly observedAt: string;
  readonly signal?: AbortSignal | null | undefined;
  readonly timeoutMs?: number | undefined;
  readonly forceOffline?: boolean | undefined;
}

export async function discoverProviderModels(
  input: DiscoverProviderModelsInput,
): Promise<ProviderModelsResult> {
  const catalog = await fetchModelsDevCatalog({
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    forceOffline: input.forceOffline,
  });

  const available = await fetchAvailableModels(input);
  const discovered = discoverGatewayModels({
    deployment: input.deployment,
    available,
    catalog,
    observedAt: input.observedAt,
  });
  return { ...discovered, deployment: input.deployment, observedAt: input.observedAt };
}


/**
 * The renderer's provider-neutral wire shape.
 *
 * Reasoning depth is reported as a capability, not a list of levels: the
 * gateway exposes whether a model reasons, not which budgets it accepts, and
 * inventing levels here is what a client would then present as fact.
 */
export function providerModelsWire(result: ProviderModelsResult | null, error: string | null): {
  providers: unknown[];
  models: unknown[];
  rejected: unknown[];
  observed_at: string | null;
  error: string | null;
} {
  if (result === null) {
    return { providers: [], models: [], rejected: [], observed_at: null, error };
  }
  const providerId = result.models[0]?.providerId
    ?? (result.deployment === "zen" ? "open_code_zen" : "open_code_go");
  return {
    providers: [{
      id: providerId,
      label: result.deployment === "zen" ? "OpenCode Zen" : "OpenCode Go",
      mark: "OC",
      available: true,
      // Account facts, so a client decodes one provider shape whether or not
      // this installation has run connected-account discovery yet.
      source: "zen",
      billing: result.models.every((model) => model.free) ? "free" : "paid",
      is_default: true,
    }],
    models: result.models.map(modelWire),
    rejected: result.rejected.map((entry) => ({ model_id: entry.modelId, reason: entry.reason })),
    observed_at: result.observedAt,
    error,
  };
}

function modelWire(model: GatewayModel): Record<string, unknown> {
  return {
    id: model.id,
    provider: model.providerId,
    label: model.name,
    slug: model.id,
    free: model.free,
    reasoning: model.reasoning,
    context_tokens: model.contextTokens,
    output_tokens: model.outputTokens,
    tool_calling: model.toolCalling,
    structured_output: model.structuredOutput,
    image_input: model.imageInput,
    input_micros_per_million: model.inputMicrosPerMillion,
    output_micros_per_million: model.outputMicrosPerMillion,
    // Cache reads are billed at a fraction of fresh input; a consumer without
    // this number has to assume they cost full price.
    cached_input_micros_per_million: model.cachedInputMicrosPerMillion,
    // USD micros per million tokens, under the names the composer reads.
    input_cost_micros: model.inputMicrosPerMillion,
    output_cost_micros: model.outputMicrosPerMillion,
    // The gateway is metered per token, so the rates above are the price.
    // Stated the same way the account inventory states it, so one consumer
    // reads one shape.
    pricing: {
      input_micros_per_million: model.inputMicrosPerMillion,
      cached_input_micros_per_million: model.cachedInputMicrosPerMillion,
      output_micros_per_million: model.outputMicrosPerMillion,
    },
    pricing_source: "catalog",
    // The gateway reports whether a model reasons, not which budgets it
    // accepts, so there are no levels to advertise here.
    reasoning_efforts: [],
    default_reasoning_effort: "",
  };
}
