/**
 * Deterministic, content-addressed proof bundles for verification admission.
 *
 * A local bundle is tamper-evident, not signed. The content hash is useful
 * only when compared with a separately retained expected hash; an unsigned
 * bundle must never be treated as an authenticated statement by itself.
 */
import type {
  AcceptanceCriterion,
  ArtifactRef,
  ContentHash,
  Rfc3339Timestamp,
  Uuid7,
  VerificationPlan,
  VerificationResult,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";
import {
  bindAcceptanceCriteria,
  type CriterionBinding,
} from "./binding.js";
import {
  contentArtifactRef,
  isImmutableArtifact,
} from "./evidence.js";
import {
  createHumanAcceptanceObligations,
  validateHumanAcceptanceObligations,
  type HumanAcceptanceObligation,
} from "./human-acceptance.js";
import {
  computeVerificationConfigHash,
  isVerifierBindingEqual,
  validateVerifierResultBinding,
  type VerifierBinding,
} from "./run-binding.js";

export const PROOF_BUNDLE_SCHEMA = "terminus.proof-bundle.v1" as const;
export const PROOF_BUNDLE_MEDIA_TYPE = "application/vnd.terminus.proof-bundle+json";

type ProofCriterionStatus =
  | "satisfied"
  | "unsatisfied"
  | "manual"
  | "unverifiable";

export interface ProofBundleCriterionResult {
  readonly id: string;
  readonly statement: string;
  readonly verificationHint: string | null;
  readonly required: boolean;
  readonly status: ProofCriterionStatus;
  readonly evidence: readonly ArtifactRef[];
  readonly reason: string | null;
  readonly humanAcceptanceObligationId: string | null;
}

export interface ProofBundleProviderReceipt {
  readonly id: string;
  readonly providerId: string;
  readonly requestHash: ContentHash;
  readonly responseHash: ContentHash | null;
  readonly receiptHash: ContentHash;
  readonly modelProfileVersion: string;
}

export interface ProofBundleReceipt {
  readonly id: string;
  readonly kind: string;
  readonly hash: ContentHash;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProofBundleExecution {
  readonly resultId: string;
  readonly nodeId: string;
  readonly status: VerificationResult["status"];
  readonly startedAt: Rfc3339Timestamp;
  readonly completedAt: Rfc3339Timestamp | null;
  readonly sourceRevision: string;
  readonly environmentImageDigest: string | null;
  readonly verifierBinding: VerifierBinding;
  readonly commandOrQuery: string;
  readonly exitCode: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly ArtifactRef[];
  readonly toolCallId: Uuid7 | null;
  readonly attempts: number;
}

export interface ProofBundle {
  readonly schema: typeof PROOF_BUNDLE_SCHEMA;
  readonly taskId: Uuid7;
  readonly contractVersion: number;
  readonly taskContractHash: ContentHash;
  readonly acceptanceCriteriaHash: ContentHash;
  readonly criteriaResults: readonly ProofBundleCriterionResult[];
  readonly finalRevision: string;
  /** Git tree hash when available; finalRevision remains the commit/source identity. */
  readonly finalTreeHash: string | null;
  readonly environmentBlueprintDigest: string;
  readonly verifierBinding: VerifierBinding;
  readonly verificationConfigHash: ContentHash;
  readonly providerReceipts: readonly ProofBundleProviderReceipt[];
  readonly toolReceipts: readonly ProofBundleReceipt[];
  readonly effectSettlementReceipts: readonly ProofBundleReceipt[];
  readonly verificationExecutions: readonly ProofBundleExecution[];
  readonly humanAcceptanceObligations: readonly HumanAcceptanceObligation[];
  readonly generatedAt: Rfc3339Timestamp;
  /** Honest local state: this package has no signer interface. */
  readonly signatureStatus: "unsigned_local";
  readonly signature: null;
  /** SHA-256 of canonical content, not a signature. */
  readonly contentHash: ContentHash;
  /** Content-addressed reference to the canonical JSON bytes. */
  readonly artifactRef: ArtifactRef;
}

export interface ProofBundleBuildInput {
  readonly taskId: Uuid7;
  readonly contractVersion: number;
  readonly taskContractHash: ContentHash;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly plan: VerificationPlan;
  readonly results: readonly VerificationResult[];
  readonly finalRevision: string;
  readonly finalTreeHash: string | null;
  readonly environmentBlueprintDigest: string;
  readonly verifierBinding: VerifierBinding;
  readonly providerReceipts: readonly ProofBundleProviderReceipt[];
  readonly toolReceipts: readonly ProofBundleReceipt[];
  readonly effectSettlementReceipts: readonly ProofBundleReceipt[];
  readonly humanAcceptanceObligations?: readonly HumanAcceptanceObligation[] | undefined;
  readonly generatedAt: Rfc3339Timestamp;
}

export interface ProofBundleExpectations {
  /** A trusted value retained outside the unsigned bundle. */
  readonly expectedContentHash?: ContentHash | undefined;
  readonly taskContractHash?: ContentHash | undefined;
  readonly criteria?: readonly AcceptanceCriterion[] | undefined;
  readonly plan?: VerificationPlan | undefined;
  readonly results?: readonly VerificationResult[] | undefined;
  readonly sourceRevision?: string | undefined;
  readonly environmentBlueprintDigest?: string | undefined;
  readonly verifierBinding?: VerifierBinding | undefined;
  readonly humanAcceptanceObligations?: readonly HumanAcceptanceObligation[] | undefined;
  /** Require an independently anchored bundle for completion admission. */
  readonly requireTrusted?: boolean | undefined;
}

export interface ProofBundleVerification {
  readonly valid: boolean;
  readonly trusted: boolean;
  readonly failures: readonly string[];
}

export interface ProofBundleAdmission extends ProofBundleVerification {
  readonly admissible: boolean;
}

type ProofBundleContent = Omit<ProofBundle, "contentHash" | "artifactRef">;

const contentHashPattern = /^sha256:[0-9a-f]{64}$/;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortById<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compareStrings(left.id, right.id));
}

