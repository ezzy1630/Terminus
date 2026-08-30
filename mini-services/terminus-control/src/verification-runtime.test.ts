import { describe, expect, test } from "bun:test";
import {
  createVerificationRuntime,
  defaultCriteriaNodes,
  isNotAGitWorkspace,
  buildDirtyGitWorkspaceRevision,
  parseGitStatusPorcelain,
  resolveKernelEnvironmentDigest,
  resolveWorkspaceRevision,
  resolvePredicateCommand,
  summarizeRequiredVerification,
  WORKSPACE_TREE_HASH_SCRIPT,
} from "./verification-runtime.js";
import { parseNodeSpec } from "@terminus/verification";
import type { VerificationNode, VerificationResult } from "@terminus/domain";
import type { VerificationRunnerCatalog } from "./agent/repository-signals.js";

const runnerCatalog = (
  entries: Readonly<Record<string, { readonly command: string; readonly sourcePath: string }>>,
): VerificationRunnerCatalog => Object.fromEntries(
  Object.entries(entries).map(([kind, value]) => [kind, {
    kind,
    command: value.command,
    sourcePath: value.sourcePath,
    sourceVersion: "sha256:test",
  }]),
) as VerificationRunnerCatalog;

function resultFor(
  nodeId: string,
  status: VerificationResult["status"],
): VerificationResult {
  return {
    id: `00000000-0000-7000-8000-result-${nodeId}` as VerificationResult["id"],
    planId: "00000000-0000-7000-8000-000000000001" as VerificationResult["planId"],
    nodeId,
    status,
    startedAt: "2026-08-30T00:00:00.000Z" as VerificationResult["startedAt"],
    completedAt: "2026-08-30T00:00:01.000Z" as VerificationResult["completedAt"],
    sourceRevision: "rev-test",
    environmentImageDigest: "env:test",
    commandOrQuery: `check:${nodeId}`,
    exitCode: status === "pass" ? 0 : null,
    structuredObservations: {},
    artifacts: [],
    toolCallId: null,
    verifierVersion: "1.0.0",
    reasonIfSkipped: status === "skipped" ? "no matching runner" : null,
    attempts: status === "skipped" ? 0 : 1,
  };
}

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

  test("an unavailable diagnostics baseline stays visible but cannot erase runnable acceptance evidence", async () => {
    const criteria = [
      {
        id: "import-clean",
        statement: "The module imports successfully",
        verificationHint: "predicate: unit_test",
        required: true,
      },
      {
        id: "regression-tests",
        statement: "The regression suite passes",
        verificationHint: "predicate: unit_test",
        required: true,
      },
    ];
    const nodes = defaultCriteriaNodes(criteria, {
      signals: {
        changedFiles: ["src/module.py"],
        nativeTestCommands: [
          "python -m pytest tests/test_import.py",
          "python -m pytest tests/test_regression.py",
        ],
      },
      runnerCatalog: runnerCatalog({
        test: { command: "python -m pytest", sourcePath: "pytest.ini" },
      }),
    });
    const diagnostics = nodes.find(
      (node) => parseNodeSpec(node.specification).predicateType === "static_diagnostics",
    );

    expect(diagnostics).toBeDefined();
    expect(diagnostics?.acceptanceCriterionId).toBeNull();
    expect(diagnostics?.required).toBe(false);
    expect(nodes.filter((node) => node.acceptanceCriterionId !== null).every((node) => node.required)).toBe(true);
    expect(nodes.filter((node) => parseNodeSpec(node.specification).command !== undefined)).toHaveLength(2);

    const runtime = createVerificationRuntime({
      async run(request) {
        if (request.predicateType === "static_diagnostics") {
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            status: "skipped",
            reasonIfSkipped: "no typecheck or lint runner",
          };
        }
        return { exitCode: 0, stdout: "pass", stderr: "" };
      },
    });
    const plan = await runtime.lifecycle.createPlan({
      taskContractId: "00000000-0000-7000-8000-000000000002" as VerificationResult["planId"],
      taskContractVersion: 1,
      sourceRevision: "rev-test",
      criteria,
      nodes,
      completionExpression: nodes.filter((node) => node.required).map((node) => node.id).join(" && "),
    });
    const evaluation = await runtime.lifecycle.evaluate(plan.id, "rev-test", "env:test");

    expect(evaluation.results.find((result) => result.nodeId === diagnostics?.id)?.status).toBe("skipped");
    expect(evaluation.allRequiredPassed).toBe(true);
    expect(evaluation.completionExpressionSatisfied).toBe(true);
  });

  test("no runnable acceptance predicate keeps every admission requirement fail-closed", () => {
    const nodes = defaultCriteriaNodes([{
      id: "tests",
      statement: "The tests pass",
      verificationHint: "predicate: unit_test",
      required: true,
    }], {
      signals: { changedFiles: ["src/module.py"] },
      runnerCatalog: {},
    });

    expect(nodes.every((node) => node.required)).toBe(true);
  });

  test("missing risk-specific verification is never relaxed by runnable baseline checks", () => {
    const nodes = defaultCriteriaNodes([{
      id: "tests",
      statement: "The tests pass",
      verificationHint: "predicate: unit_test",
      required: true,
    }], {
      riskClass: "high",
      signals: { changedFiles: ["src/module.py"] },
      runnerCatalog: runnerCatalog({
        test: { command: "python -m pytest", sourcePath: "pytest.ini" },
      }),
    });
    const security = nodes.find(
      (node) => parseNodeSpec(node.specification).predicateType === "security_scanner",
    );

    expect(security).toBeDefined();
    expect(security?.required).toBe(true);
  });
});

