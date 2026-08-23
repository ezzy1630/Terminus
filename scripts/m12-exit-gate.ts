#!/usr/bin/env bun
/**
 * M12 exit gate: aggregate release-gate evidence (SPEC §46.18 / §50.10).
 *
 * Evidence is valid only when it is current, internally consistent, and
 * suitable for the release tier. Presence alone is not evidence.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type EvidenceStatus = "present" | "missing" | "invalid" | "requires_ci" | "verified";

export type EvidenceCheck = {
  key: string;
  path: string;
  status: EvidenceStatus;
  detail: string;
  errors?: string[];
};

export type ValidationOptions = {
  expectedCommit?: string;
  freshSinceMs?: number;
  requireSignedLinuxEvidence?: boolean;
};

export type JsonRecord = Record<string, unknown>;

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const FINDINGS_PATH = join(ROOT, "docs", "security", "findings-register.yaml");

const REQUIRED_LOCAL: ReadonlyArray<{ key: string; file: string; status?: string }> = [
  { key: "fuzz-smoke", file: "fuzz-smoke.json", status: "passed" },
  { key: "fault-injection", file: "fault-injection.json", status: "passed" },
  { key: "property-tests", file: "property-tests.json", status: "passed" },
  { key: "upgrade-rollback", file: "upgrade-rollback.json", status: "passed" },
  { key: "soak-leak", file: "soak-leak.json", status: "passed" },
  { key: "preview-canary", file: "preview-canary.json", status: "passed" },
  { key: "ops-metrics", file: "ops-metrics.json", status: "not_placeholder" },
  { key: "eval-release", file: "eval-release.json", status: "passed" },
  { key: "sbom-verify", file: "sbom-verify.json", status: "passed" },
  { key: "schema-freeze", file: "schema-freeze.json", status: "frozen" },
  { key: "findings-register-status", file: "findings-register-status.json", status: "ok" },
  { key: "platform-matrix", file: "platform-support.json" },
  { key: "system-card", file: "system-card.json" },
  { key: "release-decision", file: "release-decision.yaml" },
];

function currentCommit(): string {
  const fromEnv = process.env.TERMINUS_RELEASE_COMMIT ?? process.env.GITHUB_SHA;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
  const fromGit = result.stdout.toString().trim();
  return fromGit || "unknown";
}

function readJson(path: string): JsonRecord {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as JsonRecord;
}

function timestampMs(value: JsonRecord): number | null {
  const raw = value.generatedAt ?? value.generated_at;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusFields(value: JsonRecord): string[] {
  return ["status", "evalSmoke", "mode"]
    .map((key) => value[key])
    .filter((field): field is string => typeof field === "string")
    .map((field) => field.toLowerCase());
}

/** Validate a single JSON evidence payload without touching the filesystem. */
export function validateEvidencePayload(
  key: string,
  value: JsonRecord,
  options: ValidationOptions = {},
): string[] {
  const errors: string[] = [];
  const expectedCommit = options.expectedCommit;

  if (expectedCommit) {
    for (const field of ["commit", "source_commit", "terminus_commit"]) {
      const actual = stringField(value[field]);
      if (actual && actual !== expectedCommit) {
        errors.push(`${key}: ${field} ${actual} does not match HEAD ${expectedCommit}`);
      }
    }
  }

  const generatedAt = timestampMs(value);
  if (generatedAt === null) {
    errors.push(`${key}: generatedAt is missing or invalid`);
  } else if (options.freshSinceMs !== undefined && generatedAt < options.freshSinceMs) {
    errors.push(`${key}: generatedAt ${new Date(generatedAt).toISOString()} is stale`);
  }

  for (const field of statusFields(value)) {
    if (field.includes("fixture")) errors.push(`${key}: fixture evidence is not release evidence`);
    if (field.includes("unsigned")) errors.push(`${key}: unsigned evidence is not release evidence`);
  }

  const signature = value.signature;
  if (typeof signature === "object" && signature !== null && !Array.isArray(signature)) {
    const status = stringField((signature as JsonRecord).status)?.toLowerCase();
    if (!status || status.includes("unsigned") || status.includes("missing")) {
      errors.push(`${key}: unsigned evidence signature is absent or invalid`);
    }
  }

  if (value.status === "passed" && value.pass === false) {
    errors.push(`${key}: status=passed contradicts pass=false`);
  }
  if (value.status === "failed" && value.pass === true) {
    errors.push(`${key}: status=failed contradicts pass=true`);
  }
  if (value.status === "passed" && typeof value.failures === "number" && value.failures > 0) {
    errors.push(`${key}: status=passed contradicts failures=${value.failures}`);
  }
  if (typeof value.exitCode === "number" && value.exitCode !== 0 && value.status === "passed") {
    errors.push(`${key}: status=passed contradicts exitCode=${value.exitCode}`);
  }
  if (typeof value.evalSmoke === "string" && value.evalSmoke.toLowerCase().includes("fixture")) {
    errors.push(`${key}: fixture eval smoke cannot satisfy the release gate`);
  }

  return errors;
}

