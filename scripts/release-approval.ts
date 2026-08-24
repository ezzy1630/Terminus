import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export const RELEASE_APPROVAL_ROLES = [
  "release_owner",
  "security_owner",
  "protocol_owner",
  "evaluation_owner",
] as const;

export type ReleaseApprovalRole = (typeof RELEASE_APPROVAL_ROLES)[number];

export type ReleaseApprovalPayload = {
  schema: "terminus.release-approval.v1";
  role: ReleaseApprovalRole;
  identity: string;
  candidate_commit: string;
  release_version: string;
  evidence_manifest_sha256: string;
  issued_at: string;
  expires_at: string;
};

export type ReleaseApprovalEnvelope = {
  schema: "terminus.release-approval-envelope.v1";
  algorithm: "ed25519";
  key_id: string;
  signed_payload: string;
  signature_base64: string;
};

export type TrustedApprovalKey = {
  key_id: string;
  algorithm: "ed25519";
  identity: string;
  roles: ReleaseApprovalRole[];
  public_key_pem: string;
  not_before?: string;
  not_after?: string;
  revoked?: boolean;
};

export type ReleaseApprovalTrustStore = {
  schema: "terminus.release-approval-trust.v1";
  keys: TrustedApprovalKey[];
};

export type ReleaseApprovalExpectation = {
  role: ReleaseApprovalRole;
  candidateCommit: string;
  releaseVersion: string;
  evidenceManifestSha256: string;
  nowMs?: number;
};

export type VerifiedReleaseApproval = {
  payload: ReleaseApprovalPayload;
  envelope: ReleaseApprovalEnvelope;
  envelopeSha256: string;
};

