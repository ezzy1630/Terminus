/**
 * @terminus/model-router — deterministic routing + escalation.
 *
 * Per SPEC §38.3 and §38.4: tasks request capabilities rather than model names.
 * The router ranks eligible models by cohort performance, health, predicted
 * cost, latency, cache reuse, and policy. Escalation is deterministic; a
 * learned router is `EXPERIMENTAL`.
 */
import { z } from "zod";
import type {
  ModelKey,
  ConfidentialityLabel,
  RiskClass,
} from "@terminus/domain";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ConfidentialityPolicy,
} from "@terminus/provider-core";
import { isConfidentialityAllowed } from "@terminus/provider-core";

// ────────────────────────── Routing profile (§38.3) ──────────────────────────

export const capabilityRequirementsSchema = z.object({
  codingQuality: z.enum(["low", "medium", "high"]).nullable().default(null),
  toolReliability: z.enum(["low", "medium", "high"]).nullable().default(null),
  structuredOutput: z.enum(["required", "optional", "none"]).nullable().default(null),
  context: z.enum(["small", "medium", "large"]).nullable().default(null),
  securityReasoning: z.enum(["low", "medium", "high"]).nullable().default(null),
  highRecall: z.boolean().nullable().default(null),
});

export const routingPreferencesSchema = z.object({
  latency: z.enum(["low", "medium", "high"]).nullable().default(null),
  cost: z.enum(["low", "medium", "high"]).nullable().default(null),
  providerDiversity: z.enum(["neutral", "prefer_diverse"]).nullable().default(null),
  differentFamilyFromImplementer: z.boolean().nullable().default(null),
});

export const routingProfilePolicySchema = z.object({
  confidentiality: z.enum(["public", "workspace", "secret_adjacent", "secret"]).default("workspace"),
  allowedProviders: z.array(z.string()).default([]),
});

export const fallbackPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(2),
  requireUserOnSemanticDowngrade: z.boolean().default(true),
});

export const routeProfileSchema = z.object({
  role: z.enum(["classifier", "scout", "implementer", "reviewer", "specialist", "checkpoint"]),
  minimum: capabilityRequirementsSchema,
  preferences: routingPreferencesSchema,
  policy: routingProfilePolicySchema,
  fallback: fallbackPolicySchema,
});

export type RouteProfile = z.infer<typeof routeProfileSchema>;
export type CapabilityRequirements = z.infer<typeof capabilityRequirementsSchema>;
export type RoutingPreferences = z.infer<typeof routingPreferencesSchema>;

// ────────────────────────── Health / cohort stats ────────────────────────────

export interface ModelHealth {
  readonly modelKey: ModelKey;
  readonly available: boolean;
  readonly rateLimitedUntil: number | null;
  readonly circuitOpen: boolean;
  readonly lastError: string | null;
}

export interface ModelCohortStats {
  readonly modelKey: ModelKey;
  readonly toolCallSuccessRate: number;
  readonly structuredOutputSuccessRate: number;
  readonly editCohortSuccessRate: number;
  readonly averageLatencyMs: number;
  readonly averageCostMicros: bigint;
  readonly cacheReuseRate: number;
  readonly sampleCount: number;
}

// ────────────────────────── Routing decision ─────────────────────────────────

export interface RoutingCandidate {
  readonly model: ModelCapabilitySnapshot;
  readonly score: number;
  readonly meetsMinimum: boolean;
  readonly reasons: readonly string[];
}

export interface RoutingDecision {
  readonly chosen: ModelCapabilitySnapshot | null;
  readonly candidates: readonly RoutingCandidate[];
  readonly reason: string;
  readonly fallback: readonly ModelCapabilitySnapshot[];
}

// ────────────────────────── Router ───────────────────────────────────────────

export interface RouterInputs {
  readonly profile: RouteProfile;
  readonly models: readonly ModelCapabilitySnapshot[];
  readonly health: Readonly<Record<ModelKey, ModelHealth>>;
  readonly cohortStats: Readonly<Record<ModelKey, ModelCohortStats>>;
  readonly confidentialityPolicy: ConfidentialityPolicy;
  readonly previousAttemptModel: ModelKey | null;
  readonly implementerModel: ModelKey | null;
  readonly riskClass: RiskClass;
  /**
   * Optional rate-limit / circuit-breaker / concurrency controls (§38.15).
   * If present, the router will skip providers whose circuit breaker is open,
   * whose rate limit is exhausted, or whose concurrency limit is reached.
   */  readonly controls?: RouterControls | undefined;
}

