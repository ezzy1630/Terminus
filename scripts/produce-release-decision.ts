#!/usr/bin/env bun
/**
 * Produce SPEC §50.10 machine-readable release decision YAML.
 *
 * Support, limitations, and approvals are release inputs. This script does
 * not turn a build matrix or a declaration into evidence.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Finding = {
  id?: string;
  severity?: string;
  status?: string;
  summary?: string;
  acceptance_rationale?: string;
};

type JsonRecord = Record<string, unknown>;

type FindingsRegister = { findings?: Finding[] };

type MaturityComponent = { id?: string; tier?: string; basis?: string };

type PlatformEntry = { status?: string; basis?: string; evidence?: string | null };

type PlatformMatrix = {
  commit?: string;
  supported_platforms?: string[];
  unverified_or_degraded_platforms?: string[];
  platforms?: Record<string, PlatformEntry>;
};

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "release-decision.yaml");
const FINDINGS_PATH = join(ROOT, "docs", "security", "findings-register.yaml");
const MATURITY_PATH = join(ROOT, "maturity.yaml");
const PLATFORM_MATRIX_PATH = join(OUT_DIR, "platform-support.json");
const MIGRATIONS_DIR = join(ROOT, "migrations", "sqlite");

function envOrEmpty(name: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function currentCommit(): string {
  const fromEnv = envOrEmpty("TERMINUS_RELEASE_COMMIT") || envOrEmpty("GITHUB_SHA");
  if (fromEnv) return fromEnv;
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
  return result.stdout.toString().trim() || "unknown";
}

function countMigrations(): number {
  if (!existsSync(MIGRATIONS_DIR)) return 0;
  return readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).length;
}

function loadFindings(): { knownLimitations: string[]; acceptedRisks: string[] } {
  if (!existsSync(FINDINGS_PATH)) {
    return {
      knownLimitations: ["SECURITY-FINDINGS absent: the security findings register could not be read"],
      acceptedRisks: [],
    };
  }
  let parsed: FindingsRegister;
  try {
    parsed = Bun.YAML.parse(readFileSync(FINDINGS_PATH, "utf8")) as FindingsRegister;
  } catch (error) {
    throw new Error(`security findings register is invalid: ${String(error)}`);
  }
  const knownLimitations: string[] = [];
  const acceptedRisks: string[] = [];
  for (const finding of parsed.findings ?? []) {
    const id = (finding.id ?? "unknown").trim();
    const summary = (finding.summary ?? "").trim();
    const line = `${id}: ${summary}`.trim();
    if (finding.status === "accepted") {
      acceptedRisks.push(line);
      if (finding.acceptance_rationale?.trim()) {
        knownLimitations.push(`${id}: ${finding.acceptance_rationale.trim()}`);
      }
    } else if (finding.status === "open") {
      knownLimitations.push(line);
    }
  }
  return { knownLimitations, acceptedRisks };
}

function loadStubLimitations(): string[] {
  if (!existsSync(MATURITY_PATH)) return ["MATURITY absent: component maturity could not be read"];
  let parsed: { components?: MaturityComponent[] };
  try {
    parsed = Bun.YAML.parse(readFileSync(MATURITY_PATH, "utf8")) as { components?: MaturityComponent[] };
  } catch (error) {
    throw new Error(`maturity registry is invalid: ${String(error)}`);
  }
  return (parsed.components ?? [])
    .filter((component) => component.tier === "stub")
    .map((component) => `MATURITY-STUB ${component.id ?? "unknown"}: ${component.basis?.trim() || "declared stub"}`);
}

function loadPlatformSupport(head: string): { supported: string[]; limitations: string[] } {
  if (!existsSync(PLATFORM_MATRIX_PATH)) {
    throw new Error("platform-support.json is missing; release support claims require the evidence matrix");
  }
  let matrix: PlatformMatrix;
  try {
    matrix = JSON.parse(readFileSync(PLATFORM_MATRIX_PATH, "utf8")) as PlatformMatrix;
  } catch (error) {
    throw new Error(`platform-support.json is invalid: ${String(error)}`);
  }
  if (matrix.commit !== head) throw new Error(`platform matrix commit ${matrix.commit ?? "missing"} does not match HEAD ${head}`);
  const platforms = matrix.platforms ?? {};
  const supported = matrix.supported_platforms ?? [];
  const degraded = matrix.unverified_or_degraded_platforms ?? [];
  const supportedSet = new Set(supported);
  const degradedSet = new Set(degraded);
  const errors: string[] = [];
  if (supportedSet.size !== supported.length) errors.push("supported_platforms contains duplicates");
  if (degradedSet.size !== degraded.length) errors.push("unverified_or_degraded_platforms contains duplicates");
  if (supportedSet.size + degradedSet.size !== supported.length + degraded.length) errors.push("platform lists overlap");
  for (const [name, entry] of Object.entries(platforms)) {
    if (entry.status === "supported" && !supportedSet.has(name)) errors.push(`${name} is supported but absent from supported_platforms`);
    if (entry.status !== "supported" && !degradedSet.has(name)) errors.push(`${name} is not supported but absent from unverified_or_degraded_platforms`);
  }
  for (const name of supportedSet) {
    if (platforms[name]?.status !== "supported") errors.push(`${name} has no supported evidence`);
    if (!platforms[name]?.evidence) errors.push(`${name} has no evidence reference`);
  }
  for (const name of degradedSet) {
    if (!platforms[name]) errors.push(`${name} is listed as degraded without platform evidence`);
  }
  if (errors.length > 0) throw new Error(`platform matrix is contradictory: ${errors.join("; ")}`);
  const limitations = degraded.map((name) => {
    const entry = platforms[name];
    return `PLATFORM ${name} (${entry?.status ?? "unknown"}): ${entry?.basis ?? "no support evidence"}`;
  });
  return { supported, limitations };
}

function validateEvaluationReport(): string[] {
  const reportPath = join(ROOT, process.env.TERMINUS_EVALUATION_REPORT ?? "artifacts/release-gate/eval-release.json");
  if (!existsSync(reportPath)) return ["EVALUATION absent: release evaluation evidence was not produced"];
  let report: JsonRecord;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as JsonRecord;
  } catch (error) {
    throw new Error(`evaluation report is invalid: ${String(error)}`);
  }
  const status = typeof report.status === "string" ? report.status.toLowerCase() : "";
  const fixtureAllowed = process.env.TERMINUS_RELEASE_ALLOW_FIXTURE_EVAL === "1";
  if ((status.includes("fixture") && !fixtureAllowed) || report.pass === false || status === "failed") {
    throw new Error(`evaluation report is not release evidence: status=${status || "missing"}`);
  }
  const limitations = Array.isArray(report.limitations)
    ? report.limitations.filter((value): value is string => typeof value === "string")
    : [];
  if (status.includes("fixture")) {
    limitations.push("deterministic fixture eval evidence is CI-scoped; live release eval is required before stable promotion");
  }
  return limitations;
}

function requireOwnerApprovals(): Record<string, string> {
  const names = {
    release_owner: "TERMINUS_RELEASE_OWNER_APPROVAL",
    security_owner: "TERMINUS_SECURITY_OWNER_APPROVAL",
    protocol_owner: "TERMINUS_PROTOCOL_OWNER_APPROVAL",
    evaluation_owner: "TERMINUS_EVALUATION_OWNER_APPROVAL",
  } as const;
  const signatures = Object.fromEntries(
    Object.entries(names).map(([owner, envName]) => [owner, envOrEmpty(envName)]),
  );
  const missing = Object.entries(signatures).filter(([, value]) => !value).map(([owner]) => owner);
  if (missing.length > 0) throw new Error(`release decision is unsigned: missing ${missing.join(", ")}`);
  return signatures;
}

function validateSignedLinuxEvidence(head: string): void {
  if (process.env.TERMINUS_RELEASE_ENFORCE_SIGNED_ARTIFACTS !== "1") return;
  const evidencePath = envOrEmpty("TERMINUS_LINUX_EVIDENCE");
  const signaturePath = envOrEmpty("TERMINUS_LINUX_EVIDENCE_SIGNATURE");
  const certificatePath = envOrEmpty("TERMINUS_LINUX_EVIDENCE_CERTIFICATE");
  if (!evidencePath || !signaturePath || !certificatePath) throw new Error("signed Linux evidence paths are required");
  if (!existsSync(evidencePath) || !existsSync(signaturePath) || !existsSync(certificatePath)) {
    throw new Error("signed Linux evidence is incomplete");
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { terminus_commit?: string };
  if (evidence.terminus_commit !== head) throw new Error("Linux evidence commit does not match HEAD");
}

export function buildReleaseDecision(): string {
  const head = currentCommit();
  if (head === "unknown") throw new Error("release commit is unknown");
  const platformSupport = loadPlatformSupport(head);
  const findings = loadFindings();
  const knownLimitations = [
    ...findings.knownLimitations,
    ...loadStubLimitations(),
    ...platformSupport.limitations,
    ...validateEvaluationReport(),
  ];
  validateSignedLinuxEvidence(head);
  const signatures = requireOwnerApprovals();
  const version = envOrEmpty("TERMINUS_RELEASE_VERSION") || "0.1.0";
  const securityProfile = envOrEmpty("TERMINUS_SECURITY_PROFILE") || "secure-local-default";
  return `release:
  version: ${JSON.stringify(version)}
  commit: ${JSON.stringify(head)}
  generated_at: ${JSON.stringify(new Date().toISOString())}
  protocol_versions:
    terminus_kernel_v1: "1"
  database_schema_version: ${countMigrations()}
  supported_platforms:
${yamlList(platformSupport.supported, "    ")}
  security_profile: ${JSON.stringify(securityProfile)}
  evaluation_report: ${JSON.stringify(process.env.TERMINUS_EVALUATION_REPORT ?? "artifacts/release-gate/eval-release.json")}
  divergence_report: ${JSON.stringify(process.env.TERMINUS_DIVERGENCE_REPORT ?? "upstream/divergence-budget.yaml")}
  known_limitations:
${yamlList([...new Set(knownLimitations)], "    ")}
  accepted_risks:
${yamlList([...new Set(findings.acceptedRisks)], "    ")}
  signatures:
    release_owner: ${JSON.stringify(signatures.release_owner)}
    security_owner: ${JSON.stringify(signatures.security_owner)}
    protocol_owner: ${JSON.stringify(signatures.protocol_owner)}
    evaluation_owner: ${JSON.stringify(signatures.evaluation_owner)}
`;
}

function yamlList(items: string[], indent: string): string {
  if (items.length === 0) return `${indent}[]`;
  return items.map((item) => `${indent}- ${JSON.stringify(item)}`).join("\n");
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const document = buildReleaseDecision();
  writeFileSync(OUT_PATH, document, "utf8");
  console.log(`[release-decision] wrote ${OUT_PATH}`);
}

if (import.meta.main) main();