describe("verification settlement classification", () => {
  const requiredNode = (id: string): VerificationNode => ({
    id,
    kind: "command",
    required: true,
    dependsOn: [],
    specification: "{}",
    timeout: 1_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, flakeIdentity: null },
    acceptanceCriterionId: null,
  });

  test("one skipped check does not classify passing runnable checks as a non-runnable plan", () => {
    const nodes = [requiredNode("parse"), requiredNode("diagnostics"), requiredNode("tests")];
    const summary = summarizeRequiredVerification(nodes, [
      resultFor("parse", "pass"),
      resultFor("diagnostics", "skipped"),
      resultFor("tests", "pass"),
    ]);

    expect(summary.runnableRequiredNodeIds).toEqual(["parse", "tests"]);
    expect(summary.skippedRequiredNodeIds).toEqual(["diagnostics"]);
    expect(summary.noRunnableChecks).toBe(false);
  });

  test("a plan whose required checks all skip remains explicitly non-runnable", () => {
    const nodes = [requiredNode("parse"), requiredNode("diagnostics")];
    const summary = summarizeRequiredVerification(nodes, [
      resultFor("parse", "skipped"),
      resultFor("diagnostics", "skipped"),
    ]);

    expect(summary.runnableRequiredNodeIds).toEqual([]);
    expect(summary.skippedRequiredNodeIds).toEqual(["parse", "diagnostics"]);
    expect(summary.noRunnableChecks).toBe(true);
  });
});

