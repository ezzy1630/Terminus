import { describe, expect, test } from "bun:test";
import type {
  AcceptanceCriterion,
  ArtifactRef,
  ContentHash,
  Micros,
  Rfc3339Timestamp,
  Uuid7,
  VerificationResult,
} from "@terminus/domain";
import {
  acceptHumanAcceptanceObligation,
  buildProofBundle,
  buildVerificationPlan,
  canonicalizeProofBundle,
  computeAcceptanceCriteriaHash,
  contentArtifactRef,
  createHumanAcceptanceObligations,
  createVerifierBinding,
  criterionNode,
  evaluateCompletionGate,
  evaluateProofBundleAdmission,
  verifyProofBundle,
  type ProofBundle,
  type ProofBundleBuildInput,
} from "./index.js";

const HASH_A = ("sha256:" + "aa".repeat(32)) as ContentHash;
const HASH_B = ("sha256:" + "bb".repeat(32)) as ContentHash;

function fakeUuid(n: number): Uuid7 {
  return `018f0000-0000-7000-8000-${n.toString(16).padStart(12, "0")}` as Uuid7;
}

const NOW = "2026-08-24T12:00:00Z" as Rfc3339Timestamp;
const FINAL_REVISION = "commit-final";
const ENVIRONMENT = "env-blueprint-v1";

const criteria: readonly AcceptanceCriterion[] = [
  { id: "tests", statement: "unit tests pass", verificationHint: null, required: true },
];

const plan = buildVerificationPlan({
  id: fakeUuid(1),
  taskContractId: fakeUuid(2),
  taskContractVersion: 3,
  sourceRevision: FINAL_REVISION,
  nodes: [criterionNode({
    id: "unit-tests",
    criterionId: "tests",
    predicateType: "unit_test",
    paths: ["packages/verification/src"],
    required: true,
  })],
  completionExpression: "unit-tests",
});

const verifierBinding = createVerifierBinding(plan, {
  verifierId: "trusted.verifier",
  verifierVersion: "2.4.0",
});
const evidence = contentArtifactRef(new TextEncoder().encode("test output"), "text/plain");

function passResult(): VerificationResult {
  return {
    id: fakeUuid(10),
    planId: plan.id,
    nodeId: "unit-tests",
    status: "pass",
    startedAt: NOW,
    completedAt: NOW,
    sourceRevision: FINAL_REVISION,
    environmentImageDigest: ENVIRONMENT,
    commandOrQuery: "bun test packages/verification/src",
    exitCode: 0,
    structuredObservations: {
      stdout: "1 passed",
      stderr: "",
      verificationBinding: verifierBinding,
    },
    artifacts: [evidence],
    toolCallId: null,
    verifierVersion: verifierBinding.verifierVersion,
    reasonIfSkipped: null,
    attempts: 1,
  };
}

function buildInput(overrides: Partial<ProofBundleBuildInput> = {}): ProofBundleBuildInput {
  return {
    taskId: fakeUuid(20),
    contractVersion: 3,
    taskContractHash: HASH_A,
    criteria,
    plan,
    results: [passResult()],
    finalRevision: FINAL_REVISION,
    finalTreeHash: "tree-final",
    environmentBlueprintDigest: ENVIRONMENT,
    verifierBinding,
    providerReceipts: [{
      id: "provider-1",
      providerId: "provider.local",
      requestHash: HASH_A,
      responseHash: HASH_B,
      receiptHash: HASH_B,
      modelProfileVersion: "profile-7",
    }],
    toolReceipts: [{ id: "tool-1", kind: "tool_settlement", hash: HASH_A }],
    effectSettlementReceipts: [{ id: "effect-1", kind: "effect_settlement", hash: HASH_B }],
    generatedAt: NOW,
    ...overrides,
  };
}

function trustedExpectations(bundle: ProofBundle) {
  return {
    expectedContentHash: bundle.contentHash,
    taskContractHash: HASH_A,
    criteria,
    plan,
    results: [passResult()],
    sourceRevision: FINAL_REVISION,
    environmentBlueprintDigest: ENVIRONMENT,
    verifierBinding,
    requireTrusted: true,
  } as const;
}

