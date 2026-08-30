import { describe, expect, test } from "bun:test";
import { computeContentHash } from "@terminus/context-ir";
import {
  EXCLUDED_INSTRUCTION_DIRECTORY_SEGMENTS,
  discoverInstructions,
  instructionCandidateDirectories,
  instructionsToFragments,
  isExcludedInstructionPath,
  resolveInstructionPrecedence,
} from "./project-instructions.js";

describe("project instruction provenance and precedence", () => {
  test("rejects a sibling whose path only shares the workspace prefix", () => {
    const discovered = discoverInstructions(
      {
        workspaceRoot: "/workspace/foo",
        workingDirectory: "/workspace/foo2/src",
        filenames: ["AGENTS.md"],
      },
      () => "outside rules",
    );
    expect(discovered).toEqual([]);
  });

  test("hashes the complete source before applying the bounded content view", () => {
    const raw = "A".repeat(100);
    const discovered = discoverInstructions(
      {
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace",
        filenames: ["AGENTS.md"],
        maxBytes: 20,
      },
      (path) => path === "/workspace/AGENTS.md" ? raw : null,
    );
    expect(discovered[0]?.sourceVersion).toBe(computeContentHash(raw));
    expect(discovered[0]?.content).toContain("TRUNCATION");
    expect(discovered[0]?.content).not.toBe(raw);
  });

  test("resolves duplicate directives by explicit path precedence and reports conflicts", () => {
    const fragments = instructionsToFragments({
      instructions: [
        {
          directory: "/src",
          filename: "AGENTS.md",
          path: "/workspace/src/AGENTS.md",
          precedence: 200,
          content: "run_tests: child\nshared: child\n",
          sourceVersion: "sha256:child",
        },
        {
          directory: "/",
          filename: "AGENTS.md",
          path: "/workspace/AGENTS.md",
          precedence: 100,
          content: "run_tests: root\nshared: root\n",
          sourceVersion: "sha256:root",
        },
      ],
      observedAt: "2026-08-27T00:00:00.000Z" as never,
      workspaceId: null,
      sessionId: null,
      taskId: null,
      modelKey: "test/model",
    });
    const resolved = resolveInstructionPrecedence(fragments, [
      "/workspace/src/AGENTS.md",
      "/workspace/AGENTS.md",
    ]);
    expect(resolved.fragments).toHaveLength(1);
    expect(resolved.fragments[0]?.textContent).toBe("run_tests: child\nshared: child\n");
    expect(resolved.fragments[0]?.sourceVersion).toBe("sha256:child");
    expect(resolved.conflicts.map((conflict) => conflict.directive)).toEqual(["run_tests", "shared"]);
    expect(resolved.conflicts.every((conflict) => conflict.winner === fragments[0]?.id)).toBe(true);
  });
});

describe("vendored instruction files are never promoted into the prefix", () => {
  test("the excluded segment set is exactly node_modules, vendor and .git", () => {
    expect([...EXCLUDED_INSTRUCTION_DIRECTORY_SEGMENTS].sort())
      .toEqual([".git", "node_modules", "vendor"]);
  });

  test("classifies vendored paths, at any depth, in either slash style", () => {
    for (const path of [
      "vendor",
      "vendor/opencode",
      "vendor/opencode/packages/llm",
      "node_modules/@scope/pkg",
      "packages/app/node_modules/dep",
      ".git/hooks",
      "packages\\app\\node_modules\\dep",
    ]) {
      expect(isExcludedInstructionPath(path)).toBe(true);
    }
    for (const path of [
      ".",
      "/",
      "",
      "packages/context-compiler",
      "src/vendors",
      "my-vendor-tools",
      "apps/node_modules_helper",
    ]) {
      expect(isExcludedInstructionPath(path)).toBe(false);
    }
  });

  test("discovery skips a vendored working directory and its vendored ancestors", () => {
    const files: Readonly<Record<string, string>> = {
      "/workspace/AGENTS.md": "root rules",
      "/workspace/vendor/opencode/AGENTS.md": "third-party rules",
      "/workspace/vendor/opencode/packages/llm/AGENTS.md": "much larger third-party rules",
    };
    const discovered = discoverInstructions(
      {
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/vendor/opencode/packages/llm",
        filenames: ["AGENTS.md"],
      },
      (path) => files[path] ?? null,
    );
    expect(discovered.map((instruction) => instruction.path)).toEqual(["/workspace/AGENTS.md"]);
  });

  test("discovery skips node_modules but still reaches the first-party ancestors", () => {
    const files: Readonly<Record<string, string>> = {
      "/workspace/AGENTS.md": "root rules",
      "/workspace/packages/app/AGENTS.md": "app rules",
      "/workspace/packages/app/node_modules/dep/CLAUDE.md": "dependency rules",
    };
    const discovered = discoverInstructions(
      {
        workspaceRoot: "/workspace",
        workingDirectory: "/workspace/packages/app/node_modules/dep",
        filenames: ["AGENTS.md", "CLAUDE.md"],
      },
      (path) => files[path] ?? null,
    );
    expect(discovered.map((instruction) => instruction.path)).toEqual([
      "/workspace/packages/app/AGENTS.md",
      "/workspace/AGENTS.md",
    ]);
  });

  test("a workspace that itself lives under a vendor directory still finds its own rules", () => {
    const files: Readonly<Record<string, string>> = {
      "/home/me/vendor/checkout/AGENTS.md": "my rules",
    };
    const discovered = discoverInstructions(
      {
        workspaceRoot: "/home/me/vendor/checkout",
        workingDirectory: "/home/me/vendor/checkout",
        filenames: ["AGENTS.md"],
      },
      (path) => files[path] ?? null,
    );
    expect(discovered.map((instruction) => instruction.path))
      .toEqual(["/home/me/vendor/checkout/AGENTS.md"]);
  });
});

describe("instruction candidate directories", () => {
  test("enumerates the literal prefix of each scope pattern, shallowest first", () => {
    expect(instructionCandidateDirectories([
      "packages/context-compiler/src/index.ts",
      "apps/desktop/**/*.tsx",
    ])).toEqual([
      ".",
      "apps",
      "packages",
      "apps/desktop",
      "packages/context-compiler",
      "packages/context-compiler/src",
    ]);
  });

  test("a `**` scope collapses to the workspace root", () => {
    expect(instructionCandidateDirectories(["**"])).toEqual(["."]);
    expect(instructionCandidateDirectories(["**/*.ts"])).toEqual(["."]);
  });

  test("a scope naming a vendored path contributes no candidate directory", () => {
    for (const scope of [
      "vendor/opencode/packages/llm/**",
      "node_modules/@scope/pkg/index.js",
      "packages/app/node_modules/dep/**",
      ".git/hooks/pre-commit",
    ]) {
      expect(instructionCandidateDirectories([scope])).toEqual(["."]);
    }
  });

  test("a first-party prefix survives even when a sibling scope is vendored", () => {
    expect(instructionCandidateDirectories([
      "packages/app/src/main.ts",
      "vendor/opencode/AGENTS.md",
    ])).toEqual([".", "packages", "packages/app", "packages/app/src"]);
  });

  test("absolute paths and parent traversal are ignored", () => {
    expect(instructionCandidateDirectories([
      "/etc/passwd",
      "../../elsewhere/AGENTS.md",
      "",
    ])).toEqual(["."]);
  });
});
