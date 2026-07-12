/**
 * @forge/model-router — deterministic routing + escalation.
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
} from "@forge/domain";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ConfidentialityPolicy,
} from "@forge/provider-core";
import { isConfidentialityAllowed } from "@forge/provider-core";

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
      const reasons: string[] = [];
      if (!meetsMin) reasons.push("does not meet minimum capability requirements");
      if (!confOk) reasons.push(`confidentiality '${input.profile.policy.confidentiality}' not allowed for provider '${model.providerId}'`);
      if (!allowedProvider) reasons.push(`provider '${model.providerId}' not in allowed list`);
      if (!healthOk) reasons.push(`model '${model.modelKey}' unavailable or circuit open`);
      const score = meetsMin && confOk && allowedProvider && healthOk
        ? scoreModel(model, input)
        : -Infinity;
      eligible.push({ model, score, meetsMinimum: meetsMin && confOk && allowedProvider && healthOk, reasons });
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
