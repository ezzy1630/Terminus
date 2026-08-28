import { describe, expect, test } from "bun:test";
import { defaultCriteriaNodes, resolvePredicateCommand } from "./verification-runtime.js";
import type { VerificationRunnerCatalog } from "./agent/repository-signals.js";

describe("verification runtime plan nodes", () => {
  test("namespaces criterion nodes across repair plans", () => {
    const criteria = [
      { id: "first", statement: "first", verificationHint: null, required: true },
      { id: "second", statement: "second", verificationHint: null, required: true },
    ];
    const firstPlan = defaultCriteriaNodes(criteria);
    const secondPlan = defaultCriteriaNodes(criteria);

    expect(firstPlan.map((node) => node.id)).not.toEqual(secondPlan.map((node) => node.id));
    expect(firstPlan[1]?.dependsOn).toEqual([firstPlan[0]?.id]);
    expect(secondPlan[1]?.dependsOn).toEqual([secondPlan[0]?.id]);
  });

  test("namespaces the default parse, diagnostics, and test chain", () => {
    const firstPlan = defaultCriteriaNodes([]);
    const secondPlan = defaultCriteriaNodes([]);

    expect(firstPlan.map((node) => node.id)).not.toEqual(secondPlan.map((node) => node.id));
    expect(firstPlan[1]?.dependsOn).toEqual([firstPlan[0]?.id]);
    expect(firstPlan[2]?.dependsOn).toEqual([firstPlan[1]?.id]);
  });
});

describe("H3 predicate command derivation", () => {
  const catalog = (
    entries: Readonly<Record<string, { readonly command: string; readonly sourcePath: string }>>,
  ): VerificationRunnerCatalog => Object.fromEntries(
    Object.entries(entries).map(([kind, value]) => [kind, {
      kind,
      command: value.command,
      sourcePath: value.sourcePath,
      sourceVersion: "sha256:test",
    }]),
  ) as VerificationRunnerCatalog;

  test("an explicit node command is honored verbatim", () => {
    const resolved = resolvePredicateCommand("unit_test", "cargo", ["test", "--lib"], {});
    expect(resolved).toEqual({ kind: "command", program: "cargo", args: ["test", "--lib"], source: null });
  });

  test("the placeholder resolves to the repository's own test command", () => {
    const resolved = resolvePredicateCommand(
      "unit_test",
      "terminus-predicate",
      ["unit_test", "."],
      catalog({ test: { command: "bun run test", sourcePath: "package.json" } }),
    );
    expect(resolved).toEqual({
      kind: "command",
      program: "bun",
      args: ["run", "test"],
      source: "test:package.json",
    });
  });

  test("static predicates prefer typecheck, then lint", () => {
    expect(resolvePredicateCommand(
      "static_diagnostics",
      "terminus-predicate",
      ["static_diagnostics"],
      catalog({
        typecheck: { command: "npm run typecheck", sourcePath: "package.json" },
        lint: { command: "npm run lint", sourcePath: "package.json" },
      }),
    )).toMatchObject({ kind: "command", program: "npm", args: ["run", "typecheck"] });
    expect(resolvePredicateCommand(
      "static_diagnostics",
      "terminus-predicate",
      ["static_diagnostics"],
      catalog({ lint: { command: "npm run lint", sourcePath: "package.json" } }),
    )).toMatchObject({ kind: "command", args: ["run", "lint"] });
  });

  test("no detected runner skips the node with a reason instead of failing it", () => {
    const resolved = resolvePredicateCommand("unit_test", "terminus-predicate", ["unit_test"], {});
    expect(resolved.kind).toBe("skipped");
    if (resolved.kind !== "skipped") throw new Error("expected a skipped resolution");
    expect(resolved.reason).toContain("no test runner detected");
    expect(resolved.reason).toContain("package.json");
  });

  test("a detected-but-wrong-role runner explains what was missing", () => {
    const resolved = resolvePredicateCommand(
      "security_scanner",
      "terminus-predicate",
      ["security_scanner"],
      catalog({ test: { command: "bun run test", sourcePath: "package.json" } }),
    );
    expect(resolved.kind).toBe("skipped");
    if (resolved.kind !== "skipped") throw new Error("expected a skipped resolution");
    expect(resolved.reason).toContain("security");
    expect(resolved.reason).toContain("bun run test");
  });

  test("`just <recipe>` is never synthesized for a repository without a justfile", () => {
    for (const predicateType of ["file_parses", "unit_test", "integration_test", "e2e_test", "schema_compatibility"]) {
      const resolved = resolvePredicateCommand(predicateType, "terminus-predicate", [predicateType], {});
      expect(resolved.kind).toBe("skipped");
    }
  });

  test("governed UI verification is skipped, not run as a shell command", () => {
    const resolved = resolvePredicateCommand("ui_e2e", "terminus-predicate", ["ui_e2e"], {});
    expect(resolved.kind).toBe("skipped");
  });
});
