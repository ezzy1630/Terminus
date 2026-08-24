import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  RELEASE_APPROVAL_ROLES,
  approvalEnvelopeSha256,
  canonicalReleaseApprovalPayload,
  requireExternalTrustStorePath,
  verifyReleaseApproval,
  type ReleaseApprovalEnvelope,
  type ReleaseApprovalPayload,
  type ReleaseApprovalRole,
  type ReleaseApprovalTrustStore,
} from "../../scripts/release-approval.ts";
import {
  MANIFEST_BOUND_EVIDENCE,
  buildReleaseEvidenceManifest,
  parseReleaseEvidenceManifest,
  requireStableReleaseVersion,
  releaseEvidenceManifestSha256,
  validateReleaseEvidenceManifest,
  type ReleaseEvidenceManifest,
} from "../../scripts/produce-release-evidence-manifest.ts";
import { validateDecision } from "../../scripts/m12-exit-gate.ts";
import {
  renderReleaseDecision,
  type ReleaseDecisionSignature,
} from "../../scripts/produce-release-decision.ts";

const HEAD = "a".repeat(40);
const VERSION = "0.1.0";
const MANIFEST_DIGEST = `sha256:${"b".repeat(64)}`;
const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const KEY_ID = "release-test-key";
const IDENTITY = "github:test-release-owner";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustStore: ReleaseApprovalTrustStore = {
  schema: "terminus.release-approval-trust.v1",
  keys: [
    {
      key_id: KEY_ID,
      algorithm: "ed25519",
      identity: IDENTITY,
      roles: [...RELEASE_APPROVAL_ROLES],
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ],
};

function payload(role: ReleaseApprovalRole): ReleaseApprovalPayload {
  return {
    schema: "terminus.release-approval.v1",
    role,
    identity: IDENTITY,
    candidate_commit: HEAD,
    release_version: VERSION,
    evidence_manifest_sha256: MANIFEST_DIGEST,
    issued_at: "2026-08-23T11:00:00.000Z",
    expires_at: "2026-08-24T11:00:00.000Z",
  };
}

function envelope(role: ReleaseApprovalRole): ReleaseApprovalEnvelope {
  const signedPayload = canonicalReleaseApprovalPayload(payload(role));
  return {
    schema: "terminus.release-approval-envelope.v1",
    algorithm: "ed25519",
    key_id: KEY_ID,
    signed_payload: signedPayload,
    signature_base64: sign(null, Buffer.from(signedPayload), privateKey).toString("base64"),
  };
}

describe("release owner approval verification", () => {
  test("verifies an Ed25519 approval bound to role, identity, candidate, and evidence", () => {
    const verified = verifyReleaseApproval(envelope("release_owner"), trustStore, {
      role: "release_owner",
      candidateCommit: HEAD,
      releaseVersion: VERSION,
      evidenceManifestSha256: MANIFEST_DIGEST,
      nowMs: NOW,
    });

    expect(verified.payload.identity).toBe(IDENTITY);
    expect(verified.envelopeSha256).toBe(approvalEnvelopeSha256(verified.envelope));
  });

  test("rejects a raw payload change even when its fields remain semantically equal", () => {
    const changed = envelope("security_owner");
    changed.signed_payload += " ";

    expect(() =>
      verifyReleaseApproval(changed, trustStore, {
        role: "security_owner",
        candidateCommit: HEAD,
        releaseVersion: VERSION,
        evidenceManifestSha256: MANIFEST_DIGEST,
        nowMs: NOW,
      }),
    ).toThrow("signature verification failed");
  });

  test("rejects a valid signature over non-canonical payload encoding", () => {
    const approval = payload("release_owner");
    const signedPayload = JSON.stringify({
      role: approval.role,
      schema: approval.schema,
      identity: approval.identity,
      candidate_commit: approval.candidate_commit,
      release_version: approval.release_version,
      evidence_manifest_sha256: approval.evidence_manifest_sha256,
      issued_at: approval.issued_at,
      expires_at: approval.expires_at,
    });
    const signedEnvelope: ReleaseApprovalEnvelope = {
      schema: "terminus.release-approval-envelope.v1",
      algorithm: "ed25519",
      key_id: KEY_ID,
      signed_payload: signedPayload,
      signature_base64: sign(null, Buffer.from(signedPayload), privateKey).toString("base64"),
    };

    expect(() =>
      verifyReleaseApproval(signedEnvelope, trustStore, {
        role: "release_owner",
        candidateCommit: HEAD,
        releaseVersion: VERSION,
        evidenceManifestSha256: MANIFEST_DIGEST,
        nowMs: NOW,
      }),
    ).toThrow("canonical field order");
  });

  test("rejects expired and wrong-role approvals", () => {
    expect(() =>
      verifyReleaseApproval(envelope("protocol_owner"), trustStore, {
        role: "evaluation_owner",
        candidateCommit: HEAD,
        releaseVersion: VERSION,
        evidenceManifestSha256: MANIFEST_DIGEST,
        nowMs: NOW,
      }),
    ).toThrow("does not match required role");

    expect(() =>
      verifyReleaseApproval(envelope("protocol_owner"), trustStore, {
        role: "protocol_owner",
        candidateCommit: HEAD,
        releaseVersion: VERSION,
        evidenceManifestSha256: MANIFEST_DIGEST,
        nowMs: Date.parse("2026-08-25T00:00:00.000Z"),
      }),
    ).toThrow("expired");
  });

  test("rejects approval reuse for a different evidence manifest", () => {
    expect(() =>
      verifyReleaseApproval(envelope("release_owner"), trustStore, {
        role: "release_owner",
        candidateCommit: HEAD,
        releaseVersion: VERSION,
        evidenceManifestSha256: `sha256:${"c".repeat(64)}`,
        nowMs: NOW,
      }),
    ).toThrow("does not match the release evidence manifest");
  });

  test("rejects a trust registry controlled by the candidate checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-release-root-"));
    const outside = mkdtempSync(join(tmpdir(), "terminus-release-trust-"));
    try {
      const insideTrustStore = join(root, "trust.json");
      const outsideTrustStore = join(outside, "trust.json");
      writeFileSync(insideTrustStore, "{}\n", "utf8");
      writeFileSync(outsideTrustStore, "{}\n", "utf8");

      expect(() => requireExternalTrustStorePath(insideTrustStore, root)).toThrow(
        "outside the candidate checkout",
      );
      expect(() => requireExternalTrustStorePath(outsideTrustStore, root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("release evidence manifest", () => {
  test("requires an exact stable release version", () => {
    expect(requireStableReleaseVersion(" 1.2.3 ")).toBe("1.2.3");
    expect(() => requireStableReleaseVersion("")).toThrow("release version is required");
    expect(() => requireStableReleaseVersion("1.2.3-rc.1")).toThrow("stable SemVer");
    expect(() =>
      parseReleaseEvidenceManifest({
        schema: "terminus.release-evidence-manifest.v1",
        candidate_commit: HEAD,
        release_version: "1.2.3-rc.1",
        generated_at: "2026-08-23T12:00:00.000Z",
        artifacts: [],
      }),
    ).toThrow("release evidence manifest.release_version must be stable SemVer");
  });

  test("binds every required artifact digest to one commit and version", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-release-evidence-"));
    try {
      const outDir = join(root, "artifacts", "release-gate");
      mkdirSync(outDir, { recursive: true });
      for (const entry of MANIFEST_BOUND_EVIDENCE) {
        writeFileSync(join(outDir, entry.file), `${entry.key}\n`, "utf8");
      }
      const manifest = buildReleaseEvidenceManifest(
        root,
        outDir,
        { candidateCommit: HEAD, releaseVersion: VERSION },
        "2026-08-23T12:00:00.000Z",
      );
      expect(
        validateReleaseEvidenceManifest(manifest, root, outDir, {
          candidateCommit: HEAD,
          releaseVersion: VERSION,
        }),
      ).toEqual([]);

      writeFileSync(join(outDir, MANIFEST_BOUND_EVIDENCE[0].file), "tampered\n", "utf8");
      expect(
        validateReleaseEvidenceManifest(manifest, root, outDir, {
          candidateCommit: HEAD,
          releaseVersion: VERSION,
        }),
      ).toContain("release evidence manifest fuzz-smoke digest does not match the artifact");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("release decision approvals", () => {
  test("re-verifies every embedded approval against the trusted key registry", () => {
    const manifest: ReleaseEvidenceManifest = {
      schema: "terminus.release-evidence-manifest.v1",
      candidate_commit: HEAD,
      release_version: VERSION,
      generated_at: "2026-08-23T10:00:00.000Z",
      artifacts: [],
    };
    const manifestDigest = releaseEvidenceManifestSha256(manifest);
    const signatures = Object.fromEntries(
      RELEASE_APPROVAL_ROLES.map((role) => {
        const signedPayload = canonicalReleaseApprovalPayload({
          ...payload(role),
          evidence_manifest_sha256: manifestDigest,
        });
        const signedEnvelope: ReleaseApprovalEnvelope = {
          schema: "terminus.release-approval-envelope.v1",
          algorithm: "ed25519",
          key_id: KEY_ID,
          signed_payload: signedPayload,
          signature_base64: sign(null, Buffer.from(signedPayload), privateKey).toString("base64"),
        };
        return [
          role,
          {
            verified: true,
            key_id: KEY_ID,
            identity: IDENTITY,
            issued_at: "2026-08-23T11:00:00.000Z",
            expires_at: "2026-08-24T11:00:00.000Z",
            envelope_sha256: approvalEnvelopeSha256(signedEnvelope),
            envelope: signedEnvelope,
          },
        ];
      }),
    ) as Record<ReleaseApprovalRole, ReleaseDecisionSignature>;
    const matrix = {
      commit: HEAD,
      supported_platforms: [],
      unverified_or_degraded_platforms: [],
      platforms: {},
    };
    const serialized = renderReleaseDecision({
      version: VERSION,
      commit: HEAD,
      generatedAt: "2026-08-23T12:00:00.000Z",
      databaseSchemaVersion: 5,
      supportedPlatforms: [],
      securityProfile: "secure-local-default",
      evaluationReport: "artifacts/release-gate/eval-release.json",
      evidenceManifestSha256: manifestDigest,
      knownLimitations: [],
      acceptedRisks: [],
      signatures,
    });
    const decision = Bun.YAML.parse(serialized) as Record<string, unknown>;

    expect(
      validateDecision(decision, HEAD, matrix, {
        expectedVersion: VERSION,
        approvalTrustStore: trustStore,
        approvalVerificationTimeMs: NOW,
        evidenceManifest: manifest,
      }),
    ).toEqual([]);
  });
});
