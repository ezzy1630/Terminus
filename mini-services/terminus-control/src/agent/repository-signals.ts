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
