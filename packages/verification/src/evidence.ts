/**
 * Claim/evidence graph for verification admission.
 *
 * A passing node is not itself a claim. The graph binds the acceptance
 * criterion to the exact verifier result artifacts, source revision, and
 * environment used to produce them. Review and admission consume this graph;
 * actor prose never enters it.
 */
import type {
  AcceptanceCriterion,
  ArtifactRef,
  Claim,
  ContentHash,
  Evidence,
  VerificationNode,
  VerificationResult,
  Rfc3339Timestamp,
  Uuid7,
} from "@terminus/domain";
import { computeContentHash } from "@terminus/context-ir";
import { parseNodeSpec } from "./node-spec.js";

export interface EvidenceArtifactWriter {
  write(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): Promise<ArtifactRef>;
}

export interface ClaimEvidenceEdge {
  readonly claimId: string;
  readonly evidenceId: string;
}

export interface ClaimEvidenceGraph {
  readonly claims: readonly Claim[];
  readonly evidence: readonly Evidence[];
  readonly edges: readonly ClaimEvidenceEdge[];
}

export interface BuildEvidenceGraphInput {
  readonly taskId: Uuid7;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly nodes: readonly VerificationNode[];
  readonly results: readonly VerificationResult[];
  readonly observedAt: Rfc3339Timestamp;
}

export function claimId(taskId: Uuid7, criterionId: string): string {
  return `claim:${taskId}:${criterionId}`;
}

export function buildClaimEvidenceGraph(input: BuildEvidenceGraphInput): ClaimEvidenceGraph {
  const resultByNode = new Map(input.results.map((result) => [result.nodeId, result] as const));
  const nodeById = new Map(input.nodes.map((node) => [node.id, node] as const));
  const claims: Claim[] = [];
  const evidence: Evidence[] = [];
  const edges: ClaimEvidenceEdge[] = [];

  for (const criterion of input.criteria) {
    const boundNodes = input.nodes.filter((node) => node.acceptanceCriterionId === criterion.id);
    const graphClaimId = claimId(input.taskId, criterion.id);
    const boundResults = boundNodes
      .map((node) => resultByNode.get(node.id))
      .filter((result): result is VerificationResult => result !== undefined);
    const status = criterion.verificationHint?.trim().toLowerCase().startsWith("manual:")
      || criterion.verificationHint?.trim().toLowerCase().startsWith("unverifiable:")
      ? "WAIVED" as const
      : boundResults.length > 0 && boundResults.every((result) => result.status === "pass")
        ? "SATISFIED" as const
        : "PROPOSED" as const;
    claims.push({
      id: graphClaimId,
      taskId: input.taskId,
      statement: criterion.statement,
      requiredEvidenceKind: "verification_result",
      status,
      evidenceIds: [],
      waivedRationale: status === "WAIVED" ? criterion.verificationHint : null,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    });

    const claimEvidenceIds: string[] = [];
    for (const result of boundResults) {
      const node = nodeById.get(result.nodeId);
      const predicateType = node === undefined ? null : parseNodeSpec(node.specification).predicateType;
      for (const [artifactIndex, artifact] of result.artifacts.entries()) {
        const id = `evidence:${result.id}:${artifactIndex}`;
        evidence.push({
          id,
          claimId: graphClaimId,
          kind: predicateType === null ? "verification_result" : `verification:${predicateType}`,
          summary: `${result.status} result for ${result.nodeId}`,
          sourceRevision: result.sourceRevision,
          environmentHash: result.environmentImageDigest,
          verifierResult: result.status,
          artifactRef: artifact,
          metadata: {
            nodeId: result.nodeId,
            resultId: result.id,
            attempts: result.attempts,
          },
          observedAt: result.completedAt ?? result.startedAt,
        });
        claimEvidenceIds.push(id);
        edges.push({ claimId: graphClaimId, evidenceId: id });
      }
    }
    const claim = claims[claims.length - 1]!;
    claims[claims.length - 1] = { ...claim, evidenceIds: claimEvidenceIds };
  }
  return { claims, evidence, edges };
}

export function validateClaimEvidenceGraph(
  graph: ClaimEvidenceGraph,
  expected: {
    readonly sourceRevision: string;
    readonly environmentImageDigest: string;
    readonly requiredClaimIds: readonly string[];
  },
): readonly string[] {
  const evidenceById = new Map(graph.evidence.map((item) => [item.id, item] as const));
  const claimsById = new Map(graph.claims.map((item) => [item.id, item] as const));
  const failures: string[] = [];
  for (const claimIdValue of expected.requiredClaimIds) {
    const claim = claimsById.get(claimIdValue);
    if (claim === undefined) {
      failures.push(`${claimIdValue}: claim missing`);
      continue;
    }
    if (claim.status !== "SATISFIED" && claim.status !== "WAIVED") {
      failures.push(`${claim.id}: claim is ${claim.status}`);
    }
    if (claim.status === "WAIVED") continue;
    if (claim.evidenceIds.length === 0) {
      failures.push(`${claim.id}: no immutable evidence artifact`);
      continue;
    }
    for (const evidenceId of claim.evidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (item === undefined || item.artifactRef === null) {
        failures.push(`${claim.id}: evidence ${evidenceId} has no artifact`);
        continue;
      }
      if (!isImmutableArtifact(item.artifactRef)) {
        failures.push(`${claim.id}: evidence ${evidenceId} is not an immutable artifact reference`);
      }
      if (item.verifierResult !== "pass") failures.push(`${claim.id}: evidence ${evidenceId} did not pass`);
      if (item.sourceRevision !== expected.sourceRevision) failures.push(`${claim.id}: evidence ${evidenceId} has a stale source revision`);
      if (item.environmentHash !== expected.environmentImageDigest) failures.push(`${claim.id}: evidence ${evidenceId} has a stale environment`);
    }
  }
  return failures;
}

export function isImmutableArtifact(artifact: ArtifactRef): boolean {
  const hash = artifact.hash as string;
  const uri = artifact.uri as string;
  return (
    /^sha256:[0-9a-f]{64}$/i.test(hash) &&
    /^artifact:\/\/sha256\/[0-9a-f]{64}$/i.test(uri) &&
    uri.slice("artifact://sha256/".length).toLowerCase() === hash.slice("sha256:".length).toLowerCase() &&
    typeof artifact.bytes === "bigint" &&
    artifact.bytes >= 0n
  );
}

/** Deterministic fallback used by fixture-only runners; production injects a kernel writer. */
export function contentArtifactRef(
  bytes: Uint8Array,
  mediaType: string,
): ArtifactRef {
  const hash = computeContentHash(bytes) as ContentHash;
  return {
    hash,
    uri: `artifact://sha256/${hash.slice("sha256:".length)}`,
    mediaType,
    bytes: BigInt(bytes.byteLength),
  } as ArtifactRef;
}