function sortArtifacts(values: readonly ArtifactRef[]): ArtifactRef[] {
  return [...values].sort((left, right) => {
    const hash = compareStrings(left.hash, right.hash);
    if (hash !== 0) return hash;
    return compareStrings(left.uri, right.uri);
  });
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new ValidationError(`${field} is required`);
}

function requireContentHash(value: string, field: string): void {
  if (!contentHashPattern.test(value)) {
    throw new ValidationError(`${field} must be a lowercase sha256 content hash`, { value });
  }
}

function unique(values: readonly string[], field: string, failures: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) failures.push(`${field}: duplicate '${value}'`);
    seen.add(value);
  }
}

function canonicalCriteria(criteria: readonly AcceptanceCriterion[]): readonly Record<string, unknown>[] {
  return [...criteria]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      verificationHint: criterion.verificationHint,
      required: criterion.required,
    }));
}

/** Hash the exact acceptance contract, independent of input array order. */
export function computeAcceptanceCriteriaHash(
  criteria: readonly AcceptanceCriterion[],
): ContentHash {
  return computeContentHash(canonicalJson(canonicalCriteria(criteria)));
}

function embeddedCriteria(bundle: ProofBundle): readonly AcceptanceCriterion[] {
  return bundle.criteriaResults.map((criterion) => ({
    id: criterion.id,
    statement: criterion.statement,
    verificationHint: criterion.verificationHint,
    required: criterion.required,
  }));
}

function canonicalArtifact(artifact: ArtifactRef): Readonly<Record<string, unknown>> {
  return {
    hash: artifact.hash,
    uri: artifact.uri,
    mediaType: artifact.mediaType,
    bytes: artifact.bytes,
  };
}

function canonicalCriterionResult(
  criterion: ProofBundleCriterionResult,
): Readonly<Record<string, unknown>> {
  return {
    id: criterion.id,
    statement: criterion.statement,
    verificationHint: criterion.verificationHint,
    required: criterion.required,
    status: criterion.status,
    evidence: sortArtifacts(criterion.evidence).map(canonicalArtifact),
    reason: criterion.reason,
    humanAcceptanceObligationId: criterion.humanAcceptanceObligationId,
  };
}

