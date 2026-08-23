#!/usr/bin/env bun
/**
 * Produce the evidence-backed system card for the current commit.
 *
 * Support comes from the platform matrix. Limitations come from findings,
 * maturity stubs, and current evidence. No stale baseline is carried forward.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Component = { id?: string; kind?: string; tier?: string; basis?: string };
type JsonRecord = Record<string, unknown>;
type Finding = { id?: string; severity?: string; status?: string; summary?: string; acceptance_rationale?: string };
type PlatformDetail = { status: string; basis: string; evidence?: string | null };

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");

function currentCommit(): string {
  const fromEnv = process.env.TERMINUS_RELEASE_COMMIT ?? process.env.GITHUB_SHA;
  if (fromEnv?.trim()) return fromEnv.trim();
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT });
  return result.stdout.toString().trim() || "unknown";
}

function ciRunUrl(): string | null {
  const server = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  return server && runId && repository ? `${server}/${repository}/actions/runs/${runId}` : null;
}

function loadMaturity(): Component[] {
  const parsed = Bun.YAML.parse(readFileSync(join(ROOT, "maturity.yaml"), "utf8")) as { components?: Component[] };
  return parsed.components ?? [];
}

function loadFindings(): Finding[] {
  const path = join(ROOT, "docs/security/findings-register.yaml");
  if (!existsSync(path)) return [];
  try {
    const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as { findings?: Finding[] };
    return parsed.findings ?? [];
  } catch {
    return [];
  }
}

function loadPlatformEvidence(head: string): { supported: string[]; details: Record<string, PlatformDetail>; limitation?: string } {
  const path = join(OUT_DIR, "platform-support.json");
  if (!existsSync(path)) return { supported: [], details: {}, limitation: "platform-support.json is missing" };
  try {
    const matrix = JSON.parse(readFileSync(path, "utf8")) as {
      commit?: string;
      supported_platforms?: string[];
      platforms?: Record<string, PlatformDetail>;
    };
    if (matrix.commit !== head) {
      return {
        supported: [],
        details: {},
        limitation: `platform-support.json is bound to ${matrix.commit ?? "unknown"}, not HEAD ${head}`,
      };
    }
    return {
      supported: matrix.supported_platforms ?? [],
      details: matrix.platforms ?? {},
    };
  } catch {
    return { supported: [], details: {}, limitation: "platform-support.json is invalid" };
  }
}

function loadEvalBaseline(head: string): JsonRecord | null {
  const path = join(OUT_DIR, "eval-baseline.json");
  if (!existsSync(path)) return null;
  const baseline = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
  if (baseline.commit !== undefined && baseline.commit !== head) {
    throw new Error(`eval baseline commit ${String(baseline.commit)} does not match HEAD ${head}`);
  }
  return baseline;
}

function deriveMissingInfrastructure(
  details: Record<string, PlatformDetail>,
  findings: Finding[],
  stubs: Component[],
  evalBaseline: JsonRecord | null,
  matrixLimitation?: string,
): Array<{ id: string; detail: string }> {
  const missing: Array<{ id: string; detail: string }> = [];
  if (matrixLimitation) missing.push({ id: "platform-matrix", detail: matrixLimitation });
  for (const [platform, evidence] of Object.entries(details)) {
    if (evidence.status !== "supported") {
      missing.push({ id: `platform:${platform}`, detail: evidence.basis });
    }
  }
  for (const finding of findings) {
    if (finding.status === "open" || finding.status === "accepted") {
      missing.push({
        id: `finding:${finding.id ?? "unknown"}`,
        detail: finding.acceptance_rationale?.trim() || finding.summary?.trim() || "registered security finding",
      });
    }
  }
  for (const stub of stubs) {
    missing.push({ id: `stub:${stub.id ?? "unknown"}`, detail: stub.basis?.trim() || "declared stub" });
  }
  if (!evalBaseline) missing.push({ id: "eval-baseline", detail: "no baseline evaluation artifact exists" });
  return missing;
}

function deriveKnownFailures(): Array<{ id: string; detail: string }> {
  const failures: Array<{ id: string; detail: string }> = [];
  if (!existsSync(OUT_DIR)) return failures;
  for (const file of readdirSync(OUT_DIR).filter((name) => name.endsWith(".json") && name !== "exit-gate-report.json")) {
    try {
      const value = JSON.parse(readFileSync(join(OUT_DIR, file), "utf8")) as JsonRecord;
      const status = typeof value.status === "string" ? value.status.toLowerCase() : "";
      if (status === "failed" || status.includes("fixture") || value.pass === false) {
        failures.push({
          id: `evidence:${file.replace(/\.json$/, "")}`,
          detail: `current artifact reports status=${status || "failed"}`,
        });
      }
    } catch {
      failures.push({ id: `evidence:${file.replace(/\.json$/, "")}`, detail: "current artifact is not valid JSON" });
    }
  }
  return failures;
}

function main(): void {
  const now = new Date().toISOString();
  const head = currentCommit();
  const components = loadMaturity();
  const findings = loadFindings();
  const stubs = components.filter((component) => component.tier === "stub");
  const platformEvidence = loadPlatformEvidence(head);
  const evalBaseline = loadEvalBaseline(head);
  const tierCounts = new Map<string, number>();
  for (const component of components) {
    if (component.tier) tierCounts.set(component.tier, (tierCounts.get(component.tier) ?? 0) + 1);
  }
  const card = {
    schema_version: 1,
    generatedAt: now,
    commit: head,
    ci_run_url: ciRunUrl(),
    component_maturity: Object.fromEntries(tierCounts),
    supported_platforms: platformEvidence.supported,
    platform_detail: platformEvidence.details,
    open_or_accepted_findings: findings
      .filter((finding) => finding.status === "open" || finding.status === "accepted")
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        status: finding.status,
        summary: finding.summary,
      })),
    declared_stubs: stubs.map((component) => ({ id: component.id, basis: component.basis })),
    eval_baseline: evalBaseline ?? { status: "missing", note: "no baseline evaluation artifact exists" },
    missing_infrastructure: deriveMissingInfrastructure(
      platformEvidence.details,
      findings,
      stubs,
      evalBaseline,
      platformEvidence.limitation,
    ),
    known_failures: deriveKnownFailures(),
    production_claims: [] as string[],
    note_production_claims:
      "Empty by design. Production claims require a mapped test artifact at this commit.",
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "system-card.json"), `${JSON.stringify(card, null, 2)}\n`, "utf8");

  const markdown: string[] = [
    "# Terminus system card",
    "",
    `Commit: \`${head}\` · Generated: ${now}${ciRunUrl() ? ` · [CI run](${ciRunUrl()})` : ""}`,
    "",
    "## What this build is",
    "",
    "A provider-neutral coding-agent operating system under construction. Component maturity comes from maturity.yaml.",
  ];
  for (const tier of ["production", "preview", "experimental", "stub", "fixture"]) {
    markdown.push(`- ${tierCounts.get(tier) ?? 0} \`${tier}\` components`);
  }
  markdown.push("", "## Platform support (evidence-derived)", "");
  if (platformEvidence.supported.length === 0) markdown.push("_None._ No platform has current conformance evidence.");
  else for (const platform of platformEvidence.supported) markdown.push(`- ${platform}`);
  for (const [platform, evidence] of Object.entries(platformEvidence.details)) {
    if (evidence.status !== "supported") markdown.push(`- \`${platform}\`: **${evidence.status}** - ${evidence.basis}`);
  }
  markdown.push("", "## Known limitations and accepted risks", "");
  for (const finding of card.open_or_accepted_findings) {
    markdown.push(`- ${finding.id} (${finding.severity}, ${finding.status}): ${finding.summary}`);
  }
  markdown.push("", "### Declared stubs", "");
  for (const stub of stubs) markdown.push(`- \`${stub.id}\`: ${stub.basis}`);
  markdown.push("", "## Evaluation baseline", "", evalBaseline ? `\`${String(evalBaseline.status)}\` - see artifacts/release-gate/eval-baseline.json` : "_Missing._ No evaluation claim is made.");
  markdown.push("", "## Missing infrastructure", "");
  for (const item of card.missing_infrastructure) markdown.push(`- **${item.id}**: ${item.detail}`);
  if (card.known_failures.length > 0) {
    markdown.push("", "## Current failing evidence", "");
    for (const failure of card.known_failures) markdown.push(`- **${failure.id}**: ${failure.detail}`);
  }
  markdown.push("", "## Production claims", "", "_None._ Every production claim must map to a test artifact at this commit.", "");
  writeFileSync(join(OUT_DIR, "system-card.md"), markdown.join("\n"), "utf8");
  console.log(`[system-card] wrote artifacts/release-gate/system-card.{json,md} @ ${head.slice(0, 12)}`);
}

if (import.meta.main) main();