const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertExactFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unexpected fields: ${unexpected.join(", ")}`);
  }
}

function requiredString(value: Record<string, unknown>, field: string, label: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return candidate;
}

function parseRole(value: unknown, label: string): ReleaseApprovalRole {
  if (
    typeof value !== "string" ||
    !RELEASE_APPROVAL_ROLES.includes(value as ReleaseApprovalRole)
  ) {
    throw new Error(`${label} must be one of ${RELEASE_APPROVAL_ROLES.join(", ")}`);
  }
  return value as ReleaseApprovalRole;
}

function parseIsoTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return parsed;
}

function decodeBase64(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return decoded;
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function parseReleaseApprovalEnvelope(value: unknown): ReleaseApprovalEnvelope {
  const envelope = record(value, "approval envelope");
  assertExactFields(
    envelope,
    ["schema", "algorithm", "key_id", "signed_payload", "signature_base64"],
    "approval envelope",
  );
  if (envelope.schema !== "terminus.release-approval-envelope.v1") {
    throw new Error("approval envelope.schema must be terminus.release-approval-envelope.v1");
  }
  if (envelope.algorithm !== "ed25519") {
    throw new Error("approval envelope.algorithm must be ed25519");
  }
  return {
    schema: "terminus.release-approval-envelope.v1",
    algorithm: "ed25519",
    key_id: requiredString(envelope, "key_id", "approval envelope"),
    signed_payload: requiredString(envelope, "signed_payload", "approval envelope"),
    signature_base64: requiredString(envelope, "signature_base64", "approval envelope"),
  };
}

export function parseReleaseApprovalPayload(value: unknown): ReleaseApprovalPayload {
  const payload = record(value, "approval payload");
  assertExactFields(
    payload,
    [
      "schema",
      "role",
      "identity",
      "candidate_commit",
      "release_version",
      "evidence_manifest_sha256",
      "issued_at",
      "expires_at",
    ],
    "approval payload",
  );
  if (payload.schema !== "terminus.release-approval.v1") {
    throw new Error("approval payload.schema must be terminus.release-approval.v1");
  }
  const evidenceManifestSha256 = requiredString(
    payload,
    "evidence_manifest_sha256",
    "approval payload",
  );
  if (!SHA256_PATTERN.test(evidenceManifestSha256)) {
    throw new Error("approval payload.evidence_manifest_sha256 must be a sha256 digest");
  }
  const candidateCommit = requiredString(payload, "candidate_commit", "approval payload");
  if (!GIT_OBJECT_PATTERN.test(candidateCommit)) {
    throw new Error("approval payload.candidate_commit must be a full Git object id");
  }
  return {
    schema: "terminus.release-approval.v1",
    role: parseRole(payload.role, "approval payload.role"),
    identity: requiredString(payload, "identity", "approval payload"),
    candidate_commit: candidateCommit,
    release_version: requiredString(payload, "release_version", "approval payload"),
    evidence_manifest_sha256: evidenceManifestSha256,
    issued_at: requiredString(payload, "issued_at", "approval payload"),
    expires_at: requiredString(payload, "expires_at", "approval payload"),
  };
}

export function canonicalReleaseApprovalPayload(payload: ReleaseApprovalPayload): string {
  return JSON.stringify({
    schema: payload.schema,
    role: payload.role,
    identity: payload.identity,
    candidate_commit: payload.candidate_commit,
    release_version: payload.release_version,
    evidence_manifest_sha256: payload.evidence_manifest_sha256,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
  });
}

function parseTrustedKey(value: unknown, index: number): TrustedApprovalKey {
  const label = `approval trust store.keys[${index}]`;
  const key = record(value, label);
  assertExactFields(
    key,
    [
      "key_id",
      "algorithm",
      "identity",
      "roles",
      "public_key_pem",
      "not_before",
      "not_after",
      "revoked",
    ],
    label,
  );
  if (key.algorithm !== "ed25519") throw new Error(`${label}.algorithm must be ed25519`);
  if (!Array.isArray(key.roles) || key.roles.length === 0) {
    throw new Error(`${label}.roles must contain at least one role`);
  }
  const roles = key.roles.map((role) => parseRole(role, `${label}.roles`));
  if (new Set(roles).size !== roles.length) throw new Error(`${label}.roles contains duplicates`);
  if (key.not_before !== undefined && typeof key.not_before !== "string") {
    throw new Error(`${label}.not_before must be a string`);
  }
  if (key.not_after !== undefined && typeof key.not_after !== "string") {
    throw new Error(`${label}.not_after must be a string`);
  }
  if (key.revoked !== undefined && typeof key.revoked !== "boolean") {
    throw new Error(`${label}.revoked must be a boolean`);
  }
  const notBefore =
    typeof key.not_before === "string"
      ? parseIsoTimestamp(key.not_before, `${label}.not_before`)
      : undefined;
  const notAfter =
    typeof key.not_after === "string"
      ? parseIsoTimestamp(key.not_after, `${label}.not_after`)
      : undefined;
  if (notBefore !== undefined && notAfter !== undefined && notAfter <= notBefore) {
    throw new Error(`${label}.not_after must be after not_before`);
  }
  return {
    key_id: requiredString(key, "key_id", label),
    algorithm: "ed25519",
    identity: requiredString(key, "identity", label),
    roles,
    public_key_pem: requiredString(key, "public_key_pem", label),
    ...(typeof key.not_before === "string" ? { not_before: key.not_before } : {}),
    ...(typeof key.not_after === "string" ? { not_after: key.not_after } : {}),
    ...(typeof key.revoked === "boolean" ? { revoked: key.revoked } : {}),
  };
}

export function parseReleaseApprovalTrustStore(value: unknown): ReleaseApprovalTrustStore {
  const trustStore = record(value, "approval trust store");
  assertExactFields(trustStore, ["schema", "keys"], "approval trust store");
  if (trustStore.schema !== "terminus.release-approval-trust.v1") {
    throw new Error("approval trust store.schema must be terminus.release-approval-trust.v1");
  }
  if (!Array.isArray(trustStore.keys) || trustStore.keys.length === 0) {
    throw new Error("approval trust store.keys must contain at least one trusted key");
  }
  const keys = trustStore.keys.map(parseTrustedKey);
  if (new Set(keys.map((key) => key.key_id)).size !== keys.length) {
    throw new Error("approval trust store contains duplicate key_id values");
  }
  return { schema: "terminus.release-approval-trust.v1", keys };
}

export function loadReleaseApprovalTrustStore(path: string): ReleaseApprovalTrustStore {
  if (!path.trim()) throw new Error("TERMINUS_RELEASE_APPROVAL_TRUST_STORE is required");
  try {
    return parseReleaseApprovalTrustStore(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `approval trust store ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function requireExternalTrustStorePath(path: string, repositoryRoot: string): void {
  const resolvedRoot = realpathSync(repositoryRoot);
  const resolvedPath = realpathSync(path);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    throw new Error("approval trust store must be supplied outside the candidate checkout");
  }
}