/** Optional controls the router consults to skip unhealthy providers. */
export interface RouterControls {
  readonly rateLimiter: RateLimiter;
  readonly circuitBreaker: CircuitBreaker;
  readonly concurrencyLimiter: ConcurrencyLimiter;
}

export class Router {
  /**
   * Rank eligible models by minimum-capability filter, then by a deterministic
   * score combining cohort performance, health, predicted cost, latency, cache
   * reuse, and policy. Never returns a model that violates the confidentiality
   * policy.
   */
  route(input: RouterInputs): RoutingDecision {
    const eligible: RoutingCandidate[] = [];
    for (const model of input.models) {
      const meetsMin = meetsMinimum(model, input.profile.minimum);
      const confOk = isConfidentialityAllowed(
        input.confidentialityPolicy,
        model.providerId,
        input.profile.policy.confidentiality,
      );
      const allowedProvider =
        input.profile.policy.allowedProviders.length === 0 ||
        input.profile.policy.allowedProviders.includes(model.providerId);
      const health = input.health[model.modelKey];
      const healthOk = health ? health.available && !health.circuitOpen : true;
      // §38.15 controls: skip providers with open circuit breakers, exhausted
      // rate limits, or saturated concurrency limits.
      const controls = input.controls;
      const circuitOpen = controls ? controls.circuitBreaker.isOpen(model.providerId) : false;
      const rateAvailable = controls ? controls.rateLimiter.canAcquire(model.providerId, 1) : true;
      const concurrencyAvailable = controls ? controls.concurrencyLimiter.available(model.providerId) : true;
      const controlsOk = !circuitOpen && rateAvailable && concurrencyAvailable;
      const reasons: string[] = [];
      if (!meetsMin) reasons.push("does not meet minimum capability requirements");
      if (!confOk) reasons.push(`confidentiality '${input.profile.policy.confidentiality}' not allowed for provider '${model.providerId}'`);
      if (!allowedProvider) reasons.push(`provider '${model.providerId}' not in allowed list`);
      if (!healthOk) reasons.push(`model '${model.modelKey}' unavailable or circuit open`);
      if (circuitOpen) reasons.push(`circuit breaker open for provider '${model.providerId}'`);
      if (!rateAvailable) reasons.push(`rate limit exhausted for provider '${model.providerId}'`);
      if (!concurrencyAvailable) reasons.push(`concurrency limit reached for provider '${model.providerId}'`);
      const score = meetsMin && confOk && allowedProvider && healthOk && controlsOk
        ? scoreModel(model, input)
        : -Infinity;
      eligible.push({ model, score, meetsMinimum: meetsMin && confOk && allowedProvider && healthOk && controlsOk, reasons });
    }
    const sorted = [...eligible].sort((a, b) => b.score - a.score);
    const chosen = sorted.length > 0 && sorted[0]!.meetsMinimum && sorted[0]!.score > -Infinity
      ? sorted[0]!.model
      : null;
    const fallback = sorted
      .slice(1)
      .filter((c) => c.meetsMinimum && c.score > -Infinity)
      .map((c) => c.model);
    const reason = chosen
      ? `selected ${chosen.modelKey} (score ${sorted[0]!.score.toFixed(3)})`
      : "no eligible model";
    return { chosen, candidates: sorted, reason, fallback };
  }

  /**
   * Produces an escalation attempt with a stronger model. Per §38.4 the policy
   * is deterministic: escalate after evidence of uncertainty, repeated failure,
   * or high risk.
   */
  escalate(
    current: ModelCapabilitySnapshot,
    input: RouterInputs,
    reason: EscalationReason,
  ): ModelCapabilitySnapshot | null {
    const stronger = input.models
      .filter((m) => m.modelKey !== current.modelKey)
      .filter((m) => isStrongerThan(m, current))
      .map((m) => ({ m, score: scoreModel(m, input) }))
      .sort((a, b) => b.score - a.score);
    if (stronger.length === 0) return null;
    void reason;
    return stronger[0]!.m;
  }
}

