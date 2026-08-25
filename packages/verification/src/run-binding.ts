/**
 * Immutable identity for a verification run.
 *
 * Source revision and environment are carried by every result already. This
 * module adds the verifier identity and the hash of the verification plan so
 * a result cannot be replayed under a different verifier configuration.
 */
import type {
  ContentHash,
  VerificationPlan,
  VerificationResult,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

export const DEFAULT_VERIFIER_ID = "terminus.verification.engine";
export const DEFAULT_VERIFIER_VERSION = "1.0.0";

export interface VerifierIdentity {
  readonly verifierId: string;
  readonly verifierVersion: string;
}

export interface VerifierBinding extends VerifierIdentity {
  /** Hash of the immutable verification plan configuration. */
  readonly configurationHash: ContentHash;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalSpecification(specification: string): string {
  const trimmed = specification.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    return canonicalJson(JSON.parse(trimmed) as unknown);
  } catch {
    // Invalid specifications are still part of the configuration identity.
    // The plan builder/executor will reject them separately.
    return trimmed;
  }
}

/**
 * Return the plan fields that affect verification semantics. Timestamps and
 * derived insertion order are deliberately excluded so the same plan has a
 * stable configuration identity across persistence and replay.
 */
export function canonicalVerificationPlan(plan: VerificationPlan): Readonly<Record<string, unknown>> {
  return {
    taskContractId: plan.taskContractId,
    taskContractVersion: plan.taskContractVersion,
    sourceRevision: plan.sourceRevision,
    completionExpression: plan.completionExpression,
    nodes: [...plan.nodes]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        required: node.required,
        dependsOn: [...node.dependsOn].sort(compareStrings),
        specification: canonicalSpecification(node.specification),
        timeout: node.timeout,
        retryPolicy: {
          maxAttempts: node.retryPolicy.maxAttempts,
          backoffMs: node.retryPolicy.backoffMs,
          flakeIdentity: node.retryPolicy.flakeIdentity,
        },
        acceptanceCriterionId: node.acceptanceCriterionId,
      })),
    edges: [...plan.edges]
      .sort((left, right) => {
        const from = compareStrings(left.from, right.from);
        if (from !== 0) return from;
        const to = compareStrings(left.to, right.to);
        if (to !== 0) return to;
        return compareStrings(left.kind, right.kind);
      })
      .map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
  };
}

/** Compute the content identity of the plan's verifier configuration. */
export function computeVerificationConfigHash(plan: VerificationPlan): ContentHash {
  return computeContentHash(canonicalJson(canonicalVerificationPlan(plan)));
}

export function createVerifierBinding(
  plan: VerificationPlan,
  identity: VerifierIdentity = {
    verifierId: DEFAULT_VERIFIER_ID,
    verifierVersion: DEFAULT_VERIFIER_VERSION,
  },
): VerifierBinding {
  return {
    verifierId: requireNonEmpty(identity.verifierId, "verifierId"),
    verifierVersion: requireNonEmpty(identity.verifierVersion, "verifierVersion"),
    configurationHash: computeVerificationConfigHash(plan),
  };
}

export function isVerifierBindingEqual(
  left: VerifierBinding,
  right: VerifierBinding,
): boolean {
  return left.verifierId === right.verifierId
    && left.verifierVersion === right.verifierVersion
    && left.configurationHash === right.configurationHash;
}

interface RawVerificationBinding {
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly configurationHash: string;
}

export type VerificationBindingState = "absent" | "invalid" | "valid";

/** Distinguish an omitted binding from a malformed binding at an untrusted boundary. */
export function verificationResultBindingState(result: VerificationResult): VerificationBindingState {
  const value = result.structuredObservations["verificationBinding"];
  if (value === undefined) return "absent";
  return rawBinding(value) === null ? "invalid" : "valid";
}

function rawBinding(value: unknown): RawVerificationBinding | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record["verifierId"] !== "string"
    || typeof record["verifierVersion"] !== "string"
    || typeof record["configurationHash"] !== "string"
  ) {
    return null;
  }
  return {
    verifierId: record["verifierId"],
    verifierVersion: record["verifierVersion"],
    configurationHash: record["configurationHash"],
  };
}

/** Read the binding stamped by the verification engine, if present. */
export function readVerificationResultBinding(
  result: VerificationResult,
): VerifierBinding | null {
  const parsed = rawBinding(result.structuredObservations["verificationBinding"]);
  if (parsed === null) return null;
  return parsed as VerifierBinding;
}

/** Return precise verifier-binding failures for a result. */
export function validateVerifierResultBinding(
  result: VerificationResult,
  expected: VerifierBinding,
): readonly string[] {
  const failures: string[] = [];
  if (result.verifierVersion !== expected.verifierVersion) {
    failures.push(
      `verifier version '${result.verifierVersion}' != expected '${expected.verifierVersion}'`,
    );
  }
  const actual = readVerificationResultBinding(result);
  if (actual === null) {
    failures.push(
      verificationResultBindingState(result) === "invalid"
        ? "result contains a malformed verifier binding"
        : "result is missing verifier binding",
    );
    return failures;
  }
  if (actual.verifierId !== expected.verifierId) {
    failures.push(`verifier id '${actual.verifierId}' != expected '${expected.verifierId}'`);
  }
  if (actual.verifierVersion !== expected.verifierVersion) {
    failures.push(
      `bound verifier version '${actual.verifierVersion}' != expected '${expected.verifierVersion}'`,
    );
  }
  if (actual.configurationHash !== expected.configurationHash) {
    failures.push(
      `verifier configuration '${actual.configurationHash}' != expected '${expected.configurationHash}'`,
    );
  }
  return failures;
}

/** Stamp the trusted engine binding onto a result after validation. */
export function stampVerificationResultBinding(
  result: VerificationResult,
  binding: VerifierBinding,
): VerificationResult {
  return {
    ...result,
    structuredObservations: {
      ...result.structuredObservations,
      verificationBinding: {
        verifierId: binding.verifierId,
        verifierVersion: binding.verifierVersion,
        configurationHash: binding.configurationHash,
      },
    },
  };
}