function canonicalProviderReceipt(
  receipt: ProofBundleProviderReceipt,
): Readonly<Record<string, unknown>> {
  return {
    id: receipt.id,
    providerId: receipt.providerId,
    requestHash: receipt.requestHash,
    responseHash: receipt.responseHash,
    receiptHash: receipt.receiptHash,
    modelProfileVersion: receipt.modelProfileVersion,
  };
}

function canonicalReceipt(receipt: ProofBundleReceipt): Readonly<Record<string, unknown>> {
  return {
    id: receipt.id,
    kind: receipt.kind,
    hash: receipt.hash,
    metadata: receipt.metadata ?? {},
  };
}

function canonicalObligation(
  obligation: HumanAcceptanceObligation,
): Readonly<Record<string, unknown>> {
  return {
    id: obligation.id,
    criterionId: obligation.criterionId,
    statement: obligation.statement,
    instructions: obligation.instructions,
    required: obligation.required,
    status: obligation.status,
    acceptedBy: obligation.acceptedBy,
    acceptedAt: obligation.acceptedAt,
    evidence: sortArtifacts(obligation.evidence).map(canonicalArtifact),
    sourceRevision: obligation.sourceRevision,
    environmentImageDigest: obligation.environmentImageDigest,
  };
}

function canonicalExecution(
  execution: ProofBundleExecution,
): Readonly<Record<string, unknown>> {
  return {
    resultId: execution.resultId,
    nodeId: execution.nodeId,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    sourceRevision: execution.sourceRevision,
    environmentImageDigest: execution.environmentImageDigest,
    verifierBinding: execution.verifierBinding,
    commandOrQuery: execution.commandOrQuery,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    observations: execution.observations,
    artifacts: sortArtifacts(execution.artifacts).map(canonicalArtifact),
    toolCallId: execution.toolCallId,
    attempts: execution.attempts,
  };
}

function canonicalBundleContent(bundle: ProofBundleContent): Readonly<Record<string, unknown>> {
  return {
    schema: bundle.schema,
    taskId: bundle.taskId,
    contractVersion: bundle.contractVersion,
    taskContractHash: bundle.taskContractHash,
    acceptanceCriteriaHash: bundle.acceptanceCriteriaHash,
    criteriaResults: sortById(bundle.criteriaResults).map(canonicalCriterionResult),
    finalRevision: bundle.finalRevision,
    finalTreeHash: bundle.finalTreeHash,
    environmentBlueprintDigest: bundle.environmentBlueprintDigest,
    verifierBinding: bundle.verifierBinding,
    verificationConfigHash: bundle.verificationConfigHash,
    providerReceipts: sortById(bundle.providerReceipts).map(canonicalProviderReceipt),
    toolReceipts: sortById(bundle.toolReceipts).map(canonicalReceipt),
    effectSettlementReceipts: sortById(bundle.effectSettlementReceipts).map(canonicalReceipt),
    verificationExecutions: [...bundle.verificationExecutions]
      .sort((left, right) => {
        const node = compareStrings(left.nodeId, right.nodeId);
        if (node !== 0) return node;
        return compareStrings(left.resultId, right.resultId);
      })
      .map(canonicalExecution),
    humanAcceptanceObligations: sortById(bundle.humanAcceptanceObligations).map(canonicalObligation),
    generatedAt: bundle.generatedAt,
    signatureStatus: bundle.signatureStatus,
  };
}

/** Canonical UTF-8 JSON content hashed by a proof bundle. */
export function canonicalizeProofBundle(bundle: ProofBundle): string {
  return canonicalJson(canonicalBundleContent(bundle));
}

/** Compute the bundle's content hash without trusting its stored hash. */
export function computeProofBundleHash(bundle: ProofBundle): ContentHash {
  return computeContentHash(canonicalizeProofBundle(bundle));
}

/**
 * Stable fingerprint for the independently retained result set. Lifecycles
 * use this to detect evidence replacement between evaluation and completion.
 */
export function computeVerificationResultsHash(
  results: readonly VerificationResult[],
): ContentHash {
  const ordered = [...results].sort((left, right) => {
    const node = compareStrings(left.nodeId, right.nodeId);
    if (node !== 0) return node;
    return compareStrings(left.id, right.id);
  });
  return computeContentHash(canonicalJson(ordered));
}

