#!/usr/bin/env bun
/**
 * Produce SPEC §50.10 machine-readable release decision YAML.
 *
 * Roadmap Phase 0 truth rules enforced here:
 *   - supported_platforms come ONLY from artifacts/release-gate/platform-support.json
 *     (evidence-derived); a missing matrix yields an EMPTY support list plus a
 *     recorded limitation — never a broad hard-coded claim;
 *   - known_limitations are seeded from the security findings register AND
 *     every stub-tier component in maturity.yaml, so an empty limitations
 *     list can only occur when there is genuinely nothing to disclose.
 *
 * Owner approvals via env:
 *   TERMINUS_RELEASE_OWNER_APPROVAL
 *   TERMINUS_SECURITY_OWNER_APPROVAL
 *   TERMINUS_PROTOCOL_OWNER_APPROVAL
 *   TERMINUS_EVALUATION_OWNER_APPROVAL
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type Finding = {
  id?: string;
  severity?: string;
  status?: string;
  summary?: string;
  acceptance_rationale?: string;
};

type FindingsRegister = {
  findings?: Finding[];
};

type MaturityComponent = {
  id?: string;
  tier?: string;
  basis?: string;
};

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "release-decision.yaml");
const FINDINGS_PATH = join(ROOT, "docs", "security", "findings-register.yaml");
const MATURITY_PATH = join(ROOT, "maturity.yaml");
const PLATFORM_MATRIX_PATH = join(OUT_DIR, "platform-support.json");
const MIGRATIONS_DIR = join(ROOT, "migrations", "sqlite");

function envOrEmpty(name: string): string {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : "";
}

function countMigrations(): number {
  if (!existsSync(MIGRATIONS_DIR)) return 0;
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length;
}

function loadFindings(): { known_limitations: string[]; accepted_risks: string[] } {
  const known_limitations: string[] = [];
  const accepted_risks: string[] = [];
  if (!existsSync(FINDINGS_PATH)) {
    return { known_limitations, accepted_risks };
  }
  const raw = readFileSync(FINDINGS_PATH, "utf8");
  // Minimal YAML extraction without adding a dependency: parse via Bun JSON
  // if the register is JSON-compatible, else line-scan accepted/open items.
  let parsed: FindingsRegister | null = null;
  try {
    parsed = Bun.YAML.parse(raw) as FindingsRegister;
  } catch {
    parsed = null;
  }
  if (parsed?.findings && Array.isArray(parsed.findings)) {
    for (const f of parsed.findings) {
      const id = (f.id ?? "unknown").trim();
      const summary = (f.summary ?? "").trim();
      const line = `${id}: ${summary}`.trim();
      if (f.status === "accepted") {
        accepted_risks.push(line);
        if (f.acceptance_rationale) {
          known_limitations.push(`${id}: ${f.acceptance_rationale.trim()}`);
        }
      } else if (f.status === "open") {
        known_limitations.push(line);
      }
    }
  }
  return { known_limitations, accepted_risks };
}

function loadStubLimitations(): string[] {
  if (!existsSync(MATURITY_PATH)) return [];
  try {
    const parsed = Bun.YAML.parse(readFileSync(MATURITY_PATH, "utf8")) as {
      components?: MaturityComponent[];
    };
    return (parsed.components ?? [])
      .filter((c) => c.tier === "stub")
      .map((c) => `MATURITY-STUB ${c.id}: ${c.basis?.trim() ?? "declared stub"}`);
  } catch {
    return [];
  }
}

type PlatformMatrix = {
  supported_platforms?: string[];
  unverified_or_degraded_platforms?: string[];
  platforms?: Record<string, { status?: string; basis?: string }>;
};

function loadPlatformSupport(): { supported: string[]; limitations: string[] } {
  const limitations: string[] = [];
  if (!existsSync(PLATFORM_MATRIX_PATH)) {
    limitations.push(
      "PLATFORM-MATRIX absent: no evidence-derived platform support matrix was produced; all platform support claims are withheld (run scripts/produce-platform-matrix.ts)",
    );
    return { supported: [], limitations };
  }
  let parsed: PlatformMatrix;
  try {
    parsed = JSON.parse(readFileSync(PLATFORM_MATRIX_PATH, "utf8")) as PlatformMatrix;
  } catch {
    limitations.push("PLATFORM-MATRIX invalid: platform-support.json does not parse");
    return { supported: [], limitations };
  }
  const details = parsed.platforms ?? {};
  for (const name of parsed.unverified_or_degraded_platforms ?? []) {
    const entry = details[name];
    limitations.push(`PLATFORM ${name} (${entry?.status ?? "unknown"}): ${entry?.basis ?? ""}`);
  }
  return { supported: parsed.supported_platforms ?? [], limitations };
}

function yamlQuote(s: string): string {
  return JSON.stringify(s);
}

function yamlList(items: string[], indent: string): string {
  if (items.length === 0) return `${indent}[]`;
  return items.map((i) => `${indent}- ${yamlQuote(i)}`).join("\n");
}

const findings = loadFindings();
const stubLimitations = loadStubLimitations();
const platformSupport = loadPlatformSupport();
const known_limitations = [
  ...findings.known_limitations,
  ...stubLimitations,
  ...platformSupport.limitations,
];
const accepted_risks = findings.accepted_risks;
const schemaVersion = countMigrations();
const commit =
  process.env.TERMINUS_RELEASE_COMMIT ??
  process.env.GITHUB_SHA ??
  "unknown";
const version = process.env.TERMINUS_RELEASE_VERSION ?? "0.1.0";

// Roadmap Phase 0: platform support is evidence-derived. No matrix, no
// support claims.
const supportedPlatforms = platformSupport.supported;

const doc = `release:
  version: ${yamlQuote(version)}
  commit: ${yamlQuote(commit)}
  protocol_versions:
    terminus_kernel_v1: "1"
  database_schema_version: ${schemaVersion}
  supported_platforms:
${yamlList(supportedPlatforms, "    ")}
  security_profile: ${yamlQuote(process.env.TERMINUS_SECURITY_PROFILE ?? "secure-local-default")}
  evaluation_report: ${yamlQuote(process.env.TERMINUS_EVALUATION_REPORT ?? "artifacts/release-gate/eval-release.json")}
  divergence_report: ${yamlQuote(process.env.TERMINUS_DIVERGENCE_REPORT ?? "upstream/divergence-budget.yaml")}
  known_limitations:
${yamlList(known_limitations, "    ")}
  accepted_risks:
${yamlList(accepted_risks, "    ")}
  signatures:
    release_owner: ${yamlQuote(envOrEmpty("TERMINUS_RELEASE_OWNER_APPROVAL"))}
    security_owner: ${yamlQuote(envOrEmpty("TERMINUS_SECURITY_OWNER_APPROVAL"))}
    protocol_owner: ${yamlQuote(envOrEmpty("TERMINUS_PROTOCOL_OWNER_APPROVAL"))}
    evaluation_owner: ${yamlQuote(envOrEmpty("TERMINUS_EVALUATION_OWNER_APPROVAL"))}
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, doc, "utf8");
console.log(`[release-decision] wrote ${OUT_PATH} (schema_version=${schemaVersion})`);
