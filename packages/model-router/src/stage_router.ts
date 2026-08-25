/**
 * @terminus/model-router — Stage-Aware Deterministic Router.
 *
 * Per SPEC §26.4: Stage-aware deterministic routing selects model profiles
 * based on workflow node role/stage (classifier, implementer, reviewer, specialist,
 * vision, local_safe), empirical posteriors, circuit breakers, rate limits,
 * and confidentiality policy.
 */
import type { ModelProfile, RouteDecisionV2 } from "@terminus/domain";
import { routeDecisionV2Schema, nowTimestamp } from "@terminus/domain";
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
      const expectedCostMicros = this.expectedCostMicros(profile);
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
      ? this.expectedCostMicros(chosen)
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

  private scoreProfile(profile: ModelProfile, input: StageRouteInputs): number {
    const rawPost = this.posteriorTracker.getOrCreate(profile.modelKey);
    const post = this.posteriorTracker.getExpectedMetrics(profile.modelKey);
    const effectiveLatency = rawPost.sampleCount > 0 ? post.expectedLatencyMs : profile.latencyModel.p50Ms;
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

    // Cost efficiency (20%)
    const cost = Number(profile.economics.inputMicrosPerMillion + profile.economics.outputMicrosPerMillion);
    score += 0.2 * (1 - Math.min(1, cost / 20_000_000));

    // Latency (10%)
    score += 0.1 * (1 - Math.min(1, effectiveLatency / 5000));

    // Cache advantage (10%)
    score += 0.1 * post.expectedCacheHitRate;

    return score;
  }

  private expectedCostMicros(profile: ModelProfile): bigint {
    return (profile.economics.inputMicrosPerMillion + profile.economics.outputMicrosPerMillion) / 100n;
  }

  private expectedLatencyMs(profile: ModelProfile): number {
    const posterior = this.posteriorTracker.getOrCreate(profile.modelKey);
    return posterior.sampleCount > 0
      ? this.posteriorTracker.getExpectedMetrics(profile.modelKey).expectedLatencyMs
      : profile.latencyModel.p50Ms;
  }
}
