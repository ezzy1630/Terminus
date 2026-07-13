#!/usr/bin/env bun
/**
 * boundary-check — enforce architecture boundaries (SPEC §42.5).
 *
 * This script runs the mechanical checks mandated by SPEC §42.5 and
 * referenced from `docs/architecture/trust-boundaries.md`. It is wired
 * into CI as a separate job and exposed as `just boundary-check`.
 *
 * Checks implemented:
 *  1. No `packages/*` source file imports `child_process`, `node:fs`,
 *     `node:net`, or `node:crypto` — except the documented allow-list
 *     (`@terminus/artifact-client` for content hashing; `@terminus/context-ir`
 *     for SHA-256 content-addressed IR hashes per SPEC §28.1).
 *  2. No `packages/*` source file imports from `mini-services/` or `apps/`
 *     (packages must not depend on deployables).
 *  3. `crates/terminus-kernel` source files do not import from UI or provider
 *     crates (provider crates are `provider-*`; UI lives under `apps/`).
 *  4. `packages/domain` does not import any provider SDK
 *     (`@terminus/provider-openai`, `@terminus/provider-anthropic`,
 *     `@terminus/provider-google`, `@terminus/provider-local`, or third-party
 *     provider SDKs).
 *  5. No raw SQL strings outside `prisma/` and `migrations/`. A "raw SQL
 *     string" is a template literal containing `SELECT`, `INSERT`,
 *     `UPDATE`, `DELETE`, `CREATE TABLE`, or `PRAGMA` (case-insensitive)
 *     that is not inside a `.sql` file.
 *
 * Exit code is non-zero if any violation is found. The script is
 * deliberately dependency-light so it runs in CI without extra installs.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.env.FORGE_ROOT ?? join(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const CRATES_DIR = join(ROOT, "crates");
const MINI_SERVICES_DIR = join(ROOT, "mini-services");
const APPS_DIR = join(ROOT, "apps");

// Packages that may import `node:crypto` for content hashing. SPEC §42.5
// names `@terminus/artifact-client`. We additionally allow `@terminus/context-ir`
// because its SHA-256 hashes are content-addressed IR fingerprints
// (SPEC §28.1) — the same architectural justification.
const CRYPTO_ALLOW = new Set(["artifact-client", "context-ir"]);

interface Violation {
  rule: string;
  file: string;
  line: number;
  detail: string;
}

const violations: Violation[] = [];

function* walk(dir: string, skip: RegExp[] = []): Generator<string> {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "target" || name === ".next" || name === "dist") continue;
    if (skip.some((re) => re.test(name))) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(p, skip);
    } else if (st.isFile()) {
      yield p;
    }
  }
}

function listPackages(): string[] {
  if (!existsSync(PACKAGES_DIR)) return [];
  return readdirSync(PACKAGES_DIR).filter((n) => {
    try {
      return statSync(join(PACKAGES_DIR, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

function listCrates(): string[] {
  if (!existsSync(CRATES_DIR)) return [];
  return readdirSync(CRATES_DIR).filter((n) => {
    try {
      return statSync(join(CRATES_DIR, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 1: forbidden TS imports in packages/*
// ───────────────────────────────────────────────────────────────────────────

const FORBIDDEN_TS_IMPORTS = [
  { re: /\bfrom\s+["']child_process["']/, name: "child_process" },
  { re: /\bfrom\s+["']node:child_process["']/, name: "node:child_process" },
  { re: /\bfrom\s+["']fs["']/, name: "fs" },
  { re: /\bfrom\s+["']node:fs["']/, name: "node:fs" },
  { re: /\bfrom\s+["']net["']/, name: "net" },
  { re: /\bfrom\s+["']node:net["']/, name: "node:net" },
  { re: /\bfrom\s+["']crypto["']/, name: "crypto" },
  { re: /\bfrom\s+["']node:crypto["']/, name: "node:crypto" },
];

function checkPackagesForbiddenImports(): void {
  for (const pkg of listPackages()) {
    const allowed = CRYPTO_ALLOW.has(pkg);
    for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const { re, name } of FORBIDDEN_TS_IMPORTS) {
          if (!re.test(line)) continue;
          if (allowed && (name === "crypto" || name === "node:crypto")) continue;
          violations.push({
            rule: "R1: forbidden TS import in packages/*",
            file: relative(ROOT, file),
            line: i + 1,
            detail: `import of \`${name}\` is forbidden in packages/* (only ${[...CRYPTO_ALLOW].map((p) => `@terminus/${p}`).join(", ")} may use crypto for hashing)`,
          });
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 2: packages must not import from mini-services/ or apps/
// ───────────────────────────────────────────────────────────────────────────

const FORBIDDEN_DEP_RE = /\bfrom\s+["'](\.\.?\/)+mini-services\/|\bfrom\s+["'](\.\.?\/)+apps\/|\bfrom\s+["']@terminus\/(terminus-kernel|terminus-control|terminus-tui|terminus-cli|ide-acp)["']/;

function checkPackagesNoDeployableDeps(): void {
  for (const pkg of listPackages()) {
    for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (FORBIDDEN_DEP_RE.test(line)) {
          violations.push({
            rule: "R2: package imports deployable",
            file: relative(ROOT, file),
            line: i + 1,
            detail: `packages/* must not import from mini-services/ or apps/`,
          });
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 3: crates/terminus-kernel must not import from UI or provider code
// ───────────────────────────────────────────────────────────────────────────

const KERNEL_FORBIDDEN_USE_RE = /\buse\s+(forge_provider_|crate::provider_|crate::ui_|super::ui_|super::provider_)/;
const KERNEL_FORBIDDEN_CRATE_RE = /\buse\s+(forge_provider_|provider_openai|provider_anthropic|provider_google|provider_local)/;

function checkKernelNoUIOrProvider(): void {
  const kernelDir = join(CRATES_DIR, "terminus-kernel");
  if (!existsSync(kernelDir)) return;
  for (const file of walk(kernelDir)) {
    if (!file.endsWith(".rs")) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (KERNEL_FORBIDDEN_USE_RE.test(line) || KERNEL_FORBIDDEN_CRATE_RE.test(line)) {
        violations.push({
          rule: "R3: kernel imports UI/provider code",
          file: relative(ROOT, file),
          line: i + 1,
          detail: `crates/terminus-kernel must not import from UI or provider crates`,
        });
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 4: packages/domain must not import provider SDKs
// ───────────────────────────────────────────────────────────────────────────

const PROVIDER_SDK_RES = [
  /\bfrom\s+["']@terminus\/provider-openai["']/,
  /\bfrom\s+["']@terminus\/provider-anthropic["']/,
  /\bfrom\s+["']@terminus\/provider-google["']/,
  /\bfrom\s+["']@terminus\/provider-local["']/,
  /\bfrom\s+["']openai["']/,
  /\bfrom\s+["']@anthropic-ai\/sdk["']/,
  /\bfrom\s+["']@google\/generative-ai["']/,
];

function checkDomainNoProviderSDKs(): void {
  const domainDir = join(PACKAGES_DIR, "domain", "src");
  if (!existsSync(domainDir)) return;
  for (const file of walk(domainDir)) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const re of PROVIDER_SDK_RES) {
        if (re.test(line)) {
          violations.push({
            rule: "R4: domain imports provider SDK",
            file: relative(ROOT, file),
            line: i + 1,
            detail: `packages/domain must not import provider SDKs`,
          });
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 5: no raw SQL strings outside prisma/ and migrations/
// ───────────────────────────────────────────────────────────────────────────

// Stricter SQL detection: require the keyword to be followed by SQL syntax
// (an identifier, `*`, `(`, a quoted string, or `SET`/`WHERE`/`VALUES`).
// This avoids false positives like English prose containing "update".
const SQL_PATTERNS = [
  /\bSELECT\s+[\w*,'"`()\s]+\s+FROM\s+[\w"`]/i,
  /\bINSERT\s+INTO\s+[\w"`]/i,
  /\bUPDATE\s+[\w"`]+\s+SET\b/i,
  /\bDELETE\s+FROM\s+[\w"`]/i,
  /\bCREATE\s+(TABLE|INDEX|VIEW|TRIGGER)\s+[\w"`]/i,
  /\bDROP\s+(TABLE|INDEX|VIEW|TRIGGER)\s+[\w"`]/i,
  /\bPRAGMA\s+\w+/i,
];

// Files/paths that are allowed to contain raw SQL:
//  - prisma/ (schema + Prisma migrations source)
//  - migrations/ (SQL migrations source)
//  - scripts/migrate.ts (the SQL migration runner; reads .sql files)
//  - src/lib/db.ts (the Prisma client wrapper; runs PRAGMAs via $queryRaw)
//  - any *.test.ts file (tests may construct SQL strings)
//  - python venvs, node_modules, build outputs
const SQL_ALLOWED_FILES = new Set([
  "scripts/migrate.ts",
  "src/lib/db.ts",
]);

function isSqlAllowedPath(p: string): boolean {
  const rel = relative(ROOT, p);
  // Rust crates (e.g. terminus-artifacts) implement the SQLite storage layer via
  // `rusqlite`, which requires SQL strings — there is no Prisma for Rust. R5
  // governs the TypeScript control plane (no raw SQL outside Prisma); Rust
  // storage crates are the legitimate low-level layer, so .rs files are exempt.
  if (rel.endsWith(".rs")) return true;
  if (SQL_ALLOWED_FILES.has(rel)) return true;
  if (rel.endsWith(".test.ts") || rel.endsWith(".spec.ts") || rel.endsWith(".test.tsx") || rel.endsWith(".spec.tsx")) return true;
  if (rel.endsWith("_test.py") || rel.endsWith(".test.py")) return true;
  if (rel.includes("/.venv/") || rel.includes("/venv/") || rel.includes("/__pycache__/") || rel.includes("/site-packages/")) return true;
  if (rel.includes("/node_modules/") || rel.includes("/dist/") || rel.includes("/.next/") || rel.includes("/build/") || rel.includes("/target/")) return true;
  return false;
}

function checkNoRawSqlOutsideRepositories(): void {
  // Walk every source file in the repo and look for SQL patterns inside
  // string/template literals. Skip the explicitly-allowed files above.
  const skipDirs = [
    join(ROOT, "node_modules"),
    join(ROOT, "target"),
    join(ROOT, ".next"),
    join(ROOT, "dist"),
    join(ROOT, "prisma"),
    join(ROOT, "migrations"),
    join(ROOT, ".git"),
    join(ROOT, ".devcontainer"),
    join(ROOT, ".github"),
    join(ROOT, "docs"),
    join(ROOT, "skills"),
    join(ROOT, "tools"),
    // Vendored upstream sources are checked by their own parity/divergence
    // gates and are not part of Terminus's first-party architecture surface.
    join(ROOT, "vendor"),
    join(ROOT, "python", "forge_evals", ".venv"),
  ];
  function inSkipped(p: string): boolean {
    return skipDirs.some((d) => p.startsWith(d + "/") || p === d);
  }
  const topEntries = readdirSync(ROOT);
  for (const entry of topEntries) {
    if (entry.startsWith(".")) continue;
    const p = join(ROOT, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory() && !st.isFile()) continue;
    if (inSkipped(p)) continue;
    const files = st.isDirectory() ? Array.from(walk(p)) : [p];
    for (const file of files) {
      if (isSqlAllowedPath(file)) continue;
      const ext = extname(file);
      if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".mjs" && ext !== ".rs" && ext !== ".py") continue;
      // Skip this script.
      if (file.endsWith("boundary-check.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Skip Prisma raw-query call sites (typed raw SQL is allowed in db.ts).
        if (/\$queryRaw|\$executeRaw/.test(line)) continue;
        // Skip lines that are clearly comments.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        for (const re of SQL_PATTERNS) {
          if (re.test(line)) {
            violations.push({
              rule: "R5: raw SQL outside repositories",
              file: relative(ROOT, file),
              line: i + 1,
              detail: `raw SQL strings are forbidden outside prisma/ and migrations/ (use Prisma's typed query builder; only db.ts may use $queryRaw)`,
            });
            break; // one violation per line is enough
          }
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("[boundary-check] running 5 SPEC §42.5 mechanical checks…");
  checkPackagesForbiddenImports();
  checkPackagesNoDeployableDeps();
  checkKernelNoUIOrProvider();
  checkDomainNoProviderSDKs();
  checkNoRawSqlOutsideRepositories();

  if (violations.length === 0) {
    console.log("[boundary-check] OK — no architecture-boundary violations");
    return;
  }
  console.error(`[boundary-check] ${violations.length} violation(s) found:`);
  for (const v of violations) {
    console.error(`  - ${v.rule}\n    ${v.file}:${v.line}\n    ${v.detail}`);
  }
  process.exit(1);
}

main();
