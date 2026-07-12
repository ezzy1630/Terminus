/**
 * @terminus/model-router — tests for RateLimiter, CircuitBreaker,
 * ConcurrencyLimiter, ModelHealthMonitor (§38.15), and router integration.
 */
import { describe, test, expect } from "bun:test";
import type { ModelKey, RiskClass, Micros } from "@terminus/domain";
import { micros } from "@terminus/domain";
import type {
  ModelCapabilitySnapshot,
  ProviderCapabilitySnapshot,
  ConfidentialityPolicy,
} from "@terminus/provider-core";
import {
  Router,
  RateLimiter,
  CircuitBreaker,
  ConcurrencyLimiter,
  ModelHealthMonitor,
  DEFAULT_RATE_LIMITER_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type RouterInputs,
  type RouteProfile,
  type ModelHealth,
} from "./index.js";

function mkModel(providerId: string, model: string): ModelCapabilitySnapshot {
  const snap: ProviderCapabilitySnapshot = {
    providerId,
    observedAt: "2024-01-01T00:00:00Z",
    source: "test",
    context: {
      advertisedTokens: 128_000,
      testedSafeTokens: 128_000,
      roleSupport: ["system", "user", "assistant", "tool"],
      imageInput: false,
      toolCalling: true,
      parallelToolCalls: true,
      structuredOutput: true,
    },
    continuation: {
      nativeId: true,
      crossRequest: true,
      compaction: true,
      compatibilityKey: `${providerId}-v1`,
    },
    caching: {
      mode: "automatic_prefix",
      exactPrefixRequired: true,
      minimumTokens: 1024,
      ttlOptions: [],
      toolOrderSensitive: false,
      usageReporting: true,
    },
    reasoning: { supported: true, budgetControl: true, summaryAvailable: true },
    economics: {
      inputMicrosPerMillion: micros(1_000_000),
      cachedInputMicrosPerMillion: micros(500_000),
      outputMicrosPerMillion: micros(2_000_000),
      reasoningAccounting: true,
    },
    reliability: {
      toolCallSuccess: 0.95,
      structuredOutputSuccess: 0.95,
      editCohortSuccess: 0.9,
      latencyPercentiles: { p50: 1000, p99: 5000 },
    },
    policy: {
      allowedConfidentiality: ["public", "workspace"],
      retentionMode: "none",
      region: null,
    },
  };
  return {
    modelKey: `${providerId}/${model}` as ModelKey,
    providerId,
    snapshot: snap,
    observedAt: "2024-01-01T00:00:00Z",
  };
}

function mkRouteProfile(): RouteProfile {
  return {
    role: "implementer",
    minimum: {
      codingQuality: "medium",
      toolReliability: "medium",
      structuredOutput: "optional",
      context: "medium",
      securityReasoning: null,
      highRecall: null,
    },
    preferences: { latency: null, cost: null, providerDiversity: null, differentFamilyFromImplementer: null },
    policy: { confidentiality: "workspace", allowedProviders: [] },
    fallback: { maxAttempts: 2, requireUserOnSemanticDowngrade: true },
  };
}

function mkConfidentialityPolicy(): ConfidentialityPolicy {
  return {
    allowedProviders: {
      public: ["openai", "anthropic", "google"],
      workspace: ["openai", "anthropic", "google"],
      secret_adjacent: ["anthropic"],
      secret: [],
    },
  };
}

function mkInputs(
  models: readonly ModelCapabilitySnapshot[],
  overrides: Partial<RouterInputs> = {},
): RouterInputs {
  const health: Record<string, ModelHealth> = {};
  for (const m of models) {
    health[m.modelKey] = {
      modelKey: m.modelKey,
      available: true,
      rateLimitedUntil: null,
      circuitOpen: false,
      lastError: null,
    };
  }
  return {
    profile: mkRouteProfile(),
    models,
    health,
    cohortStats: {},
    confidentialityPolicy: mkConfidentialityPolicy(),
    previousAttemptModel: null,
    implementerModel: null,
    riskClass: "normal" as RiskClass,
    ...overrides,
  };
}

// ────────────────────────── RateLimiter ──────────────────────────────────────