function resultBindingFailures(
  result: VerificationResult,
  input: ProofBundleBuildInput,
): readonly string[] {
  const failures: string[] = [];
  if (result.planId !== input.plan.id) failures.push(`${result.nodeId}: result belongs to another plan`);
  if (result.sourceRevision !== input.finalRevision) {
    failures.push(`${result.nodeId}: result has a stale source revision`);
  }
  if (result.environmentImageDigest !== input.environmentBlueprintDigest) {
    failures.push(`${result.nodeId}: result has a stale environment`);
  }
  failures.push(...validateVerifierResultBinding(result, input.verifierBinding).map(
    (failure) => `${result.nodeId}: ${failure}`,
  ));
  for (const artifact of result.artifacts) {
    if (!isImmutableArtifact(artifact)) {
      failures.push(`${result.nodeId}: result contains a non-immutable artifact reference`);
    }
  }
  return failures;
}

function executionFromResult(
  result: VerificationResult,
  verifierBinding: VerifierBinding,
): ProofBundleExecution {
  const stdout = result.structuredObservations["stdout"];
  const stderr = result.structuredObservations["stderr"];
  return {
    resultId: result.id,
    nodeId: result.nodeId,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    sourceRevision: result.sourceRevision,
    environmentImageDigest: result.environmentImageDigest,
    verifierBinding,
    commandOrQuery: result.commandOrQuery,
    exitCode: result.exitCode,
    stdout: typeof stdout === "string" ? stdout : null,
    stderr: typeof stderr === "string" ? stderr : null,
    observations: result.structuredObservations,
    artifacts: result.artifacts,
    toolCallId: result.toolCallId,
    attempts: result.attempts,
  };
}

function criterionResult(
  criterion: AcceptanceCriterion,
  binding: CriterionBinding,
  resultsByNode: ReadonlyMap<string, VerificationResult>,
  obligationsByCriterion: ReadonlyMap<string, HumanAcceptanceObligation>,
): ProofBundleCriterionResult {
  const boundResults = binding.nodeIds
    .map((nodeId) => resultsByNode.get(nodeId))
    .filter((result): result is VerificationResult => result !== undefined);
  const evidence = sortArtifacts(boundResults.flatMap((result) => result.artifacts));
  const obligation = obligationsByCriterion.get(criterion.id);
  const humanAcceptanceObligationId = obligation?.id ?? null;

  if (binding.disposition === "unverifiable") {
    return {
      id: criterion.id,
      statement: criterion.statement,
      verificationHint: criterion.verificationHint,
      required: criterion.required,
      status: "unverifiable",
      evidence,
      reason: "criterion is explicitly unverifiable",
      humanAcceptanceObligationId,
    };
  }
  if (binding.disposition === "manual" || binding.requiresHumanAcceptance) {
    return {
      id: criterion.id,
      statement: criterion.statement,
      verificationHint: criterion.verificationHint,
      required: criterion.required,
      status: "manual",
      evidence: sortArtifacts([
        ...evidence,
        ...(obligation?.evidence ?? []),
      ]),
      reason: obligation?.status === "accepted"
        ? null
        : "human acceptance obligation is not accepted",
      humanAcceptanceObligationId,
    };
  }

  const allPass = binding.nodeIds.length > 0
    && binding.nodeIds.every((nodeId) => resultsByNode.get(nodeId)?.status === "pass");
  return {
    id: criterion.id,
    statement: criterion.statement,
    verificationHint: criterion.verificationHint,
    required: criterion.required,
    status: allPass ? "satisfied" : "unsatisfied",
    evidence,
    reason: allPass ? null : "required predicate did not pass",
    humanAcceptanceObligationId,
  };
}

function validateReceipt(
  receipt: ProofBundleProviderReceipt | ProofBundleReceipt,
  failures: string[],
): void {
  if (receipt.id.trim().length === 0) failures.push("receipt id is empty");
  const primaryHash = "requestHash" in receipt ? receipt.requestHash : receipt.hash;
  if (!contentHashPattern.test(primaryHash)) {
    failures.push(`${receipt.id}: receipt request/hash is not a content hash`);
  }
  if ("responseHash" in receipt && receipt.responseHash !== null && !contentHashPattern.test(receipt.responseHash)) {
    failures.push(`${receipt.id}: receipt response hash is not a content hash`);
  }
  if ("receiptHash" in receipt && !contentHashPattern.test(receipt.receiptHash)) {
    failures.push(`${receipt.id}: receipt hash is not a content hash`);
  }
  if ("providerId" in receipt) {
    if (receipt.providerId.trim().length === 0) failures.push(`${receipt.id}: provider id is empty`);
    if (receipt.modelProfileVersion.trim().length === 0) {
      failures.push(`${receipt.id}: model profile version is empty`);
    }
  }
}

