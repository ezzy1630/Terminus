import { describe, expect, test } from "bun:test";
import {
  discoverNativeTestRecipes,
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
