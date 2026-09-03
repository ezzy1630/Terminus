import type {
  AcceptanceCriterion,
  ArtifactRef,
  Micros,
  Rfc3339Timestamp,
  Uuid7,
  VerificationPlan,
  VerificationResult,
} from "@terminus/domain";
import {
  ALL_PREDICATE_TYPES,
  parseNodeSpec,
  type PredicateType,
} from "./node-spec.js";
import { deriveVerificationNodes } from "./plan-derivation.js";
import {
  classifyVerificationTier,
  type VerificationTier,
} from "./risk-tier.js";
import {
  evaluateCompletionGate,
  type CompletionDenialReason,
} from "./completion-gate.js";
import { contentArtifactRef } from "./evidence.js";
import {
  createVerifierBinding,
  stampVerificationResultBinding,
} from "./run-binding.js";

export const CALIBRATION_SCHEMA_VERSION = 1 as const;

const SPECIAL_EVIDENCE_REQUIREMENTS = new Set([
  "workspace_revision_binding",
  "mandatory_predicate",
  "claim_evidence_binding",
]);

export interface CalibrationCase {
  readonly id: string;
  readonly tier: VerificationTier;
  // skipcq: JS-T1001
  readonly risk_class?: "low" | "normal" | "high" | "critical" | undefined;
  readonly changed_files: readonly string[];
  readonly expected_outcome:
    | "correct_completion"
    | "wrong_completion"
    | "stale_evidence_rejected"
    | "missing_evidence_rejected"
    | "irrelevant_evidence_rejected";
  readonly required_evidence: readonly string[];
}

export interface VerificationCalibrationCatalog {
  readonly schema_version: number;
  readonly cases: readonly CalibrationCase[];
}

export interface CalibrationCaseResult {
  readonly id: string;
  readonly tier: VerificationTier;
  readonly expectedOutcome: string;
  readonly actualOutcome: string;
  readonly passed: boolean;
  readonly falseCompletion: boolean;
  readonly falseBlock: boolean;
  // skipcq: JS-T1001
  readonly diagnostic?: string | undefined;
}

export interface VerificationCalibrationReport {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly falseCompletions: number;
  readonly falseBlocks: number;
  readonly falseCompletionRate: number;
  readonly falseBlockRate: number;
  readonly tierDistribution: Readonly<Record<VerificationTier, number>>;
  readonly results: readonly CalibrationCaseResult[];
  readonly passed: boolean;
}

const dummyIdSource = (): () => Uuid7 => {
  let count = 1;
  return () => {
    const hex = count.toString(16).padStart(12, "0");
    count += 1;
    return `01900000-0000-7000-8000-${hex}` as Uuid7;
  };
};

// skipcq: JS-R1005
const requireStringArray = (
  value: unknown,
  field: string,
  allowEmpty: boolean,
): readonly string[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${field} must be ${allowEmpty ? "an" : "a non-empty"} array`,
    );
  }
  if (
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${field} entries must be non-empty strings`);
  }
  return value;
};

