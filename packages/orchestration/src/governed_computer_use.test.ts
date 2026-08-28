import { describe, expect, test } from "bun:test";
import type {
  ArtifactUri,
  ComputerUseAction,
  ContentHash,
  PoolLease,
  Rfc3339Timestamp,
  UiObservation,
} from "@terminus/domain";
import {
  computeComputerUseActionHash,
  computeComputerUseEffectBindingHash,
  computeUiObservationHash,
  GovernedComputerUseCoordinator,
  type ComputerUsePolicy,
  type KernelActionReceipt,
  type KernelReconciliationReceipt,
  type ObservationReceiptVerifier,
  type TrustedObservationReceipt,
  type TrustedUiObservation,
} from "./governed_computer_use.js";

const HASH = (letter: string): ContentHash => `sha256:${letter.repeat(64)}` as ContentHash;
const ARTIFACT = (letter: string): ArtifactUri => `artifact://sha256/${letter.repeat(64)}` as ArtifactUri;
const NOW = "2026-08-27T00:00:00.000Z" as Rfc3339Timestamp;

const target = {
  elementId: "submit",
  role: "button",
  name: "Submit",
  selector: "#submit",
  boundingBox: { x: 10, y: 10, width: 100, height: 30 },
  textSnippet: "Submit",
  confidence: 0.99,
  semanticHash: "sha256:target",
  evidenceSources: ["dom", "accessibility"] as const,
};

function observation(version: number, taintLabel: UiObservation["taintLabel"] = "SYSTEM_TRUSTED"): UiObservation {
  return {
    id: `observation-${version}`,
    sessionId: "session-1",
    taskId: "task-1",
    timestamp: NOW,
    viewport: { width: 800, height: 600, devicePixelRatio: 1, scaleFactor: 1 },
    screenshotArtifactId: null,
    domTreeArtifactId: "dom-tree",
    documentUri: "https://example.test/form",
    accessibilityTree: [{
      nodeId: "submit",
      role: "button",
      name: "Submit",
      description: null,
      value: null,
      disabled: false,
      focused: false,
      boundingBox: target.boundingBox,
      childrenNodeIds: [],
    }],
    focusedElementId: null,
    targetElements: [target],
    taintLabel,
    version,
  };
}

function trusted(
  value: UiObservation,
  verifier: ObservationReceiptVerifier,
): TrustedUiObservation {
  const observationHash = computeUiObservationHash(value);
  const receipt: TrustedObservationReceipt = {
    receiptId: `observation-receipt-${value.version}`,
    adapterId: "kernel-browser-adapter",
    taskId: value.taskId,
    observationId: value.id,
    observationVersion: value.version,
    observationHash,
    receiptArtifactUri: ARTIFACT("a"),
    receiptArtifactHash: HASH("a"),
    observedAt: value.timestamp,
  };
  const coordinator = new GovernedComputerUseCoordinator({
    observationReceipts: verifier,
    kernelReceipts: null,
    nowMs: () => Date.parse(NOW),
  });
  return coordinator.admitTrustedObservation(value, receipt);
}

const observationVerifier: ObservationReceiptVerifier = {
  verify: () => true,
};

function lease(): PoolLease {
  return {
    leaseId: "lease-1",
    poolId: "pool-1",
    taskId: "task-1",
    workerId: "worker-1",
    assignedInstanceId: "instance-1",
    acquiredAt: NOW,
    expiresAt: "2026-08-27T00:05:00.000Z" as Rfc3339Timestamp,
    status: "active",
  };
}

const policy: ComputerUsePolicy = {
  policyId: "computer-use-policy",
  version: "v1;attempts=2",
  allowedSurfaces: ["browser"],
  allowedActionKinds: ["submit", "click", "navigate"],
  allowedEffectClasses: ["irreversible", "read_only"],
  requireApprovalFor: ["irreversible"],
  denyUntrustedExternalEffects: true,
  maxAttempts: 2,
};

function action(overrides: Partial<ComputerUseAction> = {}): ComputerUseAction {
  return {
    actionId: "action-1",
    taskId: "task-1",
    observationId: "observation-1",
    observationVersion: 1,
    kind: "submit",
    target,
    coordinate: null,
    text: null,
    keys: null,
    scrollDelta: null,
    intent: "submit the form once",
    requiresSemanticVerification: true,
    effectClass: "irreversible",
    ...overrides,
  };
}

function admission(
  coordinator: GovernedComputerUseCoordinator,
  current = trusted(observation(1), observationVerifier),
  overrides: Partial<Parameters<GovernedComputerUseCoordinator["admitAction"]>[0]> = {},
) {
  return coordinator.admitAction({
    taskId: "task-1",
    effectId: "effect-1",
    idempotencyKey: "computer-use-effect-1",
    surface: "browser",
    action: action(),
    observation: current,
    lease: lease(),
    policy,
    influence: { influencedByUntrustedContent: false, injectionRisk: "none", sources: [] },
    approval: null,
    ...overrides,
  });
}

