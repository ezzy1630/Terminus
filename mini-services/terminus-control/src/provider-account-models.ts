/**
 * Terminus Control — per-account model discovery.
 *
 * Terminus does not know what models exist; the account does. Three sources,
 * one per render profile, because none of them generalises:
 *
 *   - `openai_compatible` / `openai_responses` / `anthropic_messages`: the
 *     models.dev catalogue for the account's vendor. It is the only place that
 *     knows context windows, tool-calling and price, and the account's own
 *     `/models` (when it has one) reports ids and nothing else. A best-effort
 *     `GET {base_url}/models` therefore proves reachability, not identity.
 *   - `chatgpt_codex`: the Codex catalogue, which is authoritative about
 *     per-model reasoning levels and hidden slugs and appears in no public
 *     catalogue at all.
 *   - `zen_gateway`: the existing gateway discovery, unchanged.
 *
 * The result is persisted per account (`provider_account_model_discoveries`)
 * so a restart routes without a network round trip, exactly as the gateway
 * discovery already does. It contains model identity and capability metadata
 * only — never credential material.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Micros, Rfc3339Timestamp } from "@terminus/domain";
import type { ProviderCapabilitySnapshot } from "@terminus/provider-core";
import type { CredentialBoundGatewayClient, GatewayModel, GatewayProtocol } from "@terminus/provider-zen";
import { ProviderTransportError } from "./providers/provider-retry.js";
import {
  CODEX_BASE_URL,
  decodeModelsDevProvider,
  type ProviderAccountRecord,
  type ProviderRenderProfile,
} from "./provider-accounts.js";

/** Pinned by the Codex catalogue endpoint; it is a required query parameter. */
export const CODEX_CLIENT_VERSION = "0.150.1";
export const CODEX_MODELS_URL = `${CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`;

const MAX_CATALOG_BYTES = 1 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 3_000;

export interface ProviderAccountModel {
  readonly id: string;
  readonly name: string;
  readonly free: boolean;
  readonly reasoning: boolean;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly imageInput: boolean;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly inputMicrosPerMillion: number;
  readonly cachedInputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  /** Levels this model accepts, as the source names them. Empty when unknown. */
  readonly reasoningEfforts: readonly string[];
  readonly defaultReasoningEffort: string | null;
  readonly supportsParallelToolCalls: boolean;
  readonly supportsReasoningSummaries: boolean;
}

/**
 * Terminus efforts, weakest first. A provider names its own levels (`minimal`,
 * `xhigh`, `ultra`, …); the picker offers these four, so a level is folded onto
 * the nearest one rather than shown raw.
 */
export const TERMINUS_REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;
export type TerminusReasoningEffort = (typeof TERMINUS_REASONING_EFFORTS)[number];

/** The effort ladder for a reasoning model whose catalogue names no levels. */
const CATALOGUE_REASONING_EFFORTS = ["low", "medium", "high"] as const;

/**
 * Fold one provider level onto a Terminus effort.
 *
 * Returns null for a level with no equivalent, so an unrecognised name is
 * dropped from the picker instead of being offered and then rejected by the
 * provider.
 */
export function foldReasoningEffort(level: string): TerminusReasoningEffort | null {
  switch (level.trim().toLowerCase()) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "default":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "x-high":
    case "extra_high":
    case "ultra":
    case "max":
      return "max";
    default:
      return null;
  }
}

/** Fold a provider's level list into ordered, deduplicated Terminus efforts. */
export function foldReasoningEfforts(levels: readonly string[]): readonly TerminusReasoningEffort[] {
  const folded = new Set<TerminusReasoningEffort>();
  for (const level of levels) {
    const effort = foldReasoningEffort(level);
    if (effort !== null) folded.add(effort);
  }
  return TERMINUS_REASONING_EFFORTS.filter((effort) => folded.has(effort));
}

export interface RejectedProviderAccountModel {
  readonly modelId: string;
  readonly reason: string;
}

export interface ProviderAccountModelsResult {
  readonly accountId: string;
  readonly observedAt: string;
  readonly models: readonly ProviderAccountModel[];
  readonly rejected: readonly RejectedProviderAccountModel[];
  /** Null when no reachability probe ran for this profile. */
  readonly reachable: boolean | null;
  readonly reachabilityDetail: string;
}

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  free: z.boolean(),
  reasoning: z.boolean(),
  toolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  imageInput: z.boolean(),
  contextTokens: z.number(),
  outputTokens: z.number(),
  inputMicrosPerMillion: z.number(),
  cachedInputMicrosPerMillion: z.number(),
  outputMicrosPerMillion: z.number(),
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string().nullable(),
  supportsParallelToolCalls: z.boolean(),
  supportsReasoningSummaries: z.boolean(),
});

