/**
 * @terminus/provider-core — provider-neutral broker contracts.
 *
 * Per SPEC §15 and §38: `Provider`, `ProviderRenderer`, capability snapshots,
 * request/response shapes, usage/cost records, continuation decisions,
 * confidentiality policy enforcement, cost accounting. No network calls —
 * adapters handle the wire.
 */
import { z } from "zod";
import type {
  ModelKey,
  ContentHash,
  ConfidentialityLabel,
  Micros,
  TokenCount,
  Uuid7,
} from "@terminus/domain";
import { CompilationAuthorityError } from "@terminus/domain";
import type { ContextFragment, ContextManifest } from "@terminus/context-ir";
import type { ReasoningReplayEntry } from "./reasoning_replay.js";

// ────────────────────────── Capability snapshots (§38.2) ─────────────────────

export interface ContextWindow {
  readonly advertisedTokens: number;
  readonly testedSafeTokens: number;
  /**
   * The largest single response this model will produce, from the catalogue's
   * `limit.output` or the family ceiling (`resolveMaxOutputTokens`). Optional
   * because snapshots built before this field existed omit it; a consumer that
   * reads it must supply its own fallback.
   */
  readonly maxOutputTokens?: number | undefined;
  readonly roleSupport: readonly string[];
  readonly imageInput: boolean;
  readonly toolCalling: boolean;
  readonly parallelToolCalls: boolean;
  readonly structuredOutput: boolean;
}

export interface ContinuationProfile {
  readonly nativeId: boolean;
  readonly crossRequest: boolean;
  readonly compaction: boolean;
  readonly compatibilityKey: string;
}

export interface CachingProfile {
  readonly mode: "none" | "automatic_prefix" | "explicit_breakpoints" | "explicit_resource";
  readonly exactPrefixRequired: boolean;
  readonly minimumTokens: number;
  readonly ttlOptions: readonly string[];
  readonly toolOrderSensitive: boolean;
  readonly usageReporting: boolean;
}

export interface ReasoningProfile {
  readonly supported: boolean;
  readonly budgetControl: boolean;
  readonly summaryAvailable: boolean;
}

export interface ProviderEconomics {
  readonly inputMicrosPerMillion: Micros;
  readonly cachedInputMicrosPerMillion: Micros;
  /** Defaults to the ordinary input rate when the provider has no write surcharge. */
  readonly cacheWriteMicrosPerMillion?: Micros | undefined;
  readonly outputMicrosPerMillion: Micros;
  readonly reasoningAccounting: boolean;
}

export interface ProviderReliability {
  readonly toolCallSuccess: number;
  readonly structuredOutputSuccess: number;
  readonly editCohortSuccess: number;
  readonly latencyPercentiles: Readonly<Record<string, number>>;
}

export interface ProviderPolicy {
  readonly allowedConfidentiality: readonly ConfidentialityLabel[];
  readonly retentionMode: string;
  readonly region: string | null;
}

export interface ProviderCapabilitySnapshot {
  readonly providerId: string;
  readonly observedAt: string;
  readonly source: string;
  readonly context: ContextWindow;
  readonly continuation: ContinuationProfile;
  readonly caching: CachingProfile;
  readonly reasoning: ReasoningProfile;
  readonly economics: ProviderEconomics;
  readonly reliability: ProviderReliability;
  readonly policy: ProviderPolicy;
}

export interface ModelCapabilitySnapshot {
  readonly modelKey: ModelKey;
  readonly providerId: string;
  readonly snapshot: ProviderCapabilitySnapshot;
  readonly observedAt: string;
}

// ────────────────────────── Provider request/response ────────────────────────

export interface ProviderToolSchema {
  readonly id: string;
  readonly version: string;
  readonly summary: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly resultSchema: Readonly<Record<string, unknown>>;
  readonly sideEffectClass: string;
  readonly requiredCapabilities: readonly string[];
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
  readonly maximumModelResultBytes: number;
  readonly maximumArtifactBytes: number;
  readonly defaultTimeoutMs: number;
  readonly policyTags: readonly string[];
}

export interface ProviderRenderedBlock {
  readonly role: "system" | "user" | "assistant" | "tool" | "developer";
  readonly content: string;
  readonly artifactHash: ContentHash;
  readonly cacheBreakpoint: boolean;
  readonly confidentiality: ConfidentialityLabel;
}

export interface ProviderRequest {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly blocks: readonly ProviderRenderedBlock[];
  readonly toolSchemas: readonly ProviderToolSchema[];
  readonly continuationId: string | null;
  readonly cachePlan: {
    readonly stablePrefixHash: ContentHash;
    readonly breakpoints: readonly number[];
  };
  readonly outputProfile: "terse" | "explanatory" | "teaching" | "structured";
  readonly reasoningReserveTokens: TokenCount;
  readonly outputReserveTokens: TokenCount;
  readonly hardInputLimit: TokenCount;
  readonly signal: AbortSignal | null;
}

