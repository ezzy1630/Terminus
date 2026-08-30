/**
 * Pure discovery of repository-native verification recipes.
 *
 * Callers must supply complete file observations obtained through the kernel
 * read boundary. This module never opens files, executes scripts, or treats a
 * repository-provided command body as an executable command. It only emits
 * canonical invocations for a small, allow-listed set of recipe names.
 */

export const REPOSITORY_SIGNAL_PATHS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Justfile",
  "justfile",
  "Makefile",
  "makefile",
  "Cargo.toml",
  "pyproject.toml",
  "uv.lock",
  // Plain pytest layouts: a repository can be fully testable with none of the
  // manifests above (the internal eval fixtures are), and the planner then
  // reported "no test runner detected" while the task said `pytest -q`.
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "conftest.py",
  "go.mod",
  "Taskfile.yml",
  "Taskfile.yaml",
] as const;

const MAX_NATIVE_RECIPES = 12;
const SAFE_RECIPE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;
const NATIVE_RECIPE_NAME = /^(?:test|tests|check|verify|validation|ci)(?:$|[_.:@/-])/i;

export interface RepositoryFileObservation {
  readonly path: string;
  readonly content: string;
  readonly sourceVersion: string;
}

export interface NativeTestRecipe {
  readonly command: string;
  readonly recipeName: string;
  readonly sourcePath: string;
  readonly sourceVersion: string;
}

export interface NativeRecipeDiscovery {
  readonly recipes: readonly NativeTestRecipe[];
  readonly nativeTestCommands: readonly string[];
  readonly nativeRecipeSources: readonly string[];
  readonly nativeRecipeSourceVersions: readonly string[];
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRecipeName(value: string): boolean {
  return SAFE_RECIPE_NAME.test(value) && NATIVE_RECIPE_NAME.test(value);
}

function isNativeRecipeName(value: string): boolean {
  return isSafeRecipeName(value);
}

function parseJsonRecord(content: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function packageManager(
  packageJson: JsonRecord,
  observedPaths: ReadonlySet<string>,
): "bun" | "pnpm" | "yarn" | "npm" {
  const declared = packageJson.packageManager;
  if (typeof declared === "string") {
    const manager = /^(bun|pnpm|yarn|npm)(?:@|$)/.exec(declared.trim())?.[1];
    if (manager === "bun" || manager === "pnpm" || manager === "yarn" || manager === "npm") {
      return manager;
    }
  }
  if (observedPaths.has("bun.lock") || observedPaths.has("bun.lockb")) return "bun";
  if (observedPaths.has("pnpm-lock.yaml")) return "pnpm";
  if (observedPaths.has("yarn.lock")) return "yarn";
  return "npm";
}

function packageCommand(manager: "bun" | "pnpm" | "yarn" | "npm", name: string): string {
  return manager === "yarn" ? `yarn ${name}` : `${manager} run ${name}`;
}

function packageRecipes(
  observation: RepositoryFileObservation,
  observedPaths: ReadonlySet<string>,
): readonly NativeTestRecipe[] {
  const packageJson = parseJsonRecord(observation.content);
  if (packageJson === null) return [];
  const scripts = packageJson.scripts;
  if (!isRecord(scripts)) return [];
  const manager = packageManager(packageJson, observedPaths);
  return Object.keys(scripts)
    .filter((recipeName) => isNativeRecipeName(recipeName) && typeof scripts[recipeName] === "string")
    .sort()
    .map((recipeName) => ({
      command: packageCommand(manager, recipeName),
      recipeName,
      sourcePath: observation.path,
      sourceVersion: observation.sourceVersion,
    }));
}

function declaredRecipeNames(content: string): readonly string[] {
  const names: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.includes(":=")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.:@/-]*)(?:\s+[^:]+)?\s*:/.exec(trimmed);
    const recipeName = match?.[1];
    if (recipeName !== undefined && isNativeRecipeName(recipeName)) names.push(recipeName);
  }
  return [...new Set(names)].sort();
}

function makeRecipes(
  observation: RepositoryFileObservation,
  command: "just" | "make",
): readonly NativeTestRecipe[] {
  return declaredRecipeNames(observation.content).map((recipeName) => ({
    command: `${command} ${recipeName}`,
    recipeName,
    sourcePath: observation.path,
    sourceVersion: observation.sourceVersion,
  }));
}

function hasTomlSection(content: string, section: RegExp): boolean {
  return content.split(/\r?\n/).some((line) => section.test(line.trim()));
}