const resultSchema = z.object({
  accountId: z.string().min(1),
  observedAt: z.string().min(1),
  models: z.array(modelSchema),
  rejected: z.array(z.object({ modelId: z.string(), reason: z.string() })),
  reachable: z.boolean().nullable().default(null),
  reachabilityDetail: z.string().default(""),
});

/** Canonical JSON for the durable row. Never contains credentials. */
export function providerAccountModelsJson(result: ProviderAccountModelsResult): string {
  return JSON.stringify({
    accountId: result.accountId,
    observedAt: result.observedAt,
    models: result.models,
    rejected: result.rejected,
    reachable: result.reachable,
    reachabilityDetail: result.reachabilityDetail,
  });
}

/**
 * Decode a persisted row. A row that no longer matches the shape is rejected
 * rather than partially trusted: routing decisions are made from it.
 */
export function parseProviderAccountModels(json: string): ProviderAccountModelsResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ────────────────────────── models.dev catalogue ─────────────────────────────

/**
 * The account's models, as the public catalogue describes them.
 *
 * Deprecated entries are rejected rather than listed: the provider has said it
 * is going away, and a picker that offers it is offering a future failure.
 */
export function modelsFromCatalog(input: {
  readonly vendorId: string;
  readonly catalog: unknown;
  /**
   * The account's render profile. All three catalogue-backed profiles carry a
   * reasoning-depth control (`reasoning_effort`, `reasoning.effort`, or a
   * thinking budget), so a model models.dev marks `reasoning` gets the standard
   * ladder; a profile with no depth control gets none.
   */
  readonly renderProfile?: ProviderRenderProfile | undefined;
}): { readonly models: readonly ProviderAccountModel[]; readonly rejected: readonly RejectedProviderAccountModel[] } {
  const provider = decodeModelsDevProvider(input.catalog, input.vendorId);
  if (provider === null) {
    return { models: [], rejected: [{ modelId: input.vendorId, reason: `models.dev has no provider '${input.vendorId}'` }] };
  }
  const models: ProviderAccountModel[] = [];
  const rejected: RejectedProviderAccountModel[] = [];
  const profile = input.renderProfile ?? "openai_compatible";
  const depthControlled = profile === "openai_compatible"
    || profile === "openai_responses"
    || profile === "anthropic_messages";
  for (const model of provider.models) {
    if (model.status === "deprecated") {
      rejected.push({ modelId: model.id, reason: "models.dev marks the model deprecated" });
      continue;
    }
    models.push({
      id: model.id,
      name: model.name,
      free: model.inputCost === 0 && model.outputCost === 0,
      reasoning: model.reasoning,
      toolCalling: model.toolCall,
      structuredOutput: model.structuredOutput,
      imageInput: model.imageInput,
      contextTokens: model.contextTokens,
      outputTokens: model.outputTokens,
      inputMicrosPerMillion: dollarsToMicros(model.inputCost),
      cachedInputMicrosPerMillion: dollarsToMicros(model.cachedInputCost),
      outputMicrosPerMillion: dollarsToMicros(model.outputCost),
      // models.dev reports *that* a model reasons, never which budgets it
      // takes. All three catalogue-backed profiles expose the same three rungs,
      // so a reasoning model gets those and nothing finer — `max` is absent
      // because no catalogue claims a level above `high` for these models.
      reasoningEfforts: model.reasoning && depthControlled ? [...CATALOGUE_REASONING_EFFORTS] : [],
      defaultReasoningEffort: model.reasoning && depthControlled ? "medium" : null,
      supportsParallelToolCalls: false,
      supportsReasoningSummaries: false,
    });
  }
  return {
    models: models.sort((left, right) => left.id.localeCompare(right.id)),
    rejected: rejected.sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
}

// ────────────────────────── Codex catalogue ──────────────────────────────────

/**
 * Decode `GET /backend-api/codex/models`.
 *
 * `visibility` other than `list` marks a slug the endpoint answers for but
 * does not offer (`gpt-reserve`, `codex-auto-review`); they are rejected with
 * that reason rather than hidden without one.
 */
export function decodeCodexCatalog(raw: unknown): {
  readonly models: readonly ProviderAccountModel[];
  readonly rejected: readonly RejectedProviderAccountModel[];
} {
  if (!isRecord(raw) || !Array.isArray(raw.models)) {
    throw new Error("Codex model catalogue must be an object with a models array");
  }
  let reportedShape = false;
  const models: ProviderAccountModel[] = [];
  const rejected: RejectedProviderAccountModel[] = [];
  for (const entry of raw.models) {
    if (!isRecord(entry)) continue;
    const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (slug === "") continue;
    if (entry.visibility !== "list") {
      rejected.push({
        modelId: slug,
        reason: `the Codex catalogue marks the model ${typeof entry.visibility === "string" ? entry.visibility : "hidden"}`,
      });
      continue;
    }
    const levels = codexReasoningLevels(entry);
    if (levels.length === 0 && !reportedShape) {
      // The first live catalogue answered with entries this decoder could not
      // read, and an empty effort list is indistinguishable from "this model
      // does not reason". Name the keys once so the shape is not guessed twice.
      reportedShape = true;
      console.warn(
        `[terminus-control] Codex catalogue entry for ${slug} exposed no reasoning levels; keys: ${Object.keys(entry).sort().join(", ")}`,
      );
    }
    models.push({
      id: slug,
      name: typeof entry.display_name === "string" && entry.display_name.trim() !== "" ? entry.display_name : slug,
      // A subscription turn costs no micros. The quota window, not a price,
      // is what limits it.
      free: false,
      reasoning: levels.length > 0 || entry.supports_reasoning_summaries === true,
      toolCalling: true,
      structuredOutput: true,
      imageInput: Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image"),
      contextTokens: positiveInteger(entry.context_window),
      outputTokens: 0,
      inputMicrosPerMillion: 0,
      cachedInputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      reasoningEfforts: levels,
      defaultReasoningEffort: codexDefaultReasoningLevel(entry, levels),
      supportsParallelToolCalls: entry.supports_parallel_tool_calls === true,
      supportsReasoningSummaries: entry.supports_reasoning_summaries === true,
    });
  }
  return {
    models: models.sort((left, right) => left.id.localeCompare(right.id)),
    rejected: rejected.sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
}

// ────────────────────────── Discovery ────────────────────────────────────────

export interface DiscoverAccountModelsInput {
  readonly account: ProviderAccountRecord;
  readonly client: CredentialBoundGatewayClient;
  readonly observedAt: string;
  /** The raw models.dev document, for catalogue-backed profiles. */
  readonly catalog?: unknown;
  /** Extra request headers the account's connector admits (Codex identity). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | null | undefined;
  /** Zen keeps its existing discovery; the caller supplies it. */
  readonly discoverZen?: (() => Promise<{
    readonly models: readonly GatewayModel[];
    readonly rejected: readonly { readonly modelId: string; readonly reason: string }[];
  }>) | undefined;
}

export async function discoverAccountModels(
  input: DiscoverAccountModelsInput,
): Promise<ProviderAccountModelsResult> {
  const profile = input.account.renderProfile as ProviderRenderProfile;
  if (profile === "zen_gateway") {
    if (input.discoverZen === undefined) {
      throw new Error("zen account discovery requires the gateway discovery function");
    }
    const discovered = await input.discoverZen();
    return {
      accountId: input.account.id,
      observedAt: input.observedAt,
      models: discovered.models.map(fromGatewayModel),
      rejected: discovered.rejected,
      reachable: true,
      reachabilityDetail: "",
    };
  }

  if (profile === "chatgpt_codex") {
    const body = await readAll(
      input.client.stream({
        url: CODEX_MODELS_URL,
        method: "GET",
        headers: { accept: "application/json", ...(input.headers ?? {}) },
        credentialBindingId: input.account.credentialUri,
        authStyle: input.account.credentialUri === "" ? "none" : "bearer",
        signal: input.signal ?? null,
      }),
      MAX_CATALOG_BYTES,
      "Codex model catalogue",
    );
    const decoded = decodeCodexCatalog(JSON.parse(body) as unknown);
    return {
      accountId: input.account.id,
      observedAt: input.observedAt,
      models: decoded.models,
      rejected: decoded.rejected,
      reachable: true,
      reachabilityDetail: "",
    };
  }

  const catalogued = modelsFromCatalog({
    vendorId: input.account.vendorId,
    catalog: input.catalog,
    renderProfile: profile,
  });
  const probe = await probeAccountModels(input);
  return {
    accountId: input.account.id,
    observedAt: input.observedAt,
    models: catalogued.models,
    rejected: catalogued.rejected,
    reachable: probe.reachable,
    reachabilityDetail: probe.detail,
  };
}

/**
 * Best-effort reachability check.
 *
 * A failure here does not demote the account: an endpoint without a `/models`
 * route, or one that is briefly down, still routes a turn. The reason is
 * recorded so an operator can see why `last_verified_at` did not move.
 */
async function probeAccountModels(
  input: DiscoverAccountModelsInput,
): Promise<{ readonly reachable: boolean | null; readonly detail: string }> {
  if (input.account.baseUrl === "") return { reachable: null, detail: "" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await readAll(
      input.client.stream({
        url: `${input.account.baseUrl}/models`,
        method: "GET",
        headers: { accept: "application/json", ...(input.headers ?? {}) },
        credentialBindingId: input.account.credentialUri,
        authStyle: input.account.credentialUri === "" ? "none" : "bearer",
        signal: controller.signal,
      }),
      MAX_CATALOG_BYTES,
      "account model list",
    );
    return { reachable: true, detail: "" };
  } catch (error: unknown) {
    return { reachable: false, detail: probeFailureDetail(error) };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

// ────────────────────────── Projection ───────────────────────────────────────

/**
 * Why a probe did not confirm the endpoint, in one short clause.
 *
 * Deliberately carries no URL: an account's base URL can embed its own account
 * id (Cloudflare's is `/accounts/<id>/ai/v1`), and this string is shown in
 * Settings and stored in `status_detail`. It is also not a failure the user
 * must act on — most of these endpoints simply have no `/models` route, and
 * the models.dev catalogue is the source of identity either way.
 */
function probeFailureDetail(error: unknown): string {
  const status = error instanceof ProviderTransportError ? error.status : null;
  if (status === null) return "model probe did not complete; using the models.dev catalogue";
  const unsupported = status === 400 || status === 404 || status === 405 || status === 501;
  return `model probe ${unsupported ? "unsupported" : "failed"} (HTTP ${status}); using the models.dev catalogue`;
}

/**
 * The transport-level model for one account model.
 *
 * `GatewayTransport`/`GatewayRenderer` already take a base URL and protocol
 * per model, so a connected account reuses them rather than growing a second
 * chat-completions transport. `providerId` is the account, which is what the
 * attempt ledger records.
 */
export function toGatewayModel(input: {
  readonly account: ProviderAccountRecord;
  readonly model: ProviderAccountModel;
  readonly providerId: string;
  readonly observedAt: string;
}): GatewayModel {
  return {
    id: input.model.id,
    name: input.model.name,
    // The deployment field only means something for Zen; it is carried so the
    // shared transport type stays one type.
    deployment: "zen",
    providerId: input.providerId,
    baseUrl: input.account.baseUrl,
    protocol: input.account.protocol as GatewayProtocol,
    free: input.model.free,
    toolCalling: input.model.toolCalling,
    structuredOutput: input.model.structuredOutput,
    imageInput: input.model.imageInput,
    reasoning: input.model.reasoning,
    contextTokens: input.model.contextTokens,
    outputTokens: input.model.outputTokens,
    inputMicrosPerMillion: input.model.inputMicrosPerMillion,
    cachedInputMicrosPerMillion: input.model.cachedInputMicrosPerMillion,
    outputMicrosPerMillion: input.model.outputMicrosPerMillion,
    observedAt: input.observedAt,
  };
}

/**
 * The capability snapshot for one account model.
 *
 * Mirrors the gateway and direct snapshots so budget, policy and context
 * decisions downstream need no special case for an account.
 *
 * `workspaceAccess` is the caller's decision, not this module's: the shared
 * free gateway carries an explicit privacy admission, while a credential the
 * user already uses with that vendor from their own CLI does not.
 */
export function providerAccountCapabilitySnapshot(input: {
  readonly account: ProviderAccountRecord;
  readonly model: ProviderAccountModel;
  readonly providerId: string;
  readonly observedAt: Rfc3339Timestamp;
  readonly workspaceAccess: boolean;
}): ProviderCapabilitySnapshot {
  const profile = input.account.renderProfile as ProviderRenderProfile;
  const protocol = input.account.protocol as GatewayProtocol;
  const digest = createHash("sha256")
    .update(JSON.stringify({
      account: input.account.source,
      revision: input.account.revision,
      model: input.model,
    }), "utf8")
    .digest("hex");
  // ChatGPT Codex rejects `store: true`, so the endpoint keeps nothing to
  // continue from even though the protocol is Responses: every turn replays
  // its own prefix.
  const nativeContinuation = protocol === "responses" && profile !== "chatgpt_codex";
  return {
    providerId: input.providerId,
    observedAt: input.observedAt,
    source: `terminus-control/provider-account-v1:${digest}`,
    context: {
      advertisedTokens: input.model.contextTokens,
      testedSafeTokens: Math.min(input.model.contextTokens, 32_768),
      roleSupport: protocol === "messages"
        ? ["system", "user", "assistant", "tool"]
        : ["system", "user", "assistant", "tool", "developer"],
      imageInput: input.model.imageInput,
      toolCalling: input.model.toolCalling,
      parallelToolCalls: input.model.supportsParallelToolCalls,
      structuredOutput: input.model.structuredOutput,
    },
    continuation: {
      nativeId: nativeContinuation,
      crossRequest: nativeContinuation,
      compaction: true,
      compatibilityKey: `account-${input.account.source}-${protocol}-${input.model.id}`,
    },
    caching: protocol === "messages"
      ? { mode: "explicit_breakpoints", exactPrefixRequired: true, minimumTokens: 2_048, ttlOptions: [], toolOrderSensitive: true, usageReporting: true }
      : { mode: "automatic_prefix", exactPrefixRequired: false, minimumTokens: 1_024, ttlOptions: [], toolOrderSensitive: true, usageReporting: true },
    reasoning: {
      supported: input.model.reasoning,
      budgetControl: input.model.reasoningEfforts.length > 0,
      summaryAvailable: input.model.supportsReasoningSummaries,
    },
    economics: {
      inputMicrosPerMillion: BigInt(input.model.inputMicrosPerMillion) as Micros,
      cachedInputMicrosPerMillion: BigInt(input.model.cachedInputMicrosPerMillion) as Micros,
      outputMicrosPerMillion: BigInt(input.model.outputMicrosPerMillion) as Micros,
      reasoningAccounting: input.model.reasoning,
    },
    reliability: { toolCallSuccess: 0, structuredOutputSuccess: 0, editCohortSuccess: 0, latencyPercentiles: { p50: 0, p99: 0 } },
    policy: {
      allowedConfidentiality: input.workspaceAccess ? ["public", "workspace"] : ["public"],
      retentionMode: "provider_managed",
      region: null,
    },
  };
}

function fromGatewayModel(model: GatewayModel): ProviderAccountModel {
  return {
    id: model.id,
    name: model.name,
    free: model.free,
    reasoning: model.reasoning,
    toolCalling: model.toolCalling,
    structuredOutput: model.structuredOutput,
    imageInput: model.imageInput,
    contextTokens: model.contextTokens,
    outputTokens: model.outputTokens,
    inputMicrosPerMillion: model.inputMicrosPerMillion,
    cachedInputMicrosPerMillion: model.cachedInputMicrosPerMillion,
    outputMicrosPerMillion: model.outputMicrosPerMillion,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    supportsParallelToolCalls: false,
    supportsReasoningSummaries: false,
  };
}

// ────────────────────────── Wire ─────────────────────────────────────────────

export interface ProviderAccountModelsWireEntry {
  readonly account: ProviderAccountRecord;
  readonly result: ProviderAccountModelsResult | null;
}

/**
 * The provider-neutral inventory the composer decodes.
 *
 * Every model row belongs to exactly one account, and `provider` is that
 * account's id — the desktop groups on it and sends it back as
 * `provider_account_id`, so an inventory entry and a routing decision name the
 * same thing.
 */
export function providerAccountModelsWire(
  entries: readonly ProviderAccountModelsWireEntry[],
  error: string | null,
): {
  providers: unknown[];
  models: unknown[];
  rejected: unknown[];
  observed_at: string | null;
  error: string | null;
} {
  const providers = entries.map(({ account, result }) => {
    const available = account.status === "connected";
    return {
      id: account.id,
      label: account.displayName,
      mark: accountMark(account.displayName, account.vendorId),
      available,
      // Only an account a client cannot use carries a reason. A connected
      // account's `status_detail` is an observation (a probe note, a quota
      // window), and presenting it as "unavailable because …" is a lie.
      ...(available || account.statusDetail === ""
        ? {}
        : { unavailable_reason: account.statusDetail }),
      source: account.source,
      billing: account.billing,
      is_default: account.isDefault,
      model_count: result?.models.length ?? 0,
    };
  });
  const models = entries.flatMap(({ account, result }) =>
    (result?.models ?? []).map((model) => ({
      id: model.id,
      provider: account.id,
      slug: model.id,
      label: model.name,
      free: model.free,
      reasoning: model.reasoning,
      context_tokens: model.contextTokens,
      output_tokens: model.outputTokens,
      tool_calling: model.toolCalling,
      structured_output: model.structuredOutput,
      image_input: model.imageInput,
      billing: account.billing,
      // Levels this exact model accepts, as its own catalogue names them.
      // Empty means the source reports reasoning as a yes/no capability and
      // never said which budgets it takes; the picker then offers none rather
      // than four Terminus invented.
      // Folded onto the four efforts the picker offers. The raw provider level
      // stays on the stored record, because that is what the renderer sends.
      reasoning_efforts: [...foldReasoningEfforts(model.reasoningEfforts)],
      default_reasoning_effort: model.defaultReasoningEffort === null
        ? ""
        : foldReasoningEffort(model.defaultReasoningEffort) ?? "",
      // USD micros per million tokens. A subscription account has no
      // per-token price at all, so the fields are absent rather than zero —
      // "$0.00/M" would be a claim about a plan Terminus cannot see.
      ...(account.billing === "subscription"
        ? {}
        : {
            input_cost_micros: model.inputMicrosPerMillion,
            output_cost_micros: model.outputMicrosPerMillion,
            input_micros_per_million: model.inputMicrosPerMillion,
            output_micros_per_million: model.outputMicrosPerMillion,
          }),
    })),
  );
  const rejected = entries.flatMap(({ account, result }) =>
    (result?.rejected ?? []).map((entry) => ({
      provider: account.id,
      model_id: entry.modelId,
      reason: entry.reason,
    })),
  );
  const observedAt = entries
    .map(({ result }) => result?.observedAt ?? null)
    .filter((value): value is string => value !== null)
    .sort()
    .pop() ?? null;
  return { providers, models, rejected, observed_at: observedAt, error };
}

/**
 * Two letters, derived rather than bundled: Terminus ships no third-party
 * artwork, and an account discovered at runtime has none to ship anyway.
 */
export function accountMark(label: string, fallback: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const initials = words.length >= 2
    ? `${words[0]![0]!}${words[1]![0]!}`
    : (words[0] ?? fallback).slice(0, 2);
  return (initials || fallback.slice(0, 2)).toUpperCase();
}

// ────────────────────────── Helpers ──────────────────────────────────────────

/**
 * The reasoning levels one Codex catalogue entry advertises.
 *
 * The live catalogue does not answer with a plain string array: an entry is an
 * object naming the level plus its own metadata, and the key it uses has
 * changed across client versions. Both encodings and every key that has been
 * observed are accepted, because the alternative is silently reporting a
 * reasoning model as one that does not reason.
 */
function codexReasoningLevels(entry: Readonly<Record<string, unknown>>): readonly string[] {
  const raw = firstArray(entry, [
    "supported_reasoning_levels",
    "supported_reasoning_efforts",
    "reasoning_levels",
    "reasoning_efforts",
  ]);
  const levels: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && value.trim() !== "") {
      levels.push(value.trim());
      continue;
    }
    if (!isRecord(value)) continue;
    for (const key of ["effort", "level", "slug", "value", "id", "name"]) {
      const named = value[key];
      if (typeof named === "string" && named.trim() !== "") {
        levels.push(named.trim());
        break;
      }
    }
  }
  return [...new Set(levels)];
}

/** The entry's default level, kept only when the model actually advertises it. */
function codexDefaultReasoningLevel(
  entry: Readonly<Record<string, unknown>>,
  levels: readonly string[],
): string | null {
  for (const key of ["default_reasoning_level", "default_reasoning_effort"]) {
    const value = entry[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const normalized = value.trim();
    // A default the model does not list is a catalogue inconsistency; sending
    // it back would be a 400. Fall through to the advertised list.
    if (levels.length === 0 || levels.includes(normalized)) return normalized;
  }
  return levels.includes("medium") ? "medium" : levels[0] ?? null;
}

function firstArray(
  entry: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): readonly unknown[] {
  for (const key of keys) {
    const value = entry[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

async function readAll(
  stream: AsyncIterable<string | Uint8Array>,
  limit: number,
  what: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (text.length > limit) throw new Error(`${what} exceeded ${limit} bytes`);
  }
  return text + decoder.decode();
}

function dollarsToMicros(value: number): number {
  return Math.round(value * 1_000_000);
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
