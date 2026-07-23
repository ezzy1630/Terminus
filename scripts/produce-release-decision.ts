#!/usr/bin/env bun
/**
 * Produce SPEC §50.10 machine-readable release decision YAML.
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

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");
const OUT_PATH = join(OUT_DIR, "release-decision.yaml");
const FINDINGS_PATH = join(ROOT, "docs", "security", "findings-register.yaml");
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

function yamlQuote(s: string): string {
  return JSON.stringify(s);
}

function yamlList(items: string[], indent: string): string {
  if (items.length === 0) return `${indent}[]`;
  return items.map((i) => `${indent}- ${yamlQuote(i)}`).join("\n");
}

const { known_limitations, accepted_risks } = loadFindings();
const schemaVersion = countMigrations();
const commit =
  process.env.TERMINUS_RELEASE_COMMIT ??
  process.env.GITHUB_SHA ??
  "unknown";
const version = process.env.TERMINUS_RELEASE_VERSION ?? "0.1.0";

const supportedPlatforms = [
  "linux-x86_64",
  "linux-arm64",
  "linux-container",
  "macos-arm64",
  "macos-x86_64",
  "windows-x86_64",
];

const doc = `release:
  version: ${yamlQuote(version)}
  commit: ${yamlQuote(commit)}
  protocol_versions:
    terminus_kernel_v1: "1"
  database_schema_version: ${schemaVersion}
  supported_platforms:
${supportedPlatforms.map((p) => `    - ${yamlQuote(p)}`).join("\n")}
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