function cargoRecipes(observation: RepositoryFileObservation): readonly NativeTestRecipe[] {
  if (!hasTomlSection(observation.content, /^\[(?:package|workspace)\]$/)) return [];
  return [{
    command: "cargo test",
    recipeName: "cargo-test",
    sourcePath: observation.path,
    sourceVersion: observation.sourceVersion,
  }];
}

function pythonRecipes(
  observation: RepositoryFileObservation,
  observedPaths: ReadonlySet<string>,
): readonly NativeTestRecipe[] {
  const hasProject = hasTomlSection(observation.content, /^\[project\]$/);
  const hasPytest = hasTomlSection(observation.content, /^\[tool\.pytest(?:\.[A-Za-z0-9_.-]+)?\]$/);
  const hasUv = hasTomlSection(observation.content, /^\[tool\.uv(?:\.[A-Za-z0-9_.-]+)?\]$/);
  if (!hasProject && !hasPytest && !hasUv) return [];
  const command = observedPaths.has("uv.lock") ? "uv run pytest" : "python -m pytest";
  return [{ command, recipeName: "pytest", sourcePath: observation.path, sourceVersion: observation.sourceVersion }];
}

/**
 * Whether a pytest-family configuration file actually configures pytest.
 * `pytest.ini` and `conftest.py` exist for no other reason; `tox.ini` and
 * `setup.cfg` are shared with other tools and only count when they carry a
 * `[pytest]` / `[tool:pytest]` section.
 */
export function configuresPytest(observation: RepositoryFileObservation): boolean {
  switch (observation.path) {
    case "pytest.ini":
    case "conftest.py":
      return true;
    case "tox.ini":
    case "setup.cfg":
      return /^\s*\[(?:pytest|tool:pytest)\]\s*$/m.test(observation.content);
    default:
      return false;
  }
}

function goRecipes(observation: RepositoryFileObservation): readonly NativeTestRecipe[] {
  if (!/^\s*module\s+\S+/m.test(observation.content)) return [];
  return [{
    command: "go test ./...",
    recipeName: "go-test",
    sourcePath: observation.path,
    sourceVersion: observation.sourceVersion,
  }];
}

