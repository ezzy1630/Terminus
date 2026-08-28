import { describe, expect, test } from "bun:test";
import {
  InMemoryRouterOutcomeStore,
  RouterOutcomeRecorder,
  routerOutcomeRecordSchema,
  type RouterOutcomeRecordInput,
} from "./index.js";

function outcome(overrides: Partial<RouterOutcomeRecordInput> = {}): RouterOutcomeRecordInput {
  return {
    outcomeId: "outcome-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    pairId: "pair-1",
    cohort: "small-bugfix",
    assignment: "candidate",
    profileId: "profile:fast",
    modelKey: "provider/model",
    providerId: "provider",
    adapterRef: "adapter:remote",
    result: "success",
    qualityScore: 0.8,
    toolCallsSucceeded: 2,
    toolCallsFailed: 0,
    structuredOutputSucceeded: true,
    editCohortSucceeded: true,
    latencyMs: 100,
    costMicros: 1_000n,
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
    ...overrides,
  };
}

describe("durable router outcomes", () => {
  test("validates, deduplicates, and survives store rehydration", () => {
    const source = new InMemoryRouterOutcomeStore();
    const recorder = new RouterOutcomeRecorder(source);
    const recorded = recorder.record(outcome());
    recorder.record(recorded);

    expect(source.list()).toHaveLength(1);
    expect(source.get(recorded.outcomeId)?.schemaVersion).toBe("terminus.routing.outcome.v1");
    const restored = new InMemoryRouterOutcomeStore(source.list());
    expect(restored.get("outcome-1")?.costMicros).toBe(1_000n);
  });

  test("rejects a replacement for an existing outcome identity", () => {
    const store = new InMemoryRouterOutcomeStore();
    const recorder = new RouterOutcomeRecorder(store);
    recorder.record(outcome());

    expect(() => recorder.record(outcome({ qualityScore: 0.7 }))).toThrow("conflicts with an existing record");
  });

  test("does not label missing receipt or artifact as verified", () => {
    const recorder = new RouterOutcomeRecorder(new InMemoryRouterOutcomeStore());

    expect(() => recorder.recordVerified(outcome({ providerReceipt: null }))).toThrow(
      "requires a matching provider receipt",
    );
    expect(() => recorder.recordVerified(outcome({ verificationArtifactRef: null }))).toThrow(
      "requires a matching provider receipt",
    );
    const unverified = recorder.record(outcome({
      providerReceipt: null,
      verificationArtifactRef: null,
      verificationStatus: "unverified",
    }));
    expect(unverified.verificationStatus).toBe("unverified");
    expect(routerOutcomeRecordSchema.safeParse(unverified).success).toBe(true);
  });
});