export function approvalEnvelopeSha256(envelope: ReleaseApprovalEnvelope): string {
  return sha256(
    JSON.stringify({
      schema: envelope.schema,
      algorithm: envelope.algorithm,
      key_id: envelope.key_id,
      signed_payload: envelope.signed_payload,
      signature_base64: envelope.signature_base64,
    }),
  );
}

export function verifyReleaseApproval(
  envelopeValue: unknown,
  trustStore: ReleaseApprovalTrustStore,
  expectation: ReleaseApprovalExpectation,
): VerifiedReleaseApproval {
  const envelope = parseReleaseApprovalEnvelope(envelopeValue);
  const trustedKey = trustStore.keys.find((key) => key.key_id === envelope.key_id);
  if (!trustedKey) throw new Error(`approval key ${envelope.key_id} is not trusted`);
  if (trustedKey.revoked) throw new Error(`approval key ${envelope.key_id} is revoked`);

  const publicKey = createPublicKey(trustedKey.public_key_pem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`approval key ${envelope.key_id} is not an Ed25519 public key`);
  }
  const signature = decodeBase64(envelope.signature_base64, "approval envelope.signature_base64");
  if (signature.length !== 64) throw new Error("approval Ed25519 signature must be 64 bytes");
  if (!verifySignature(null, Buffer.from(envelope.signed_payload, "utf8"), publicKey, signature)) {
    throw new Error("approval signature verification failed");
  }

  let payloadValue: unknown;
  try {
    payloadValue = JSON.parse(envelope.signed_payload);
  } catch (error) {
    throw new Error(
      `approval signed_payload is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const payload = parseReleaseApprovalPayload(payloadValue);
  if (envelope.signed_payload !== canonicalReleaseApprovalPayload(payload)) {
    throw new Error("approval signed_payload must use canonical field order and encoding");
  }
  const nowMs = expectation.nowMs ?? Date.now();
  const issuedAtMs = parseIsoTimestamp(payload.issued_at, "approval payload.issued_at");
  const expiresAtMs = parseIsoTimestamp(payload.expires_at, "approval payload.expires_at");
  if (expiresAtMs <= issuedAtMs) throw new Error("approval expires_at must be after issued_at");
  if (issuedAtMs > nowMs + CLOCK_SKEW_MS) throw new Error("approval issued_at is in the future");
  if (expiresAtMs <= nowMs) throw new Error("approval has expired");

  if (payload.role !== expectation.role) {
    throw new Error(`approval role ${payload.role} does not match required role ${expectation.role}`);
  }
  if (payload.identity !== trustedKey.identity) {
    throw new Error(`approval identity ${payload.identity} is not bound to key ${envelope.key_id}`);
  }
  if (!trustedKey.roles.includes(payload.role)) {
    throw new Error(`approval key ${envelope.key_id} is not trusted for role ${payload.role}`);
  }
  if (payload.candidate_commit !== expectation.candidateCommit) {
    throw new Error("approval candidate_commit does not match the release candidate");
  }
  if (payload.release_version !== expectation.releaseVersion) {
    throw new Error("approval release_version does not match the release candidate");
  }
  if (payload.evidence_manifest_sha256 !== expectation.evidenceManifestSha256) {
    throw new Error("approval evidence_manifest_sha256 does not match the release evidence manifest");
  }

  if (trustedKey.not_before !== undefined) {
    const notBeforeMs = parseIsoTimestamp(trustedKey.not_before, `approval key ${envelope.key_id}.not_before`);
    if (issuedAtMs < notBeforeMs || nowMs < notBeforeMs) {
      throw new Error(`approval key ${envelope.key_id} is not yet valid`);
    }
  }
  if (trustedKey.not_after !== undefined) {
    const notAfterMs = parseIsoTimestamp(trustedKey.not_after, `approval key ${envelope.key_id}.not_after`);
    if (issuedAtMs >= notAfterMs || nowMs >= notAfterMs) {
      throw new Error(`approval key ${envelope.key_id} is no longer valid`);
    }
  }

  return {
    payload,
    envelope,
    envelopeSha256: approvalEnvelopeSha256(envelope),
  };
}
