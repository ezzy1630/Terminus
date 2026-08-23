/**
 * @terminus/model-router — tests for ModelProfile, ProfileRegistry,
 * PosteriorTracker, StageRouter, and ProviderContinuationManager (SPEC §26).
 */
import { describe, test, expect } from "bun:test";
import { modelProfileSchema, routeDecisionV2Schema, modelCohortPosteriorSchema, providerContinuationSchema } from "@terminus/domain";
import {
  STANDARD_MODEL_PROFILES,
  CLAUDE_3_7_SONNET_PROFILE,
  GPT_4O_PROFILE,
  GEMINI_2_0_FLASH_PROFILE,
  LOCAL_LLAMA_3_3_70B_PROFILE,
  ProfileRegistry,
  PosteriorTracker,
  StageRouter,
  ProviderContinuationManager,
  CircuitBreaker,
} from "./index.js";

describe("Phase 8 Model Profiles & Registry", () => {
  test("all standard model profiles pass schema validation", () => {
    expect(STANDARD_MODEL_PROFILES.length).toBeGreaterThanOrEqual(9);
    for (const profile of STANDARD_MODEL_PROFILES) {
      const parsed = modelProfileSchema.safeParse(profile);
      expect(parsed.success).toBe(true);
    }
  });

  test("ProfileRegistry resolves pinned profiles and filters correctly", () => {
    const registry = new ProfileRegistry(STANDARD_MODEL_PROFILES);

    const sonnet = registry.getById(CLAUDE_3_7_SONNET_PROFILE.id);
    expect(sonnet).not.toBeNull();
    expect(sonnet?.modelKey).toBe("claude-3-7-sonnet-20250219");

    const pinned = registry.resolvePinned("openai", "gpt-4o-2024-11-20", "2024-11-20-v1");
    expect(pinned).not.toBeNull();
    expect(pinned?.id).toBe(GPT_4O_PROFILE.id);

    const localProfiles = registry.listLocalProfiles();
    expect(localProfiles.length).toBeGreaterThanOrEqual(3);
    for (const lp of localProfiles) {
      expect(lp.providerId).toBe("local");
    }

    const secretEligible = registry.listForConfidentiality("secret");
    expect(secretEligible.length).toBeGreaterThanOrEqual(3);
    for (const p of secretEligible) {
      expect(p.confidentialityPolicy).toContain("secret");
      expect(p.providerId).toBe("local");
    }
  });
});

describe("PosteriorTracker Bayesian Updating", () => {
  test("initializes neutral prior and updates Beta-Binomial and Log-Normal posterior", () => {
    const tracker = new PosteriorTracker();
    const modelKey = "claude-3-7-sonnet-20250219";

    const prior = tracker.getOrCreate(modelKey);
    expect(prior.sampleCount).toBe(0);
    expect(prior.toolCallAlpha).toBe(10.0);

    const updated = tracker.recordObservation({
      modelKey,
      toolCallsSucceeded: 5,
      toolCallsFailed: 0,
      structuredOutputSucceeded: true,
      editCohortSucceeded: true,
      latencyMs: 800,
      costMicros: 15_000n,
      cacheHitRate: 0.8,
    });

    expect(updated.sampleCount).toBe(1);
    expect(updated.toolCallAlpha).toBe(15.0);
    expect(updated.structuredOutputAlpha).toBe(11.0);
    expect(updated.observedCostMicros).toBe(15_000n);
    expect(updated.observedCacheHitRate).toBe(0.8);

    const metrics = tracker.getExpectedMetrics(modelKey);
    expect(metrics.expectedToolReliability).toBeGreaterThan(0.9);
    expect(metrics.expectedLatencyMs).toBeGreaterThan(0);
  });
});

