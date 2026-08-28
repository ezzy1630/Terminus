/**
 * @terminus/model-router — Stage-Aware Deterministic Router.
 *
 * Per SPEC §26.4: Stage-aware deterministic routing selects model profiles
 * based on workflow node role/stage (classifier, implementer, reviewer, specialist,
 * vision, local_safe), empirical posteriors, circuit breakers, rate limits,
 * and confidentiality policy.
 */
import { z } from "zod";
import type { ModelProfile, RouteDecisionV2, Rfc3339Timestamp, TokenCount } from "@terminus/domain";
import { routeDecisionV2Schema, nowTimestamp, rfc3339Schema } from "@terminus/domain";
import type { ProfileRegistry } from "./profile_registry.js";
import type { PosteriorTracker } from "./posterior.js";
import type { RateLimiter } from "./index.js";
import type { CircuitBreaker } from "./index.js";
import type { ConcurrencyLimiter } from "./index.js";

export type StageRole =
  | "classifier"
  | "implementer"
  | "reviewer"
  | "specialist"
  | "vision"
  | "local_safe";

export interface StageRouteInputs {
  readonly stage: StageRole;
  readonly confidentiality: "public" | "workspace" | "secret_adjacent" | "secret";
  readonly allowedAdapterRefs?: readonly string[];
  readonly implementerModelFamilyRef?: string | null;
  readonly budgetMaxMicros?: bigint | null;
  readonly maxLatencyMs?: number | null;
  readonly requireOffline?: boolean;
  /** Forecasts are optional on the deterministic serving path. */
  readonly predictedInputTokens?: TokenCount | null;
  readonly predictedOutputTokens?: TokenCount | null;
  readonly predictedCacheReadTokens?: TokenCount | null;
}

export interface ShadowRoutingInputs extends StageRouteInputs {
  readonly observationId: string;
  readonly taskId: string;
  readonly cohort: string;
  readonly featureVersion: string;
  readonly taskFeatures: Readonly<Record<string, string | number | boolean>>;
  readonly servingDecision: RouteDecisionV2;
  readonly predictedInputTokens: TokenCount;
  readonly predictedOutputTokens: TokenCount;
  readonly predictedCacheReadTokens?: TokenCount | null;
  readonly observedAt?: Rfc3339Timestamp;
}

export interface ShadowRoutingObservation {
  readonly schemaVersion: "terminus.routing.shadow.v1";
  readonly observationId: string;
  readonly taskId: string;
  readonly cohort: string;
  readonly featureVersion: string;
  readonly taskFeatures: Readonly<Record<string, string | number | boolean>>;
  readonly servingModelKey: string | null;
  readonly shadowModelKey: string | null;
  readonly shadowDecision: RouteDecisionV2;
  readonly candidateUncertainty: Readonly<Record<string, number>>;
  readonly predictedInputTokens: TokenCount;
  readonly predictedOutputTokens: TokenCount;
  readonly predictedCacheReadTokens: TokenCount;
  readonly predictedCostMicros: bigint;
  readonly observedAt: Rfc3339Timestamp;
  /** Filled by a verified execution; shadow routing never supplies it. */
  readonly outcome: "unobserved";
}

export const shadowRoutingObservationSchema = z.object({
  schemaVersion: z.literal("terminus.routing.shadow.v1"),
  observationId: z.string().min(1),
  taskId: z.string().min(1),
  cohort: z.string().min(1),
  featureVersion: z.string().min(1),
  taskFeatures: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  servingModelKey: z.string().nullable(),
  shadowModelKey: z.string().nullable(),
  shadowDecision: routeDecisionV2Schema,
  candidateUncertainty: z.record(z.string(), z.number().min(0).max(1)),
  predictedInputTokens: z.bigint().nonnegative(),
  predictedOutputTokens: z.bigint().nonnegative(),
  predictedCacheReadTokens: z.bigint().nonnegative(),
  predictedCostMicros: z.bigint().nonnegative(),
  observedAt: rfc3339Schema,
  outcome: z.literal("unobserved"),
}).strict();

