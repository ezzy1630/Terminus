import { describe, expect, test } from "bun:test";
import { computeContentHash } from "@terminus/context-ir";
import {
  discoverInstructions,
  instructionsToFragments,
  resolveInstructionPrecedence,
} from "./project-instructions.js";

describe("project instruction provenance and precedence", () => {
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
