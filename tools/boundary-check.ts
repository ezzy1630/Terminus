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
 *  6. The ADR-0039 packaged-runtime supervisor is the only production app
 *     module allowed to import or invoke a direct process-creation API.
 *
 * Exit code is non-zero if any violation is found. The script is
 * deliberately dependency-light so it runs in CI without extra installs.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.env.TERMINUS_ROOT ?? process.env.FORGE_ROOT ?? join(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const CRATES_DIR = join(ROOT, "crates");
const MINI_SERVICES_DIR = join(ROOT, "mini-services");
const APPS_DIR = join(ROOT, "apps");

// Packages that may import `node:crypto` for content hashing. SPEC §42.5
// names `@terminus/artifact-client`. We additionally allow `@terminus/context-ir`
// because its SHA-256 hashes are content-addressed IR fingerprints
// (SPEC §28.1) — the same architectural justification — and
// `@terminus/capability-registry`, which hashes capability descriptors,
// skill payloads, and MCP server configs into `sha256:<hex>` lockfile pins
// used for rug-pull detection (SPEC §35.5, ADR-0017, ADR-0018), and
// `@terminus/workflow-compiler`, which computes content hashes of compiled
// workflow IR and source documents (SPEC §8.2, ADR-0036).
const CRYPTO_ALLOW = new Set(["artifact-client", "context-ir", "capability-registry", "workflow-compiler"]);

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
  { re: /(\bfrom\s+["']|\brequire\(["'])child_process["']/, name: "child_process" },
  { re: /(\bfrom\s+["']|\brequire\(["'])node:child_process["']/, name: "node:child_process" },
  { re: /(\bfrom\s+["']|\brequire\(["'])fs["']/, name: "fs" },
  { re: /(\bfrom\s+["']|\brequire\(["'])node:fs["']/, name: "node:fs" },
  { re: /(\bfrom\s+["']|\brequire\(["'])net["']/, name: "net" },
  { re: /(\bfrom\s+["']|\brequire\(["'])node:net["']/, name: "node:net" },
  { re: /(\bfrom\s+["']|\brequire\(["'])tls["']/, name: "tls" },
  { re: /(\bfrom\s+["']|\brequire\(["'])node:tls["']/, name: "node:tls" },
  { re: /(\bfrom\s+["']|\brequire\(["'])dgram["']/, name: "dgram" },
  { re: /(\bfrom\s+["']|\brequire\(["'])node:dgram["']/, name: "node:dgram" },
  { re: /(\bfrom\s+["']|\brequire\(["'])crypto["']/, name: "crypto" },
  { re: /(\bfrom\s+["']|\brequire\(["'])node:crypto["']/, name: "node:crypto" },
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
//  - packages/task-runtime/src/sqlite-repository.ts (the injected SQLite
//    repository port; it has no ambient database/client authority)
//  - any *.test.ts file (tests may construct SQL strings)
//  - python venvs, node_modules, build outputs
const SQL_ALLOWED_FILES = new Set([
  "scripts/migrate.ts",
  "src/lib/db.ts",
  "packages/task-runtime/src/sqlite-repository.ts",
]);

function isSqlAllowedPath(p: string): boolean {
  const rel = relative(ROOT, p);
  // Rust crates (e.g. terminus-artifacts) implement the SQLite storage layer via
  // `rusqlite`, which requires SQL strings — there is no Prisma for Rust. R5
  // governs the TypeScript control plane (no raw SQL outside Prisma); Rust
  // storage crates are the legitimate low-level layer, so .rs files are exempt.
  return (
    rel.endsWith(".rs") ||
    SQL_ALLOWED_FILES.has(rel) ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".spec.ts") ||
    rel.endsWith(".test.tsx") ||
    rel.endsWith(".spec.tsx") ||
    rel.endsWith("_test.py") ||
    rel.endsWith(".test.py") ||
    rel.includes("/.venv/") ||
    rel.includes("/venv/") ||
    rel.includes("/__pycache__/") ||
    rel.includes("/site-packages/") ||
    rel.includes("/node_modules/") ||
    rel.includes("/dist/") ||
    rel.includes("/.next/") ||
    rel.includes("/build/") ||
    rel.includes("/target/")
  );
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
    // Ignored local vendor sources are not part of Terminus's first-party
    // architecture. `standalone-check` proves they are not workspace inputs.
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
// Rule 6: direct process execution forbidden in packages/*
// ───────────────────────────────────────────────────────────────────────────

// Actual process-creation sinks only. Bare `exec(`/`spawn(` must NOT be
// matched here: legitimate brokered code legitimately contains
// `kernel.exec(...)`, `port.spawn(...)` (KernelProcessPort / AdapterProcessPort),
// interface methods named exec/spawn, and `RegExp.prototype.exec`.
// Direct child_process usage is already banned by Rule 1's import ban;
// this rule catches the remaining no-static-import paths: Bun's global
// spawn APIs and dynamic imports of child_process.
const PROCESS_EXEC_PATTERNS = [
  /\bBun\.spawn(Sync)?\(/,
  /\bimport\(\s*["'](node:)?child_process["']/,
];

function checkNoDirectProcessExec(): void {
  for (const pkg of listPackages()) {
    for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) continue;
        for (const re of PROCESS_EXEC_PATTERNS) {
          if (re.test(line)) {
            violations.push({
              rule: "R6: direct process execution in packages/*",
              file: relative(ROOT, file),
              line: i + 1,
              detail: "direct process execution (exec/spawn) is forbidden in packages/*; route through kernel RPC",
            });
            break;
          }
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 7: filesystem mutation forbidden in packages/*
// ───────────────────────────────────────────────────────────────────────────

const FS_MUTATION_PATTERNS = [
  /\bwriteFileSync\(|\bunlinkSync\(|\bmkdirSync\(|\brmdirSync\(|\bcopyFileSync\(|\bappendFileSync\(/,
];

function checkNoDirectFsMutation(): void {
  for (const pkg of listPackages()) {
    if (pkg === "artifact-client") continue; // artifact client manages local cache files
    for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) continue;
        for (const re of FS_MUTATION_PATTERNS) {
          if (re.test(line)) {
            violations.push({
              rule: "R7: direct filesystem mutation in packages/*",
              file: relative(ROOT, file),
              line: i + 1,
              detail: "filesystem mutation is forbidden in packages/*; route through kernel FileService / PatchService",
            });
            break;
          }
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 8: direct socket access outside UDS connector / egress proxy
// ───────────────────────────────────────────────────────────────────────────

const SOCKET_PATTERNS = [
  /\bnet\.createConnection\(|\bnet\.connect\(|\btls\.connect\(/,
];

function checkNoDirectSocketAccess(): void {
  for (const pkg of listPackages()) {
    for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) continue;
        for (const re of SOCKET_PATTERNS) {
          if (re.test(line)) {
            violations.push({
              rule: "R8: direct socket access in packages/*",
              file: relative(ROOT, file),
              line: i + 1,
              detail: "raw socket access is forbidden; use kernel egress broker or UDS connector",
            });
            break;
          }
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 9: direct environment-secret reads outside secrets broker
// ───────────────────────────────────────────────────────────────────────────

const SECRET_ENV_PATTERNS = [
  /process\.env\.(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)/,
];

function checkNoEnvironmentSecretReads(): void {
  for (const pkg of listPackages()) {
    if (pkg === "provider-openai" || pkg === "provider-anthropic" || pkg === "provider-google") continue; // provider config defaults
    for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) continue;
        for (const re of SECRET_ENV_PATTERNS) {
          if (re.test(line)) {
            violations.push({
              rule: "R9: environment secret read in packages/*",
              file: relative(ROOT, file),
              line: i + 1,
              detail: "raw environment secret reads are forbidden; use brokered SecretService capabilities",
            });
            break;
          }
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 10: raw Git CLI effects outside crates/terminus-git
// ───────────────────────────────────────────────────────────────────────────

const RAW_GIT_PATTERNS = [
  /\bexec\s*\(\s*["'`]\s*git\s+/i,
  /\bspawn\s*\(\s*["'`]\s*git\s+/i,
];

function checkNoRawGitEffects(): void {
  for (const pkg of listPackages()) {
    for (const file of walk(join(PACKAGES_DIR, pkg, "src"))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim().startsWith("//") || line.trim().startsWith("/*") || line.trim().startsWith("*")) continue;
        for (const re of RAW_GIT_PATTERNS) {
          if (re.test(line)) {
            violations.push({
              rule: "R10: raw Git CLI execution in packages/*",
              file: relative(ROOT, file),
              line: i + 1,
              detail: "raw Git CLI execution is forbidden; use crates/terminus-git via kernel",
            });
            break;
          }
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule 11: exact packaged supervisor exception for app process execution
// ───────────────────────────────────────────────────────────────────────────

const PACKAGED_SUPERVISOR = "apps/desktop/electron/runtime-supervisor.ts";
const APP_PROCESS_PATTERNS = [
  /\bfrom\s+["'](?:node:)?child_process["']/,
  /\brequire\(["'](?:node:)?child_process["']\)/,
  /\bimport\(\s*["'](?:node:)?child_process["']\s*\)/,
  /\bBun\.spawn(?:Sync)?\(/,
];

function checkAppsProcessSupervisorBoundary(): void {
  for (const file of walk(APPS_DIR)) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    const rel = relative(ROOT, file).split("\\").join("/");
    if (rel.includes("/tests/") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
      if (rel === PACKAGED_SUPERVISOR) continue;
      if (APP_PROCESS_PATTERNS.some((pattern) => pattern.test(line))) {
        violations.push({
          rule: "R11: app process execution outside packaged supervisor",
          file: rel,
          line: index + 1,
          detail: `ADR-0039 permits direct process execution only in ${PACKAGED_SUPERVISOR}`,
        });
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("[boundary-check] running 11 SPEC §42.5 mechanical checks…");
  checkPackagesForbiddenImports();
  checkPackagesNoDeployableDeps();
  checkKernelNoUIOrProvider();
  checkDomainNoProviderSDKs();
  checkNoRawSqlOutsideRepositories();
  checkNoDirectProcessExec();
  checkNoDirectFsMutation();
  checkNoDirectSocketAccess();
  checkNoEnvironmentSecretReads();
  checkNoRawGitEffects();
  checkAppsProcessSupervisorBoundary();

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