describe("H3 predicate command derivation", () => {
  test("an explicit node command is honored verbatim", () => {
    const resolved = resolvePredicateCommand("unit_test", "cargo", ["test", "--lib"], {});
    expect(resolved).toEqual({ kind: "command", program: "cargo", args: ["test", "--lib"], source: null });
  });

  test("the placeholder resolves to the repository's own test command", () => {
    const resolved = resolvePredicateCommand(
      "unit_test",
      "terminus-predicate",
      ["unit_test", "."],
      runnerCatalog({ test: { command: "bun run test", sourcePath: "package.json" } }),
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
      runnerCatalog({
        typecheck: { command: "npm run typecheck", sourcePath: "package.json" },
        lint: { command: "npm run lint", sourcePath: "package.json" },
      }),
    )).toMatchObject({ kind: "command", program: "npm", args: ["run", "typecheck"] });
    expect(resolvePredicateCommand(
      "static_diagnostics",
      "terminus-predicate",
      ["static_diagnostics"],
      runnerCatalog({ lint: { command: "npm run lint", sourcePath: "package.json" } }),
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
      runnerCatalog({ test: { command: "bun run test", sourcePath: "package.json" } }),
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

  test("parses NUL-delimited status paths, including spaces and renames", () => {
    const entries = parseGitStatusPorcelain(" M src/with spaces.ts\0R  renamed.ts\0old name.ts\0?? new file.ts\0");
    expect(entries).toEqual([
      { status: " M", path: "src/with spaces.ts", oldPath: null },
      { status: "R ", path: "renamed.ts", oldPath: "old name.ts" },
      { status: "??", path: "new file.ts", oldPath: null },
    ]);
  });

  test("dirty revision includes status and current content hashes deterministically", () => {
    const entries = parseGitStatusPorcelain(" D deleted.ts\0 M changed.ts\0?? untracked.ts\0");
    const hashes = new Map([
      ["changed.ts", "a".repeat(40)],
      ["untracked.ts", "b".repeat(40)],
    ]);
    const first = buildDirtyGitWorkspaceRevision("a".repeat(40), entries, hashes);
    const reordered = buildDirtyGitWorkspaceRevision(
      "a".repeat(40),
      [...entries].reverse(),
      hashes,
    );
    expect(first).toBe(reordered);
    expect(first).toMatch(/^git:a{40}:dirty:[0-9a-f]{64}$/);
    expect(buildDirtyGitWorkspaceRevision("a".repeat(40), entries, new Map([
      ["changed.ts", "c".repeat(40)],
      ["untracked.ts", "b".repeat(40)],
    ]))).not.toBe(first);
  });

  test("Git revision lookup hashes dirty paths through structured argv", async () => {
    const calls: Array<{ readonly program: string; readonly args: readonly string[] }> = [];
    const outputs = [
      { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 },
      { stdout: " M src/with spaces.ts\0?? new.ts\0", stderr: "", exitCode: 0 },
      { stdout: `${"b".repeat(40)}\n${"c".repeat(40)}\n`, stderr: "", exitCode: 0 },
    ];
    const clients = {
      process: {
        Start(request: { readonly command: { readonly program: string; readonly args: readonly string[] } }) {
          calls.push(request.command);
          const output = outputs.shift();
          if (output === undefined) throw new Error("unexpected process call");
          return {
            subscribe(observer: { next: (event: unknown) => void }) {
              const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
              if (output.stdout.length > 0) observer.next({ stdout: { bytes: encode(output.stdout) } });
              observer.next({ exited: { exitCode: output.exitCode } });
              return { unsubscribe: () => undefined };
            },
          };
        },
      },
    };
    const revision = await resolveWorkspaceRevision(
      clients as unknown as Parameters<typeof resolveWorkspaceRevision>[0],
      {} as Parameters<typeof resolveWorkspaceRevision>[1],
      "workspace",
    );
    expect(revision).toMatch(/^git:a{40}:dirty:[0-9a-f]{64}$/);
    expect(calls.map((call) => [call.program, ...call.args])).toEqual([
      ["git", "rev-parse", "HEAD"],
      ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["git", "hash-object", "--no-filters", "--", "new.ts", "src/with spaces.ts"],
    ]);
  });

  test("Git revision lookup hashes every path when long paths force short batches", async () => {
    const paths = Array.from(
      { length: 300 },
      (_, index) => `untracked/${"p".repeat(190)}-${index}.ts`,
    );
    const calls: Array<{ readonly program: string; readonly args: readonly string[] }> = [];
    let callIndex = 0;
    const clients = {
      process: {
        Start(request: { readonly command: { readonly program: string; readonly args: readonly string[] } }) {
          calls.push(request.command);
          const output = callIndex === 0
            ? `${"a".repeat(40)}\n`
            : callIndex === 1
              ? paths.map((path) => `?? ${path}\0`).join("")
              : request.command.args.slice(3).map(() => "b".repeat(40)).join("\n") + "\n";
          callIndex += 1;
          return {
            subscribe(observer: { next: (event: unknown) => void }) {
              observer.next({ stdout: { bytes: new TextEncoder().encode(output) } });
              observer.next({ exited: { exitCode: 0 } });
              return { unsubscribe: () => undefined };
            },
          };
        },
      },
    };
    const revision = await resolveWorkspaceRevision(
      clients as unknown as Parameters<typeof resolveWorkspaceRevision>[0],
      {} as Parameters<typeof resolveWorkspaceRevision>[1],
      "workspace",
    );
    expect(revision).toMatch(/^git:a{40}:dirty:[0-9a-f]{64}$/);
    const hashCalls = calls.filter((call) => call.args[0] === "hash-object");
    const batchSizes = hashCalls.map((call) => call.args.length - 3);
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(batchSizes.every((size) => size > 0 && size < 256)).toBe(true);
    expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(paths.length);
  });

  test("Git revision lookup admits deleted-only worktrees without hashing absent paths", async () => {
    const calls: Array<{ readonly program: string; readonly args: readonly string[] }> = [];
    const outputs = [
      { stdout: `${"a".repeat(40)}\n`, exitCode: 0 },
      { stdout: " D deleted file.ts\0", exitCode: 0 },
    ];
    const clients = {
      process: {
        Start(request: { readonly command: { readonly program: string; readonly args: readonly string[] } }) {
          calls.push(request.command);
          const output = outputs.shift();
          if (output === undefined) throw new Error("unexpected process call");
          return {
            subscribe(observer: { next: (event: unknown) => void }) {
              observer.next({ stdout: { bytes: new TextEncoder().encode(output.stdout) } });
              observer.next({ exited: { exitCode: output.exitCode } });
              return { unsubscribe: () => undefined };
            },
          };
        },
      },
    };
    const revision = await resolveWorkspaceRevision(
      clients as unknown as Parameters<typeof resolveWorkspaceRevision>[0],
      {} as Parameters<typeof resolveWorkspaceRevision>[1],
      "workspace",
    );
    expect(revision).toMatch(/^git:a{40}:dirty:[0-9a-f]{64}$/);
    expect(calls.map((call) => call.args[0])).toEqual(["rev-parse", "status"]);
  });

  test("rejects unbounded or unterminated Git status output", () => {
    expect(() => parseGitStatusPorcelain(" M file.ts")).toThrow("NUL terminated");
    expect(() => parseGitStatusPorcelain(`${"x".repeat(512 * 1024)}\0`)).toThrow("bounded workspace revision limit");
    expect(() => parseGitStatusPorcelain("xx file.ts\0")).toThrow("malformed porcelain");
    expect(() => parseGitStatusPorcelain("R  renamed.ts\0")).toThrow("missing its old path");
  });
});