function receiptFor(
  admitted: Extract<ReturnType<GovernedComputerUseCoordinator["admitAction"]>, { admitted: true }>,
  after: TrustedUiObservation | null,
  outcome: KernelActionReceipt["outcome"],
): KernelActionReceipt {
  return {
    receiptId: `kernel-receipt-${outcome}`,
    effectId: admitted.effectId,
    taskId: admitted.taskId,
    actionId: admitted.action.actionId,
    actionHash: admitted.actionHash,
    effectBindingHash: admitted.effectBindingHash,
    idempotencyKey: admitted.idempotencyKey,
    beforeObservationHash: admitted.observation.observationHash,
    afterObservationHash: after?.observationHash ?? null,
    outcome,
    receiptArtifactUri: ARTIFACT("b"),
    receiptArtifactHash: HASH("b"),
    observedAt: NOW,
  };
}

function reconciliationFor(
  admitted: Extract<ReturnType<GovernedComputerUseCoordinator["admitAction"]>, { admitted: true }>,
  settlement: KernelReconciliationReceipt["settlement"],
  afterObservationHash: ContentHash | null,
): KernelReconciliationReceipt {
  return {
    receiptId: `reconciliation-${settlement}`,
    effectId: admitted.effectId,
    taskId: admitted.taskId,
    actionHash: admitted.actionHash,
    effectBindingHash: admitted.effectBindingHash,
    idempotencyKey: admitted.idempotencyKey,
    settlement,
    afterObservationHash,
    receiptArtifactUri: ARTIFACT("c"),
    receiptArtifactHash: HASH("c"),
    reconciledAt: NOW,
  };
}

function coordinator(): GovernedComputerUseCoordinator {
  return new GovernedComputerUseCoordinator({
    observationReceipts: observationVerifier,
    kernelReceipts: {
      verifyActionReceipt: () => true,
      verifyReconciliationReceipt: () => true,
    },
    nowMs: () => Date.parse(NOW),
  });
}

