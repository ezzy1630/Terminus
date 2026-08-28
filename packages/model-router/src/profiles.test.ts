/**
 * @terminus/model-router — focused tests for injected neutral model profiles.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  micros,
  modelProfileSchema,
  type TokenCount,
  type ModelProfile,
} from "@terminus/domain";
import {
  CircuitBreaker,
  ModelProfileConflictError,
  PosteriorTracker,
  ProfileRegistry,
  ProviderContinuationManager,
  StageRouter,
  ShadowRoutingRecorder,
  shadowRoutingObservationSchema,
} from "./index.js";

interface ProfileFixtureInput {
  readonly id: string;
  readonly adapterRef: string;
  readonly modelKey: string;
  readonly modelFamilyRef: string;
  readonly latencyMs: number;
  readonly costMicros: number;
  readonly codingQuality: "low" | "medium" | "high";
  readonly imageInput?: boolean;
  readonly reasoningStrength?: "none" | "low" | "medium" | "high";
  readonly offlineExecution?: boolean;
  readonly allowsSecret?: boolean;
}

function profileFixture(input: ProfileFixtureInput): ModelProfile {
  return modelProfileSchema.parse({
    id: input.id,
    adapterRef: input.adapterRef,
    renderingProfileRef: `rendering:${input.id}`,
    modelKey: input.modelKey,
    version: "profile-v1",
    modelFamilyRef: input.modelFamilyRef,
    economics: {
      inputMicrosPerMillion: micros(input.costMicros),
      cachedInputMicrosPerMillion: micros(Math.floor(input.costMicros / 2)),
      outputMicrosPerMillion: micros(input.costMicros * 4),
      reasoningAccounting: input.reasoningStrength === "high",
    },
    latencyModel: {
      p50Ms: input.latencyMs,
      p90Ms: input.latencyMs * 2,
      p99Ms: input.latencyMs * 4,
      ttftMs: Math.floor(input.latencyMs / 2),
    },
    allowedConfidentiality: input.allowsSecret
      ? ["public", "workspace", "secret_adjacent", "secret"]
      : ["public", "workspace", "secret_adjacent"],
    capabilities: {
      codingQuality: input.codingQuality,
      toolReliability: "high",
      structuredOutput: true,
      imageInput: input.imageInput ?? false,
      advertisedContextTokens: 128_000,
      testedSafeContextTokens: 100_000,
      securityReasoning: input.reasoningStrength === "high" ? "high" : "medium",
      reasoningStrength: input.reasoningStrength ?? "none",
      offlineExecution: input.offlineExecution ?? false,
    },
  }) as ModelProfile;
}

const FAST_PROFILE = profileFixture({
  id: "profile:fast",
  adapterRef: "adapter:remote-a",
  modelKey: "model-fast",
  modelFamilyRef: "family:a",
  latencyMs: 150,
  costMicros: 100_000,
  codingQuality: "medium",
});

const DEEP_PROFILE = profileFixture({
  id: "profile:deep",
  adapterRef: "adapter:remote-b",
  modelKey: "model-deep",
  modelFamilyRef: "family:b",
  latencyMs: 900,
  costMicros: 1_000_000,
  codingQuality: "high",
  imageInput: true,
  reasoningStrength: "high",
});

const OFFLINE_PROFILE = profileFixture({
  id: "profile:offline",
  adapterRef: "adapter:offline",
  modelKey: "model-offline",
  modelFamilyRef: "family:offline",
  latencyMs: 500,
  costMicros: 0,
  codingQuality: "high",
  reasoningStrength: "high",
  offlineExecution: true,
  allowsSecret: true,
});

const INJECTED_PROFILES = [
  FAST_PROFILE,
  DEEP_PROFILE,
  OFFLINE_PROFILE,
] as const;

describe("provider-neutral ModelProfile", () => {
  test("canonical schema exposes only opaque provider integration references", () => {
    const schemaJson = JSON.stringify(
      z.toJSONSchema(modelProfileSchema, { unrepresentable: "any" }),
    );
    const forbiddenCanonicalTerms = [
      "anthropic",
      "openai",
      "google",
      "gemini",
      "systemPromptPlacement",
      "toolDialect",
      "continuationStrategy",
      "cachingStrategy",
      "structuredOutputRepair",
    ];

    for (const term of forbiddenCanonicalTerms) {
      expect(schemaJson).not.toContain(term);
    }
  });

  test("strictly rejects provider rendering fields", () => {
    expect(
      modelProfileSchema.safeParse({
        ...FAST_PROFILE,
        providerId: "closed-vendor-id",
        toolDialect: "wire-dialect",
      }).success,
    ).toBe(false);
  });
});

describe("ProfileRegistry", () => {
  test("uses only profiles injected by the composition root", () => {
    const registry = new ProfileRegistry(INJECTED_PROFILES);

    expect(registry.listAll()).toHaveLength(3);
    expect(
      registry.resolvePinned("adapter:remote-b", "model-deep", "profile-v1")
        ?.id,
    ).toBe(DEEP_PROFILE.id);
    expect(registry.listByAdapter("adapter:remote-a")).toEqual([FAST_PROFILE]);
    expect(registry.listOfflineProfiles()).toEqual([OFFLINE_PROFILE]);
    expect(registry.listForConfidentiality("secret")).toEqual([
      OFFLINE_PROFILE,
    ]);
  });

  test("treats exact duplicates as idempotent and rejects descriptor replacement", () => {
    const registry = new ProfileRegistry([FAST_PROFILE]);

    expect(() => registry.register({ ...FAST_PROFILE })).not.toThrow();
    expect(registry.listAll()).toHaveLength(1);
    expect(() =>
      registry.register({
        ...FAST_PROFILE,
        renderingProfileRef: "rendering:replacement",
      }),
    ).toThrow(ModelProfileConflictError);
    expect(registry.getById(FAST_PROFILE.id)?.renderingProfileRef).toBe(
      FAST_PROFILE.renderingProfileRef,
    );
  });
});

describe("PosteriorTracker", () => {
  test("updates reliability, latency, cost, and cache observations", () => {
    const tracker = new PosteriorTracker();
    const prior = tracker.getOrCreate(FAST_PROFILE.modelKey);
    expect(prior.sampleCount).toBe(0);

    const updated = tracker.recordObservation({
      modelKey: FAST_PROFILE.modelKey,
      toolCallsSucceeded: 5,
      toolCallsFailed: 0,
      structuredOutputSucceeded: true,
      editCohortSucceeded: true,
      latencyMs: 800,
      costMicros: 15_000n,
      cacheHitRate: 0.8,
    });

    expect(updated.sampleCount).toBe(1);
    expect(updated.toolCallAlpha).toBe(6);
    expect(updated.observedCostMicros).toBe(15_000n);
    expect(
      tracker.getExpectedMetrics(FAST_PROFILE.modelKey).expectedLatencyMs,
    ).toBeGreaterThan(0);
  });
});

describe("StageRouter", () => {
  test("routes by neutral capability and adapter constraints", () => {
    const registry = new ProfileRegistry(INJECTED_PROFILES);
    const router = new StageRouter(registry, new PosteriorTracker());

    expect(
      router.route({ stage: "classifier", confidentiality: "workspace" })
        .chosenProfileId,
    ).toBe(FAST_PROFILE.id);
    expect(
      router.route({ stage: "vision", confidentiality: "workspace" })
        .chosenProfileId,
    ).toBe(DEEP_PROFILE.id);
    expect(
      router.route({ stage: "local_safe", confidentiality: "secret" })
        .chosenProfileId,
    ).toBe(OFFLINE_PROFILE.id);
    expect(
      router.route({
        stage: "implementer",
        confidentiality: "workspace",
        allowedAdapterRefs: [DEEP_PROFILE.adapterRef],
      }).chosenProfileId,
    ).toBe(DEEP_PROFILE.id);
    expect(
      router.route({
        stage: "reviewer",
        confidentiality: "workspace",
        implementerModelFamilyRef: DEEP_PROFILE.modelFamilyRef,
      }).chosenProfileId,
    ).not.toBe(DEEP_PROFILE.id);
  });

  test("emits a shadow observation without changing the serving decision", () => {
    const registry = new ProfileRegistry(INJECTED_PROFILES);
    const tracker = new PosteriorTracker();
    const router = new StageRouter(registry, tracker);
    const serving = router.route({
      stage: "implementer",
      confidentiality: "workspace",
      allowedAdapterRefs: ["adapter:remote-b"],
      predictedInputTokens: 10_000n as TokenCount,
      predictedOutputTokens: 2_000n as TokenCount,
      predictedCacheReadTokens: 4_000n as TokenCount,
    });
    const observation = router.shadowRoute({
      observationId: "shadow-1",
      taskId: "task-1",
      cohort: "tiny_bugfix",
      featureVersion: "features-v1",
      taskFeatures: { files_changed: 2, has_tests: true },
      servingDecision: serving,
      stage: "implementer",
      confidentiality: "workspace",
      allowedAdapterRefs: ["adapter:remote-b"],
      predictedInputTokens: 10_000n as TokenCount,
      predictedOutputTokens: 2_000n as TokenCount,
      predictedCacheReadTokens: 4_000n as TokenCount,
    });

    expect(observation.schemaVersion).toBe("terminus.routing.shadow.v1");
    expect(observation.servingModelKey).toBe(serving.chosenModelKey);
    expect(observation.outcome).toBe("unobserved");
    expect(observation.predictedCostMicros).toBe(16_000n);
    expect(observation.candidateUncertainty[FAST_PROFILE.id]).toBe(1);
    expect(shadowRoutingObservationSchema.safeParse(observation).success).toBe(true);
    const recorder = new ShadowRoutingRecorder();
    recorder.record(observation);
    recorder.record(observation);
    expect(recorder.all()).toHaveLength(1);
    expect(() => recorder.record({ ...observation, predictedCostMicros: observation.predictedCostMicros + 1n })).toThrow(
      "conflicts with an existing record",
    );
    expect(router.route({
      stage: "implementer",
      confidentiality: "workspace",
      allowedAdapterRefs: ["adapter:remote-b"],
    }).chosenModelKey)
      .toBe(serving.chosenModelKey);
  });

  test("keys health controls by opaque adapter reference", () => {
    const circuitBreaker = new CircuitBreaker();
    for (let failures = 0; failures < 5; failures += 1) {
      circuitBreaker.recordFailure(DEEP_PROFILE.adapterRef);
    }
    const router = new StageRouter(
      new ProfileRegistry(INJECTED_PROFILES),
      new PosteriorTracker(),
      { circuitBreaker },
    );

    expect(
      router.route({ stage: "implementer", confidentiality: "workspace" })
        .chosenProfileId,
    ).toBe(OFFLINE_PROFILE.id);
  });
});

describe("ProviderContinuationManager", () => {
  test("classifies failures and records opaque model continuations", () => {
    const manager = new ProviderContinuationManager();
    expect(
      manager.classifyFailure(new Error("Rate limit exceeded"), 429).kind,
    ).toBe("rate_limit");

    const continuation = manager.recordContinuation({
      id: "cont-1",
      taskId: "task-1",
      modelKey: FAST_PROFILE.modelKey,
      inputManifestHash: "sha256:abc",
      toolStateEpoch: 1,
      continuationToken: "token-1",
      lastFailureKind: "timeout",
    });

    expect(continuation.retryCount).toBe(0);
    expect(manager.getContinuation("cont-1")?.continuationToken).toBe(
      "token-1",
    );
  });
});
