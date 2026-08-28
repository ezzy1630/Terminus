import { describe, expect, test } from "bun:test";
import {
  discoverNativeTestRecipes,
  discoverVerificationRunners,
  type RepositoryFileObservation,
} from "./repository-signals.js";

function observation(path: string, content: string): RepositoryFileObservation {
  return { path, content, sourceVersion: `sha256:${path}` };
}

describe("repository-native recipe discovery", () => {
  test("uses the declared package manager and ignores non-check scripts", () => {
    const result = discoverNativeTestRecipes([
      observation("package.json", JSON.stringify({
        packageManager: "bun@1.2.3",
        scripts: { build: "rm -rf dist", test: "bun test", "test:unit": "bun test" },
      })),
      observation("package-lock.json", "{}"),
    ]);

    expect(result.nativeTestCommands).toEqual(["bun run test", "bun run test:unit"]);
    expect(result.nativeRecipeSources).toEqual(["package.json"]);
    expect(result.nativeRecipeSourceVersions).toEqual(["package.json=sha256:package.json"]);
  });

  test("discovers bounded recipes across native project formats", () => {
    const result = discoverNativeTestRecipes([
      observation("Cargo.toml", "[package]\nname = \"demo\"\n"),
      observation("Justfile", "test:\n  cargo test\ncheck-all: test\n  just test\nbuild:\n  cargo build\n"),
      observation("pyproject.toml", "[project]\nname = \"demo\"\n"),
      observation("uv.lock", "version = 1\n"),
      observation("go.mod", "module example.test/demo\n\ngo 1.23\n"),
      observation("Taskfile.yml", "version: '3'\ntasks:\n  test:\n    cmds: []\n  deploy:\n    cmds: []\n"),
    ]);

    expect(result.nativeTestCommands).toEqual([
      "cargo test",
      "go test ./...",
      "just check-all",
      "just test",
      "uv run pytest",
      "task test",
    ]);
  });

  test("malformed configuration and unsafe recipe names fail closed", () => {
    const result = discoverNativeTestRecipes([
      observation("package.json", "{not json"),
      observation("Justfile", "test; rm -rf /:\n\tunsafe\nbuild:\n\ttrue\n"),
      observation("Taskfile.yml", "tasks:\n  test\n"),
    ]);

    expect(result.nativeTestCommands).toEqual([]);
  });

  test("deduplicates commands and caps output deterministically", () => {
    const scripts = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`test:${String(index).padStart(2, "0")}`, "bun test"]),
    );
    const result = discoverNativeTestRecipes([
      observation("package.json", JSON.stringify({ scripts })),
      observation("Justfile", "test:\n\ttrue\n"),
    ]);

    expect(result.nativeTestCommands).toHaveLength(12);
    expect(result.nativeTestCommands[0]).toBe("just test");
    expect(new Set(result.nativeTestCommands).size).toBe(12);
  });
});

describe("H3 verification runner discovery", () => {
  test("a plain npm repository yields test/lint/typecheck commands", () => {
    const catalog = discoverVerificationRunners([
      observation("package.json", JSON.stringify({
        scripts: { test: "jest", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" },
      })),
    ]);
    expect(catalog.test?.command).toBe("npm run test");
    expect(catalog.lint?.command).toBe("npm run lint");
    expect(catalog.typecheck?.command).toBe("npm run typecheck");
    expect(catalog.e2e_test).toBeUndefined();
  });

  test("the declared package manager is honored", () => {
    const catalog = discoverVerificationRunners([
      observation("package.json", JSON.stringify({
        packageManager: "bun@1.2.3",
        scripts: { test: "bun test", "test:e2e": "playwright test" },
      })),
    ]);
    expect(catalog.test?.command).toBe("bun run test");
    expect(catalog.e2e_test?.command).toBe("bun run test:e2e");
  });

  test("a justfile wins over the package script it wraps", () => {
    const catalog = discoverVerificationRunners([
      observation("package.json", JSON.stringify({ scripts: { test: "vitest" } })),
      observation("justfile", "test:\n\tcargo test\ncheck:\n\tcargo check\n"),
    ]);
    expect(catalog.test?.command).toBe("just test");
    expect(catalog.test?.sourcePath).toBe("justfile");
    expect(catalog.typecheck?.command).toBe("just check");
  });

  test("cargo, pytest and go repositories are detected without any script file", () => {
    expect(discoverVerificationRunners([observation("Cargo.toml", "[package]\nname = \"x\"\n")]).test?.command)
      .toBe("cargo test");
    expect(discoverVerificationRunners([
      observation("pyproject.toml", "[project]\nname = \"x\"\n"),
    ]).test?.command).toBe("python -m pytest");
    expect(discoverVerificationRunners([
      observation("pyproject.toml", "[project]\nname = \"x\"\n"),
      observation("uv.lock", ""),
    ]).test?.command).toBe("uv run pytest");
    expect(discoverVerificationRunners([observation("go.mod", "module example.com/x\n")]).test?.command)
      .toBe("go test ./...");
  });

  test("a repository with no runner yields an empty catalog", () => {
    expect(discoverVerificationRunners([])).toEqual({});
    expect(discoverVerificationRunners([observation("package.json", "{}")])).toEqual({});
    expect(discoverVerificationRunners([observation("package.json", "not json")])).toEqual({});
  });

  test("only allow-listed recipe names are turned into commands", () => {
    const catalog = discoverVerificationRunners([
      observation("Makefile", "deploy-prod:\n\t./deploy.sh\ntest:\n\t./run-tests.sh\n"),
    ]);
    expect(catalog.test?.command).toBe("make test");
    expect(Object.values(catalog).every((runner) => !runner.command.includes("deploy"))).toBe(true);
  });
});
