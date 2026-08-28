import { describe, expect, test } from "bun:test";
import {
  PosteriorTracker,
  routerOutcomeRecordSchema,
  type RouterOutcomeRecord,
} from "./index.js";

function verifiedOutcome(): RouterOutcomeRecord {
  return routerOutcomeRecordSchema.parse({
    schemaVersion: "terminus.routing.outcome.v1",
    outcomeId: "outcome-verified-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    pairId: "pair-1",
    cohort: "small-bugfix",
    assignment: "serving",
    profileId: "profile:fast",
    modelKey: "provider/model",
    providerId: "provider",
    adapterRef: "adapter:remote",
    result: "success",
    qualityScore: 0.9,
    toolCallsSucceeded: 2,
    toolCallsFailed: 0,
    structuredOutputSucceeded: true,
    editCohortSucceeded: true,
    latencyMs: 100,
    costMicros: 300n,
    cacheHitRate: 0.8,
    providerReceipt: {
      receiptId: "receipt-1",
      providerId: "provider",
      model: "provider/model",
      artifactRef: "artifact://receipt-1",
      verified: true,
    },
    verificationArtifactRef: "artifact://verification-1",
    verificationStatus: "verified",
    recordedAt: "2026-08-27T00:00:00Z",
  }) as unknown as RouterOutcomeRecord;
}

describe("router posterior calibration", () => {
  test("exposes conservative cost and latency uncertainty", () => {
    const tracker = new PosteriorTracker();
    tracker.recordObservation({
      modelKey: "provider/model",
      toolCallsSucceeded: 1,
      toolCallsFailed: 0,
      structuredOutputSucceeded: true,
      editCohortSucceeded: true,
      latencyMs: 100,
      costMicros: 100n,
      cacheHitRate: 0.5,
    });
    tracker.recordObservation({
      modelKey: "provider/model",
      toolCallsSucceeded: 1,
      toolCallsFailed: 0,
      structuredOutputSucceeded: true,
      editCohortSucceeded: true,
      latencyMs: 200,
      costMicros: 300n,
      cacheHitRate: 0.7,
    });

    const calibration = tracker.getCalibration("provider/model");
    expect(calibration.sampleCount).toBe(2);
    expect(calibration.meanMicros).toBe(200n);
    expect(calibration.uncertaintyMicros).not.toBeNull();
    expect(calibration.upperBoundMicros).toBeGreaterThan(calibration.meanMicros!);
    const metrics = tracker.getExpectedMetrics("provider/model");
    expect(metrics.calibrationStatus).toBe("observed_telemetry");
    expect(metrics.latencyUncertaintyMs).not.toBeNull();
  });

  test("counts only verified durable outcomes for verified calibration", () => {
    const tracker = new PosteriorTracker();
    const record = verifiedOutcome();
    tracker.recordVerifiedOutcome(record);
    tracker.recordVerifiedOutcome(record);

    const metrics = tracker.getExpectedMetrics(record.modelKey);
    expect(metrics.calibrationStatus).toBe("verified_outcomes");
    expect(metrics.verifiedSampleCount).toBe(1);
    expect(metrics.expectedCostMicros).toBe(300n);
  });
});