/** Validate the schema and constraints of a calibration catalog. */
// skipcq: JS-R1005
export const validateCalibrationCatalog = (
  raw: unknown,
): VerificationCalibrationCatalog => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("calibration catalog must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== CALIBRATION_SCHEMA_VERSION) {
    throw new Error(
      `unsupported calibration schema_version: ${String(obj.schema_version)}`,
    );
  }
  if (!Array.isArray(obj.cases) || obj.cases.length === 0) {
    throw new Error("calibration catalog must declare at least one case");
  }
  const seenIds = new Set<string>();
  const cases: CalibrationCase[] = [];
  for (const item of obj.cases) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("calibration case must be an object");
    }
    const caseItem = item as Record<string, unknown>;
    if (
      typeof caseItem.id !== "string" ||
      caseItem.id.trim().length === 0 ||
      seenIds.has(caseItem.id)
    ) {
      throw new Error(
        `invalid or duplicate calibration case id: ${String(caseItem.id)}`,
      );
    }
    const id = caseItem.id;
    seenIds.add(id);
    const tier = caseItem.tier as VerificationTier;
    if (tier !== 0 && tier !== 1 && tier !== 2 && tier !== 3) {
      throw new Error(`${id}: invalid tier ${String(caseItem.tier)}`);
    }
    const riskClass = caseItem.risk_class;
    if (
      riskClass !== undefined &&
      riskClass !== "low" &&
      riskClass !== "normal" &&
      riskClass !== "high" &&
      riskClass !== "critical"
    ) {
      throw new Error(`${id}: invalid risk_class ${String(riskClass)}`);
    }
    const changedFiles = requireStringArray(
      caseItem.changed_files,
      `${id}.changed_files`,
      true,
    );
    const requiredEvidence = requireStringArray(
      caseItem.required_evidence,
      `${id}.required_evidence`,
      false,
    );
    for (const evidence of requiredEvidence) {
      if (
        !ALL_PREDICATE_TYPES.includes(evidence as PredicateType) &&
        !SPECIAL_EVIDENCE_REQUIREMENTS.has(evidence)
      ) {
        throw new Error(`${id}: unsupported required evidence ${evidence}`);
      }
    }
    const validOutcomes: readonly CalibrationCase["expected_outcome"][] = [
      "correct_completion",
      "wrong_completion",
      "stale_evidence_rejected",
      "missing_evidence_rejected",
      "irrelevant_evidence_rejected",
    ];
    if (
      !validOutcomes.includes(
        caseItem.expected_outcome as CalibrationCase["expected_outcome"],
      )
    ) {
      throw new Error(
        `${id}: unrecognized expected_outcome: ${String(caseItem.expected_outcome)}`,
      );
    }
    cases.push({
      id,
      tier,
      risk_class: riskClass as CalibrationCase["risk_class"],
      changed_files: changedFiles,
      expected_outcome:
        caseItem.expected_outcome as CalibrationCase["expected_outcome"],
      required_evidence: requiredEvidence,
    });
  }
  return { schema_version: CALIBRATION_SCHEMA_VERSION, cases };
};

const SOURCE_REVISION = "a".repeat(40);
const STALE_SOURCE_REVISION = "b".repeat(40);
const ENVIRONMENT_DIGEST = `sha256:${"c".repeat(64)}`;
const NOW = "2026-09-02T00:00:00.000Z" as Rfc3339Timestamp;
const FINAL_CHECKPOINT = contentArtifactRef(
  new TextEncoder().encode("verification-calibration-checkpoint"),
  "application/json",
);

// skipcq: JS-R1005
const criterionFor = (caseItem: CalibrationCase): AcceptanceCriterion => {
  const verificationHint =
    caseItem.tier === 0
      ? null
      : caseItem.tier === 1
        ? "predicate: diff_policy"
        : caseItem.tier === 3
          ? "predicate: security_scanner"
          : caseItem.expected_outcome === "wrong_completion"
            ? "command: calibration-unit-test"
            : "predicate: file_parses";
  return {
    id: `criterion:${caseItem.id}`,
    statement: `Known-outcome calibration case ${caseItem.id}`,
    verificationHint,
    required: true,
  };
};

const buildCasePlan = (caseItem: CalibrationCase): {
  readonly criterion: AcceptanceCriterion;
  readonly plan: VerificationPlan;
} => {
  const idSource = dummyIdSource();
  const criterion = criterionFor(caseItem);
  const derivation = deriveVerificationNodes({
    criteria: [criterion],
    objective: `calibration:${caseItem.id}`,
    riskClass: caseItem.risk_class ?? "normal",
    mode: "admission",
    signals: {
      changedFiles: caseItem.changed_files,
      nativeTestCommands:
        caseItem.expected_outcome === "wrong_completion"
          ? ["calibration-unit-test"]
          : [],
    },
    idSource,
  });
  const plan: VerificationPlan = {
    id: idSource(),
    taskContractId: idSource(),
    taskContractVersion: 1,
    sourceRevision: SOURCE_REVISION,
    nodes: derivation.nodes,
    edges: derivation.nodes.flatMap((node) =>
      node.dependsOn.map((from) => ({
        from,
        to: node.id,
        kind: "depends" as const,
      })),
    ),
    completionExpression: derivation.completionExpression,
    createdAt: NOW,
  };
  return { criterion, plan };
};