export type EscalationReason =
  | "repeated_tool_failures"
  | "verification_repairs"
  | "explicit_low_confidence"
  | "high_risk"
  | "user_request";

// ────────────────────────── Scoring ──────────────────────────────────────────

function meetsMinimum(
  model: ModelCapabilitySnapshot,
  min: CapabilityRequirements,
): boolean {
  if (min.codingQuality === "high" && model.snapshot.reliability.editCohortSuccess < 0.85) return false;
  if (min.codingQuality === "medium" && model.snapshot.reliability.editCohortSuccess < 0.7) return false;
  if (min.toolReliability === "high" && model.snapshot.reliability.toolCallSuccess < 0.95) return false;
  if (min.toolReliability === "medium" && model.snapshot.reliability.toolCallSuccess < 0.85) return false;
  if (min.structuredOutput === "required" && !model.snapshot.context.structuredOutput) return false;
  if (min.context === "large" && model.snapshot.context.testedSafeTokens < 128_000) return false;
  if (min.context === "medium" && model.snapshot.context.testedSafeTokens < 32_000) return false;
  return true;
}

function scoreModel(model: ModelCapabilitySnapshot, input: RouterInputs): number {
  const stats = input.cohortStats[model.modelKey];
  const health = input.health[model.modelKey];
  let score = 0;
  // Cohort performance (40%).
  if (stats) {
    const tool = stats.toolCallSuccessRate;
    const struct = stats.structuredOutputSuccessRate;
    const edit = stats.editCohortSuccessRate;
    score += 0.4 * ((tool + struct + edit) / 3);
  } else {
    score += 0.4 * 0.5; // No data — neutral prior.
  }
  // Health (10%).
  if (health) {
    score += 0.1 * (health.available && !health.circuitOpen ? 1 : 0);
  } else {
    score += 0.1 * 0.5;
  }
  // Cost (15%) — lower cost is better.
  const predictedCost = stats ? Number(stats.averageCostMicros) : Number(model.snapshot.economics.inputMicrosPerMillion + model.snapshot.economics.outputMicrosPerMillion) / 1_000_000;
  score += 0.15 * (1 - Math.min(1, predictedCost / 10_000));
  // Latency (15%).
  const predictedLatency = stats ? stats.averageLatencyMs : 1000;
  score += 0.15 * (1 - Math.min(1, predictedLatency / 10_000));
  // Cache reuse (10%).
  const cacheReuse = stats ? stats.cacheReuseRate : 0;
  score += 0.1 * cacheReuse;
  // Preferences (10%).
  if (input.profile.preferences.cost === "low") {
    score += 0.05 * (Number(model.snapshot.economics.inputMicrosPerMillion) < 1_000_000 ? 1 : 0);
  }
  if (input.profile.preferences.latency === "low") {
    score += 0.05 * ((stats?.averageLatencyMs ?? 1000) < 2000 ? 1 : 0);
  }
  // Reviewer preference: different family from implementer.
  if (input.profile.role === "reviewer" && input.implementerModel) {
    const impl = input.models.find((m) => m.modelKey === input.implementerModel);
    if (impl && impl.providerId !== model.providerId) {
      score += 0.1;
    }
  }
  // Risk: high/critical risk requires high coding quality.
  if (input.riskClass === "high" || input.riskClass === "critical") {
    if (model.snapshot.reliability.editCohortSuccess < 0.9) score -= 0.2;
  }
  return score;
}

function isStrongerThan(a: ModelCapabilitySnapshot, b: ModelCapabilitySnapshot): boolean {
  // A model is "stronger" if it has a larger tested-safe context window AND
  // >= reliability on edit cohort, OR if it has higher reliability.
  const aCtx = a.snapshot.context.testedSafeTokens;
  const bCtx = b.snapshot.context.testedSafeTokens;
  const aEdit = a.snapshot.reliability.editCohortSuccess;
  const bEdit = b.snapshot.reliability.editCohortSuccess;
  if (aCtx > bCtx && aEdit >= bEdit) return true;
  if (aEdit > bEdit && aCtx >= bCtx) return true;
  return false;
}

// ────────────────────────── Fallback record (§38.5) ──────────────────────────