export interface ProviderToolCallChunk {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Canonical durable transcript for a provider-emitted tool invocation. */
export const providerToolCallTranscriptSchema = z.object({
  protocol: z.literal("terminus.tool-call.v1"),
  provider_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

/** Canonical durable transcript for the matching settled tool result. */
export const providerToolResultTranscriptSchema = z.object({
  protocol: z.literal("terminus.tool-result.v1"),
  provider_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  result: z.record(z.string(), z.unknown()),
}).strict();

export type ProviderToolCallTranscript = z.infer<typeof providerToolCallTranscriptSchema>;
export type ProviderToolResultTranscript = z.infer<typeof providerToolResultTranscriptSchema>;

/**
 * One opaque reasoning item the provider emitted and expects back verbatim.
 *
 * OpenAI's Responses API with `store: false` keeps nothing server-side, so the
 * only way a reasoning chain survives a tool round trip is for the client to
 * replay the encrypted item immediately before the message or function call it
 * produced (`include: ["reasoning.encrypted_content"]`). Anthropic's thinking
 * blocks work the same way through `signature`. The payload is never read or
 * rewritten here — it is a provider-owned blob carried unchanged.
 */
export interface ProviderReasoningItem {
  /** The provider's own item id (`rs_…`), replayed with the item. */
  readonly id: string;
  /** The opaque payload: OpenAI `encrypted_content`, Anthropic `signature`. */
  readonly encryptedContent: string;
  /** Human-readable summary parts, when the provider returned any. */
  readonly summary: readonly string[];
}

export interface ProviderResponseChunk {
  readonly kind: "text" | "tool_call" | "error" | "done";
  readonly text?: string | undefined;
  readonly toolCall?: ProviderToolCallChunk | undefined;
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly usage?: UsageRecord | undefined;
  readonly continuationId?: string | undefined;
  /** Provider-native request/response identifier, when exposed by the stream. */
  readonly providerRequestId?: string | undefined;
  readonly reasoning?: string | undefined;
  /**
   * A completed reasoning item, in wire order relative to the tool call or
   * message it precedes. Carried on a `text` chunk so no consumer has to learn
   * a fifth chunk kind; consumers that only read `text`/`reasoning` ignore it.
   */
  readonly reasoningItem?: ProviderReasoningItem | undefined;
  /** The provider's own terminal stop reason, verbatim (e.g. `refusal`). */
  readonly stopReason?: string | undefined;
  /** Why the provider stopped, when it explained (Anthropic `stop_details`). */
  readonly stopDetail?: string | undefined;
}

export interface ProjectedResponse {
  readonly text: string;
  readonly toolCalls: readonly ProviderToolCallChunk[];
  readonly reasoning: string | null;
  readonly continuationId: string | null;
  /**
   * `refusal` is a *successful* HTTP 200 on Anthropic's current models: a
   * safety classifier declined the request and `content` is not an answer.
   * It is a distinct terminal state — never retry it, never read the text as
   * a result — which is why it is its own kind rather than `error`.
   */
  readonly finishReason: "stop" | "tool_use" | "length" | "error" | "cancelled" | "refusal";
  /** The provider's explanation when `finishReason` is `refusal`. */
  readonly refusalReason?: string | null | undefined;
  /** Every reasoning item this response emitted, in wire order. */
  readonly reasoningItems?: readonly ProviderReasoningItem[] | undefined;
  /**
   * The same items, keyed by the provider call each one must be replayed
   * before. This is the persistable form: the flat list above has lost that
   * association, and a renderer rebuilt after a restart needs it to replay a
   * tool call the database still holds.
   */
  readonly reasoningReplay?: readonly ReasoningReplayEntry[] | undefined;
}

// ────────────────────────── Usage / cost (§38.14) ────────────────────────────

export interface UsageRecord {
  readonly inputTokens: TokenCount;
  readonly cachedInputTokens: TokenCount;
  readonly cacheWriteTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly reasoningTokens: TokenCount;
  readonly toolSchemaTokens: TokenCount;
  readonly latencyMs: number;
  readonly timeToFirstTokenMs: number | null;
}

export const usageRecordSchema = z.object({
  inputTokens: z.bigint(),
  cachedInputTokens: z.bigint(),
  cacheWriteTokens: z.bigint(),
  outputTokens: z.bigint(),
  reasoningTokens: z.bigint(),
  toolSchemaTokens: z.bigint(),
  latencyMs: z.number(),
  timeToFirstTokenMs: z.number().nullable(),
});

export interface CostRecord {
  readonly providerReportedCostMicros: Micros | null;
  readonly computedCostMicros: Micros;
  readonly inputMicros: Micros;
  readonly cachedInputMicros: Micros;
  readonly cacheWriteMicros: Micros;
  readonly outputMicros: Micros;
  readonly reasoningMicros: Micros;
  readonly anomaly: boolean;
  readonly anomalyReason: string | null;
}

const MICROS_PER_MILLION = 1_000_000n;

function nonNegative(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError(`${label} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function roundedMicros(tokens: bigint | number, microsPerMillion: bigint | number): Micros {
  const normalizedTokens = nonNegative(tokens, "token count");
  const normalizedRate = nonNegative(microsPerMillion, "micros per million");
  return ((normalizedTokens * normalizedRate + MICROS_PER_MILLION / 2n) / MICROS_PER_MILLION) as Micros;
}

function costComponents(
  usage: UsageRecord,
  economics: ProviderEconomics,
): {
  readonly inputMicros: Micros;
  readonly cachedInputMicros: Micros;
  readonly cacheWriteMicros: Micros;
  readonly outputMicros: Micros;
  readonly reasoningMicros: Micros;
} {
  const inputTokens = nonNegative(usage.inputTokens, "input token count");
  const cachedInputTokensValue = nonNegative(usage.cachedInputTokens, "cached input token count");
  const cachedInputTokens = cachedInputTokensValue > inputTokens
    ? inputTokens
    : cachedInputTokensValue;
  const cacheWriteTokensValue = nonNegative(usage.cacheWriteTokens, "cache write token count");
  const remainingInputTokens = inputTokens - cachedInputTokens;
  const cacheWriteTokens = cacheWriteTokensValue > remainingInputTokens
    ? remainingInputTokens
    : cacheWriteTokensValue;
  const uncachedInputTokens = remainingInputTokens - cacheWriteTokens;
  const inputMicros = roundedMicros(uncachedInputTokens, economics.inputMicrosPerMillion);
  const cachedInputMicros = roundedMicros(cachedInputTokens, economics.cachedInputMicrosPerMillion);
  const cacheWriteMicros = roundedMicros(
    cacheWriteTokens,
    economics.cacheWriteMicrosPerMillion ?? economics.inputMicrosPerMillion,
  );
  const outputMicros = roundedMicros(
    nonNegative(usage.outputTokens, "output token count"),
    economics.outputMicrosPerMillion,
  );
  const reasoningMicros = economics.reasoningAccounting
    ? roundedMicros(
        nonNegative(usage.reasoningTokens, "reasoning token count"),
        economics.outputMicrosPerMillion,
      )
    : (0n as Micros);
  return { inputMicros, cachedInputMicros, cacheWriteMicros, outputMicros, reasoningMicros };
}

/** Compute provider economics with bigint arithmetic and deterministic rounding. */
export function computeExactCostMicros(
  usage: UsageRecord,
  economics: ProviderEconomics,
): Micros {
  const components = costComponents(usage, economics);
  return (
    components.inputMicros
    + components.cachedInputMicros
    + components.cacheWriteMicros
    + components.outputMicros
    + components.reasoningMicros
  ) as Micros;
}

function tolerancePpm(tolerance: number): bigint {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("anomaly tolerance must be a finite non-negative number");
  }
  const scaled = Math.round(tolerance * Number(MICROS_PER_MILLION));
  if (!Number.isSafeInteger(scaled)) throw new RangeError("anomaly tolerance is too large");
  return BigInt(scaled);
}

function exceedsTolerance(reported: bigint, computed: bigint, tolerance: number): boolean {
  if (reported < 0n) return true;
  if (computed === 0n) return reported !== 0n;
  const difference = reported >= computed ? reported - computed : computed - reported;
  return difference * MICROS_PER_MILLION > computed * tolerancePpm(tolerance);
}

// ────────────────────────── Continuation (§38.8) ─────────────────────────────

export interface ContinuationInput {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly continuationId: string | null;
  readonly previousManifest: ContextManifest | null;
  readonly currentManifest: ContextManifest;
  readonly stablePrefixHashChanged: boolean;
  readonly policyAllowsProviderPersistence: boolean;
}

export interface ContinuationDecision {
  readonly canContinue: boolean;
  readonly reason: string;
  readonly requiresRerender: boolean;
  readonly requiresUserConsent: boolean;
  readonly newContinuationId: string | null;
}

// ────────────────────────── Provider / Renderer ──────────────────────────────

export interface RenderCompatibilityInput {
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly fragments: readonly ContextFragment[];
  readonly toolSchemas: readonly ProviderToolSchema[];
  readonly hardInputLimit: TokenCount;
}

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly incompatibilities: readonly string[];
  readonly downgradesRequired: readonly string[];
}

export interface CanonicalRenderInput {
  readonly provider: ProviderCapabilitySnapshot;
  readonly model: ModelCapabilitySnapshot;
  readonly fragments: readonly ContextFragment[];
  readonly toolSchemas: readonly ProviderToolSchema[];
  readonly cachePlan: {
    readonly stablePrefixHash: ContentHash;
    readonly breakpoints: readonly number[];
  };
  readonly continuationId: string | null;
  readonly outputProfile: "terse" | "explanatory" | "teaching" | "structured";
  readonly reasoningReserveTokens: TokenCount;
  readonly outputReserveTokens: TokenCount;
  readonly hardInputLimit: TokenCount;
  /** Compiler estimate for all selected fragments and tool schemas. */
  readonly estimatedInputTokens?: TokenCount | undefined;
  /** Compiler estimate through the latest selected cache breakpoint. */
  readonly predictedCacheWriteTokens?: TokenCount | undefined;
  readonly signal: AbortSignal | null;
  /**
   * Optional compiled manifest ID. Required for authority validation.
   */
  readonly manifestId?: Uuid7 | string | undefined;
}

/**
 * Requested reasoning depth for one turn. `max` is Terminus-level, not a
 * vendor level: renderers map it onto the deepest setting the vendor exposes.
 * A renderer whose protocol has no reasoning control ignores it explicitly.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "max"];

export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)
    ? value as ReasoningEffort
    : null;
}

export interface RenderedProviderRequest {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly request: ProviderRequest;
  readonly predictedCachedTokens: TokenCount;
  /** Estimated full provider input, including tool schemas. */
  readonly estimatedInputTokens?: TokenCount | undefined;
  /** Estimated prefix through the latest provider cache-write breakpoint. */
  readonly predictedCacheWriteTokens?: TokenCount | undefined;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface ProviderResponse {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly chunks: readonly ProviderResponseChunk[];
  readonly observedAt: string;
  /** Provider-native request/response identifier, when the endpoint returns one. */
  readonly providerRequestId?: string | null | undefined;
}

export interface ProviderRenderer {
  readonly providerId: string;
  readonly version: string;
  compatibility(input: RenderCompatibilityInput): CompatibilityResult;
  render(input: CanonicalRenderInput): Promise<RenderedProviderRequest>;
  projectResponse(response: ProviderResponse): Promise<ProjectedResponse>;
  extractUsage(response: ProviderResponse): UsageRecord;
  continuationPolicy(input: ContinuationInput): ContinuationDecision;
}

export interface ProviderTransport {
  stream(
    request: ProviderRequest,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | null,
  ): AsyncIterable<ProviderResponseChunk>;
}

export interface Provider {
  readonly providerId: string;
  readonly displayName: string;
  readonly renderer: ProviderRenderer;
  readonly transport?: ProviderTransport | undefined;
}

// ────────────────────────── Confidentiality policy (§38.18) ──────────────────

export interface ConfidentialityPolicy {
  readonly allowedProviders: Readonly<Record<ConfidentialityLabel, readonly string[]>>;
}

export function isConfidentialityAllowed(
  policy: ConfidentialityPolicy,
  provider: string,
  confidentiality: ConfidentialityLabel,
): boolean {
  const allow = policy.allowedProviders[confidentiality] ?? [];
  return allow.includes(provider);
}

export function filterByConfidentiality(
  policy: ConfidentialityPolicy,
  provider: string,
  fragments: readonly ContextFragment[],
): {
  readonly admitted: readonly ContextFragment[];
  readonly omitted: readonly { readonly fragmentId: string; readonly reason: string }[];
} {
  const admitted: ContextFragment[] = [];
  const omitted: { fragmentId: string; reason: string }[] = [];
  for (const f of fragments) {
    if (isConfidentialityAllowed(policy, provider, f.confidentiality)) {
      admitted.push(f);
    } else {
      omitted.push({
        fragmentId: f.id,
        reason: `confidentiality '${f.confidentiality}' not allowed for provider '${provider}'`,
      });
    }
  }
  return { admitted, omitted };
}

// ────────────────────────── Cost accounting (§38.14) ─────────────────────────

export interface CostComputationInput {
  readonly usage: UsageRecord;
  readonly economics: ProviderEconomics;
  readonly providerReportedCostMicros: Micros | null;
  readonly anomalyTolerance?: number | undefined;
}

export function computeCost(input: CostComputationInput): CostRecord {
  const { inputMicros, cachedInputMicros, cacheWriteMicros, outputMicros, reasoningMicros } = costComponents(
    input.usage,
    input.economics,
  );
  const computed = (inputMicros + cachedInputMicros + cacheWriteMicros + outputMicros + reasoningMicros) as Micros;
  const tolerance = input.anomalyTolerance ?? 0.05;
  let anomaly = false;
  let anomalyReason: string | null = null;
  if (input.providerReportedCostMicros !== null) {
    const reported = input.providerReportedCostMicros;
    if (exceedsTolerance(reported, computed, tolerance)) {
      anomaly = true;
      anomalyReason = `provider reported ${reported.toString()} micros but computed ${computed.toString()}`;
    }
  }
  return {
    providerReportedCostMicros: input.providerReportedCostMicros,
    computedCostMicros: computed,
    inputMicros,
    cachedInputMicros,
    cacheWriteMicros,
    outputMicros,
    reasoningMicros,
    anomaly,
    anomalyReason,
  };
}

// ────────────────────────── Renderer base class ──────────────────────────────

export abstract class BaseProviderRenderer implements ProviderRenderer {
  abstract readonly providerId: string;
  abstract readonly version: string;

  compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    const incompatibilities: string[] = [];
    const downgrades: string[] = [];
    if (input.toolSchemas.length > 0 && !input.provider.context.toolCalling) {
      incompatibilities.push("provider does not support tool calling");
    }
    for (const frag of input.fragments) {
      if (frag.confidentiality === "secret") {
        downgrades.push(
          `fragment ${frag.id} has 'secret' confidentiality — needs provider policy check`,
        );
      }
    }
    const totalTokens = input.fragments.reduce(
      (sum, f) => sum + (f.estimatedTokens[input.model.modelKey] ?? 0),
      0,
    );
    if (totalTokens > Number(input.hardInputLimit)) {
      incompatibilities.push(
        `estimated ${totalTokens} tokens exceeds hard input limit ${input.hardInputLimit}`,
      );
    }
    return {
      compatible: incompatibilities.length === 0,
      incompatibilities,
      downgradesRequired: downgrades,
    };
  }

  /**
   * Asserts that the request was issued via Context Compiler compilation.
   */
  protected assertCompilationAuthority(input: CanonicalRenderInput): void {
    if (!input.manifestId) {
      throw new CompilationAuthorityError(
        "Provider request bypassed Context Compiler execution — missing compiled manifest ID",
        { providerId: this.providerId, model: input.model.modelKey },
      );
    }
  }

  abstract render(input: CanonicalRenderInput): Promise<RenderedProviderRequest>;
  abstract projectResponse(response: ProviderResponse): Promise<ProjectedResponse>;
  abstract extractUsage(response: ProviderResponse): UsageRecord;

  continuationPolicy(input: ContinuationInput): ContinuationDecision {
    if (!input.policyAllowsProviderPersistence) {
      return {
        canContinue: false,
        reason: "provider persistence disallowed by policy",
        requiresRerender: false,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    if (input.continuationId === null) {
      return {
        canContinue: false,
        reason: "no continuation id present",
        requiresRerender: false,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    if (input.stablePrefixHashChanged) {
      return {
        canContinue: false,
        reason: "stable prefix hash changed — cache prefix invalidated",
        requiresRerender: true,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    return {
      canContinue: true,
      reason: "continuation compatible",
      requiresRerender: false,
      requiresUserConsent: false,
      newContinuationId: input.continuationId,
    };
  }
}

// ────────────────────────── Budget guard (§38.14) ────────────────────────────

export interface BudgetLimits {
  readonly requestMicros: Micros;
  readonly taskMicros: Micros;
  readonly sessionMicros: Micros;
}

export interface BudgetState {
  readonly requestSpent: Micros;
  readonly taskSpent: Micros;
  readonly sessionSpent: Micros;
}

export interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly scope: "request" | "task" | "session";
  readonly limitExceeded: Micros | null;
  readonly currentSpent: Micros;
}

export function checkBudget(
  limits: BudgetLimits,
  state: BudgetState,
  estimatedCostMicros: Micros,
): BudgetCheckResult {
  const projected = (a: Micros, b: Micros): Micros => (a + b) as Micros;
  if (projected(state.requestSpent, estimatedCostMicros) > limits.requestMicros) {
    return {
      allowed: false,
      reason: `request budget would be exceeded: ${state.requestSpent} + ${estimatedCostMicros} > ${limits.requestMicros}`,
      scope: "request",
      limitExceeded: limits.requestMicros,
      currentSpent: state.requestSpent,
    };
  }
  if (projected(state.taskSpent, estimatedCostMicros) > limits.taskMicros) {
    return {
      allowed: false,
      reason: `task budget would be exceeded: ${state.taskSpent} + ${estimatedCostMicros} > ${limits.taskMicros}`,
      scope: "task",
      limitExceeded: limits.taskMicros,
      currentSpent: state.taskSpent,
    };
  }
  if (projected(state.sessionSpent, estimatedCostMicros) > limits.sessionMicros) {
    return {
      allowed: false,
      reason: `session budget would be exceeded: ${state.sessionSpent} + ${estimatedCostMicros} > ${limits.sessionMicros}`,
      scope: "session",
      limitExceeded: limits.sessionMicros,
      currentSpent: state.sessionSpent,
    };
  }
  return { allowed: true, reason: null, scope: "request", limitExceeded: null, currentSpent: state.requestSpent };
}

// ────────────────────────── Cache observation (§38.9) ────────────────────────

export type CacheEventKind = "read" | "write" | "hit" | "miss";

/** How a cache event was established. Unknown is deliberately not inferred. */
export type CacheEventSource = "provider_event" | "provider_usage" | "inferred" | "unknown";

/** Provider semantics for a usage field that reports cached input. */
export type CacheUsageSemantics = "read_tokens" | "hit_tokens" | "read_and_hit_tokens" | "unknown";

export type CacheMissReason =
  | "prefix_changed"
  | "below_minimum"
  | "expired"
  | "evicted"
  | "provider_rejected"
  | "unknown";

export interface CacheEvent {
  readonly kind: CacheEventKind;
  readonly tokens: TokenCount;
  readonly breakpointIndex: number | null;
  readonly stablePrefixHash: ContentHash | null;
  readonly occurredAt: string;
  /** Provider event name, retained without interpreting vendor semantics. */
  readonly providerEvent?: string | null;
  readonly source?: CacheEventSource;
  readonly missReason?: CacheMissReason | null;
  readonly firstDifferingFragmentId?: string | null;
}

export interface CacheObservationOptions {
  /** Total input tokens eligible for the provider cache, when reported. */
  readonly eligibleInputTokens?: TokenCount | null;
  /** Total request input tokens, when the provider reports it separately. */
  readonly inputTokens?: TokenCount | null;
  /** Whether cached usage means a read, hit, both, or is unknown. */
  readonly usageSemantics?: CacheUsageSemantics;
  /** Provider-reported total request cost, if available. */
  readonly providerReportedCostMicros?: Micros | null;
  /** Provider-reported cache savings, if the provider exposes it. */
  readonly providerReportedCacheSavingsMicros?: Micros | null;
  /** Independently computed total request cost, if available. */
  readonly computedCostMicros?: Micros | null;
  /** Effective time to first token for the request. */
  readonly timeToFirstTokenMs?: number | null;
  /** Explicit economics computed from provider-specific rates. */
  readonly economics?: CacheEconomicsObservation | null;
}

/** Provider-specific cache economics after the rates are explicitly pinned. */
export interface CacheEconomicsObservation {
  readonly cacheReadCostMicros: Micros;
  readonly cacheWriteCostMicros: Micros;
  readonly uncachedInputCostMicros: Micros;
  readonly effectiveInputCostMicros: Micros;
  readonly cacheSavingsMicros: Micros;
}

export interface CacheObservationRecord {
  readonly manifestId: string;
  readonly providerId: string;
  readonly model: ModelKey;
  readonly events: readonly CacheEvent[];
  readonly predictedCachedTokens: TokenCount;
  readonly observedCachedTokens: TokenCount;
  readonly cacheWriteTokensObserved: TokenCount;
  readonly cacheHitRate: number;
  /** Total input tokens eligible for caching, or null when not reported. */
  readonly eligibleInputTokens: TokenCount | null;
  /** Total input tokens, or null when not reported. */
  readonly inputTokens: TokenCount | null;
  /** Provider cache reads, measured in tokens. */
  readonly cacheReadTokens: TokenCount;
  /** Explicit provider cache hits, measured in tokens. */
  readonly cacheHitTokens: TokenCount;
  /** Explicit provider cache misses, measured in tokens. */
  readonly cacheMissTokens: TokenCount;
  /** Token-weighted hit rate; null means no cache-eligible denominator. */
  readonly tokenWeightedHitRate: number | null;
  /** Cache reads divided by total request input, when both are known. */
  readonly cacheReadRate: number | null;
  readonly usageSemantics: CacheUsageSemantics;
  readonly providerReportedCostMicros: Micros | null;
  readonly providerReportedCacheSavingsMicros: Micros | null;
  readonly computedCostMicros: Micros | null;
  readonly timeToFirstTokenMs: number | null;
  readonly economics: CacheEconomicsObservation | null;
  /** First explicit miss reason, if a provider supplied one. */
  readonly firstMissReason: CacheMissReason | null;
  /** First fragment that caused a provider-reported prefix drift, if known. */
  readonly firstDifferingFragmentId: string | null;
  readonly firstDriftReason: CacheMissReason | null;
  readonly stablePrefixPreserved: boolean;
  readonly prefixDriftAt: number | null;
  readonly occurredAt: string;
}

export function computeCacheObservation(
  manifestId: string,
  providerId: string,
  model: ModelKey,
  events: readonly CacheEvent[],
  predictedCachedTokens: TokenCount,
  options: CacheObservationOptions = {},
): CacheObservationRecord {
  let observedCached = 0n as TokenCount;
  let cacheReadTokens = 0n as TokenCount;
  let cacheHitTokens = 0n as TokenCount;
  let cacheMissTokens = 0n as TokenCount;
  let cacheWrites = 0n as TokenCount;
  let hits = 0;
  let misses = 0;
  let stablePrefixPreserved = true;
  let prefixDriftAt: number | null = null;
  let firstMissReason: CacheMissReason | null = null;
  let firstDifferingFragmentId: string | null = null;
  let firstDriftReason: CacheMissReason | null = null;
  for (const e of events) {
    switch (e.kind) {
      case "hit":
        observedCached = (observedCached + e.tokens) as TokenCount;
        cacheHitTokens = (cacheHitTokens + e.tokens) as TokenCount;
        hits++;
        break;
      case "write":
        cacheWrites = (cacheWrites + e.tokens) as TokenCount;
        break;
      case "miss":
        misses++;
        cacheMissTokens = (cacheMissTokens + e.tokens) as TokenCount;
        if (firstMissReason === null && e.missReason !== undefined && e.missReason !== null) {
          firstMissReason = e.missReason;
        }
        if (firstDifferingFragmentId === null && e.firstDifferingFragmentId !== undefined) {
          firstDifferingFragmentId = e.firstDifferingFragmentId;
        }
        if (firstDriftReason === null && e.missReason !== undefined && e.missReason !== null) {
          firstDriftReason = e.missReason;
        }
        if (stablePrefixPreserved && e.stablePrefixHash !== null) {
          stablePrefixPreserved = false;
          prefixDriftAt = e.breakpointIndex;
        }
        break;
      case "read":
        observedCached = (observedCached + e.tokens) as TokenCount;
        cacheReadTokens = (cacheReadTokens + e.tokens) as TokenCount;
        break;
      default: {
        const _exhaustive: never = e.kind;
        void _exhaustive;
      }
    }
  }
  // Cache hit rate: hits / (hits + misses) among read-related events.
  const relevantEvents = hits + misses;
  const hitRate = relevantEvents > 0 ? hits / relevantEvents : 0;
  const eligibleInputTokens = options.eligibleInputTokens ?? null;
  const inputTokens = options.inputTokens ?? null;
  const tokenWeightedDenominator = cacheHitTokens + cacheMissTokens;
  const tokenWeightedHitRate = tokenWeightedDenominator > 0n
    ? Number(cacheHitTokens) / Number(tokenWeightedDenominator)
    : eligibleInputTokens !== null && eligibleInputTokens > 0n
      ? Number(cacheHitTokens) / Number(eligibleInputTokens)
      : null;
  const cacheReadRate = inputTokens !== null && inputTokens > 0n
    ? Number(cacheReadTokens + cacheHitTokens) / Number(inputTokens)
    : null;
  return {
    manifestId,
    providerId,
    model,
    events,
    predictedCachedTokens,
    observedCachedTokens: observedCached,
    cacheWriteTokensObserved: cacheWrites,
    cacheHitRate: hitRate,
    eligibleInputTokens,
    inputTokens,
    cacheReadTokens,
    cacheHitTokens,
    cacheMissTokens,
    tokenWeightedHitRate,
    cacheReadRate,
    usageSemantics: options.usageSemantics ?? "unknown",
    providerReportedCostMicros: options.providerReportedCostMicros ?? null,
    providerReportedCacheSavingsMicros: options.providerReportedCacheSavingsMicros ?? null,
    computedCostMicros: options.computedCostMicros ?? null,
    timeToFirstTokenMs: options.timeToFirstTokenMs ?? null,
    economics: options.economics ?? null,
    firstMissReason,
    firstDifferingFragmentId,
    firstDriftReason,
    stablePrefixPreserved,
    prefixDriftAt,
    occurredAt: new Date().toISOString(),
  };
}

// ────────────────────────── Fallback observer (§38.5) ────────────────────────

export interface FallbackObservation {
  readonly originalProvider: string;
  readonly originalModel: ModelKey;
  readonly fallbackProvider: string;
  readonly fallbackModel: ModelKey;
  readonly reason: string;
  readonly continuationLost: boolean;
  readonly cacheLost: boolean;
  readonly costImpactMicros: Micros;
  readonly latencyImpactMs: number;
  readonly userConsentRequired: boolean;
  readonly policyCompliant: boolean;
  readonly policyCheckReason: string | null;
  readonly occurredAt: string;
}

export function validateFallbackPolicy(
  fallback: FallbackObservation,
  policy: ConfidentialityPolicy,
  confidentiality: ConfidentialityLabel,
): { readonly compliant: boolean; readonly reason: string | null } {
  if (!isConfidentialityAllowed(policy, fallback.fallbackProvider, confidentiality)) {
    return {
      compliant: false,
      reason: `confidentiality '${confidentiality}' not allowed for fallback provider '${fallback.fallbackProvider}'`,
    };
  }
  return { compliant: true, reason: null };
}

// ────────────────────────── Cost reconciliation (§38.14) ─────────────────────

export interface ReconciliationReport {
  readonly manifestId: string;
  readonly providerId: string;
  readonly model: ModelKey;
  readonly predictedCostMicros: Micros;
  readonly observedCostMicros: Micros;
  readonly providerReportedCostMicros: Micros | null;
  readonly computedCostMicros: Micros;
  readonly deltaMicros: Micros;
  readonly anomaly: boolean;
  readonly anomalyReason: string | null;
  readonly reconciledAt: string;
}

export function reconcileCost(
  manifestId: string,
  providerId: string,
  model: ModelKey,
  usage: UsageRecord,
  economics: ProviderEconomics,
  predictedCostMicros: Micros,
  providerReportedCostMicros: Micros | null,
): ReconciliationReport {
  const costRecord = computeCost({
    usage,
    economics,
    providerReportedCostMicros,
  });
  const delta = (costRecord.computedCostMicros - predictedCostMicros) as Micros;
  return {
    manifestId,
    providerId,
    model,
    predictedCostMicros,
    observedCostMicros: costRecord.computedCostMicros,
    providerReportedCostMicros,
    computedCostMicros: costRecord.computedCostMicros,
    deltaMicros: delta,
    anomaly: costRecord.anomaly,
    anomalyReason: costRecord.anomalyReason,
    reconciledAt: new Date().toISOString(),
  };
}

// ────────────────────────── Partial stream settlement (§38.12) ───────────────

export interface PartialStreamResult {
  readonly receivedChunks: number;
  readonly textReceived: string;
  readonly toolCallsReceived: number;
  readonly cancellationReason: "user" | "timeout" | "budget" | "policy" | "error";
  readonly usageAccrued: UsageRecord | null;
  readonly costAccrued: Micros;
  readonly continuationPossible: boolean;
  readonly continuationId: string | null;
}

export function settlePartialStream(
  chunks: readonly ProviderResponseChunk[],
  cancellationReason: PartialStreamResult["cancellationReason"],
  economics: ProviderEconomics,
): PartialStreamResult {
  let textReceived = "";
  let toolCallsReceived = 0;
  let usageAccrued: UsageRecord | null = null;
  let continuationId: string | null = null;
  for (const chunk of chunks) {
    if (chunk.kind === "text" && chunk.text !== undefined) textReceived += chunk.text;
    if (chunk.kind === "tool_call") toolCallsReceived++;
    if (chunk.usage) usageAccrued = chunk.usage;
    if (chunk.kind === "done" && chunk.continuationId) continuationId = chunk.continuationId;
  }
  const costAccrued = usageAccrued
    ? computeCost({ usage: usageAccrued, economics, providerReportedCostMicros: null }).computedCostMicros
    : (0n as Micros);
  const continuationPossible =
    toolCallsReceived === 0 && textReceived.length > 0 && chunks.length > 0;
  return {
    receivedChunks: chunks.length,
    textReceived,
    toolCallsReceived,
    cancellationReason,
    usageAccrued,
    costAccrued,
    continuationPossible,
    continuationId,
  };
}

// ────────────────────────── Re-exports ───────────────────────────────────────

export type {
  ContextFragment,
  ContextManifest,
  ModelKey,
  ContentHash,
  ConfidentialityLabel,
  Micros,
  TokenCount,
  Uuid7,
};

export * from "./model_profile.js";
export * from "./model_family.js";
export * from "./reasoning_replay.js";
export * from "./catalog/index.js";
export * from "./tool-args-repair.js";
export * from "./conformance/types.js";
export * from "./conformance/episodes.js";
export * from "./conformance/validator.js";
