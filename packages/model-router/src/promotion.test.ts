import { describe, expect, test } from "bun:test";
import {
  evaluateRouterPromotion,
  routerOutcomeRecordSchema,
  type RouterOutcomeRecord,
} from "./index.js";

function outcome(
  side: "baseline" | "candidate",
  pairId: string,
  overrides: Partial<RouterOutcomeRecord> = {},
): RouterOutcomeRecord {
  return routerOutcomeRecordSchema.parse({
    schemaVersion: "terminus.routing.outcome.v1",
    outcomeId: `${side}-${pairId}`,
    taskId: `task-${pairId}`,
    attemptId: `attempt-${side}-${pairId}`,
    pairId,
    cohort: "small-bugfix",
    assignment: side,
    profileId: side === "baseline" ? "profile:baseline" : "profile:candidate",
    modelKey: side === "baseline" ? "provider/model-a" : "provider/model-b",
    providerId: "provider",
    adapterRef: `adapter:${side}`,
    result: "success",
    qualityScore: 0.8,
    toolCallsSucceeded: 2,
    toolCallsFailed: 0,
    structuredOutputSucceeded: true,
    editCohortSucceeded: true,
    latencyMs: 100,
    costMicros: 1_000n,
    cacheHitRate: 0.5,
    providerReceipt: {
      receiptId: `receipt-${side}-${pairId}`,
      providerId: "provider",
      model: side === "baseline" ? "provider/model-a" : "provider/model-b",
      artifactRef: `artifact://receipt-${side}-${pairId}`,
      verified: true,
    },
    verificationArtifactRef: `artifact://verification-${side}-${pairId}`,
    verificationStatus: "verified",
    recordedAt: "2026-08-27T00:00:00Z",
    ...overrides,
  }) as unknown as RouterOutcomeRecord;
}

function pairedInput(overrides: Partial<Parameters<typeof evaluateRouterPromotion>[0]> = {}) {
  return {
    experimentId: "router-v2",
    cohort: "small-bugfix",
    baselineVersion: "baseline-v1",
    candidateVersion: "candidate-v2",
    evidenceId: "evidence-1",
    baseline: [outcome("baseline", "pair-1"), outcome("baseline", "pair-2")],
    candidate: [outcome("candidate", "pair-1"), outcome("candidate", "pair-2")],
    holdoutComplete: true,
    policy: { minimumPairs: 2 },
    ...overrides,
  };
}

describe("router promotion guardrails", () => {
  test("emits promotable paired evidence without enabling the candidate", () => {
    const result = evaluateRouterPromotion(pairedInput());

    expect(result.promotionEligible).toBe(true);
    expect(result.decision).toBe("promote");
    expect(result.shadowOnly).toBe(true);
    expect(result.defaultEnabled).toBe(false);
    expect(result.quality.meanDelta).toBe(0);
  });

  test("retains an experiment when the minimum paired cohort is incomplete", () => {
    const result = evaluateRouterPromotion({
      ...pairedInput(),
      baseline: [outcome("baseline", "pair-1")],
      candidate: [outcome("candidate", "pair-1")],
      policy: { minimumPairs: 20 },
    });

    expect(result.promotionEligible).toBe(false);
    expect(result.decision).toBe("retain_experimental");
    expect(result.gates.find((gate) => gate.name === "cohort")?.status).toBe("blocked");
  });

  test("rolls back measured quality regression and blocks unverified receipts", () => {
    const result = evaluateRouterPromotion(pairedInput({
      candidate: [
        outcome("candidate", "pair-1", { qualityScore: 0.4 }),
        outcome("candidate", "pair-2", { qualityScore: 0.4, providerReceipt: null }),
      ],
    }));

    expect(result.promotionEligible).toBe(false);
    expect(result.decision).toBe("rollback");
    expect(result.gates.find((gate) => gate.name === "paired_quality")?.status).toBe("fail");
    expect(result.gates.find((gate) => gate.name === "provider_receipts")?.status).toBe("blocked");
  });
});