function taskRecipes(observation: RepositoryFileObservation): readonly NativeTestRecipe[] {
  const names: string[] = [];
  let inTasks = false;
  for (const line of observation.content.split(/\r?\n/)) {
    if (/^tasks\s*:\s*(?:#.*)?$/.test(line.trim())) {
      inTasks = true;
      continue;
    }
    if (!inTasks) continue;
    const task = /^\s{2}([A-Za-z0-9][A-Za-z0-9_.:@/-]*)\s*:\s*(?:#.*)?$/.exec(line);
    if (task?.[1] !== undefined && isNativeRecipeName(task[1])) names.push(task[1]);
    if (/^\S/.test(line) && line.trim().length > 0 && !/^tasks\s*:/.test(line)) inTasks = false;
  }
  return [...new Set(names)].sort().map((recipeName) => ({
    command: `task ${recipeName}`,
    recipeName,
    sourcePath: observation.path,
    sourceVersion: observation.sourceVersion,
  }));
}

function recipesForObservation(
  observation: RepositoryFileObservation,
  observedPaths: ReadonlySet<string>,
): readonly NativeTestRecipe[] {
  switch (observation.path) {
    case "package.json":
      return packageRecipes(observation, observedPaths);
    case "Justfile":
    case "justfile":
      return makeRecipes(observation, "just");
    case "Makefile":
    case "makefile":
      return makeRecipes(observation, "make");
    case "Cargo.toml":
      return cargoRecipes(observation);
    case "pyproject.toml":
      return pythonRecipes(observation, observedPaths);
    case "pytest.ini":
    case "tox.ini":
    case "setup.cfg":
    case "conftest.py":
      if (!configuresPytest(observation)) return [];
      return [{
        command: observedPaths.has("uv.lock") ? "uv run pytest" : "python -m pytest",
        recipeName: "pytest",
        sourcePath: observation.path,
        sourceVersion: observation.sourceVersion,
      }];
    case "go.mod":
      return goRecipes(observation);
    case "Taskfile.yml":
    case "Taskfile.yaml":
      return taskRecipes(observation);
    default:
      return [];
  }
}

/** Discover bounded, canonical repository-native checks from complete reads. */
export function discoverNativeTestRecipes(
  observations: readonly RepositoryFileObservation[],
): NativeRecipeDiscovery {
  const observedPaths = new Set(observations.map((observation) => observation.path));
  const sortedObservations = [...observations].sort((left, right) => left.path.localeCompare(right.path));
  const allRecipes = sortedObservations
    .flatMap((observation) => recipesForObservation(observation, observedPaths))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.command.localeCompare(right.command));
  const recipes: NativeTestRecipe[] = [];
  const commands = new Set<string>();
  for (const recipe of allRecipes) {
    if (commands.has(recipe.command)) continue;
    commands.add(recipe.command);
    recipes.push(recipe);
    if (recipes.length === MAX_NATIVE_RECIPES) break;
  }
  return {
    recipes,
    nativeTestCommands: recipes.map((recipe) => recipe.command),
    nativeRecipeSources: [...new Set(recipes.map((recipe) => recipe.sourcePath))].sort(),
    nativeRecipeSourceVersions: [...new Set(recipes.map((recipe) => `${recipe.sourcePath}=${recipe.sourceVersion}`))].sort(),
  };
}


// ───────────────────── Verification runner detection (H3) ───────────────────
//
// `discoverNativeTestRecipes` above answers "which repository-native checks
// exist?" for prompt context. Verification needs a narrower question: "which
// concrete command implements *this* predicate?" A hardcoded `just <recipe>`
// fails on every repository without a justfile, so the mapping is derived from
// the same complete kernel reads.

/** Predicate-facing runner roles a repository can implement. */
export const VERIFICATION_RUNNER_KINDS = [
  "test",
  "unit_test",
  "integration_test",
  "e2e_test",
  "lint",
  "typecheck",
  "format",
  "codegen_check",
  "security",
] as const;

export type VerificationRunnerKind = (typeof VERIFICATION_RUNNER_KINDS)[number];

export interface VerificationRunner {
  readonly kind: VerificationRunnerKind;
  readonly command: string;
  readonly sourcePath: string;
  readonly sourceVersion: string;
}

export type VerificationRunnerCatalog = Readonly<Partial<Record<VerificationRunnerKind, VerificationRunner>>>;

/**
 * Source precedence. A repository-owned task runner (justfile/Makefile) states
 * the maintainers' canonical entry point, so it wins over the package manager
 * script it usually wraps.
 */
const RUNNER_SOURCE_PRIORITY: readonly string[] = [
  "justfile",
  "Justfile",
  "Makefile",
  "makefile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
];

/**
 * Script/recipe names per runner kind, most specific first. Matching is exact
 * and case-insensitive: no substring guessing, because an unintended match
 * would run an arbitrary repository command under verification authority.
 */
const RUNNER_NAME_CANDIDATES: Readonly<Record<VerificationRunnerKind, readonly string[]>> = {
  test: ["test", "tests"],
  unit_test: ["test:unit", "test-unit", "unit-test", "unit"],
  integration_test: ["test:integration", "test-integration", "integration-test", "integration"],
  e2e_test: ["test:e2e", "test-e2e", "e2e-test", "e2e"],
  lint: ["lint", "lint:check", "lint-check", "check:lint"],
  typecheck: ["typecheck", "type-check", "types", "tsc", "check"],
  format: ["format:check", "format-check", "fmt:check", "fmt-check", "check:format"],
  codegen_check: ["codegen-check", "codegen:check", "generate-check"],
  security: ["security", "audit", "security-scan"],
};

function namedRunner(
  names: ReadonlySet<string>,
  toCommand: (name: string) => string,
  observation: RepositoryFileObservation,
): Partial<Record<VerificationRunnerKind, VerificationRunner>> {
  const lowered = new Map<string, string>();
  for (const name of names) lowered.set(name.toLowerCase(), name);
  const found: Partial<Record<VerificationRunnerKind, VerificationRunner>> = {};
  for (const kind of VERIFICATION_RUNNER_KINDS) {
    for (const candidate of RUNNER_NAME_CANDIDATES[kind]) {
      const actual = lowered.get(candidate);
      if (actual === undefined) continue;
      if (!SAFE_RECIPE_NAME.test(actual)) continue;
      found[kind] = {
        kind,
        command: toCommand(actual),
        sourcePath: observation.path,
        sourceVersion: observation.sourceVersion,
      };
      break;
    }
  }
  return found;
}

/** Recipe/target names declared by a justfile or Makefile, unfiltered by role. */
function allDeclaredRecipeNames(content: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.includes(":=")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.:@/-]*)(?:\s+[^:]+)?\s*:/.exec(trimmed);
    const recipeName = match?.[1];
    if (recipeName !== undefined && SAFE_RECIPE_NAME.test(recipeName)) names.add(recipeName);
  }
  return names;
}