const passingResult = (
  plan: VerificationPlan,
  node: VerificationPlan["nodes"][number],
  idSource: () => Uuid7,
): VerificationResult => {
  const binding = createVerifierBinding(plan);
  return stampVerificationResultBinding(
    {
      id: idSource(),
      planId: plan.id,
      nodeId: node.id,
      status: "pass",
      startedAt: NOW,
      completedAt: NOW,
      sourceRevision: SOURCE_REVISION,
      environmentImageDigest: ENVIRONMENT_DIGEST,
      commandOrQuery: node.specification,
      exitCode: 0,
      structuredObservations: {},
      artifacts: [
        contentArtifactRef(
          new TextEncoder().encode(`calibration:${node.id}:pass`),
          "application/json",
        ),
      ],
      toolCallId: null,
      verifierVersion: binding.verifierVersion,
      reasonIfSkipped: null,
      attempts: 1,
    },
    binding,
  );
};

// skipcq: JS-R1005
const corruptResultsForCase = (
  caseItem: CalibrationCase,
  plan: VerificationPlan,
  results: readonly VerificationResult[],
): readonly VerificationResult[] => {
  const criterionNode = plan.nodes.find(
    (node) => node.acceptanceCriterionId !== null,
  );
  if (criterionNode === undefined) {
    throw new Error(`${caseItem.id}: derived plan has no criterion node`);
  }
  switch (caseItem.expected_outcome) {
    case "correct_completion":
      return results;
    case "wrong_completion":
      return results.map((result) =>
        result.nodeId === criterionNode.id
          ? { ...result, status: "fail", exitCode: 1 }
          : result,
      );
    case "stale_evidence_rejected":
      return results.map((result) =>
        result.nodeId === criterionNode.id
          ? { ...result, sourceRevision: STALE_SOURCE_REVISION }
          : result,
      );
    case "missing_evidence_rejected":
      return results.filter((result) => result.nodeId !== criterionNode.id);
    case "irrelevant_evidence_rejected": {
      const unboundArtifact = {
        ...FINAL_CHECKPOINT,
        hash: `sha256:${"d".repeat(64)}`,
      } as ArtifactRef;
      return results.map((result) =>
        result.nodeId === criterionNode.id
          ? { ...result, artifacts: [unboundArtifact] }
          : result,
      );
    }
    default:
      return results;
  }
};

const expectedDenial = (
  outcome: CalibrationCase["expected_outcome"],
): CompletionDenialReason | null => {
  switch (outcome) {
    case "correct_completion":
      return null;
    case "wrong_completion":
    case "stale_evidence_rejected":
    case "missing_evidence_rejected":
      return "binding_invalid";
    case "irrelevant_evidence_rejected":
      return "evidence_missing";
    default:
      return null;
  }
};