function validateBundleShape(bundle: ProofBundle): readonly string[] {
  const failures: string[] = [];
  if (bundle.schema !== PROOF_BUNDLE_SCHEMA) failures.push("unsupported proof bundle schema");
  if (bundle.signatureStatus !== "unsigned_local" || bundle.signature !== null) {
    failures.push("bundle claims a signature unsupported by the local verifier");
  }
  requireText(bundle.finalRevision, "finalRevision");
  requireText(bundle.environmentBlueprintDigest, "environmentBlueprintDigest");
  requireContentHash(bundle.taskContractHash, "taskContractHash");
  requireContentHash(bundle.acceptanceCriteriaHash, "acceptanceCriteriaHash");
  requireContentHash(bundle.verificationConfigHash, "verificationConfigHash");
  requireContentHash(bundle.contentHash, "contentHash");
  requireText(bundle.verifierBinding.verifierId, "verifierId");
  requireText(bundle.verifierBinding.verifierVersion, "verifierVersion");
  requireContentHash(bundle.verifierBinding.configurationHash, "verifierBinding.configurationHash");
  if (bundle.verifierBinding.configurationHash !== bundle.verificationConfigHash) {
    failures.push("verifier binding configuration hash differs from bundle configuration hash");
  }
  if (bundle.finalTreeHash !== null) requireText(bundle.finalTreeHash, "finalTreeHash");
  unique(bundle.criteriaResults.map((criterion) => criterion.id), "criteriaResults", failures);
  unique(bundle.verificationExecutions.map((execution) => execution.resultId), "verificationExecutions", failures);
  unique(bundle.humanAcceptanceObligations.map((obligation) => obligation.id), "humanAcceptanceObligations", failures);
  unique(bundle.providerReceipts.map((receipt) => receipt.id), "providerReceipts", failures);
  unique(bundle.toolReceipts.map((receipt) => receipt.id), "toolReceipts", failures);
  unique(bundle.effectSettlementReceipts.map((receipt) => receipt.id), "effectSettlementReceipts", failures);

  for (const criterion of bundle.criteriaResults) {
    if (!["satisfied", "unsatisfied", "manual", "unverifiable"].includes(criterion.status)) {
      failures.push(`${criterion.id}: unsupported criterion status`);
    }
    for (const artifact of criterion.evidence) {
      if (!isImmutableArtifact(artifact)) failures.push(`${criterion.id}: invalid criterion evidence`);
    }
  }
  for (const execution of bundle.verificationExecutions) {
    if (execution.sourceRevision !== bundle.finalRevision) {
      failures.push(`${execution.nodeId}: execution source revision is not bundle revision`);
    }
    if (execution.environmentImageDigest !== bundle.environmentBlueprintDigest) {
      failures.push(`${execution.nodeId}: execution environment is not bundle environment`);
    }
    if (!isVerifierBindingEqual(execution.verifierBinding, bundle.verifierBinding)) {
      failures.push(`${execution.nodeId}: execution verifier binding differs from bundle binding`);
    }
    for (const artifact of execution.artifacts) {
      if (!isImmutableArtifact(artifact)) failures.push(`${execution.nodeId}: invalid execution artifact`);
    }
  }
  for (const obligation of bundle.humanAcceptanceObligations) {
    if (obligation.sourceRevision !== bundle.finalRevision) {
      failures.push(`${obligation.criterionId}: obligation source revision is stale`);
    }
    if (obligation.environmentImageDigest !== bundle.environmentBlueprintDigest) {
      failures.push(`${obligation.criterionId}: obligation environment is stale`);
    }
    for (const artifact of obligation.evidence) {
      if (!isImmutableArtifact(artifact)) failures.push(`${obligation.criterionId}: invalid obligation evidence`);
    }
  }
  for (const receipt of bundle.providerReceipts) validateReceipt(receipt, failures);
  for (const receipt of bundle.toolReceipts) validateReceipt(receipt, failures);
  for (const receipt of bundle.effectSettlementReceipts) validateReceipt(receipt, failures);
  return failures;
}