function allTaskfileNames(content: string): ReadonlySet<string> {
  const names = new Set<string>();
  let inTasks = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^tasks\s*:\s*(?:#.*)?$/.test(line.trim())) {
      inTasks = true;
      continue;
    }
    if (!inTasks) continue;
    const task = /^\s{2}([A-Za-z0-9][A-Za-z0-9_.:@/-]*)\s*:\s*(?:#.*)?$/.exec(line);
    if (task?.[1] !== undefined && SAFE_RECIPE_NAME.test(task[1])) names.add(task[1]);
    if (/^\S/.test(line) && line.trim().length > 0 && !/^tasks\s*:/.test(line)) inTasks = false;
  }
  return names;
}

function runnersForObservation(
  observation: RepositoryFileObservation,
  observedPaths: ReadonlySet<string>,
): Partial<Record<VerificationRunnerKind, VerificationRunner>> {
  const fixed = (
    entries: Partial<Record<VerificationRunnerKind, string>>,
  ): Partial<Record<VerificationRunnerKind, VerificationRunner>> => {
    const output: Partial<Record<VerificationRunnerKind, VerificationRunner>> = {};
    for (const [kind, command] of Object.entries(entries)) {
      if (command === undefined) continue;
      output[kind as VerificationRunnerKind] = {
        kind: kind as VerificationRunnerKind,
        command,
        sourcePath: observation.path,
        sourceVersion: observation.sourceVersion,
      };
    }
    return output;
  };
  switch (observation.path) {
    case "package.json": {
      const packageJson = parseJsonRecord(observation.content);
      if (packageJson === null) return {};
      const scripts = packageJson.scripts;
      if (!isRecord(scripts)) return {};
      const manager = packageManager(packageJson, observedPaths);
      const names = new Set(
        Object.keys(scripts).filter((name) => typeof scripts[name] === "string"),
      );
      return namedRunner(names, (name) => packageCommand(manager, name), observation);
    }
    case "Justfile":
    case "justfile":
      return namedRunner(allDeclaredRecipeNames(observation.content), (name) => `just ${name}`, observation);
    case "Makefile":
    case "makefile":
      return namedRunner(allDeclaredRecipeNames(observation.content), (name) => `make ${name}`, observation);
    case "Taskfile.yml":
    case "Taskfile.yaml":
      return namedRunner(allTaskfileNames(observation.content), (name) => `task ${name}`, observation);
    case "Cargo.toml":
      if (!hasTomlSection(observation.content, /^\[(?:package|workspace)\]$/)) return {};
      return fixed({
        test: "cargo test",
        unit_test: "cargo test --lib",
        typecheck: "cargo check --all-targets",
        format: "cargo fmt --check",
      });
    case "pyproject.toml": {
      const hasProject = hasTomlSection(observation.content, /^\[project\]$/);
      const hasPytest = hasTomlSection(observation.content, /^\[tool\.pytest(?:\.[A-Za-z0-9_.-]+)?\]$/);
      const hasUv = hasTomlSection(observation.content, /^\[tool\.uv(?:\.[A-Za-z0-9_.-]+)?\]$/);
      if (!hasProject && !hasPytest && !hasUv) return {};
      const prefix = observedPaths.has("uv.lock") ? "uv run " : "python -m ";
      return fixed({ test: `${prefix}pytest`, unit_test: `${prefix}pytest` });
    }
    case "pytest.ini":
    case "tox.ini":
    case "setup.cfg":
    case "conftest.py": {
      if (!configuresPytest(observation)) return {};
      const prefix = observedPaths.has("uv.lock") ? "uv run " : "python -m ";
      return fixed({ test: `${prefix}pytest`, unit_test: `${prefix}pytest` });
    }
    case "go.mod":
      if (!/^\s*module\s+\S+/m.test(observation.content)) return {};
      return fixed({ test: "go test ./...", unit_test: "go test ./...", typecheck: "go build ./..." });
    default:
      return {};
  }
}

/**
 * Resolve which concrete command implements each verification runner role.
 * Absent roles are absent: the caller must report `skipped` with the reason,
 * never a synthesized command that will fail.
 */
