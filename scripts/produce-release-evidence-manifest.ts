#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { sha256 } from "./release-approval.ts";
import { requireCleanReleaseSource } from "./verify-release-source.ts";

export const MANIFEST_BOUND_EVIDENCE = [
  { key: "fuzz-smoke", file: "fuzz-smoke.json" },
  { key: "fault-injection", file: "fault-injection.json" },
  { key: "property-tests", file: "property-tests.json" },
  { key: "upgrade-rollback", file: "upgrade-rollback.json" },
  { key: "soak-leak", file: "soak-leak.json" },
  { key: "preview-canary", file: "preview-canary.json" },
  { key: "ops-metrics", file: "ops-metrics.json" },
  { key: "eval-release", file: "eval-release.json" },
  { key: "sbom-verify", file: "sbom-verify.json" },
  { key: "schema-freeze", file: "schema-freeze.json" },
  { key: "platform-matrix", file: "platform-support.json" },
  { key: "system-card", file: "system-card.json" },
] as const;

export type EvidenceManifestEntry = {
  key: string;
  path: string;
  sha256: string;
};

export type ReleaseEvidenceManifest = {
  schema: "terminus.release-evidence-manifest.v1";
  candidate_commit: string;
  release_version: string;
  generated_at: string;
  artifacts: EvidenceManifestEntry[];
};