test("completion gate rejects criteria, configuration, and evidence tampering", () => {
  const original = buildProofBundle(buildInput());
  const tamperedBundles: readonly ProofBundle[] = [
    {
      ...original,
      criteriaResults: original.criteriaResults.map((criterion) => ({
        ...criterion,
        statement: "agent changed the acceptance contract",
      })),
    },
    { ...original, verificationConfigHash: HASH_B },
    {
      ...original,
      criteriaResults: original.criteriaResults.map((criterion) => ({
        ...criterion,
        evidence: criterion.evidence.map((artifact) => ({
          ...artifact,
          hash: HASH_B,
          uri: `artifact://sha256/${HASH_B.slice("sha256:".length)}` as ArtifactRef["uri"],
        })),
      })),
    },
  ];

  for (const proofBundle of tamperedBundles) {
    const decision = evaluateCompletionGate({
      taskId: original.taskId,
      contractVersion: original.contractVersion,
      plan,
      criteria,
      results: [passResult()],
      findings: [],
      sourceRevision: FINAL_REVISION,
      environmentImageDigest: ENVIRONMENT,
      now: NOW,
      expiresAt: null,
      invalidatedNodeIds: new Set(),
      completionExpressionSatisfied: true,
      unresolvedRisks: [],
      acceptedRisks: [],
      externalEffects: [],
      costMicros: 0n as Micros,
      durationSeconds: 1,
      finalCheckpoint: evidence,
      expectedCriteriaHash: computeAcceptanceCriteriaHash(criteria),
      verifierBinding,
      proofBundle,
      proofBundleContentHash: original.contentHash,
      taskContractHash: HASH_A,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("proof_bundle_invalid");
  }

  const deletedCriteriaDecision = evaluateCompletionGate({
    taskId: original.taskId,
    contractVersion: original.contractVersion,
    plan,
    criteria: [],
    results: [],
    findings: [],
    sourceRevision: FINAL_REVISION,
    environmentImageDigest: ENVIRONMENT,
    now: NOW,
    expiresAt: null,
    invalidatedNodeIds: new Set(),
    completionExpressionSatisfied: true,
    unresolvedRisks: [],
    acceptedRisks: [],
    externalEffects: [],
    costMicros: 0n as Micros,
    durationSeconds: 1,
    finalCheckpoint: evidence,
    expectedCriteriaHash: computeAcceptanceCriteriaHash(criteria),
    verifierBinding,
  });
  expect(deletedCriteriaDecision.allow).toBe(false);
  if (!deletedCriteriaDecision.allow) expect(deletedCriteriaDecision.reason).toBe("criteria_mismatch");
});

describe("proof bundle integrity", () => {
  test("construction is deterministic and records unsigned local status honestly", () => {
    const first = buildProofBundle(buildInput());
    const second = buildProofBundle(buildInput({ criteria: [...criteria].reverse(), results: [passResult()] }));

    expect(first.contentHash).toBe(second.contentHash);
    expect(canonicalizeProofBundle(first)).toBe(canonicalizeProofBundle(second));
    expect(first.artifactRef.hash).toBe(first.contentHash);
    expect(first.signatureStatus).toBe("unsigned_local");
    expect(first.signature).toBeNull();

    const verification = verifyProofBundle(first, trustedExpectations(first));
    expect(verification.valid).toBe(true);
    expect(verification.trusted).toBe(true);
  });

  test.each([
    ["criteria", (bundle: ProofBundle) => ({
      ...bundle,
      criteriaResults: bundle.criteriaResults.map((criterion) => ({
        ...criterion,
        statement: "tampered criterion",
      })),
    })],
    ["configuration", (bundle: ProofBundle) => ({
      ...bundle,
      verificationConfigHash: HASH_B,
    })],
    ["evidence", (bundle: ProofBundle) => ({
      ...bundle,
      criteriaResults: bundle.criteriaResults.map((criterion) => ({
        ...criterion,
        evidence: criterion.evidence.map((artifact) => ({
          ...artifact,
          hash: HASH_B,
          uri: `artifact://sha256/${HASH_B.slice("sha256:".length)}` as ArtifactRef["uri"],
        })),
      })),
    })],
    ["source", (bundle: ProofBundle) => ({
      ...bundle,
      verificationExecutions: bundle.verificationExecutions.map((execution) => ({
        ...execution,
        sourceRevision: "commit-attacker",
      })),
    })],
    ["environment", (bundle: ProofBundle) => ({
      ...bundle,
      environmentBlueprintDigest: "env-attacker",
    })],
  ] as const)("rejects tampered %s bundle content", (_name, mutate) => {
    const original = buildProofBundle(buildInput());
    const tampered = mutate(original) as ProofBundle;
    const verification = verifyProofBundle(tampered, trustedExpectations(original));
    expect(verification.valid).toBe(false);
    expect(verification.failures.length).toBeGreaterThan(0);
  });

  test("an unsigned bundle with a forged replacement hash is not trusted", () => {
    const original = buildProofBundle(buildInput());
    const forged = {
      ...original,
      finalRevision: "commit-attacker",
      contentHash: HASH_B,
      artifactRef: {
        ...original.artifactRef,
        hash: HASH_B,
        uri: `artifact://sha256/${HASH_B.slice("sha256:".length)}` as ArtifactRef["uri"],
      },
    } as ProofBundle;
    const verification = verifyProofBundle(forged, {
      ...trustedExpectations(original),
      expectedContentHash: original.contentHash,
    });
    expect(verification.valid).toBe(false);
    expect(verification.trusted).toBe(true);
  });
});

describe("human acceptance obligations", () => {
  const manualCriteria: readonly AcceptanceCriterion[] = [{
    id: "visual",
    statement: "the interface feels clear",
    verificationHint: "manual: inspect the rendered interface and approve the hierarchy",
    required: true,
  }];

  test("subjective criteria create open obligations and cannot auto-pass", () => {
    const manualPlan = buildVerificationPlan({
      id: fakeUuid(30),
      taskContractId: fakeUuid(31),
      taskContractVersion: 1,
      sourceRevision: FINAL_REVISION,
      nodes: [],
      completionExpression: "",
    });
    const binding = createVerifierBinding(manualPlan);
    const obligations = createHumanAcceptanceObligations({
      criteria: manualCriteria,
      nodes: manualPlan.nodes,
      sourceRevision: FINAL_REVISION,
      environmentImageDigest: ENVIRONMENT,
    });
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.status).toBe("open");

    const bundle = buildProofBundle({
      taskId: fakeUuid(32),
      contractVersion: 1,
      taskContractHash: HASH_A,
      criteria: manualCriteria,
      plan: manualPlan,
      results: [],
      finalRevision: FINAL_REVISION,
      finalTreeHash: null,
      environmentBlueprintDigest: ENVIRONMENT,
      verifierBinding: binding,
      providerReceipts: [],
      toolReceipts: [],
      effectSettlementReceipts: [],
      generatedAt: NOW,
      humanAcceptanceObligations: obligations,
    });
    const admission = evaluateProofBundleAdmission(bundle, {
      expectedContentHash: bundle.contentHash,
      taskContractHash: HASH_A,
      criteria: manualCriteria,
      plan: manualPlan,
      sourceRevision: FINAL_REVISION,
      environmentBlueprintDigest: ENVIRONMENT,
      verifierBinding: binding,
      requireTrusted: true,
    });
    expect(admission.admissible).toBe(false);
    expect(admission.failures.join(" ")).toMatch(/open|accepted/i);
  });

  test("completion becomes admissible only after an explicit human decision", () => {
    const manualPlan = buildVerificationPlan({
      id: fakeUuid(40),
      taskContractId: fakeUuid(41),
      taskContractVersion: 1,
      sourceRevision: FINAL_REVISION,
      nodes: [],
      completionExpression: "",
    });
    const binding = createVerifierBinding(manualPlan);
    const open = createHumanAcceptanceObligations({
      criteria: manualCriteria,
      sourceRevision: FINAL_REVISION,
      environmentImageDigest: ENVIRONMENT,
    })[0]!;
    const accepted = acceptHumanAcceptanceObligation(open, {
      acceptedBy: "human-reviewer",
      acceptedAt: NOW,
      evidence: [contentArtifactRef(new TextEncoder().encode("reviewed"), "text/plain")],
    });
    const bundle = buildProofBundle({
      taskId: fakeUuid(42),
      contractVersion: 1,
      taskContractHash: HASH_A,
      criteria: manualCriteria,
      plan: manualPlan,
      results: [],
      finalRevision: FINAL_REVISION,
      finalTreeHash: null,
      environmentBlueprintDigest: ENVIRONMENT,
      verifierBinding: binding,
      providerReceipts: [],
      toolReceipts: [],
      effectSettlementReceipts: [],
      generatedAt: NOW,
      humanAcceptanceObligations: [accepted],
    });
    const admission = evaluateProofBundleAdmission(bundle, {
      expectedContentHash: bundle.contentHash,
      taskContractHash: HASH_A,
      criteria: manualCriteria,
      plan: manualPlan,
      sourceRevision: FINAL_REVISION,
      environmentBlueprintDigest: ENVIRONMENT,
      verifierBinding: binding,
      requireTrusted: true,
    });
    expect(admission.admissible).toBe(true);
  });
});

test("criteria hash changes when a criterion is deleted", () => {
  expect(computeAcceptanceCriteriaHash(criteria)).not.toBe(
    computeAcceptanceCriteriaHash([]),
  );
});