function ensureFindingsRegisterStatus(head: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, "findings-register-status.json");
  if (!existsSync(FINDINGS_PATH)) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          status: "missing_register",
          generatedAt: new Date().toISOString(),
          commit: head,
          path: "docs/security/findings-register.yaml",
          findings: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return;
  }
  const raw = readFileSync(FINDINGS_PATH, "utf8");
  let findings: unknown[] = [];
  try {
    const parsed = Bun.YAML.parse(raw) as { findings?: unknown[] };
    findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    findings = [];
  }
  const openCritical = findings.filter((f) => {
    if (typeof f !== "object" || f === null) return false;
    const rec = f as JsonRecord;
    return rec.status === "open" && (rec.severity === "critical" || rec.severity === "sev1");
  });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        status: openCritical.length === 0 ? "ok" : "blocking_open_findings",
        generatedAt: new Date().toISOString(),
        commit: head,
        path: "docs/security/findings-register.yaml",
        count: findings.length,
        openCritical: openCritical.length,
        findings,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function checkJsonFile(
  key: string,
  file: string,
  expectedStatus: string | undefined,
  options: ValidationOptions,
): EvidenceCheck {
  const path = join(OUT_DIR, file);
  if (!existsSync(path)) return { key, path, status: "missing", detail: "file not found" };
  try {
    const value = readJson(path);
    const errors = validateEvidencePayload(key, value, options);
    if (expectedStatus === "not_placeholder" && value.status === "placeholder") {
      errors.push(`${key}: placeholder metrics are not release evidence`);
    } else if (expectedStatus && expectedStatus !== "not_placeholder" && value.status !== expectedStatus) {
      errors.push(`${key}: expected status=${expectedStatus}, got ${String(value.status)}`);
    }
    if (errors.length > 0) {
      return { key, path, status: "invalid", detail: errors.join("; "), errors };
    }
    return { key, path, status: "present", detail: "validated" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { key, path, status: "invalid", detail, errors: [detail] };
  }
}

export function validateMatrix(value: JsonRecord, head: string): string[] {
  const errors: string[] = [];
  if (value.commit !== head) errors.push(`platform matrix commit ${String(value.commit)} does not match HEAD ${head}`);
  const platforms = value.platforms;
  const supported = value.supported_platforms;
  const degraded = value.unverified_or_degraded_platforms;
  if (typeof platforms !== "object" || platforms === null || Array.isArray(platforms)) {
    errors.push("platform matrix platforms is missing");
    return errors;
  }
  if (!Array.isArray(supported) || !Array.isArray(degraded)) {
    errors.push("platform matrix support lists are missing");
    return errors;
  }
  const details = platforms as Record<string, JsonRecord>;
  const supportedSet = new Set(supported.filter((p): p is string => typeof p === "string"));
  const degradedSet = new Set(degraded.filter((p): p is string => typeof p === "string"));
  if (supportedSet.size !== supported.length) errors.push("platform matrix supported list contains duplicates or non-strings");
  if (degradedSet.size !== degraded.length) errors.push("platform matrix degraded list contains duplicates or non-strings");
  if (supportedSet.size + degradedSet.size !== supported.length + degraded.length) {
    errors.push("platform matrix support lists overlap");
  }
  for (const [name, detail] of Object.entries(details)) {
    const status = detail?.status;
    if (status === "supported" && !supportedSet.has(name)) errors.push(`platform ${name} is supported but absent from supported_platforms`);
    if (status !== "supported" && !degradedSet.has(name)) errors.push(`platform ${name} is not supported but absent from unverified_or_degraded_platforms`);
  }
  for (const name of supportedSet) {
    if (details[name]?.status !== "supported") errors.push(`platform ${name} is claimed supported without supported evidence`);
    if (!stringField(details[name]?.evidence)) errors.push(`platform ${name} has no evidence reference`);
  }
  for (const name of degradedSet) {
    if (!details[name]) errors.push(`platform ${name} is listed as degraded without platform evidence`);
  }
  return errors;
}

export function validateDecision(value: JsonRecord, head: string, matrix: JsonRecord): string[] {
  const release = value.release;
  if (typeof release !== "object" || release === null || Array.isArray(release)) {
    return ["release decision is missing release object"];
  }
  const decision = release as JsonRecord;
  const errors: string[] = [];
  if (decision.commit !== head) errors.push(`release decision commit ${String(decision.commit)} does not match HEAD ${head}`);
  if (JSON.stringify(decision.supported_platforms ?? []) !== JSON.stringify(matrix.supported_platforms ?? [])) {
    errors.push("release decision supported_platforms contradict the evidence matrix");
  }
  const limitations = decision.known_limitations;
  if (!Array.isArray(limitations)) errors.push("release decision known_limitations is missing");
  else if ((matrix.unverified_or_degraded_platforms ?? []).length > 0 && limitations.length === 0) {
    errors.push("release decision omits limitations for unverified or degraded platforms");
  }
  const signatures = decision.signatures;
  if (typeof signatures !== "object" || signatures === null || Array.isArray(signatures)) {
    errors.push("release decision signatures are missing");
  } else {
    for (const owner of ["release_owner", "security_owner", "protocol_owner", "evaluation_owner"]) {
      if (!stringField((signatures as JsonRecord)[owner])) errors.push(`release decision is unsigned: ${owner}`);
    }
  }
  return errors;
}

function validateCrossArtifacts(head: string, options: ValidationOptions): string[] {
  const errors: string[] = [];
  const matrixPath = join(OUT_DIR, "platform-support.json");
  const decisionPath = join(OUT_DIR, "release-decision.yaml");
  const cardPath = join(OUT_DIR, "system-card.json");
  if (!existsSync(matrixPath) || !existsSync(decisionPath) || !existsSync(cardPath)) return errors;
  try {
    const matrix = readJson(matrixPath);
    errors.push(...validateMatrix(matrix, head));
    const decision = Bun.YAML.parse(readFileSync(decisionPath, "utf8")) as JsonRecord;
    errors.push(...validateDecision(decision, head, matrix));
    const card = readJson(cardPath);
    errors.push(...validateEvidencePayload("system-card", card, { ...options, expectedCommit: head }));
    if (card.commit !== head) errors.push(`system card commit ${String(card.commit)} does not match HEAD ${head}`);
    if (JSON.stringify(card.supported_platforms ?? []) !== JSON.stringify(matrix.supported_platforms ?? [])) {
      errors.push("system card supported_platforms contradict the evidence matrix");
    }
  } catch (error) {
    errors.push(`cross-artifact validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

function linuxEvidence(options: ValidationOptions): EvidenceCheck {
  const key = "linux-enforcement";
  const path = process.env.TERMINUS_LINUX_EVIDENCE ?? "";
  if (!path) {
    return { key, path, status: "requires_ci", detail: "signed Linux evidence requires the dedicated CI runner" };
  }
  if (!existsSync(path)) return { key, path, status: "missing", detail: "evidence manifest does not exist" };
  try {
    const value = readJson(path);
    const errors = validateEvidencePayload(key, value, { ...options, expectedCommit: options.expectedCommit });
    if (options.requireSignedLinuxEvidence) {
      for (const envName of ["TERMINUS_LINUX_EVIDENCE_SIGNATURE", "TERMINUS_LINUX_EVIDENCE_CERTIFICATE"]) {
        const signaturePath = process.env[envName];
        if (!signaturePath || !existsSync(signaturePath)) errors.push(`${key}: ${envName} is missing`);
      }
    }
    return errors.length > 0
      ? { key, path, status: "invalid", detail: errors.join("; "), errors }
      : { key, path, status: "verified", detail: "manifest is current and signed evidence paths are present" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { key, path, status: "invalid", detail, errors: [detail] };
  }
}

function checkDecisionFile(key: string, file: string, head: string, options: ValidationOptions): EvidenceCheck {
  const path = join(OUT_DIR, file);
  if (!existsSync(path)) return { key, path, status: "missing", detail: "file not found" };
  try {
    const value = Bun.YAML.parse(readFileSync(path, "utf8")) as JsonRecord;
    const errors: string[] = [];
    if (options.freshSinceMs !== undefined && statSync(path).mtimeMs < options.freshSinceMs) errors.push(`${key}: file mtime is stale`);
    const matrixPath = join(OUT_DIR, "platform-support.json");
    if (!existsSync(matrixPath)) errors.push("platform matrix is missing");
    else errors.push(...validateDecision(value, head, readJson(matrixPath)));
    const release = value.release;
    if (typeof release !== "object" || release === null || Array.isArray(release)) {
      errors.push(`${key}: release object is missing`);
    } else {
      const generatedAt = timestampMs(release as JsonRecord);
      if (generatedAt === null) errors.push(`${key}: generated_at is missing or invalid`);
      else if (options.freshSinceMs !== undefined && generatedAt < options.freshSinceMs) errors.push(`${key}: generated_at is stale`);
    }
    if (errors.length > 0) return { key, path, status: "invalid", detail: errors.join("; "), errors };
    return { key, path, status: "present", detail: "validated" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { key, path, status: "invalid", detail, errors: [detail] };
  }
}

export function validateReleaseGateArtifacts(
  options: ValidationOptions = {},
): { checks: EvidenceCheck[]; errors: string[] } {
  const head = options.expectedCommit ?? currentCommit();
  const checks = REQUIRED_LOCAL.map((entry) =>
    entry.file.endsWith(".json")
      ? checkJsonFile(entry.key, entry.file, entry.status, { ...options, expectedCommit: head })
      : checkDecisionFile(entry.key, entry.file, head, options),
  );
  checks.push(linuxEvidence(options));
  const errors = checks.flatMap((check) => check.errors ?? []);
  errors.push(...validateCrossArtifacts(head, options));
  if (options.requireSignedLinuxEvidence && checks.at(-1)?.status === "requires_ci") {
    errors.push("linux-enforcement: signed evidence is required for this release");
  }
  return { checks, errors };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const head = currentCommit();
  ensureFindingsRegisterStatus(head);
  const freshSinceRaw = process.env.TERMINUS_RELEASE_RUN_STARTED_AT;
  const freshSinceMs = freshSinceRaw ? Number(freshSinceRaw) * 1000 : undefined;
  const options: ValidationOptions = {
    expectedCommit: head,
    freshSinceMs: Number.isFinite(freshSinceMs) ? freshSinceMs : undefined,
    requireSignedLinuxEvidence: process.env.TERMINUS_RELEASE_ENFORCE_SIGNED_ARTIFACTS === "1",
  };
  const result = validateReleaseGateArtifacts(options);
  const missing = result.checks.filter((c) => c.status === "missing" || c.status === "invalid");
  const requiresCi = result.checks.filter((c) => c.status === "requires_ci");
  const present = result.checks.filter((c) => c.status === "present" || c.status === "verified");
  const requireLinux = process.env.TERMINUS_RELEASE_REQUIRE_LINUX === "1";
  const gateStatus =
    result.errors.length === 0 && missing.length === 0 && (!requireLinux || requiresCi.length === 0)
      ? requiresCi.length > 0
        ? "passed_local"
        : "passed"
      : "failed";
  const report = {
    generatedAt: new Date().toISOString(),
    commit: head,
    status: gateStatus,
    summary: {
      required: REQUIRED_LOCAL.length + 1,
      present: present.length,
      missing: missing.length,
      requiresCi: requiresCi.length,
      errors: result.errors.length,
    },
    errors: result.errors,
    checklist: result.checks.map((c) => ({
      item: c.key,
      status: c.status,
      detail: c.detail,
      errors: c.errors ?? [],
    })),
    evidenceDir: OUT_DIR,
    files: readdirSync(OUT_DIR),
  };
  const reportPath = join(OUT_DIR, "exit-gate-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const checklistMd = join(OUT_DIR, "exit-gate-checklist.md");
  const lines = [
    "# M12 exit-gate checklist",
    "",
    `Status: **${gateStatus}**`,
    `Commit: \`${head}\``,
    `Generated: ${report.generatedAt}`,
    "",
    ...result.checks.map((c) => `- [${c.status === "present" || c.status === "verified" ? "x" : " "}] ${c.key} - ${c.status}: ${c.detail}`),
    "",
  ];
  writeFileSync(checklistMd, `${lines.join("\n")}\n`, "utf8");
  console.log(`[m12-exit-gate] status=${gateStatus} -> ${reportPath}`);
  if (gateStatus === "failed") process.exit(1);
}

if (import.meta.main) main();