/**
 * Process-local observation sink for experiments. It is deliberately not
 * connected to serving or promotion; a durable caller may persist the
 * immutable records returned by `all`.
 */
export class ShadowRoutingRecorder {
  private readonly observations = new Map<string, ShadowRoutingObservation>();

  record(observation: ShadowRoutingObservation): void {
    const validated = shadowRoutingObservationSchema.parse(observation) as unknown as ShadowRoutingObservation;
    const existing = this.observations.get(validated.observationId);
    if (existing !== undefined) {
      const encode = (value: ShadowRoutingObservation): string => JSON.stringify(value, (_key, nested) =>
        typeof nested === "bigint" ? nested.toString() : nested,
      );
      if (encode(existing) !== encode(validated)) {
        throw new Error(`shadow observation '${validated.observationId}' conflicts with an existing record`);
      }
      return;
    }
    this.observations.set(validated.observationId, validated);
  }

  all(): readonly ShadowRoutingObservation[] {
    return Array.from(this.observations.values());
  }
}

export interface StageRouterControls {
  readonly rateLimiter?: RateLimiter;
  readonly circuitBreaker?: CircuitBreaker;
  readonly concurrencyLimiter?: ConcurrencyLimiter;
}

export class StageRouter {
  constructor(
    private readonly registry: ProfileRegistry,
    private readonly posteriorTracker: PosteriorTracker,
    private readonly controls: StageRouterControls = {},
  ) {}

  /**
   * Select best model profile for the requested stage and constraints.
   */
  route(input: StageRouteInputs): RouteDecisionV2 {
    let candidates = this.registry.listAll();

    // Filter by confidentiality
    candidates = candidates.filter((p) =>
      p.allowedConfidentiality.includes(input.confidentiality),
    );

    // Filter by offline requirement
    if (input.requireOffline || input.stage === "local_safe" || input.confidentiality === "secret") {
      candidates = candidates.filter((p) => p.capabilities.offlineExecution);
    }

    // Filter by caller-authorized opaque adapter references.
    if (input.allowedAdapterRefs && input.allowedAdapterRefs.length > 0) {
      const allowedAdapterRefs = new Set(input.allowedAdapterRefs);
      candidates = candidates.filter((profile) => allowedAdapterRefs.has(profile.adapterRef));
    }

    // Filter by stage-specific requirements
    if (input.stage === "vision") {
      candidates = candidates.filter((p) => p.capabilities.imageInput);
    }
    if (input.stage === "implementer") {
      candidates = candidates.filter((p) => p.capabilities.codingQuality === "high");
    }
    if (input.stage === "specialist") {
      candidates = candidates.filter(
        (p) =>
          p.capabilities.reasoningStrength === "high" ||
          p.capabilities.securityReasoning === "high",
      );
    }

    // Score eligible candidates
    const scoredCandidates: Array<{ profile: ModelProfile; score: number }> = [];
    const candidateScoresRecord: Record<string, number> = {};

    for (const profile of candidates) {
      const expectedCostMicros = this.expectedCostMicros(profile, input);
      const expectedLatencyMs = this.expectedLatencyMs(profile);

      if (
        input.budgetMaxMicros !== undefined &&
        input.budgetMaxMicros !== null &&
        expectedCostMicros > input.budgetMaxMicros
      ) {
        candidateScoresRecord[profile.id] = -999.0;
        continue;
      }
      if (
        input.maxLatencyMs !== undefined &&
        input.maxLatencyMs !== null &&
        expectedLatencyMs > input.maxLatencyMs
      ) {
        candidateScoresRecord[profile.id] = -999.0;
        continue;
      }

      // Check circuit breaker and rate limit
      const cbOpen = this.controls.circuitBreaker?.isOpen(profile.adapterRef) ?? false;
      const rateAvailable = this.controls.rateLimiter?.canAcquire(profile.adapterRef, 1) ?? true;
      const concAvailable = this.controls.concurrencyLimiter?.available(profile.adapterRef) ?? true;

      if (cbOpen || !rateAvailable || !concAvailable) {
        candidateScoresRecord[profile.id] = -999.0;
        continue;
      }

      const score = this.scoreProfile(profile, input);
      candidateScoresRecord[profile.id] = score;
      scoredCandidates.push({ profile, score });
    }

    scoredCandidates.sort((a, b) => {
      const scoreOrder = b.score - a.score;
      if (scoreOrder !== 0) return scoreOrder;
      if (a.profile.id === b.profile.id) return 0;
      return a.profile.id < b.profile.id ? -1 : 1;
    });

    const chosen = scoredCandidates.length > 0 && scoredCandidates[0]!.score > -900.0
      ? scoredCandidates[0]!.profile
      : null;

    const fallbackProfileIds = scoredCandidates
      .slice(1)
      .filter((c) => c.score > -900.0)
      .map((c) => c.profile.id);

    const expectedCostMicros = chosen
      ? this.expectedCostMicros(chosen, input)
      : 0n;

    const expectedLatencyMs = chosen
      ? this.expectedLatencyMs(chosen)
      : 0;

    const decision: RouteDecisionV2 = {
      stage: input.stage,
      chosenProfileId: chosen ? chosen.id : null,
      chosenModelKey: chosen ? chosen.modelKey : null,
      reason: chosen
        ? `Stage '${input.stage}': selected ${chosen.id} (score ${scoredCandidates[0]!.score.toFixed(3)})`
        : `Stage '${input.stage}': no eligible profile found satisfying constraints`,
      candidateScores: candidateScoresRecord,
      fallbackProfileIds,
      expectedCostMicros,
      expectedLatencyMs,
      timestamp: nowTimestamp(),
    };

    return routeDecisionV2Schema.parse(decision) as unknown as RouteDecisionV2;
  }