export interface FallbackRecord {
  readonly originalProvider: string;
  readonly originalModel: ModelKey;
  readonly reason: FallbackReason;
  readonly newProvider: string;
  readonly newModel: ModelKey;
  readonly compatibilityChanges: readonly string[];
  readonly contextRerendered: boolean;
  readonly continuationLost: boolean;
  readonly cacheLost: boolean;
  readonly costImpactMicros: bigint;
  readonly latencyImpactMs: number;
  readonly userConsentRequired: boolean;
}

export type FallbackReason =
  | "provider_unavailable"
  | "rate_limited"
  | "model_unavailable"
  | "request_exceeds_capability"
  | "policy_excludes_provider"
  | "escalation_condition";

export function recordFallback(
  original: ModelCapabilitySnapshot,
  next: ModelCapabilitySnapshot,
  reason: FallbackReason,
  opts: {
    readonly continuationLost: boolean;
    readonly cacheLost: boolean;
    readonly costImpactMicros: bigint;
    readonly latencyImpactMs: number;
    readonly userConsentRequired: boolean;
  },
): FallbackRecord {
  const compatibilityChanges: string[] = [];
  if (original.snapshot.continuation.compatibilityKey !== next.snapshot.continuation.compatibilityKey) {
    compatibilityChanges.push("continuation-compatibility-key-changed");
  }
  if (original.snapshot.caching.mode !== next.snapshot.caching.mode) {
    compatibilityChanges.push(`caching-mode-${original.snapshot.caching.mode}-to-${next.snapshot.caching.mode}`);
  }
  return {
    originalProvider: original.providerId,
    originalModel: original.modelKey,
    reason,
    newProvider: next.providerId,
    newModel: next.modelKey,
    compatibilityChanges,
    contextRerendered: true,
    continuationLost: opts.continuationLost,
    cacheLost: opts.cacheLost,
    costImpactMicros: opts.costImpactMicros,
    latencyImpactMs: opts.latencyImpactMs,
    userConsentRequired: opts.userConsentRequired,
  };
}

export type { ConfidentialityLabel, ModelKey, ProviderCapabilitySnapshot };

// ────────────────────────── Rate limiting & fairness (§38.15) ────────────────

/**
 * Token-bucket rate limiter per provider (§38.15). Each provider has an
 * independent bucket with a capacity and a steady-state refill rate. Tokens
 * are consumed by `acquire()`; the bucket refills over time. Probing via
 * `canAcquire()` does not consume.
 */
export interface RateLimiterConfig {
  /** Bucket capacity (max burst). */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  capacity: 10,
  refillPerSecond: 2,
};

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Token-bucket rate limiter. One bucket per provider. Thread-unsafe — callers
 * must serialize access if used from concurrent contexts (the broker does
 * this by routing on a single task queue).
 */
export class RateLimiter {
  private readonly buckets: Map<string, TokenBucket> = new Map();
  private readonly configs: Map<string, RateLimiterConfig> = new Map();
  private readonly clock: () => number;

  constructor(
    defaultConfig: RateLimiterConfig = DEFAULT_RATE_LIMITER_CONFIG,
    clock: () => number = () => Date.now(),
  ) {
    this.defaultConfig = defaultConfig;
    this.clock = clock;
  }

  private readonly defaultConfig: RateLimiterConfig;

  /** Configure the bucket for a specific provider. */
  configure(provider: string, config: RateLimiterConfig): void {
    this.configs.set(provider, config);
    // Reset the bucket so the new capacity takes effect immediately.
    const existing = this.buckets.get(provider);
    this.buckets.set(provider, {
      tokens: config.capacity,
      lastRefillMs: this.clock(),
    });
    void existing;
  }

  /** Probe whether `cost` tokens are available. Does NOT consume. */
  canAcquire(provider: string, cost = 1): boolean {
    const bucket = this.getOrCreateBucket(provider);
    this.refill(provider, bucket);
    return bucket.tokens >= cost;
  }

