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

function dummyIdSource(): () => Uuid7 {
  let count = 1;
  return () => {
    const hex = count.toString(16).padStart(12, "0");
    count += 1;
    return `01900000-0000-7000-8000-${hex}` as Uuid7;
  };
}

function requireStringArray(
  value: unknown,
  field: string,
  allowEmpty: boolean,
): readonly string[] {
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
}

/** Validate the schema and constraints of a calibration catalog. */
export function validateCalibrationCatalog(
  raw: unknown,
): VerificationCalibrationCatalog {
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
    const c = item as Record<string, unknown>;
    if (
      typeof c.id !== "string" ||
      c.id.trim().length === 0 ||
      seenIds.has(c.id)
    ) {
      throw new Error(
        `invalid or duplicate calibration case id: ${String(c.id)}`,
      );
    }
    const id = c.id;
    seenIds.add(id);
    const tier = c.tier as VerificationTier;
    if (tier !== 0 && tier !== 1 && tier !== 2 && tier !== 3) {
      throw new Error(`${id}: invalid tier ${String(c.tier)}`);
    }
    const riskClass = c.risk_class;
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
      c.changed_files,
      `${id}.changed_files`,
      true,
    );
    const requiredEvidence = requireStringArray(
      c.required_evidence,
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
        c.expected_outcome as CalibrationCase["expected_outcome"],
      )
    ) {
      throw new Error(
        `${id}: unrecognized expected_outcome: ${String(c.expected_outcome)}`,
      );
    }
    cases.push({
      id,
      tier,
      risk_class: riskClass as CalibrationCase["risk_class"],
      changed_files: changedFiles,
      expected_outcome:
        c.expected_outcome as CalibrationCase["expected_outcome"],
      required_evidence: requiredEvidence,
    });
  }
  return { schema_version: CALIBRATION_SCHEMA_VERSION, cases };
}

const SOURCE_REVISION = "a".repeat(40);
const STALE_SOURCE_REVISION = "b".repeat(40);
const ENVIRONMENT_DIGEST = `sha256:${"c".repeat(64)}`;
const NOW = "2026-09-02T00:00:00.000Z" as Rfc3339Timestamp;
const FINAL_CHECKPOINT = contentArtifactRef(
  new TextEncoder().encode("verification-calibration-checkpoint"),
  "application/json",
);

function criterionFor(c: CalibrationCase): AcceptanceCriterion {
  const verificationHint =
    c.tier === 0
      ? null
      : c.tier === 1
        ? "predicate: diff_policy"
        : c.tier === 3
          ? "predicate: security_scanner"
          : c.expected_outcome === "wrong_completion"
            ? "command: calibration-unit-test"
            : "predicate: file_parses";
  return {
    id: `criterion:${c.id}`,
    statement: `Known-outcome calibration case ${c.id}`,
    verificationHint,
    required: true,
  };
}

function buildCasePlan(c: CalibrationCase): {
  readonly criterion: AcceptanceCriterion;
  readonly plan: VerificationPlan;
} {
  const idSource = dummyIdSource();
  const criterion = criterionFor(c);
  const derivation = deriveVerificationNodes({
    criteria: [criterion],
    objective: `calibration:${c.id}`,
    riskClass: c.risk_class ?? "normal",
    mode: "admission",
    signals: {
      changedFiles: c.changed_files,
      nativeTestCommands:
        c.expected_outcome === "wrong_completion"
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
}

function passingResult(
  plan: VerificationPlan,
  node: VerificationPlan["nodes"][number],
  idSource: () => Uuid7,
): VerificationResult {
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
}

function corruptResultsForCase(
  c: CalibrationCase,
  plan: VerificationPlan,
  results: readonly VerificationResult[],
): readonly VerificationResult[] {
  const criterionNode = plan.nodes.find(
    (node) => node.acceptanceCriterionId !== null,
  );
  if (criterionNode === undefined)
    throw new Error(`${c.id}: derived plan has no criterion node`);
  switch (c.expected_outcome) {
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
  }
}

function expectedDenial(
  outcome: CalibrationCase["expected_outcome"],
): CompletionDenialReason | null {
  switch (outcome) {
    case "correct_completion":
      return null;
    case "wrong_completion":
    case "stale_evidence_rejected":
    case "missing_evidence_rejected":
      return "binding_invalid";
    case "irrelevant_evidence_rejected":
      return "evidence_missing";
  }
}

/** Run known-outcome cases through the production completion-admission gate. */
export function runVerificationCalibration(
  catalog: VerificationCalibrationCatalog,
): VerificationCalibrationReport {
  const results: CalibrationCaseResult[] = [];
  const tierDistribution: Record<VerificationTier, number> = {
    0: 0,
    1: 0,
    2: 0,
    3: 0,
  };

  for (const c of catalog.cases) {
    tierDistribution[c.tier] += 1;
    const expectedComplete = c.expected_outcome === "correct_completion";
    const classified = classifyVerificationTier({
      riskClass: c.risk_class ?? "normal",
      changedFiles: c.changed_files,
    });
    if (classified.tier !== c.tier) {
      results.push({
        id: c.id,
        tier: c.tier,
        expectedOutcome: c.expected_outcome,
        actualOutcome: `tier_mismatch:${classified.tier}`,
        passed: false,
        falseCompletion: false,
        falseBlock: expectedComplete,
        diagnostic: `expected tier ${c.tier}, got ${classified.tier}: ${classified.reason}`,
      });
      continue;
    }

    const { criterion, plan } = buildCasePlan(c);
    const predicateTypes = new Set(
      plan.nodes.map((node) => parseNodeSpec(node.specification).predicateType),
    );
    const missingPlanEvidence = c.required_evidence.filter(
      (evidence) =>
        !SPECIAL_EVIDENCE_REQUIREMENTS.has(evidence) &&
        !predicateTypes.has(evidence as PredicateType),
    );
    if (missingPlanEvidence.length > 0) {
      results.push({
        id: c.id,
        tier: c.tier,
        expectedOutcome: c.expected_outcome,
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
    const observedResults = corruptResultsForCase(c, plan, cleanResults);
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
    const expectedReason = expectedDenial(c.expected_outcome);
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
      id: c.id,
      tier: c.tier,
      expectedOutcome: c.expected_outcome,
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
