#!/usr/bin/env bun
/**
 * codegen/inventory — static repository inventory at HEAD.
 *
 * Roadmap Phase 0: replace hard-coded README counts (which drift and
 * overclaim) with generated, statically verifiable facts. Every number here
 * is computed from the source tree by a deterministic scan.
 *
 * IMPORTANT HONESTY BOUNDARY: these are STATIC source scans. A counted
 * `#[test]` is a declared test, not a passing test run. Executed-test
 * evidence lives in CI artifacts (see .github/workflows/ci.yml) and in
 * artifacts/release-gate/. This file never claims runs happened.
 *
 * Output: docs/generated/inventory.md (deterministic; covered by codegen-check).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..", "..");
const OUT_PATH = join(ROOT, "docs", "generated", "inventory.md");

function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output.split("\0").filter((path) => path.length > 0);
}

const TRACKED_FILES = trackedFiles();

function filesUnder(rel: string, pred: (relPath: string) => boolean): string[] {
  const prefix = `${rel}/`;
  return TRACKED_FILES.filter((path) => path.startsWith(prefix) && pred(path));
}

function countTopLevelDirs(rel: string): number {
  const prefix = `${rel}/`;
  const directories = new Set<string>();
  for (const path of TRACKED_FILES) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const separator = remainder.indexOf("/");
    if (separator > 0) directories.add(remainder.slice(0, separator));
  }
  return directories.size;
}

function countMatches(files: string[], re: RegExp): number {
  let n = 0;
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    n += (text.match(re) ?? []).length;
  }
  return n;
}

function lineCount(rel: string): number {
  if (!existsSync(join(ROOT, rel))) return 0;
  return readFileSync(join(ROOT, rel), "utf8").split("\n").length - 1;
}

function main(): void {
  const rustFiles = filesUnder("crates", (p) => p.endsWith(".rs") && !p.includes("/generated"));
  const rustTests = countMatches(rustFiles, /#\[(?:tokio::)?test\]/g);

  const tsTestFiles = [
    ...filesUnder("packages", (p) => /\.test\.(ts|tsx)$/.test(p)),
    ...filesUnder("apps", (p) => /\.test\.(ts|tsx)$/.test(p)),
  ];
  const tsTestBlocks = countMatches(tsTestFiles, /\b(?:test|it)\s*\(/g);

  const pyFiles = filesUnder("python", (p) => p.endsWith(".py"));
  const pyTests = countMatches(pyFiles, /^\s*def\s+test_/gm);

  const crates = countTopLevelDirs("crates");
  const packages = countTopLevelDirs("packages");
  const apps = countTopLevelDirs("apps");
  const adapters = countTopLevelDirs("adapters");
  const miniServices = countTopLevelDirs("mini-services");
  const adrs = filesUnder("docs/decisions", (p) => /ADR-\d+.*\.md$/.test(p)).length;
  const runbooks = filesUnder("docs/runbooks", (p) => p.endsWith(".md")).length;
  const migrations = filesUnder("migrations/sqlite", (p) => p.endsWith(".sql")).length;
  const specLines = lineCount("SPEC.md");

  // Rust crate test totals are also broken down per top-level integration
  // test file so the numbers can be checked against CI artifacts.
  const lines: string[] = [];
  lines.push("# Static inventory");
  lines.push("");
  lines.push("> Auto-generated from Git-tracked source at HEAD by `tools/codegen/inventory.ts`.");
  lines.push("> Do not edit by hand — run `just codegen`.");
  lines.push("");
  lines.push("**Honesty boundary:** every count below is a STATIC source scan at HEAD.");
  lines.push("A declared test is not a passing run. Executed-test evidence lives in CI");
  lines.push("(workflow artifacts on the exact commit) and under `artifacts/release-gate/`.");
  lines.push("");
  lines.push("| Fact | Value | How derived |");
  lines.push("|---|---:|---|");
  lines.push(`| SPEC.md lines | ${specLines} | wc of SPEC.md |`);
  lines.push(`| Rust crates | ${crates} | directories in crates/ |`);
  lines.push(`| TypeScript packages | ${packages} | directories in packages/ |`);
  lines.push(`| Client apps | ${apps} | directories in apps/ |`);
  lines.push(`| External harness adapters | ${adapters} | directories in adapters/ |`);
  lines.push(`| Mini-services | ${miniServices} | directories in mini-services/ |`);
  lines.push(`| Declared Rust tests | ${rustTests} | \`#[test]\` + \`#[tokio::test]\` occurrences in crates/** (excl. generated) |`);
  lines.push(`| TypeScript test files | ${tsTestFiles.length} | \`*.test.{ts,tsx}\` in packages/ + apps/ |`);
  lines.push(`| Declared TypeScript test blocks | ${tsTestBlocks} | \`test(/it(\` occurrences in those files |`);
  lines.push(`| Declared Python tests | ${pyTests} | \`def test_*\` in python/** |`);
  lines.push(`| ADRs | ${adrs} | docs/decisions/ADR-*.md |`);
  lines.push(`| Runbooks | ${runbooks} | docs/runbooks/*.md |`);
  lines.push(`| SQLite migrations | ${migrations} | migrations/sqlite/*.sql |`);
  lines.push("");
  lines.push("Maturity classification of every component: see the");
  lines.push("[component maturity registry](component-maturity.md) (`maturity.yaml`).");
  lines.push("");
  writeFileSync(OUT_PATH, `${lines.join("\n")}`, "utf8");
  console.log(`[codegen-inventory] wrote ${OUT_PATH}`);
}

main();