/** Run known-outcome cases through the production completion-admission gate. */
// skipcq: JS-R1005
export const runVerificationCalibration = (
  catalog: VerificationCalibrationCatalog,
): VerificationCalibrationReport => {
  const results: CalibrationCaseResult[] = [];
  const tierDistribution: Record<VerificationTier, number> = {
    0: 0,
    1: 0,
    2: 0,
    3: 0,
  };

  for (const caseItem of catalog.cases) {
    tierDistribution[caseItem.tier] += 1;
    const expectedComplete = caseItem.expected_outcome === "correct_completion";
    const classified = classifyVerificationTier({
      riskClass: caseItem.risk_class ?? "normal",
      changedFiles: caseItem.changed_files,
    });
    if (classified.tier !== caseItem.tier) {
      results.push({
        id: caseItem.id,
        tier: caseItem.tier,
        expectedOutcome: caseItem.expected_outcome,
        actualOutcome: `tier_mismatch:${classified.tier}`,
        passed: false,
        falseCompletion: false,
        falseBlock: expectedComplete,
        diagnostic: `expected tier ${caseItem.tier}, got ${classified.tier}: ${classified.reason}`,
      });
      continue;
    }

    const { criterion, plan } = buildCasePlan(caseItem);
    const predicateTypes = new Set(
      plan.nodes.map((node) => parseNodeSpec(node.specification).predicateType),
    );
    const missingPlanEvidence = caseItem.required_evidence.filter(
      (evidence) =>
        !SPECIAL_EVIDENCE_REQUIREMENTS.has(evidence) &&
        !predicateTypes.has(evidence as PredicateType),
    );
    if (missingPlanEvidence.length > 0) {
      results.push({
        id: caseItem.id,
        tier: caseItem.tier,
        expectedOutcome: caseItem.expected_outcome,
        actualOutcome: "required_evidence_absent_from_plan",
        passed: false,
        falseCompletion: false,
        falseBlock: expectedComplete,
        diagnostic: `derived plan lacks: ${missingPlanEvidence.join(", ")}`,
      });
      continue;
    }

    const idSource = dummyIdSource();
    const cleanResults = plan.nodes.map((node) =>
      passingResult(plan, node, idSource),
    );
    const observedResults = corruptResultsForCase(caseItem, plan, cleanResults);
    const resultMap = new Map(
      observedResults.map((result) => [result.nodeId, result] as const),
    );
    const decision = evaluateCompletionGate({
      taskId: idSource(),
      contractVersion: 1,
      plan,
      criteria: [criterion],
      results: observedResults,
      findings: [],
      sourceRevision: SOURCE_REVISION,
      environmentImageDigest: ENVIRONMENT_DIGEST,
      now: NOW,
      expiresAt: null,
      invalidatedNodeIds: new Set(),
      completionExpressionSatisfied: plan.nodes
        .filter((node) => node.required)
        .every((node) => resultMap.get(node.id)?.status === "pass"),
      unresolvedRisks: [],
      acceptedRisks: [],
      externalEffects: [],
      costMicros: 0n as Micros,
      durationSeconds: 1,
      finalCheckpoint: FINAL_CHECKPOINT,
      verifierBinding: createVerifierBinding(plan),
    });
    const expectedReason = expectedDenial(caseItem.expected_outcome);
    const passed =
      expectedReason === null
        ? decision.allow
        : decision.allow === false && decision.reason === expectedReason;
    const falseCompletion = !expectedComplete && decision.allow;
    const falseBlock = expectedComplete && !decision.allow;
    const actualOutcome = decision.allow
      ? "completion_admitted"
      : decision.reason;
    results.push({
      id: caseItem.id,
      tier: caseItem.tier,
      expectedOutcome: caseItem.expected_outcome,
      actualOutcome,
      passed,
      falseCompletion,
      falseBlock,
      diagnostic: passed
        ? undefined
        : `expected ${expectedReason ?? "completion_admitted"}, observed ${actualOutcome}`,
    });
  }

  const falseCompletions = results.filter(
    (result) => result.falseCompletion,
  ).length;
  const falseBlocks = results.filter((result) => result.falseBlock).length;
  const passedCases = results.filter((result) => result.passed).length;
  const totalCases = results.length;
  const failedCases = totalCases - passedCases;
  return {
    totalCases,
    passedCases,
    failedCases,
    falseCompletions,
    falseBlocks,
    falseCompletionRate: totalCases > 0 ? falseCompletions / totalCases : 0,
    falseBlockRate: totalCases > 0 ? falseBlocks / totalCases : 0,
    tierDistribution,
    results,
    passed: failedCases === 0 && falseCompletions === 0 && falseBlocks === 0,
  };
}