  /**
 * Produce an observation for an experimental shadow decision. The supplied
 * serving decision remains authoritative; this method does not alter the
 * result of the deterministic serving path or update posterior observations.
   */
  shadowRoute(input: ShadowRoutingInputs): ShadowRoutingObservation {
    if (!input.observationId || !input.taskId || !input.cohort || !input.featureVersion) {
      throw new Error("shadow routing identity fields are required");
    }
    const shadowDecision = this.route(input);
    const candidateUncertainty: Record<string, number> = {};
    for (const profile of this.registry.listAll()) {
      candidateUncertainty[profile.id] = this.posteriorTracker
        .getExpectedMetricsIfObserved(profile.modelKey)?.uncertainty ?? 1;
    }
    const shadowProfile = shadowDecision.chosenModelKey === null
      ? null
      : this.registry.listAll().find((profile) => profile.modelKey === shadowDecision.chosenModelKey) ?? null;
    if (shadowDecision.chosenModelKey !== null && shadowProfile === null) {
      throw new Error(`shadow route selected unknown model '${shadowDecision.chosenModelKey}'`);
    }
    const observation: ShadowRoutingObservation = {
      schemaVersion: "terminus.routing.shadow.v1",
      observationId: input.observationId,
      taskId: input.taskId,
      cohort: input.cohort,
      featureVersion: input.featureVersion,
      taskFeatures: input.taskFeatures,
      servingModelKey: input.servingDecision.chosenModelKey,
      shadowModelKey: shadowDecision.chosenModelKey,
      shadowDecision,
      candidateUncertainty,
      predictedInputTokens: input.predictedInputTokens,
      predictedOutputTokens: input.predictedOutputTokens,
      predictedCacheReadTokens: input.predictedCacheReadTokens ?? 0n as TokenCount,
      predictedCostMicros: shadowDecision.chosenModelKey === null
        ? 0n
        : this.expectedCostMicros(shadowProfile!, input),
      observedAt: input.observedAt ?? nowTimestamp(),
      outcome: "unobserved",
    };
    return shadowRoutingObservationSchema.parse(observation) as unknown as ShadowRoutingObservation;
  }

