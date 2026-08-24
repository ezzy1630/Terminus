#!/usr/bin/env bun
/**
 * check-declaration-consistency — the Phase 0 truth gate.
 *
 * Verifies that source declarations, release metadata, and CI configuration
 * tell the same story:
 *
 *   1. maturity registry validates and covers every component directory,
 *      agreeing with each adapter's own adapter.yaml status;
 *   2. the CI workflow triggers on the repository's actual default branch
 *      (the branch/CI mismatch that started Phase 0);
 *   3. README carries no hard-coded test-count claims — counts must come
 *      from docs/generated/inventory.md;
 *   4. when release artifacts exist locally: supported_platforms in the
 *      release decision are a subset of evidence-backed platforms, and the
 *      known_limitations list may not be empty while stub components exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let failures = 0;

function fail(msg: string): void {
  console.error(`[truth-check] FAIL ${msg}`);
  failures += 1;
}

function run(cmd: string[]): string | null {
  const r = Bun.spawnSync(cmd, { cwd: ROOT });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

// ---------- 1. maturity registry ----------
{
  const r = Bun.spawnSync(["bun", "run", "tools/codegen/maturity.ts"], { cwd: ROOT });
  if (r.exitCode !== 0) {
    fail("maturity registry invalid or incomplete (see output above)");
  }
}

// ---------- 2. CI triggers cover the default branch ----------
{
  const fromEnv = process.env.TERMINUS_EXPECTED_DEFAULT_BRANCH;
  const fromGh = run(["gh", "api", "repos/:owner/:repo", "--jq", ".default_branch"]);
  const fromRef = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(
    /^origin\//,
    "",
  );
  const fromHead = existsSync(join(ROOT, ".git"))
    ? run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    : null;
  const defaultBranch = fromEnv ?? fromGh ?? fromRef ?? fromHead ?? null;
  if (!defaultBranch) {
    fail("could not determine default branch; set TERMINUS_EXPECTED_DEFAULT_BRANCH");
  } else {
    let ci: Record<string, { push?: { branches?: string[] } }> | null = null;
    try {
      // `on:` may parse as the string "on" (YAML 1.2) or boolean true
      // (YAML 1.1) depending on the parser.
      ci = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as Record<string, { push?: { branches?: string[] } }> | null;
    } catch (err) {
      fail(`ci.yml does not parse: ${String(err)}`);
    }
    const trigger = ci?.on ?? ci?.true ?? {};
    const branches = trigger.push?.branches ?? [];
    if (!branches.includes(defaultBranch)) {
      fail(
        `ci.yml push triggers [${branches.join(", ")}] do not include default branch "${defaultBranch}"`,
      );
    } else {
      console.log(`[truth-check] ok: ci.yml triggers include default branch ${defaultBranch}`);
    }
  }
}

// ---------- 3. README hard-count hygiene ----------
{
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const patterns: Array<[RegExp, string]> = [
    [/\d+\+?\s*tests passing/i, "hard-coded 'tests passing' claim"],
    [/\*\*\d+\+?\s*tests?\s*\*\*/i, "bold hard-coded test count"],
    [/0 typecheck errors/i, "hard-coded typecheck-error claim"],
    [/Total\s*\|\s*\**\d+/i, "hard-coded table total"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(readme)) fail(`README.md contains ${label} (use docs/generated/inventory.md)`);
  }
}

// ---------- 4. release artifacts cross-check (when present) ----------
{
  const decisionPath = join(ROOT, "artifacts/release-gate/release-decision.yaml");
  const matrixPath = join(ROOT, "artifacts/release-gate/platform-support.json");
  if (existsSync(decisionPath)) {
    const decisionText = readFileSync(decisionPath, "utf8");
    const decision = Bun.YAML.parse(decisionText) as {
      release?: { supported_platforms?: string[]; known_limitations?: string[] };
    };
    const supported = decision.release?.supported_platforms ?? [];
    if (existsSync(matrixPath)) {
      const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
        supported_platforms?: string[];
      };
      const verified = new Set(matrix.supported_platforms ?? []);
      for (const p of supported) {
        if (!verified.has(p)) {
          fail(`release decision claims platform "${p}" without evidence-backed support`);
        }
      }
    }
    if (decision.release?.known_limitations?.length === 0) {
      let stubCount = -1;
      try {
        const reg = Bun.YAML.parse(readFileSync(join(ROOT, "maturity.yaml"), "utf8")) as {
          components?: Array<{ tier?: string }>;
        };
        stubCount = (reg.components ?? []).filter((c) => c.tier === "stub").length;
      } catch {
        stubCount = -1;
      }
      if (stubCount > 0) {
        fail(
          `release decision lists zero limitations while ${stubCount} stub-tier components exist`,
        );
      }
    }
  }
}

if (failures > 0) {
  console.error(`[truth-check] ${failures} inconsistency(ies) found`);
  process.exit(1);
}
console.log("[truth-check] PASS declarations and metadata agree");