/** Build a deterministic local proof bundle and its content-addressed artifact reference. */
export function buildProofBundle(input: ProofBundleBuildInput): ProofBundle {
  requireText(input.finalRevision, "finalRevision");
  requireText(input.environmentBlueprintDigest, "environmentBlueprintDigest");
  requireContentHash(input.taskContractHash, "taskContractHash");
  if (input.plan.sourceRevision !== input.finalRevision) {
    throw new ValidationError("proof bundle final revision does not match the verification plan");
  }
  if (new Set(input.criteria.map((criterion) => criterion.id)).size !== input.criteria.length) {
    throw new ValidationError("proof bundle criteria contain duplicate identifiers");
  }
  if (input.finalTreeHash !== null) requireText(input.finalTreeHash, "finalTreeHash");
  if (input.verifierBinding.configurationHash !== computeVerificationConfigHash(input.plan)) {
    throw new ValidationError("proof bundle verifier binding does not match the verification plan");
  }
  const receiptFailures: string[] = [];
  for (const receipt of input.providerReceipts) validateReceipt(receipt, receiptFailures);
  for (const receipt of input.toolReceipts) validateReceipt(receipt, receiptFailures);
  for (const receipt of input.effectSettlementReceipts) validateReceipt(receipt, receiptFailures);
  if (receiptFailures.length > 0) {
    throw new ValidationError("proof bundle contains invalid receipts", { failures: receiptFailures });
  }

  const coverage = bindAcceptanceCriteria(input.criteria, input.plan.nodes);
  if (!coverage.complete) {
    throw new ValidationError("proof bundle cannot omit required criterion bindings", {
      uncoveredRequired: coverage.uncoveredRequired,
    });
  }
  const obligations = input.humanAcceptanceObligations
    ?? createHumanAcceptanceObligations({
      criteria: input.criteria,
      nodes: input.plan.nodes,
      sourceRevision: input.finalRevision,
      environmentImageDigest: input.environmentBlueprintDigest,
    });
  const obligationFailures = validateHumanAcceptanceObligations({
    criteria: input.criteria,
    nodes: input.plan.nodes,
    obligations,
    sourceRevision: input.finalRevision,
    environmentImageDigest: input.environmentBlueprintDigest,
  }).filter((failure) =>
    !failure.includes(": human acceptance is open")
    && !failure.includes(": human acceptance is rejected")
  );
  if (obligationFailures.length > 0) {
    throw new ValidationError("proof bundle contains invalid human acceptance obligations", {
      failures: obligationFailures,
    });
  }

  const resultIds = new Set<string>();
  const resultByNode = new Map<string, VerificationResult>();
  const resultFailures: string[] = [];
  for (const result of input.results) {
    if (resultIds.has(result.id)) resultFailures.push(`duplicate verification result '${result.id}'`);
    resultIds.add(result.id);
    if (resultByNode.has(result.nodeId)) resultFailures.push(`duplicate result for node '${result.nodeId}'`);
    resultByNode.set(result.nodeId, result);
    resultFailures.push(...resultBindingFailures(result, input));
  }
  if (resultFailures.length > 0) {
    throw new ValidationError("proof bundle contains unbound verification results", {
      failures: resultFailures,
    });
  }

  const obligationsByCriterion = new Map(obligations.map((obligation) => [obligation.criterionId, obligation] as const));
  const criteriaResults = coverage.bindings.map((binding) => {
    const criterion = input.criteria.find((candidate) => candidate.id === binding.criterionId);
    if (criterion === undefined) {
      throw new ValidationError(`criterion '${binding.criterionId}' disappeared while building proof bundle`);
    }
    return criterionResult(criterion, binding, resultByNode, obligationsByCriterion);
  });
  const verificationExecutions = input.results.map((result) => executionFromResult(result, input.verifierBinding));
  const bundleBase = {
    schema: PROOF_BUNDLE_SCHEMA,
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    taskContractHash: input.taskContractHash,
    acceptanceCriteriaHash: computeAcceptanceCriteriaHash(input.criteria),
    criteriaResults,
    finalRevision: input.finalRevision,
    finalTreeHash: input.finalTreeHash,
    environmentBlueprintDigest: input.environmentBlueprintDigest,
    verifierBinding: input.verifierBinding,
    verificationConfigHash: computeVerificationConfigHash(input.plan),
    providerReceipts: input.providerReceipts,
    toolReceipts: input.toolReceipts,
    effectSettlementReceipts: input.effectSettlementReceipts,
    verificationExecutions,
    humanAcceptanceObligations: obligations,
    generatedAt: input.generatedAt,
    signatureStatus: "unsigned_local" as const,
    signature: null,
  };
  const canonical = canonicalJson(canonicalBundleContent(bundleBase));
  const contentHash = computeContentHash(canonical);
  const artifactRef = contentArtifactRef(
    new TextEncoder().encode(canonical),
    PROOF_BUNDLE_MEDIA_TYPE,
  );
  return {
    ...bundleBase,
    contentHash,
    artifactRef,
  };
}

