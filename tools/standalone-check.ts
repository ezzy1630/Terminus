#!/usr/bin/env bun
/**
 * Prove that the first-party runtime is independent of OpenCode.
 *
 * Historical research, design references, external eval baselines, and ignored
 * local vendor data are outside this check. The build and runtime workspace are
 * not: retired paths, imports, aliases, and dependency edges fail closed.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const violations: string[] = [];

const RETIRED_PATHS = [
  "packages/open-code-bridge",
  "upstream/opencode.lock.json",
  "upstream/divergence-budget.yaml",
  "upstream/overlays",
  "docs/architecture/opencode-retained-capabilities.md",
  "docs/runbooks/upstream-merge-conflict.md",
  "docs/security/fork-gate-report.json",
  "scripts/check-upstream-patches.sh",
  "scripts/fetch-opencode.sh",
  "scripts/pin-upstream.sh",
  "scripts/upstream-sync-ci.ts",
  "scripts/verify-opencode-parity.sh",
  "scripts/verify-upstream-divergence.py",
  "scripts/verify-upstream-pin.sh",
  "tools/codegen/fork-gate-report.ts",
] as const;

const BUILD_METADATA = [
  "package.json",
  "bun.lock",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.packages.json",
  "justfile",
  "mise.toml",
  "terminus.config.yaml",
  "maturity.yaml",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
] as const;

const FORBIDDEN_METADATA_REFERENCES = [
  "@terminus/open-code-bridge",
  "packages/open-code-bridge",
  "upstream/opencode.lock.json",
  "upstream/divergence-budget.yaml",
  "just upstream-check",
  '"node-pty"',
  '"@xterm/xterm"',
] as const;

const BUILT_ARTIFACT_ROOTS = [
  "apps/desktop/dist-electron",
  "apps/desktop/dist",
  "apps/desktop/release",
] as const;
const RETIRED_DESKTOP_MARKERS = [
  "node-pty",
  "desktopCapturer",
  "mediaDevices",
  "getUserMedia",
  "getDisplayMedia",
  "URL.createObjectURL",
  "capture:getSources",
  "capture:get-sources",
  "pty:create",
  "pty:write",
  "pty:resize",
  "pty:kill",
] as const;
const FORBIDDEN_ENTITLEMENTS = [
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.disable-libsystem-validation",
] as const;
const MAX_ARTIFACT_SCAN_BYTES = 64 * 1024 * 1024;
const PACKAGED_HISTORICAL_MIGRATION =
  /\/Contents\/Resources\/runtime\/terminus-control\/share\/terminus\/migrations\/sqlite\/\d+_[^/]+[.]sql$/;

const RUNTIME_ROOTS = [
  "src",
  "apps",
  "packages",
  "mini-services",
  "crates",
  "scripts",
  "tools",
] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs"]);
const IMPORT_PATTERN = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s*["']([^"']+)["']/g;
const FORBIDDEN_SPECIFIER =
  /(?:^|[/@._-])open[-_.]?code(?:$|[/@._-])|(?:^|[/@._-])opencode(?:$|[/@._-])/i;

const DETECTOR_FIXTURES = [
  "@terminus/open-code-bridge",
  "@terminus/open_code_bridge",
  "@terminus/open.code.bridge",
  "@terminus/opencode",
] as const;

interface PackageManifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

function fail(message: string): void {
  violations.push(message);
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function parseManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(read(path));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as PackageManifest;
}

function* walkFiles(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "release" || entry === "target" || entry === ".git") continue;
    const path = join(directory, entry);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        yield* walkFiles(path);
      } else if (stat.isFile()) {
        yield path;
      }
    } catch {
      continue;
    }
  }
}

function* walkArtifactFiles(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) yield* walkArtifactFiles(path);
      else if (stat.isFile()) yield path;
    } catch {
      continue;
    }
  }
}

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

function checkRetiredPaths(): void {
  for (const path of RETIRED_PATHS) {
    if (existsSync(join(ROOT, path))) fail(`retired path still exists: ${path}`);
  }
}

function checkDetectorCoverage(): void {
  for (const fixture of DETECTOR_FIXTURES) {
    if (!FORBIDDEN_SPECIFIER.test(fixture)) {
      fail(`standalone detector does not reject known retired spelling: ${fixture}`);
    }
  }
}

function checkBuildMetadata(): void {
  for (const path of BUILD_METADATA) {
    if (!existsSync(join(ROOT, path))) continue;
    const text = read(path);
    for (const forbidden of FORBIDDEN_METADATA_REFERENCES) {
      if (text.includes(forbidden)) fail(`${path} references retired build metadata: ${forbidden}`);
    }
  }
}

function checkDesktopEntitlements(): void {
  const path = "apps/desktop/electron/entitlements.mac.plist";
  if (!existsSync(join(ROOT, path))) return;
  const text = read(path);
  for (const entitlement of FORBIDDEN_ENTITLEMENTS) {
    if (text.includes(entitlement)) fail(`${path} retains unsupported entitlement: ${entitlement}`);
  }
}

function checkDesktopSourceMarkers(): void {
  const roots = ["apps/desktop/src", "apps/desktop/electron"] as const;
  for (const root of roots) {
    for (const absolutePath of walkFiles(join(ROOT, root))) {
      if (!SOURCE_EXTENSIONS.has(extension(absolutePath))) continue;
      const text = readFileSync(absolutePath, "utf8");
      for (const marker of RETIRED_DESKTOP_MARKERS) {
        if (text.includes(marker)) {
          fail(`desktop source retains retired local-effect marker ${marker}: ${relative(ROOT, absolutePath)}`);
        }
      }
    }
  }
}

function checkBuiltDesktopArtifacts(): void {
  for (const root of BUILT_ARTIFACT_ROOTS) {
    for (const absolutePath of walkArtifactFiles(join(ROOT, root))) {
      const relativePath = relative(ROOT, absolutePath);
      const lowerPath = relativePath.toLowerCase();
      if (lowerPath.includes("node-pty") || lowerPath.includes("pty.node") || lowerPath.includes("@xterm")) {
        fail(`built desktop artifact retains retired native/runtime path: ${relativePath}`);
      }
      const size = statSync(absolutePath).size;
      if (size > MAX_ARTIFACT_SCAN_BYTES) continue;
      const text = readFileSync(absolutePath).toString("latin1");
      for (const marker of RETIRED_DESKTOP_MARKERS) {
        if (text.includes(marker)) fail(`built desktop artifact retains retired bridge marker ${marker}: ${relativePath}`);
      }
      // Applied SQL migrations are immutable compatibility history. A legacy
      // data value is not an executable dependency; imports, manifests, and
      // all other packaged runtime files remain fail-closed below.
      if (FORBIDDEN_SPECIFIER.test(text) && !PACKAGED_HISTORICAL_MIGRATION.test(relativePath)) {
        fail(`built desktop artifact retains retired OpenCode runtime marker: ${relativePath}`);
      }
    }
  }

  const mainBundle = "apps/desktop/dist-electron/main.js";
  if (existsSync(join(ROOT, mainBundle))) {
    const text = read(mainBundle);
    for (const invariant of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"] as const) {
      if (!text.includes(invariant)) fail(`${mainBundle} is not a current hardened build; missing ${invariant}`);
    }
  }

  const rendererDocument = "apps/desktop/dist/index.html";
  if (existsSync(join(ROOT, rendererDocument))) {
    const text = read(rendererDocument);
    for (const forbidden of ["__TERMINUS_CONNECT_SOURCES__", "ws://localhost:5173", "http://localhost:5173"] as const) {
      if (text.includes(forbidden)) fail(`${rendererDocument} retains a development CSP source: ${forbidden}`);
    }
  }
}

function checkRuntimeImports(): void {
  for (const root of RUNTIME_ROOTS) {
    for (const absolutePath of walkFiles(join(ROOT, root))) {
      if (!SOURCE_EXTENSIONS.has(extension(absolutePath))) continue;
      const text = readFileSync(absolutePath, "utf8");
      if (absolutePath.endsWith(".rs")) {
        for (const line of text.split("\n")) {
          if (/^\s*(?:use|extern\s+crate)\s+/.test(line) && FORBIDDEN_SPECIFIER.test(line)) {
            fail(`${relative(ROOT, absolutePath)} imports retired Rust runtime code: ${line.trim()}`);
          }
        }
        continue;
      }
      for (const match of text.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (specifier && FORBIDDEN_SPECIFIER.test(specifier)) {
          fail(`${relative(ROOT, absolutePath)} imports retired runtime code: ${specifier}`);
        }
      }
      for (const match of text.matchAll(SIDE_EFFECT_IMPORT_PATTERN)) {
        const specifier = match[1];
        if (specifier && FORBIDDEN_SPECIFIER.test(specifier)) {
          fail(`${relative(ROOT, absolutePath)} imports retired runtime code: ${specifier}`);
        }
      }
    }
  }
}

function checkRuntimeDependencyMetadata(): void {
  const paths = [join(ROOT, "Cargo.toml"), join(ROOT, "Cargo.lock")];
  for (const root of RUNTIME_ROOTS) {
    for (const absolutePath of walkFiles(join(ROOT, root))) {
      const name = basename(absolutePath);
      if (name === "Cargo.toml" || (name.startsWith("tsconfig") && name.endsWith(".json"))) {
        paths.push(absolutePath);
      }
    }
  }

  for (const absolutePath of paths) {
    if (!existsSync(absolutePath)) continue;
    for (const line of readFileSync(absolutePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      if (FORBIDDEN_SPECIFIER.test(line)) {
        fail(`${relative(ROOT, absolutePath)} declares retired dependency metadata: ${trimmed}`);
      }
    }
  }
}

function checkWorkspaceDependencies(): void {
  const manifestPaths = ["package.json"];
  for (const root of RUNTIME_ROOTS) {
    for (const absolutePath of walkFiles(join(ROOT, root))) {
      if (absolutePath.endsWith("/package.json")) manifestPaths.push(relative(ROOT, absolutePath));
    }
  }

  for (const path of manifestPaths) {
    const manifest = parseManifest(path);
    if (manifest.name && FORBIDDEN_SPECIFIER.test(manifest.name)) {
      fail(`${path} declares retired package name: ${manifest.name}`);
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const dependencies = manifest[field] ?? {};
      for (const [name, version] of Object.entries(dependencies)) {
        if (FORBIDDEN_SPECIFIER.test(name) || FORBIDDEN_SPECIFIER.test(version)) {
          fail(`${path} ${field} declares retired dependency: ${name}@${version}`);
        }
      }
    }
  }
}

function requirePackageName(path: string, expected: string): PackageManifest {
  const manifest = parseManifest(path);
  if (manifest.name !== expected) fail(`${path} must be owned as ${expected}, found ${manifest.name ?? "no name"}`);
  return manifest;
}

function requireDependency(path: string, manifest: PackageManifest, dependency: string): void {
  if (manifest.dependencies?.[dependency] !== "workspace:*") {
    fail(`${path} must depend directly on ${dependency}@workspace:*`);
  }
}

function requireSourceExport(path: string, fragment: string): void {
  if (!read(path).includes(fragment)) fail(`${path} must export ${fragment}`);
}

function checkDirectOwnership(): void {
  const protocol = requirePackageName("packages/runtime-protocol/package.json", "@terminus/runtime-protocol");
  requireDependency("packages/runtime-protocol/package.json", protocol, "@terminus/domain");
  requireSourceExport("packages/runtime-protocol/src/index.ts", '"./v2_commands.js"');
  requireSourceExport("packages/runtime-protocol/src/index.ts", '"./v2_events.js"');

  const publicApi = requirePackageName("packages/public-api/package.json", "@terminus/public-api");
  requireDependency("packages/public-api/package.json", publicApi, "@terminus/runtime-protocol");
  requireSourceExport("packages/public-api/src/index.ts", '"./v2_endpoints.js"');

  const publicClient = requirePackageName("packages/public-client/package.json", "@terminus/public-client");
  requireDependency("packages/public-client/package.json", publicClient, "@terminus/public-api");

  const clientSource = read("packages/public-client/src/index.ts");
  if (!clientSource.includes('from "@terminus/public-api"')) {
    fail("packages/public-client/src/index.ts must use the Terminus public API directly");
  }
}

function main(): void {
  checkDetectorCoverage();
  checkRetiredPaths();
  checkBuildMetadata();
  checkDesktopEntitlements();
  checkDesktopSourceMarkers();
  checkRuntimeImports();
  checkRuntimeDependencyMetadata();
  checkWorkspaceDependencies();
  checkDirectOwnership();
  checkBuiltDesktopArtifacts();

  if (violations.length > 0) {
    console.error(`[standalone-check] ${violations.length} violation(s) found:`);
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }

  console.log("[standalone-check] OK");
  console.log("  retired OpenCode source and tooling paths are absent");
  console.log("  first-party runtime imports and workspace dependencies are independent");
  console.log("  present desktop build/package artifacts contain no retired PTY, capture, or OpenCode bridge markers");
  console.log("  @terminus/runtime-protocol -> @terminus/public-api -> @terminus/public-client is explicit");
}

main();