export function discoverVerificationRunners(
  observations: readonly RepositoryFileObservation[],
): VerificationRunnerCatalog {
  const observedPaths = new Set(observations.map((observation) => observation.path));
  const ordered = [...observations].sort((left, right) => {
    const leftRank = RUNNER_SOURCE_PRIORITY.indexOf(left.path);
    const rightRank = RUNNER_SOURCE_PRIORITY.indexOf(right.path);
    return (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank)
      - (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank);
  });
  const catalog: Partial<Record<VerificationRunnerKind, VerificationRunner>> = {};
  for (const observation of ordered) {
    for (const [kind, runner] of Object.entries(runnersForObservation(observation, observedPaths))) {
      const key = kind as VerificationRunnerKind;
      if (catalog[key] === undefined && runner !== undefined) catalog[key] = runner;
    }
  }
  return catalog;
}

// ─────────────────── Task-scoped repository map selection ────────────────────

/**
 * Token ceiling for the repository-map fragment.
 *
 * Measured 2026-08-29: the map shipped 16–18k tokens per attempt — the
 * alphabetically-first 200 indexed files, with a symbol extractor that skips
 * `export function/class/const`, so most lines were a bare path. It was
 * recompiled on every attempt, it was never ranked against the task, and no
 * eval has ever shown it helps. Phase 1 replaces it with retrieval; until
 * then it is capped and ranked so it costs about 1.5k instead of 18k.
 */
export const REPOSITORY_MAP_TOKEN_BUDGET = 1_500;

/** Bytes per token used to size the map. Matches the calibrated estimator. */
const REPOSITORY_MAP_BYTES_PER_TOKEN = 3.6;

export interface RepositoryMapSelectionEntry {
  readonly path: string;
  readonly symbols: readonly string[];
}

export interface RepositoryMapSelection {
  readonly entries: readonly RepositoryMapSelectionEntry[];
  readonly omittedEntries: number;
}

/** Normalize a contract scope pattern to the literal directory prefix it fixes. */
function scopePrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const wildcardIndex = segments.findIndex((segment) => /[*?[\]]/.test(segment));
  const prefix = wildcardIndex >= 0 ? segments.slice(0, wildcardIndex) : segments;
  return prefix.join("/");
}

/**
 * Rank and cap the repository map for one task.
 *
 * Files inside the contract's allowed scope come first (write paths ahead of
 * read paths — those are the files the task is actually about), then
 * everything else in the index's own order. Entries are admitted until the
 * rendered lines reach {@link REPOSITORY_MAP_TOKEN_BUDGET}; the caller
 * reports the remainder as omitted so the model knows to search rather than
 * assume the list is complete.
 *
 * `**` collapses to an empty prefix, which matches everything — that is the
 * common case and it degrades to "index order, capped", never to "nothing".
 */
export function selectTaskScopedRepositoryMap(
  entries: readonly RepositoryMapSelectionEntry[],
  options: {
    readonly writePaths?: readonly string[] | undefined;
    readonly readPaths?: readonly string[] | undefined;
    readonly tokenBudget?: number | undefined;
  } = {},
): RepositoryMapSelection {
  const budget = options.tokenBudget ?? REPOSITORY_MAP_TOKEN_BUDGET;
  const writePrefixes = (options.writePaths ?? []).map(scopePrefix).filter((prefix) => prefix.length > 0);
  const readPrefixes = (options.readPaths ?? []).map(scopePrefix).filter((prefix) => prefix.length > 0);
  const rank = (path: string): number => {
    if (writePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return 0;
    if (readPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return 1;
    return 2;
  };
  const ranked = entries
    .map((entry, index) => ({ entry, rank: rank(entry.path), index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index);

  const budgetBytes = Math.max(0, Math.floor(budget * REPOSITORY_MAP_BYTES_PER_TOKEN));
  const selected: RepositoryMapSelectionEntry[] = [];
  let usedBytes = 0;
  for (const candidate of ranked) {
    const line = candidate.entry.symbols.length === 0
      ? candidate.entry.path
      : `${candidate.entry.path}: ${candidate.entry.symbols.join(", ")}`;
    const lineBytes = new TextEncoder().encode(line).byteLength + 1;
    if (usedBytes + lineBytes > budgetBytes && selected.length > 0) break;
    selected.push(candidate.entry);
    usedBytes += lineBytes;
  }
  return { entries: selected, omittedEntries: Math.max(0, entries.length - selected.length) };
}