function expectedExecutionContent(
  results: readonly VerificationResult[],
  verifierBinding: VerifierBinding,
): string {
  return canonicalJson(
    [...results]
      .map((result) => executionFromResult(result, verifierBinding))
      .sort((left, right) => {
        const node = compareStrings(left.nodeId, right.nodeId);
        if (node !== 0) return node;
        return compareStrings(left.resultId, right.resultId);
      })
      .map(canonicalExecution),
  );
}

/** Verify canonical integrity and all supplied external bindings. */
export function verifyProofBundle(
  bundle: ProofBundle,
  expected: ProofBundleExpectations = {},
): ProofBundleVerification {
  const failures: string[] = [];
  try {
    failures.push(...validateBundleShape(bundle));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  let computedHash: ContentHash | null = null;
  try {
    computedHash = computeProofBundleHash(bundle);
    if (computedHash !== bundle.contentHash) {
      failures.push(`content hash '${bundle.contentHash}' does not match canonical content '${computedHash}'`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (bundle.artifactRef.hash !== bundle.contentHash) {
    failures.push("proof bundle artifact hash does not match content hash");
  }
  if (bundle.artifactRef.uri !== `artifact://sha256/${bundle.contentHash.slice("sha256:".length)}`) {
    failures.push("proof bundle artifact URI does not match content hash");
  }
  if (bundle.artifactRef.mediaType !== PROOF_BUNDLE_MEDIA_TYPE) {
    failures.push("proof bundle artifact media type is not the proof bundle type");
  }
  if (!isImmutableArtifact(bundle.artifactRef)) {
    failures.push("proof bundle artifact reference is not immutable");
  }
  try {
    const canonicalBytes = new TextEncoder().encode(canonicalizeProofBundle(bundle));
    if (bundle.artifactRef.bytes !== BigInt(canonicalBytes.byteLength)) {
      failures.push("proof bundle artifact byte count does not match canonical content");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const embeddedCriteriaHash = computeAcceptanceCriteriaHash(embeddedCriteria(bundle));
  if (embeddedCriteriaHash !== bundle.acceptanceCriteriaHash) {
    failures.push("acceptance criteria hash does not match embedded criteria");
  }

  if (expected.expectedContentHash !== undefined && bundle.contentHash !== expected.expectedContentHash) {
    failures.push("proof bundle does not match the independently retained content hash");
  }
  if (expected.taskContractHash !== undefined && bundle.taskContractHash !== expected.taskContractHash) {
    failures.push("proof bundle task contract hash mismatch");
  }
  if (expected.criteria !== undefined) {
    if (computeAcceptanceCriteriaHash(expected.criteria) !== bundle.acceptanceCriteriaHash) {
      failures.push("proof bundle acceptance criteria changed since plan creation");
    }
  }
  if (expected.plan !== undefined) {
    const expectedConfigHash = computeVerificationConfigHash(expected.plan);
    if (expectedConfigHash !== bundle.verificationConfigHash) {
      failures.push("proof bundle verification configuration changed");
    }
    if (expected.plan.sourceRevision !== bundle.finalRevision) {
      failures.push("proof bundle plan source revision mismatch");
    }
  }
  if (expected.sourceRevision !== undefined && bundle.finalRevision !== expected.sourceRevision) {
    failures.push("proof bundle source revision mismatch");
  }
  if (
    expected.environmentBlueprintDigest !== undefined
    && bundle.environmentBlueprintDigest !== expected.environmentBlueprintDigest
  ) {
    failures.push("proof bundle environment blueprint mismatch");
  }
  if (expected.verifierBinding !== undefined && !isVerifierBindingEqual(bundle.verifierBinding, expected.verifierBinding)) {
    failures.push("proof bundle verifier binding mismatch");
  }
  if (expected.results !== undefined) {
    const binding = expected.verifierBinding ?? bundle.verifierBinding;
    if (expectedExecutionContent(expected.results, binding) !== canonicalJson(
      [...bundle.verificationExecutions]
        .sort((left, right) => {
          const node = compareStrings(left.nodeId, right.nodeId);
          if (node !== 0) return node;
          return compareStrings(left.resultId, right.resultId);
        })
        .map(canonicalExecution),
    )) {
      failures.push("proof bundle verification executions changed");
    }
  }
  if (expected.humanAcceptanceObligations !== undefined) {
    if (canonicalJson(expected.humanAcceptanceObligations.map(canonicalObligation).sort((left, right) =>
      compareStrings(String(left["id"]), String(right["id"])),
    )) !== canonicalJson(bundle.humanAcceptanceObligations.map(canonicalObligation).sort((left, right) =>
      compareStrings(String(left["id"]), String(right["id"])),
    ))) {
      failures.push("proof bundle human acceptance obligations changed");
    }
  }

  const trusted = expected.expectedContentHash !== undefined;
  if (expected.requireTrusted === true && !trusted) {
    failures.push("unsigned local proof bundle lacks an independently retained content hash");
  }
  return {
    valid: failures.length === 0,
    trusted,
    failures,
  };
}

/** Evaluate completion admissibility from a verified proof bundle. */
export function evaluateProofBundleAdmission(
  bundle: ProofBundle,
  expected: ProofBundleExpectations,
): ProofBundleAdmission {
  const verification = verifyProofBundle(bundle, { ...expected, requireTrusted: true });
  const failures = [...verification.failures];
  if (expected.criteria === undefined) failures.push("proof bundle admission requires the trusted acceptance criteria");
  if (expected.plan === undefined) failures.push("proof bundle admission requires the trusted verification plan");
  if (expected.verifierBinding === undefined) failures.push("proof bundle admission requires the trusted verifier binding");
  if (expected.sourceRevision === undefined) failures.push("proof bundle admission requires the trusted source revision");
  if (expected.environmentBlueprintDigest === undefined) {
    failures.push("proof bundle admission requires the trusted environment blueprint");
  }
  const criteria = expected.criteria ?? embeddedCriteria(bundle);
  const nodes = expected.plan?.nodes ?? [];
  failures.push(...validateHumanAcceptanceObligations({
    criteria,
    nodes,
    obligations: bundle.humanAcceptanceObligations,
    sourceRevision: expected.sourceRevision ?? bundle.finalRevision,
    environmentImageDigest: expected.environmentBlueprintDigest ?? bundle.environmentBlueprintDigest,
  }));
  const requiredCriteria = bundle.criteriaResults.filter((criterion) => criterion.required);
  for (const criterion of requiredCriteria) {
    if (criterion.status === "satisfied") continue;
    if (criterion.status === "manual") {
      const obligation = bundle.humanAcceptanceObligations.find(
        (candidate) => candidate.id === criterion.humanAcceptanceObligationId,
      );
      if (obligation?.status === "accepted") continue;
    }
    failures.push(`${criterion.id}: required criterion is ${criterion.status}`);
  }
  return {
    ...verification,
    admissible: failures.length === 0,
    valid: failures.length === 0,
    failures,
  };
}

/** Fail closed when a proof bundle cannot support completion. */
export function assertProofBundleAdmissible(
  bundle: ProofBundle,
  expected: ProofBundleExpectations,
): void {
  const admission = evaluateProofBundleAdmission(bundle, expected);
  if (!admission.admissible) {
    throw new ValidationError("proof bundle admission denied", {
      failures: admission.failures,
    });
  }
}