  private scoreProfile(profile: ModelProfile, input: StageRouteInputs): number {
    const post = this.posteriorTracker.getExpectedMetricsIfObserved(profile.modelKey) ?? {
      expectedToolReliability: 0.5,
      expectedStructuredSuccess: 0.5,
      expectedEditSuccess: 0.5,
      expectedLatencyMs: profile.latencyModel.p50Ms,
      expectedCostMicros: 0n,
      expectedCacheHitRate: 0,
      uncertainty: 1,
    };
    const effectiveLatency = this.posteriorTracker.hasObserved(profile.modelKey)
      ? post.expectedLatencyMs
      : profile.latencyModel.p50Ms;
    let score = 0;

    // Reliability from posterior (30%)
    const reliability = (post.expectedToolReliability + post.expectedStructuredSuccess + post.expectedEditSuccess) / 3;
    score += 0.3 * reliability;

    // Stage affinity (30%)
    switch (input.stage) {
      case "classifier":
        // Fast, low latency preferred
        score += 0.3 * (1 - Math.min(1, effectiveLatency / 1500));
        break;
      case "implementer":
        // High edit success and tool reliability
        score += 0.2 * post.expectedEditSuccess + 0.1 * post.expectedToolReliability;
        break;
      case "reviewer":
        // Family diversity preference (+0.25 bonus for different family)
        if (
          input.implementerModelFamilyRef &&
          input.implementerModelFamilyRef !== profile.modelFamilyRef
        ) {
          score += 0.25;
        }
        score += 0.05 * (profile.capabilities.securityReasoning === "high" ? 1 : 0.5);
        break;
      case "specialist":
        // High reasoning
        score += profile.capabilities.reasoningStrength === "high" ? 0.3 : 0.1;
        break;
      case "vision":
        score += profile.capabilities.imageInput ? 0.3 : -1.0;
        break;
      case "local_safe":
        score += profile.capabilities.offlineExecution ? 0.3 : -1.0;
        break;
    }

    // Cost efficiency (20%). With forecasts this is token-weighted; without
    // forecasts expectedCostMicros retains the historical profile-rate prior.
    const cost = Number(this.expectedCostMicros(profile, input));
    score += 0.2 * (1 - Math.min(1, cost / 20_000_000));

    // Latency (10%)
    score += 0.1 * (1 - Math.min(1, effectiveLatency / 5000));

    // Cache advantage (10%)
    score += 0.1 * post.expectedCacheHitRate;

    return score;
  }

  private expectedCostMicros(profile: ModelProfile, input: StageRouteInputs): bigint {
    if (input.predictedInputTokens === undefined || input.predictedInputTokens === null
      || input.predictedOutputTokens === undefined || input.predictedOutputTokens === null) {
      return (
        profile.economics.inputMicrosPerMillion + profile.economics.outputMicrosPerMillion
      ) / 100n;
    }
    const inputTokens = input.predictedInputTokens;
    const outputTokens = input.predictedOutputTokens;
    const cacheReadTokens = input.predictedCacheReadTokens ?? 0n;
    const boundedCacheReadTokens = cacheReadTokens > inputTokens ? inputTokens : cacheReadTokens;
    const uncachedInputTokens = inputTokens - boundedCacheReadTokens;
    const million = 1_000_000n;
    return (
      (uncachedInputTokens * profile.economics.inputMicrosPerMillion)
      + (boundedCacheReadTokens * profile.economics.cachedInputMicrosPerMillion)
      + (outputTokens * profile.economics.outputMicrosPerMillion)
    ) / million;
  }

  private expectedLatencyMs(profile: ModelProfile): number {
    return this.posteriorTracker.hasObserved(profile.modelKey)
      ? this.posteriorTracker.getExpectedMetrics(profile.modelKey).expectedLatencyMs
      : profile.latencyModel.p50Ms;
  }
}