describe("RateLimiter", () => {
  test("acquire consumes tokens; release returns them", () => {
    let now = 1_000_000;
    const r = new RateLimiter(
      { capacity: 3, refillPerSecond: 0 },
      () => now,
    );
    expect(r.acquire("openai", 1)).toBe(true);
    expect(r.acquire("openai", 1)).toBe(true);
    expect(r.acquire("openai", 1)).toBe(true);
    expect(r.acquire("openai", 1)).toBe(false); // exhausted
    r.release("openai", 1);
    expect(r.acquire("openai", 1)).toBe(true);
  });

  test("canAcquire is a non-consuming probe", () => {
    let now = 1_000_000;
    const r = new RateLimiter(
      { capacity: 1, refillPerSecond: 0 },
      () => now,
    );
    expect(r.canAcquire("openai", 1)).toBe(true);
    expect(r.canAcquire("openai", 1)).toBe(true);
    expect(r.acquire("openai", 1)).toBe(true);
    expect(r.canAcquire("openai", 1)).toBe(false);
  });

  test("refills over time", () => {
    let now = 1_000_000;
    const r = new RateLimiter(
      { capacity: 1, refillPerSecond: 1 },
      () => now,
    );
    expect(r.acquire("openai", 1)).toBe(true);
    expect(r.acquire("openai", 1)).toBe(false);
    now += 1100; // >1 second later, refilled.
    expect(r.acquire("openai", 1)).toBe(true);
  });

  test("per-provider isolation", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(r.acquire("openai", 1)).toBe(true);
    expect(r.acquire("anthropic", 1)).toBe(true);
    expect(r.acquire("openai", 1)).toBe(false);
    expect(r.acquire("anthropic", 1)).toBe(false);
  });

  test("DEFAULT_RATE_LIMITER_CONFIG has positive capacity", () => {
    expect(DEFAULT_RATE_LIMITER_CONFIG.capacity).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMITER_CONFIG.refillPerSecond).toBeGreaterThan(0);
  });
});

// ────────────────────────── CircuitBreaker ───────────────────────────────────

describe("CircuitBreaker", () => {
  test("opens after failureThreshold consecutive failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 1, cooldownMs: 1000 });
    expect(cb.isOpen("openai")).toBe(false);
    cb.recordFailure("openai");
    cb.recordFailure("openai");
    expect(cb.isOpen("openai")).toBe(false);
    cb.recordFailure("openai");
    expect(cb.isOpen("openai")).toBe(true);
  });

  test("transitions to half-open after cooldown", () => {
    let now = 1_000_000;
    const cb = new CircuitBreaker(
      { failureThreshold: 1, successThreshold: 1, cooldownMs: 100 },
      () => now,
    );
    cb.recordFailure("openai");
    expect(cb.isOpen("openai")).toBe(true);
    now += 200; // past cooldown
    expect(cb.isOpen("openai")).toBe(false);
    expect(cb.isHalfOpen("openai")).toBe(true);
  });

  test("half-open success closes the breaker", () => {
    let now = 1_000_000;
    const cb = new CircuitBreaker(
      { failureThreshold: 1, successThreshold: 1, cooldownMs: 100 },
      () => now,
    );
    cb.recordFailure("openai");
    now += 200;
    cb.recordSuccess("openai"); // half-open → closed
    expect(cb.isOpen("openai")).toBe(false);
    expect(cb.isHalfOpen("openai")).toBe(false);
    expect(cb.state("openai")).toBe("closed");
  });

  test("half-open failure re-opens the breaker", () => {
    let now = 1_000_000;
    const cb = new CircuitBreaker(
      { failureThreshold: 1, successThreshold: 1, cooldownMs: 100 },
      () => now,
    );
    cb.recordFailure("openai");
    now += 200;
    cb.recordFailure("openai"); // half-open → open
    expect(cb.isOpen("openai")).toBe(true);
  });

  test("successes reset the failure counter", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, successThreshold: 1, cooldownMs: 1000 });
    cb.recordFailure("openai");
    cb.recordFailure("openai");
    cb.recordSuccess("openai"); // reset
    cb.recordFailure("openai");
    cb.recordFailure("openai");
    expect(cb.isOpen("openai")).toBe(false); // only 2 failures since reset
  });

  test("reset force-closes the breaker", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, cooldownMs: 1000 });
    cb.recordFailure("openai");
    expect(cb.isOpen("openai")).toBe(true);
    cb.reset("openai");
    expect(cb.isOpen("openai")).toBe(false);
  });

  test("DEFAULT_CIRCUIT_BREAKER_CONFIG has positive thresholds", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBeGreaterThan(0);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.successThreshold).toBeGreaterThan(0);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs).toBeGreaterThan(0);
  });
});

// ────────────────────────── ConcurrencyLimiter ───────────────────────────────

describe("ConcurrencyLimiter", () => {
  test("admits up to limit, then rejects", () => {
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 2);
    expect(cl.acquire("openai")).toBe(true);
    expect(cl.acquire("openai")).toBe(true);
    expect(cl.acquire("openai")).toBe(false);
  });

  test("release frees a slot", () => {
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 1);
    expect(cl.acquire("openai")).toBe(true);
    expect(cl.acquire("openai")).toBe(false);
    cl.release("openai");
    expect(cl.acquire("openai")).toBe(true);
  });

  test("release is idempotent (clamps at 0)", () => {
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 2);
    cl.release("openai");
    cl.release("openai");
    expect(cl.count("openai")).toBe(0);
  });

  test("per-provider isolation", () => {
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 1);
    cl.setLimit("anthropic", 1);
    expect(cl.acquire("openai")).toBe(true);
    expect(cl.acquire("anthropic")).toBe(true);
    expect(cl.acquire("openai")).toBe(false);
    expect(cl.acquire("anthropic")).toBe(false);
  });

  test("rejects negative limit", () => {
    const cl = new ConcurrencyLimiter();
    expect(() => cl.setLimit("openai", -1)).toThrow();
  });
});