  /**
   * Consume `cost` tokens. Returns true if the tokens were available and
   * consumed; false if the bucket was empty (no consumption in that case).
   */
  acquire(provider: string, cost = 1): boolean {
    const bucket = this.getOrCreateBucket(provider);
    this.refill(provider, bucket);
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /**
   * Return tokens to the bucket (e.g., a request was served from cache and
   * didn't actually consume provider capacity). Will not exceed capacity.
   */
  release(provider: string, cost = 1): void {
    const bucket = this.getOrCreateBucket(provider);
    const config = this.configs.get(provider) ?? this.defaultConfig;
    bucket.tokens = Math.min(config.capacity, bucket.tokens + cost);
  }

  /** Current token count for a provider (after refill). */
  availableTokens(provider: string): number {
    const bucket = this.getOrCreateBucket(provider);
    this.refill(provider, bucket);
    return bucket.tokens;
  }

  private getOrCreateBucket(provider: string): TokenBucket {
    let bucket = this.buckets.get(provider);
    if (!bucket) {
      const config = this.configs.get(provider) ?? this.defaultConfig;
      bucket = { tokens: config.capacity, lastRefillMs: this.clock() };
      this.buckets.set(provider, bucket);
    }
    return bucket;
  }

  private refill(provider: string, bucket: TokenBucket): void {
    const config = this.configs.get(provider) ?? this.defaultConfig;
    const now = this.clock();
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    const refill = (elapsedMs / 1000) * config.refillPerSecond;
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
  }
}

/**
 * Per-provider circuit breaker (§38.15). Opens after `failureThreshold`
 * consecutive failures; transitions to half-open after `cooldownMs`; closes
 * again after `successThreshold` consecutive successes in half-open state.
 */
export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly successThreshold: number;
  readonly cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 30_000,
};

type CircuitState = "closed" | "open" | "half_open";

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAtMs: number | null;
}

/**
 * Circuit breaker tracking failures per provider. `isOpen()` returns true
 * only when the breaker is fully open (not half-open). Half-open allows a
 * limited probe request through; successes close the breaker, failures
 * re-open it.
 */
export class CircuitBreaker {
  private readonly entries: Map<string, CircuitEntry> = new Map();
  private readonly configs: Map<string, CircuitBreakerConfig> = new Map();
  private readonly clock: () => number;

  constructor(
    defaultConfig: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
    clock: () => number = () => Date.now(),
  ) {
    this.defaultConfig = defaultConfig;
    this.clock = clock;
  }

  private readonly defaultConfig: CircuitBreakerConfig;

  configure(provider: string, config: CircuitBreakerConfig): void {
    this.configs.set(provider, config);
  }

  /** True if the breaker is fully open (requests should be rejected). */
  isOpen(provider: string): boolean {
    const entry = this.getOrCreateEntry(provider);
    this.maybeTransitionToHalfOpen(provider, entry);
    return entry.state === "open";
  }

  /** True if the breaker is in half-open state (limited probes allowed). */
  isHalfOpen(provider: string): boolean {
    const entry = this.getOrCreateEntry(provider);
    this.maybeTransitionToHalfOpen(provider, entry);
    return entry.state === "half_open";
  }

  /** Record a successful request. Closes the breaker after enough successes. */
  recordSuccess(provider: string): void {
    const entry = this.getOrCreateEntry(provider);
    this.maybeTransitionToHalfOpen(provider, entry);
    entry.consecutiveFailures = 0;
    entry.consecutiveSuccesses++;
    if (entry.state === "half_open") {
      const config = this.configs.get(provider) ?? this.defaultConfig;
      if (entry.consecutiveSuccesses >= config.successThreshold) {
        entry.state = "closed";
        entry.openedAtMs = null;
      }
    }
  }

  /** Record a failed request. Opens the breaker after enough failures. */
  recordFailure(provider: string): void {
    const entry = this.getOrCreateEntry(provider);
    this.maybeTransitionToHalfOpen(provider, entry);
    entry.consecutiveSuccesses = 0;
    entry.consecutiveFailures++;
    if (entry.state === "half_open") {
      // A failure in half-open re-opens the breaker immediately.
      entry.state = "open";
      entry.openedAtMs = this.clock();
      return;
    }
    const config = this.configs.get(provider) ?? this.defaultConfig;
    if (entry.consecutiveFailures >= config.failureThreshold) {
      entry.state = "open";
      entry.openedAtMs = this.clock();
    }
  }