export type ReleaseEvidenceIdentity = {
  candidateCommit: string;
  releaseVersion: string;
};

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
export const RELEASE_EVIDENCE_MANIFEST_PATH = join(OUT_DIR, "release-evidence-manifest.json");
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const STABLE_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function requireStableReleaseVersion(value: string, source = "release version"): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${source} is required`);
  if (!STABLE_SEMVER_PATTERN.test(normalized)) {
    throw new Error(`${source} must be stable SemVer: ${normalized}`);
  }
  return normalized;
}

function repositoryRelativePath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

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

function nonEmptyStrings(value: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.flatMap((field) => {
    const candidate = value[field];
    return typeof candidate === "string" && candidate.trim() ? [candidate.trim()] : [];
  });
}

/**
 * Evidence may use the canonical candidate fields or one of the named legacy
 * aliases. Every populated alias must agree, so an extra stale field cannot be
 * hidden behind a correct one.
 */
export function validateDirectEvidenceIdentity(
  value: Record<string, unknown>,
  identity: ReleaseEvidenceIdentity,
  label: string,
): string[] {
  const subject =
    typeof value.subject === "object" && value.subject !== null && !Array.isArray(value.subject)
      ? (value.subject as Record<string, unknown>)
      : {};
  const commits = [
    ...nonEmptyStrings(value, ["candidate_commit", "commit", "source_commit", "terminus_commit"]),
    ...nonEmptyStrings(subject, ["candidate_commit", "commit"]),
  ];
  const versions = [
    ...nonEmptyStrings(value, ["release_version", "terminus_version"]),
    ...nonEmptyStrings(subject, ["release_version"]),
  ];
  const errors: string[] = [];
  if (commits.length === 0) errors.push(`${label}: candidate commit binding is missing`);
  else if (commits.some((commit) => commit !== identity.candidateCommit)) {
    errors.push(`${label}: candidate commit binding does not match ${identity.candidateCommit}`);
  }
  if (versions.length === 0) errors.push(`${label}: release version binding is missing`);
  else if (versions.some((version) => version !== identity.releaseVersion)) {
    errors.push(`${label}: release version binding does not match ${identity.releaseVersion}`);
  }
  return errors;
}

function canonicalTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return value;
}

export function parseReleaseEvidenceManifest(value: unknown): ReleaseEvidenceManifest {
  const manifest = record(value, "release evidence manifest");
  assertExactFields(
    manifest,
    ["schema", "candidate_commit", "release_version", "generated_at", "artifacts"],
    "release evidence manifest",
  );
  if (manifest.schema !== "terminus.release-evidence-manifest.v1") {
    throw new Error(
      "release evidence manifest.schema must be terminus.release-evidence-manifest.v1",
    );
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("release evidence manifest.artifacts must be an array");
  }
  const artifacts = manifest.artifacts.map((entryValue, index): EvidenceManifestEntry => {
    const label = `release evidence manifest.artifacts[${index}]`;
    const entry = record(entryValue, label);
    assertExactFields(entry, ["key", "path", "sha256"], label);
    const digest = requiredString(entry, "sha256", label);
    if (!SHA256_PATTERN.test(digest)) throw new Error(`${label}.sha256 must be a sha256 digest`);
    return {
      key: requiredString(entry, "key", label),
      path: requiredString(entry, "path", label),
      sha256: digest,
    };
  });
  if (new Set(artifacts.map((entry) => entry.key)).size !== artifacts.length) {
    throw new Error("release evidence manifest contains duplicate artifact keys");
  }
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) {
    throw new Error("release evidence manifest contains duplicate artifact paths");
  }
  const candidateCommit = requiredString(
    manifest,
    "candidate_commit",
    "release evidence manifest",
  );
  if (!GIT_OBJECT_PATTERN.test(candidateCommit)) {
    throw new Error("release evidence manifest.candidate_commit must be a full Git object id");
  }
  const releaseVersion = requireStableReleaseVersion(
    requiredString(manifest, "release_version", "release evidence manifest"),
    "release evidence manifest.release_version",
  );
  return {
    schema: "terminus.release-evidence-manifest.v1",
    candidate_commit: candidateCommit,
    release_version: releaseVersion,
    generated_at: canonicalTimestamp(
      requiredString(manifest, "generated_at", "release evidence manifest"),
      "release evidence manifest.generated_at",
    ),
    artifacts,
  };
}

export function canonicalReleaseEvidenceManifest(manifest: ReleaseEvidenceManifest): string {
  return JSON.stringify({
    schema: manifest.schema,
    candidate_commit: manifest.candidate_commit,
    release_version: manifest.release_version,
    generated_at: manifest.generated_at,
    artifacts: [...manifest.artifacts]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => ({ key: entry.key, path: entry.path, sha256: entry.sha256 })),
  });
}

export function releaseEvidenceManifestSha256(manifest: ReleaseEvidenceManifest): string {
  return sha256(canonicalReleaseEvidenceManifest(manifest));
}

export function buildReleaseEvidenceManifest(
  root: string,
  outDir: string,
  identity: ReleaseEvidenceIdentity,
  generatedAt = new Date().toISOString(),
): ReleaseEvidenceManifest {
  const artifacts = MANIFEST_BOUND_EVIDENCE.map(({ key, file }) => {
    const path = join(outDir, file);
    if (!existsSync(path)) throw new Error(`release evidence is missing: ${path}`);
    const relativePath = repositoryRelativePath(root, path);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`release evidence path is outside the repository: ${path}`);
    }
    return { key, path: relativePath, sha256: sha256(readFileSync(path)) };
  });
  return parseReleaseEvidenceManifest({
    schema: "terminus.release-evidence-manifest.v1",
    candidate_commit: identity.candidateCommit,
    release_version: identity.releaseVersion,
    generated_at: generatedAt,
    artifacts,
  });
}

export function validateReleaseEvidenceManifest(
  manifest: ReleaseEvidenceManifest,
  root: string,
  outDir: string,
  identity: ReleaseEvidenceIdentity,
): string[] {
  const errors: string[] = [];
  if (manifest.candidate_commit !== identity.candidateCommit) {
    errors.push("release evidence manifest candidate_commit does not match the release candidate");
  }
  if (manifest.release_version !== identity.releaseVersion) {
    errors.push("release evidence manifest release_version does not match the release candidate");
  }
  const entries = new Map(manifest.artifacts.map((entry) => [entry.key, entry]));
  for (const expected of MANIFEST_BOUND_EVIDENCE) {
    const entry = entries.get(expected.key);
    if (!entry) {
      errors.push(`release evidence manifest is missing ${expected.key}`);
      continue;
    }
    const expectedPath = repositoryRelativePath(root, join(outDir, expected.file));
    if (entry.path !== expectedPath) {
      errors.push(
        `release evidence manifest ${expected.key} path ${entry.path} does not match ${expectedPath}`,
      );
      continue;
    }
    const artifactPath = join(root, entry.path);
    if (!existsSync(artifactPath)) {
      errors.push(`release evidence manifest ${expected.key} artifact is missing`);
      continue;
    }
    const actualDigest = sha256(readFileSync(artifactPath));
    if (actualDigest !== entry.sha256) {
      errors.push(`release evidence manifest ${expected.key} digest does not match the artifact`);
    }
  }
  return errors;
}

function envOrEmpty(name: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function currentCommit(): string {
  const fromEnv = envOrEmpty("TERMINUS_RELEASE_COMMIT") || envOrEmpty("GITHUB_SHA");
  if (fromEnv) return fromEnv;
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
}

function releaseVersion(): string {
  const fromEnv = envOrEmpty("TERMINUS_RELEASE_VERSION");
  return requireStableReleaseVersion(fromEnv, "TERMINUS_RELEASE_VERSION");
}

function main(): void {
  requireCleanReleaseSource(ROOT);
  const candidateCommit = currentCommit();
  if (!candidateCommit) throw new Error("release commit is unknown");
  const manifest = buildReleaseEvidenceManifest(ROOT, OUT_DIR, {
    candidateCommit,
    releaseVersion: releaseVersion(),
  });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(RELEASE_EVIDENCE_MANIFEST_PATH, `${canonicalReleaseEvidenceManifest(manifest)}\n`, "utf8");
  console.log(
    `[release-evidence-manifest] wrote ${RELEASE_EVIDENCE_MANIFEST_PATH} (${releaseEvidenceManifestSha256(manifest)})`,
  );
}

if (import.meta.main) main();
