#!/usr/bin/env bun
/**
 * produce-system-card — first system card (roadmap Phase 0).
 *
 * A system card states what the system at a given commit IS, backed by
 * evidence, with every known limitation and every piece of missing
 * infrastructure recorded explicitly. It never upgrades declarations into
 * claims: maturity comes from maturity.yaml, platform support from the
 * evidence-derived matrix, limitations from the findings register + registry,
 * and eval status from whatever baseline artifact exists.
 *
 * Outputs:
 *   artifacts/release-gate/system-card.json
 *   artifacts/release-gate/system-card.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "artifacts", "release-gate");

interface Component {
  id: string;
  kind: string;
  tier: string;
  basis: string;
}

function commit(): string {
  return (
    process.env.TERMINUS_RELEASE_COMMIT ??
    process.env.GITHUB_SHA ??
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim() ??
    "unknown"
  );
}

function ciRunUrl(): string | null {
  const server = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  if (server && runId) return `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`;
  return null;
}

const MISSING_INFRASTRUCTURE: ReadonlyArray<{ id: string; detail: string }> = [
  {
    id: "branch-protection",
    detail:
      "GitHub-side branch protection cannot be applied by automation on this repo plan (API returns 403); an owner must apply docs/runbooks/branch-protection.md manually.",
  },
  {
    id: "linux-enforcement-evidence",
    detail:
      "Signed Linux effective-enforcement evidence requires the linux-evidence workflow on an Ubuntu runner (just linux-enforcement-evidence); absent locally, Linux support is withheld.",
  },
  {
    id: "full-soak-runner",
    detail:
      "24h soak needs a dedicated runner; CI runs a 30s smoke (FIND-002). Required before promoting beyond preview.",
  },
  {
    id: "external-pentest",
    detail: "Formal external penetration test not yet engaged (FIND-001); scheduled before 1.0.",
  },
  {
    id: "live-adapter-probes",
    detail:
      "No external-harness adapter has ever been verified by a live capability probe; all non-fixture adapters are stubs and last_verified is null.",
  },
  {
    id: "hardened-container-profiles",
    detail:
      "Container backend emits plain docker argv; hardened OCI profiles (read-only rootfs, cap-drop, seccomp, limits) are Phase 4 work.",
  },
  {
    id: "durable-state-substrate",
    detail:
      "Authoritative job/approval/secret/audit state remains process-local until the Phase 2 durable substrate lands.",
  },
];

// Known failing checks at this baseline, recorded verbatim per the Phase 0
// exit gate ("all failures ... are recorded"). Each entry must be removed
// together with the commit that fixes it.
const KNOWN_FAILURES: ReadonlyArray<{ id: string; detail: string }> = [
  {
    id: "e2e-assert-lifecycle-verification-dag",
    detail:
      "`just e2e` fails at scripts/e2e/assert-lifecycle.ts:343 on macOS arm64: the control plane emits a verification plan with 1 node (ac_lifecycle) where the harness requires >= 3; reproduction confirmed on clean HEAD a383115 (pre-existing, not introduced by Phase 0 truth work).",
  },
];

function main(): void {
  const now = new Date().toISOString();
  const head = commit();

  // --- inputs ---
  const maturity = Bun.YAML.parse(readFileSync(join(ROOT, "maturity.yaml"), "utf8")) as {
    components: Component[];
  };
  const components = maturity.components;

  let platforms: Record<string, { status: string; basis: string }> = {};
  let supportedPlatforms: string[] = [];
  if (existsSync(join(OUT_DIR, "platform-support.json"))) {
    const m = JSON.parse(readFileSync(join(OUT_DIR, "platform-support.json"), "utf8"));
    platforms = m.platforms ?? {};
    supportedPlatforms = m.supported_platforms ?? [];
  }

  let findings: Array<Record<string, unknown>> = [];
  try {
    const reg = Bun.YAML.parse(
      readFileSync(join(ROOT, "docs/security/findings-register.yaml"), "utf8"),
    );
    findings = reg.findings ?? [];
  } catch {
    /* recorded as missing below */
  }

  const evalBaselinePath = join(OUT_DIR, "eval-baseline.json");
  const evalBaseline = existsSync(evalBaselinePath)
    ? (JSON.parse(readFileSync(evalBaselinePath, "utf8")) as Record<string, unknown>)
    : null;

  const tierCounts = new Map<string, number>();
  for (const c of components) tierCounts.set(c.tier, (tierCounts.get(c.tier) ?? 0) + 1);
  const stubs = components.filter((c) => c.tier === "stub");

  const card = {
    schema_version: 1,
    generatedAt: now,
    commit: head,
    ci_run_url: ciRunUrl(),
    component_maturity: Object.fromEntries(tierCounts),
    supported_platforms: supportedPlatforms,
    platform_detail: platforms,
    open_or_accepted_findings: findings
      .filter((f) => f.status === "open" || f.status === "accepted")
      .map((f) => ({ id: f.id, severity: f.severity, status: f.status, summary: f.summary })),
    declared_stubs: stubs.map((c) => ({ id: c.id, basis: c.basis })),
    eval_baseline: evalBaseline ?? {
      status: "missing",
      note: "no baseline evaluation artifact exists; run `just eval-baseline`",
    },
    missing_infrastructure: MISSING_INFRASTRUCTURE,
    known_failures: KNOWN_FAILURES,
    production_claims: [] as string[],
    note_production_claims:
      "Empty by design: no durable/enforced/non-bypassable/production claim may appear here without a mapped test artifact. Components are promoted in maturity.yaml with an evidence pointer when such artifacts exist.",
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "system-card.json"), `${JSON.stringify(card, null, 2)}\n`);

  const md: string[] = [];
  md.push("# Terminus system card");
  md.push("");
  md.push(`Commit: \`${head}\` · Generated: ${now}${ciRunUrl() ? ` · [CI run](${ciRunUrl()})` : ""}`);
  md.push("");
  md.push("## What this build is");
  md.push("");
  md.push(
    "A provider-neutral coding-agent operating system under construction. Per the maturity registry:",
  );
  for (const t of ["production", "preview", "experimental", "stub", "fixture"]) {
    md.push(`- ${tierCounts.get(t) ?? 0} \`${t}\` components`);
  }
  md.push("");
  md.push("## Platform support (evidence-derived)");
  md.push("");
  if (supportedPlatforms.length === 0) {
    md.push("_None._ No platform has conformance evidence bound to this commit.");
  } else {
    for (const p of supportedPlatforms) md.push(`- ${p}`);
  }
  md.push("");
  for (const [name, e] of Object.entries(platforms)) {
    if (e.status !== "supported") md.push(`- \`${name}\`: **${e.status}** — ${e.basis}`);
  }
  md.push("");
  md.push("## Known limitations and accepted risks");
  md.push("");
  for (const f of card.open_or_accepted_findings) {
    md.push(`- ${f.id} (${f.severity}, ${f.status}): ${f.summary}`);
  }
  md.push("");
  md.push("### Declared stubs");
  md.push("");
  for (const s of stubs) md.push(`- \`${s.id}\`: ${s.basis}`);
  md.push("");
  md.push("## Evaluation baseline");
  md.push("");
  md.push(
    evalBaseline
      ? `\`${evalBaseline.status as string}\` — see artifacts/release-gate/eval-baseline.json`
      : "_Missing._ Run `just eval-baseline`. No performance or capability claims are made.",
  );
  md.push("");
  md.push("## Missing infrastructure");
  md.push("");
  for (const m of MISSING_INFRASTRUCTURE) md.push(`- **${m.id}**: ${m.detail}`);
  md.push("");
  if (KNOWN_FAILURES.length > 0) {
    md.push("## Known failing checks at this baseline");
    md.push("");
    for (const f of KNOWN_FAILURES) md.push(`- **${f.id}**: ${f.detail}`);
    md.push("");
  }
  md.push("## Production claims");
  md.push("");
  md.push(
    "_None._ Every `durable` / `enforced` / `non-bypassable` / `production` claim must map to a test artifact; none currently does, so none is made.",
  );
  md.push("");
  writeFileSync(join(OUT_DIR, "system-card.md"), `${md.join("\n")}`);

  console.log(`[system-card] wrote artifacts/release-gate/system-card.{json,md} @ ${head.slice(0, 12)}`);
}

main();