  /** Force-reset the breaker to closed (e.g., after operator intervention). */
  reset(provider: string): void {
    this.entries.set(provider, {
      state: "closed",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      openedAtMs: null,
    });
  }

  /** Current state snapshot for telemetry. */
  state(provider: string): CircuitState {
    const entry = this.getOrCreateEntry(provider);
    this.maybeTransitionToHalfOpen(provider, entry);
    return entry.state;
  }

  private getOrCreateEntry(provider: string): CircuitEntry {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = {
        state: "closed",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        openedAtMs: null,
      };
      this.entries.set(provider, entry);
    }
    return entry;
  }

  private maybeTransitionToHalfOpen(provider: string, entry: CircuitEntry): void {
    if (entry.state !== "open" || entry.openedAtMs === null) return;
    const config = this.configs.get(provider) ?? this.defaultConfig;
    if (this.clock() - entry.openedAtMs >= config.cooldownMs) {
      entry.state = "half_open";
      entry.consecutiveSuccesses = 0;
    }
  }
}

/**
 * Per-provider concurrency limiter (§38.15). Tracks the number of in-flight
 * requests per provider and rejects new ones beyond the limit.
 */
export class ConcurrencyLimiter {
  private readonly limits: Map<string, number> = new Map();
  private readonly counts: Map<string, number> = new Map();

  /** Set the concurrency limit for a provider. */
  setLimit(provider: string, limit: number): void {
    if (limit < 0) {
      throw new RangeError(`concurrency limit must be non-negative: ${limit}`);
    }
    this.limits.set(provider, limit);
  }

  /** Get the configured limit (default 1). */
  limit(provider: string): number {
    return this.limits.get(provider) ?? 1;
  }

  /** Current in-flight count for a provider. */
  count(provider: string): number {
    return this.counts.get(provider) ?? 0;
  }

  /** True if a new request can be admitted without exceeding the limit. */
  available(provider: string): boolean {
    return this.count(provider) < this.limit(provider);
  }

  /**
   * Try to admit a new request. Returns true if admitted (count incremented);
   * false if the limit would be exceeded (no change).
   */
  acquire(provider: string): boolean {
    if (!this.available(provider)) return false;
    this.counts.set(provider, this.count(provider) + 1);
    return true;
  }

  /**
   * Release a previously acquired slot. Idempotent: releasing more times than
   * acquired is a no-op (count is clamped at 0).
   */
  release(provider: string): void {
    const c = this.count(provider);
    this.counts.set(provider, Math.max(0, c - 1));
  }
}

// ────────────────────────── Fairness queue (§38.15) ──────────────────────────

/**
 * Weighted fair queuing entry. Each provider has a weight and a virtual
 * finish time. The queue always dequeues the entry with the smallest
 * finish time, achieving max-min fairness across providers.
 */
export interface FairnessQueueEntry {
  readonly providerId: string;
  readonly taskId: string;
  readonly queuedAt: number;
  readonly weight: number;
}

export interface FairnessQueueDequeue {
  readonly entry: FairnessQueueEntry;
  readonly waitTimeMs: number;
}

export class FairnessQueue {
  private readonly entries: FairnessQueueEntry[] = [];
  private readonly virtualTimes: Map<string, number> = new Map();
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /** Enqueue a task for a provider with the given weight (higher = more capacity). */
  enqueue(providerId: string, taskId: string, weight = 1): FairnessQueueEntry {
    const entry: FairnessQueueEntry = {
      providerId,
      taskId,
      queuedAt: this.clock(),
      weight: Math.max(1, weight),
    };
    this.entries.push(entry);
    return entry;
  }