describe("StageRouter Deterministic Routing", () => {
  test("routes classifier stage to fast low-latency model", () => {
    const registry = new ProfileRegistry(STANDARD_MODEL_PROFILES);
    const tracker = new PosteriorTracker();
    const router = new StageRouter(registry, tracker);

    const decision = router.route({
      stage: "classifier",
      confidentiality: "workspace",
    });

    expect(decision.chosenProfileId).not.toBeNull();
    expect(decision.stage).toBe("classifier");
    // Haiku or Flash should be top
    expect(
      decision.chosenProfileId?.includes("haiku") || decision.chosenProfileId?.includes("flash"),
    ).toBe(true);
  });

  test("routes reviewer stage preferring diverse family from implementer", () => {
    const registry = new ProfileRegistry(STANDARD_MODEL_PROFILES);
    const tracker = new PosteriorTracker();
    const router = new StageRouter(registry, tracker);

    const decision = router.route({
      stage: "reviewer",
      confidentiality: "workspace",
      implementerProviderId: "anthropic",
    });

    expect(decision.chosenProfileId).not.toBeNull();
    // Reviewer should NOT be anthropic when diversity preferred
    expect(decision.chosenProfileId?.startsWith("profile-anthropic")).toBe(false);
  });

  test("routes local_safe or secret confidentiality to local open-weight model", () => {
    const registry = new ProfileRegistry(STANDARD_MODEL_PROFILES);
    const tracker = new PosteriorTracker();
    const router = new StageRouter(registry, tracker);

    const decision = router.route({
      stage: "local_safe",
      confidentiality: "secret",
    });

    expect(decision.chosenProfileId).not.toBeNull();
    expect(decision.chosenProfileId?.startsWith("profile-local")).toBe(true);
  });

  test("bypasses tripped circuit breaker provider during routing", () => {
    const registry = new ProfileRegistry(STANDARD_MODEL_PROFILES);
    const tracker = new PosteriorTracker();
    const cb = new CircuitBreaker();
    cb.recordFailure("anthropic");
    cb.recordFailure("anthropic");
    cb.recordFailure("anthropic");
    cb.recordFailure("anthropic");
    cb.recordFailure("anthropic"); // Trips breaker

    const router = new StageRouter(registry, tracker, { circuitBreaker: cb });

    const decision = router.route({
      stage: "implementer",
      confidentiality: "workspace",
    });

    expect(decision.chosenProfileId).not.toBeNull();
    expect(decision.chosenProfileId?.startsWith("profile-anthropic")).toBe(false);
  });
});

describe("ProviderContinuationManager", () => {
  test("classifies provider errors properly and manages continuation state", () => {
    const mgr = new ProviderContinuationManager();

    const rateLimit = mgr.classifyFailure(new Error("Rate limit exceeded"), 429);
    expect(rateLimit.kind).toBe("rate_limit");
    expect(rateLimit.retryable).toBe(true);

    const quota = mgr.classifyFailure(new Error("Insufficient quota balance"), 402);
    expect(quota.kind).toBe("quota_exhausted");
    expect(quota.fallbackRecommended).toBe(true);

    const refusal = mgr.classifyFailure(new Error("Safety policy refusal"));
    expect(refusal.kind).toBe("model_refusal");
    expect(refusal.fallbackRecommended).toBe(true);

    const cont = mgr.recordContinuation({
      id: "cont-1",
      taskId: "task-1",
      modelKey: "claude-3-7-sonnet-20250219",
      inputManifestHash: "sha256:abc",
      toolStateEpoch: 1,
      continuationToken: "tok_123",
      lastFailureKind: "timeout",
    });

    expect(cont.id).toBe("cont-1");
    expect(cont.retryCount).toBe(0);
    expect(mgr.getContinuation("cont-1")?.continuationToken).toBe("tok_123");

    const retried = mgr.recordContinuation({
      id: "cont-1",
      taskId: "task-1",
      modelKey: "claude-3-7-sonnet-20250219",
      inputManifestHash: "sha256:abc",
      toolStateEpoch: 2,
    });
    expect(retried.retryCount).toBe(1);
  });
});
