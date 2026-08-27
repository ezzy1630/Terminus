import type { ContentHash } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

/** Inputs that identify one exact provider submission. */
export interface ProviderAttemptIdentityInput {
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelKey: string;
  /** Hash of the full, canonical model/provider capability snapshot. */
  readonly modelSnapshotHash: ContentHash | string;
  /** Hash of the exact canonical request artifact persisted before dispatch. */
  readonly requestArtifactHash: ContentHash | string;
  /** Exact admitted provider endpoint or kernel transport identity. */
  readonly endpoint: string;
  /** Hash of the canonical tool schemas supplied to the renderer. */
  readonly toolSchemaHash: ContentHash | string;
  /** Immutable context epoch that produced the request. */
  readonly contextEpochId: string;
}

export interface ProviderAttemptIdentity {
  readonly requestFingerprint: ContentHash;
  /** Stable across retries of this durable attempt, and safe to pass to the kernel. */
  readonly providerIdempotencyKey: string;
}

function requireNonEmpty(name: string, value: string): string {
  if (value.trim() === "") throw new Error(`provider attempt identity ${name} must not be empty`);
  return value;
}

export function providerAttemptIdempotencyKey(attemptId: string): string {
  return `provider-attempt:${requireNonEmpty("attemptId", attemptId)}`;
}

/**
 * Derive identity only from durable, canonical inputs. The request artifact
 * hash is the content identity of the exact request bytes; hashing this
 * record avoids copying provider bodies into the operational database.
 */
export function deriveProviderAttemptIdentity(
  input: ProviderAttemptIdentityInput,
): ProviderAttemptIdentity {
  const attemptId = requireNonEmpty("attemptId", input.attemptId);
  const identity = {
    schema: "terminus.provider-attempt-identity.v1",
    attempt_id: attemptId,
    provider_id: requireNonEmpty("providerId", input.providerId),
    model_key: requireNonEmpty("modelKey", input.modelKey),
    model_snapshot_hash: requireNonEmpty("modelSnapshotHash", input.modelSnapshotHash),
    request_artifact_hash: requireNonEmpty("requestArtifactHash", input.requestArtifactHash),
    endpoint: requireNonEmpty("endpoint", input.endpoint),
    tool_schema_hash: requireNonEmpty("toolSchemaHash", input.toolSchemaHash),
    context_epoch_id: requireNonEmpty("contextEpochId", input.contextEpochId),
  };
  return {
    requestFingerprint: computeContentHash(canonicalJson(identity)),
    providerIdempotencyKey: providerAttemptIdempotencyKey(attemptId),
  };
}
