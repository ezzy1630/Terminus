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
 * an operator hand-typed into the gateway configuration, which is why
 * `configuredGatewayModel` still has to assert `reasoning: false` and a
 * 32k context for any model it has not discovered.
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
import type { CredentialBoundGatewayClient } from "@terminus/provider-zen";

const MODELS_DEV_HOST = "models.dev";
const MODELS_DEV_URL = `https://${MODELS_DEV_HOST}/api.json`;
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
}

/**
 * The discovered record for a configured model id, if one has been seen.
 *
 * Without this the turn path builds its capability snapshot from
 * `configuredGatewayModel`, which can only assert conservative placeholders —
 * `reasoning: false`, a 32k window, zero cost — because the stored
 * configuration holds nothing else. Those values reach the context compiler
 * and the economics ledger, so a discovered record is strictly better than a
 * guess whenever one exists.
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
 * Ask the gateway which models this credential can reach.
 *
 * Runs through the same credential-bound connector as inference, so the bearer
 * stays inside the kernel and the path allowlist still applies.
 */
export async function fetchAvailableModels(input: {
  readonly client: CredentialBoundGatewayClient;
  readonly deployment: GatewayDeployment;
  readonly secretUri: string;
  readonly signal?: AbortSignal | null;
}): Promise<readonly { readonly id: string; readonly ownedBy: string }[]> {
  const body = await readAll(
    input.client.stream({
      url: `${GATEWAY_BASE_URLS[input.deployment]}/models`,
      method: "GET",
      headers: { accept: "application/json" },
      credentialBindingId: input.secretUri,
      authStyle: "bearer",
      signal: input.signal ?? null,
    }),
    MAX_GATEWAY_LIST_BYTES,
    "gateway model list",
  );
  return parseAvailableModels(JSON.parse(body) as unknown);
}

/**
 * Fetch the public Models.dev catalogue.
 *
 * No credential is attached — this is open data, and binding it to the
 * OpenCode connector would send that bearer to a third-party host. A kernel
 * destination decision is not an HTTP response, so this remains fail-closed
 * until a bounded public-fetch connector exists.
 */
export async function fetchModelsDevCatalog(): Promise<ReturnType<typeof parseModelsDevCatalog>> {
  throw new Error(
    `Models.dev catalogue discovery is unavailable: ${MODELS_DEV_URL} requires a kernel-owned bounded public-fetch connector`,
  );
}

export async function discoverProviderModels(input: {
  readonly client: CredentialBoundGatewayClient;
  readonly deployment: GatewayDeployment;
  readonly secretUri: string;
  readonly observedAt: string;
  readonly signal?: AbortSignal | null;
}): Promise<ProviderModelsResult> {
  // Both sources are needed for a usable answer, so they are fetched together
  // and a failure in either fails the discovery rather than returning a
  // half-described catalogue.
  const [available, catalog] = await Promise.all([
    fetchAvailableModels(input),
    fetchModelsDevCatalog(),
  ]);
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
  };
}