  /** Dequeue the next entry by virtual finish time (SJF-like). */
  dequeue(): FairnessQueueDequeue | null {
    if (this.entries.length === 0) return null;
    let bestIdx = 0;
    let bestFinishTime = Number.POSITIVE_INFINITY;
    const now = this.clock();
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const virtualNow = this.virtualTimes.get(entry.providerId) ?? 0;
      const finishTime = virtualNow + (1 / entry.weight);
      if (finishTime < bestFinishTime) {
        bestFinishTime = finishTime;
        bestIdx = i;
      }
    }
    const entry = this.entries[bestIdx]!;
    this.virtualTimes.set(entry.providerId, bestFinishTime);
    this.entries.splice(bestIdx, 1);
    return { entry, waitTimeMs: now - entry.queuedAt };
  }

  /** Current queue depth. */
  get depth(): number {
    return this.entries.length;
  }

  /** Get entries for a specific provider. */
  forProvider(providerId: string): readonly FairnessQueueEntry[] {
    return this.entries.filter((e) => e.providerId === providerId);
  }

  /** Remove all entries for a provider. */
  drainProvider(providerId: string): readonly FairnessQueueEntry[] {
    const removed: FairnessQueueEntry[] = [];
    const remaining: FairnessQueueEntry[] = [];
    for (const e of this.entries) {
      if (e.providerId === providerId) {
        removed.push(e);
      } else {
        remaining.push(e);
      }
    }
    this.entries.length = 0;
    this.entries.push(...remaining);
    return removed;
  }

  /** Average wait time for all currently queued entries. */
  averageWaitMs(): number {
    if (this.entries.length === 0) return 0;
    const now = this.clock();
    return this.entries.reduce((sum, e) => sum + (now - e.queuedAt), 0) / this.entries.length;
  }
}

/**
 * Combines rate-limiter, circuit-breaker, and concurrency-limiter signals
 * into a {@link ModelHealth} record per model key. The router consumes this
 * to skip unhealthy models.
 */
export class ModelHealthMonitor {
  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly concurrencyLimiter: ConcurrencyLimiter,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Build a ModelHealth record for a model key hosted by the given provider.
   * `available` is true iff the circuit breaker is not open, the rate limiter
   * can admit a request, and the concurrency limiter has a slot.
   */
  snapshot(modelKey: ModelKey, provider: string): ModelHealth {
    const circuitOpen = this.circuitBreaker.isOpen(provider);
    const rateLimited = !this.rateLimiter.canAcquire(provider, 1);
    const concurrencyFull = !this.concurrencyLimiter.available(provider);
    const available = !circuitOpen && !rateLimited && !concurrencyFull;
    let lastError: string | null = null;
    if (circuitOpen) lastError = "circuit breaker open";
    else if (rateLimited) lastError = "rate limited";
    else if (concurrencyFull) lastError = "concurrency limit reached";
    return {
      modelKey,
      available,
      rateLimitedUntil: rateLimited ? this.clock() + 1000 : null,
      circuitOpen,
      lastError,
    };
  }

  /**
   * Build a ModelHealth map for every (modelKey, provider) pair. Useful as
   * the `health` input to {@link Router.route}.
   */
  snapshotsFor(
    models: readonly ModelCapabilitySnapshot[],
  ): Readonly<Record<ModelKey, ModelHealth>> {
    const out: Record<string, ModelHealth> = {};
    for (const m of models) {
      out[m.modelKey] = this.snapshot(m.modelKey, m.providerId);
    }
    return out as Readonly<Record<ModelKey, ModelHealth>>;
  }

  /** Record a successful request to the provider (closes the breaker). */
  recordSuccess(provider: string): void {
    this.circuitBreaker.recordSuccess(provider);
  }

  /** Record a failed request to the provider (may open the breaker). */
  recordFailure(provider: string): void {
    this.circuitBreaker.recordFailure(provider);
  }

  /**
   * Admit a request: consume a rate-limit token and a concurrency slot.
   * Returns true if admitted; false otherwise. On failure the caller must
   * call `release(provider)` when the request finishes (success or failure).
   */
  admit(provider: string): boolean {
    if (!this.circuitBreaker.isOpen(provider) && this.rateLimiter.acquire(provider, 1)) {
      if (this.concurrencyLimiter.acquire(provider)) {
        return true;
      }
      // Concurrency full — return the rate-limit token.
      this.rateLimiter.release(provider, 1);
    }
    return false;
  }

  /** Release a previously admitted request's rate-limit + concurrency slot. */
  release(provider: string): void {
    this.rateLimiter.release(provider, 1);
    this.concurrencyLimiter.release(provider);
  }
}

// ────────────────────────── Phase 8 Exports (§26, §38) ──────────────────────────

export * from "./profile_registry.js";
export * from "./posterior.js";
export * from "./stage_router.js";
export * from "./continuation.js";
