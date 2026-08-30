import { describe, expect, test } from "bun:test";
import {
  defaultCriteriaNodes,
  isNotAGitWorkspace,
  resolveKernelEnvironmentDigest,
  resolvePredicateCommand,
  WORKSPACE_TREE_HASH_SCRIPT,
} from "./verification-runtime.js";
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

describe("F1/F6 verification budgets and environment binding", () => {
  test("plan nodes carry runnable budgets, and the contract can raise them", () => {
    const criteria = [{ id: "tests", statement: "the suite passes", verificationHint: "predicate: unit_test", required: true }];
    const floors = defaultCriteriaNodes(criteria);
    for (const node of floors) expect(node.timeout).toBeGreaterThanOrEqual(120_000);
    expect(floors.some((node) => node.timeout >= 600_000)).toBe(true);
    const raised = defaultCriteriaNodes(criteria, { timeoutSeconds: 1_200 });
    expect(raised.some((node) => node.timeout === 1_200_000)).toBe(true);
    // A short contract budget cannot restore a guaranteed timeout.
    const clamped = defaultCriteriaNodes(criteria, { timeoutSeconds: 30 });
    for (const node of clamped) expect(node.timeout).toBeGreaterThanOrEqual(120_000);
  });

  test("the environment digest ignores which kernel process answered", async () => {
    // Including instanceId meant any kernel restart during VERIFYING
    // permanently poisoned that task's plan.
    const digestFor = async (instanceId: string): Promise<string> =>
      resolveKernelEnvironmentDigest({
        info: {
          GetInfo: () => ({
            protocolVersion: "1",
            buildRevision: "abc123",
            instanceId,
            supportedBackends: ["seatbelt"],
            supportedServices: ["files", "process"],
          }),
        },
      } as unknown as Parameters<typeof resolveKernelEnvironmentDigest>[0]);
    expect(await digestFor("instance-a")).toBe(await digestFor("instance-b"));
    // A genuinely different environment still produces a different digest.
    const otherBuild = await resolveKernelEnvironmentDigest({
      info: {
        GetInfo: () => ({
          protocolVersion: "1",
          buildRevision: "def456",
          instanceId: "instance-a",
          supportedBackends: ["seatbelt"],
          supportedServices: ["files", "process"],
        }),
      },
    } as unknown as Parameters<typeof resolveKernelEnvironmentDigest>[0]);
    expect(await digestFor("instance-a")).not.toBe(otherBuild);
  });
});

describe("resolveWorkspaceRevision fallback", () => {
  test("recognises the git failure text that means 'no repository here'", () => {
    expect(isNotAGitWorkspace("fatal: not a git repository (or any parent up to mount point /Volumes)")).toBe(true);
    expect(isNotAGitWorkspace("fatal: this operation must be run in a work tree")).toBe(true);
    expect(isNotAGitWorkspace("fatal: ambiguous argument 'HEAD': unknown revision")).toBe(false);
    expect(isNotAGitWorkspace("")).toBe(false);
  });

  test("the tree hash script excludes .git and orders deterministically", () => {
    expect(WORKSPACE_TREE_HASH_SCRIPT).toContain('-not -path "./.git/*"');
    expect(WORKSPACE_TREE_HASH_SCRIPT).toContain("LC_ALL=C sort -z");
    expect(WORKSPACE_TREE_HASH_SCRIPT).toContain("shasum -a 256");
  });
});