describe("governed computer-use contract", () => {
  test("requires a trusted observation receipt and binds its content hash", () => {
    const value = observation(1);
    const hash = computeUiObservationHash(value);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => new GovernedComputerUseCoordinator({
      observationReceipts: null,
      kernelReceipts: null,
    }).admitTrustedObservation(value, {
      receiptId: "receipt",
      adapterId: "adapter",
      taskId: value.taskId,
      observationId: value.id,
      observationVersion: value.version,
      observationHash: hash,
      receiptArtifactUri: ARTIFACT("a"),
      receiptArtifactHash: HASH("a"),
      observedAt: NOW,
    })).toThrow("verification is unavailable");

    const tampered = { ...value, documentUri: "https://evil.example.test" };
    const trustedValue = trusted(value, observationVerifier);
    expect(trustedValue.observationHash).toBe(hash);
    expect(() => new GovernedComputerUseCoordinator({
      observationReceipts: observationVerifier,
      kernelReceipts: null,
    }).admitTrustedObservation(tampered, trustedValue.receipt)).toThrow("does not bind");
    expect(() => admission(coordinator(), { ...trustedValue, observationHash: HASH("d") })).toThrow("tampered");
  });

  test("denies tainted external actions before any dispatch contract exists", () => {
    const current = trusted(observation(1, "UNTRUSTED_WEB"), observationVerifier);
    const result = admission(coordinator(), current, {
      policy: { ...policy, denyUntrustedExternalEffects: true },
      influence: { influencedByUntrustedContent: true, injectionRisk: "high", sources: ["web"] },
    });
    expect(result).toMatchObject({ admitted: false, reason: "untrusted_influence" });
  });

  test("requires exact approval for a clean irreversible action", () => {
    const current = trusted(observation(1, "USER_TRUSTED"), observationVerifier);
    const pending = admission(coordinator(), current, { approval: null });
    expect(pending).toMatchObject({ admitted: false, reason: "approval_required" });
    if (pending.admitted) throw new Error("approval should be required");
    const actionHash = computeComputerUseActionHash(action(), current.observationHash);
    const effectBindingHash = computeComputerUseEffectBindingHash({
      effectId: "effect-1",
      idempotencyKey: "computer-use-effect-1",
      taskId: "task-1",
      surface: "browser",
      leaseId: "lease-1",
      poolId: "pool-1",
      policyId: policy.policyId,
      policyVersion: policy.version,
      actionHash,
    });
    const approved = admission(coordinator(), current, {
      approval: {
        approvalId: "approval-1",
        taskId: "task-1",
        actionHash,
        effectBindingHash,
        approvedBy: "operator-1",
        reviewedUntrustedInfluence: false,
        expiresAt: "2026-08-27T00:05:00.000Z" as Rfc3339Timestamp,
        status: "approved",
      },
    });
    expect(approved.admitted).toBe(true);
  });

  test("accepts only a kernel receipt with exact before/after hashes", () => {
    const current = trusted(observation(1, "USER_TRUSTED"), observationVerifier);
    const after = trusted(observation(2, "USER_TRUSTED"), observationVerifier);
    const admitted = admission(coordinator(), current, {
      approval: {
        approvalId: "approval-1",
        taskId: "task-1",
        actionHash: computeComputerUseActionHash(action(), current.observationHash),
        effectBindingHash: computeComputerUseEffectBindingHash({
          effectId: "effect-1",
          idempotencyKey: "computer-use-effect-1",
          taskId: "task-1",
          surface: "browser",
          leaseId: "lease-1",
          poolId: "pool-1",
          policyId: policy.policyId,
          policyVersion: policy.version,
          actionHash: computeComputerUseActionHash(action(), current.observationHash),
        }),
        approvedBy: "operator-1",
        reviewedUntrustedInfluence: true,
        expiresAt: "2026-08-27T00:05:00.000Z" as Rfc3339Timestamp,
        status: "approved",
      },
    });
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) throw new Error("admission should pass");
    const settled = coordinator().settleAction({
      admission: admitted,
      receipt: receiptFor(admitted, after, "committed"),
      afterObservation: after,
    });
    expect(settled).toMatchObject({ status: "committed", beforeObservationHash: current.observationHash, afterObservationHash: after.observationHash });
    expect(() => coordinator().settleAction({
      admission: admitted,
      receipt: { ...receiptFor(admitted, after, "committed"), afterObservationHash: HASH("d") },
      afterObservation: after,
    })).toThrow("after observation");
  });

  test("never retries unknown settlement without trusted reconciliation and a fresh observation", () => {
    const current = trusted(observation(1, "USER_TRUSTED"), observationVerifier);
    const after = trusted(observation(2, "USER_TRUSTED"), observationVerifier);
    const admitted = admission(coordinator(), current, {
      approval: {
        approvalId: "approval-1",
        taskId: "task-1",
        actionHash: computeComputerUseActionHash(action(), current.observationHash),
        effectBindingHash: HASH("e"),
        approvedBy: "operator-1",
        reviewedUntrustedInfluence: true,
        expiresAt: "2026-08-27T00:05:00.000Z" as Rfc3339Timestamp,
        status: "approved",
      },
    });
    expect(admitted.admitted).toBe(false);
    const cleanAdmitted = admission(coordinator(), current, {
      policy: { ...policy, requireApprovalFor: [] },
    });
    expect(cleanAdmitted.admitted).toBe(true);
    if (!cleanAdmitted.admitted) throw new Error("admission should pass");
    const unknown = coordinator().settleAction({
      admission: cleanAdmitted,
      receipt: receiptFor(cleanAdmitted, null, "unknown"),
      afterObservation: null,
    });
    const noReceipt = coordinator().recoverUnknown({
      admission: cleanAdmitted,
      settlement: unknown,
      attempts: 1,
      reconciliation: null,
      afterReconciliationObservation: null,
    });
    expect(noReceipt).toMatchObject({ status: "manual_review_required", reason: "missing_reconciliation_receipt" });

    const notExecuted = coordinator().recoverUnknown({
      admission: cleanAdmitted,
      settlement: unknown,
      attempts: 1,
      reconciliation: reconciliationFor(cleanAdmitted, "not_executed", after.observationHash),
      afterReconciliationObservation: after,
    });
    expect(notExecuted).toMatchObject({ status: "retry_allowed", nextAttempt: 2, requiresFreshObservation: true });
    const exhausted = coordinator().recoverUnknown({
      admission: cleanAdmitted,
      settlement: unknown,
      attempts: 2,
      reconciliation: reconciliationFor(cleanAdmitted, "not_executed", after.observationHash),
      afterReconciliationObservation: after,
    });
    expect(exhausted).toMatchObject({ status: "manual_review_required", reason: "retry_budget_exhausted" });
  });

  test("emits compact evidence with hashes and no page content", () => {
    const current = trusted(observation(1, "UNTRUSTED_WEB"), observationVerifier);
    const result = admission(coordinator(), current, {
      policy: { ...policy, denyUntrustedExternalEffects: false },
      influence: { influencedByUntrustedContent: true, injectionRisk: "high", sources: ["web"] },
      approval: null,
    });
    expect(result).toMatchObject({ admitted: false, reason: "approval_required" });
    const evidence = coordinator().compactEvidence({ admission: result });
    expect(evidence).toMatchObject({ status: "denied", influencedByUntrustedContent: true, injectionRisk: "high" });
    expect(evidence).not.toHaveProperty("documentUri");
    expect(evidence).not.toHaveProperty("textSnippet");
  });
});