// ────────────────────────── ModelHealthMonitor ───────────────────────────────

describe("ModelHealthMonitor", () => {
  test("snapshot reflects all three controls", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, cooldownMs: 1000 });
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 1);
    const mon = new ModelHealthMonitor(rl, cb, cl);
    // Healthy.
    let h = mon.snapshot("openai/gpt-4" as ModelKey, "openai");
    expect(h.available).toBe(true);
    expect(h.circuitOpen).toBe(false);
    // Open the circuit breaker.
    cb.recordFailure("openai");
    h = mon.snapshot("openai/gpt-4" as ModelKey, "openai");
    expect(h.available).toBe(false);
    expect(h.circuitOpen).toBe(true);
  });

  test("admit consumes tokens and slots; release returns them", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    const cb = new CircuitBreaker({ failureThreshold: 5, successThreshold: 1, cooldownMs: 1000 });
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 1);
    const mon = new ModelHealthMonitor(rl, cb, cl);
    expect(mon.admit("openai")).toBe(true);
    expect(mon.admit("openai")).toBe(false); // both rate and concurrency full
    mon.release("openai");
    expect(mon.admit("openai")).toBe(true);
  });

  test("snapshotsFor produces a health map for the router", () => {
    const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1 });
    const cb = new CircuitBreaker();
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 5);
    const mon = new ModelHealthMonitor(rl, cb, cl);
    const models = [mkModel("openai", "gpt-4"), mkModel("anthropic", "claude")];
    const map = mon.snapshotsFor(models);
    const openaiHealth = map["openai/gpt-4" as ModelKey];
    const anthropicHealth = map["anthropic/claude" as ModelKey];
    expect(openaiHealth).toBeDefined();
    expect(anthropicHealth).toBeDefined();
    expect(openaiHealth!.available).toBe(true);
  });
});

// ────────────────────────── Router integration with controls ─────────────────

describe("Router.route with controls", () => {
  test("skips providers with open circuit breakers", () => {
    const models = [mkModel("openai", "gpt-4"), mkModel("anthropic", "claude")];
    const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1 });
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, cooldownMs: 10_000 });
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 5);
    cl.setLimit("anthropic", 5);
    // Open OpenAI's breaker.
    cb.recordFailure("openai");
    const router = new Router();
    const decision = router.route(mkInputs(models, {
      controls: { rateLimiter: rl, circuitBreaker: cb, concurrencyLimiter: cl },
    }));
    expect(decision.chosen).not.toBeNull();
    expect(decision.chosen!.providerId).toBe("anthropic");
  });

  test("skips providers with exhausted rate limits", () => {
    const models = [mkModel("openai", "gpt-4"), mkModel("anthropic", "claude")];
    const rl = new RateLimiter({ capacity: 0, refillPerSecond: 0 });
    const cb = new CircuitBreaker();
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 5);
    cl.setLimit("anthropic", 5);
    const router = new Router();
    const decision = router.route(mkInputs(models, {
      controls: { rateLimiter: rl, circuitBreaker: cb, concurrencyLimiter: cl },
    }));
    // Both providers have 0-capacity rate limits → no eligible model.
    expect(decision.chosen).toBeNull();
  });

  test("skips providers with saturated concurrency", () => {
    const models = [mkModel("openai", "gpt-4"), mkModel("anthropic", "claude")];
    const rl = new RateLimiter({ capacity: 10, refillPerSecond: 1 });
    const cb = new CircuitBreaker();
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 0); // zero concurrency
    cl.setLimit("anthropic", 5);
    const router = new Router();
    const decision = router.route(mkInputs(models, {
      controls: { rateLimiter: rl, circuitBreaker: cb, concurrencyLimiter: cl },
    }));
    expect(decision.chosen).not.toBeNull();
    expect(decision.chosen!.providerId).toBe("anthropic");
  });

  test("reasons include circuit-breaker and rate-limit info", () => {
    const models = [mkModel("openai", "gpt-4")];
    const rl = new RateLimiter({ capacity: 0, refillPerSecond: 0 });
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, cooldownMs: 10_000 });
    const cl = new ConcurrencyLimiter();
    cl.setLimit("openai", 5);
    cb.recordFailure("openai");
    const router = new Router();
    const decision = router.route(mkInputs(models, {
      controls: { rateLimiter: rl, circuitBreaker: cb, concurrencyLimiter: cl },
    }));
    const candidate = decision.candidates.find((c) => c.model.providerId === "openai")!;
    expect(candidate.reasons).toContain("circuit breaker open for provider 'openai'");
    expect(candidate.reasons).toContain("rate limit exhausted for provider 'openai'");
  });
});
