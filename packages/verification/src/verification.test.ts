/**
 * @terminus/verification — tests for parallel DAG execution (§40.1),
 * changed-code invalidation (§40.5), flaky-test policy (§40.9), and
 * predicate registry (§40.2).
 */
import { describe, test, expect } from "bun:test";
import type {
  VerificationPlan,
  VerificationNode,
  VerificationResult,
  Uuid7,
  Rfc3339Timestamp,
} from "@terminus/domain";
import {
  VerificationEngine,
  buildVerificationPlan,
  ChangedCodeInvalidator,
  evaluateFlaky,
  PredicateRegistry,
  PredicateType,
  predicateTypeToNodeKind,
  parseNodeSpec,
  serializeNodeSpec,
  evaluateCompletionExpression,
  type NodeExecutor,
  type NodeExecutorInput,
  type FlakyTestPolicy,
  type PredicateExecutor,
} from "./index.js";
import { ValidationError } from "@terminus/domain";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function fakeTs(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

function mkNode(
  id: string,
  kind: VerificationNode["kind"],
  opts: {
    dependsOn?: readonly string[];
    required?: boolean;
    specification?: string;
  } = {},
): VerificationNode {
  return {
    id,
    kind,
    required: opts.required ?? false,
    dependsOn: opts.dependsOn ?? [],
    specification: opts.specification ?? `cmd:${id}`,
    timeout: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, flakeIdentity: null },
    acceptanceCriterionId: null,
  };
}

function mkPlan(nodes: readonly VerificationNode[], completionExpression = ""): VerificationPlan {
  return buildVerificationPlan({
    id: fakeUuid(1),
    taskContractId: fakeUuid(2),
    taskContractVersion: 1,
    sourceRevision: "rev-1",
    nodes,
    completionExpression,
  });
}

function passResult(planId: Uuid7, nodeId: string): VerificationResult {
  return {
    id: fakeUuid(Math.floor(Math.random() * 1_000_000) + 100),
    planId,
    nodeId,
    status: "pass",
    startedAt: fakeTs(),
    completedAt: fakeTs(),
    sourceRevision: "rev-1",
    environmentImageDigest: null,
    commandOrQuery: `cmd:${nodeId}`,
    exitCode: 0,
    structuredObservations: {},
    artifacts: [],
    toolCallId: null,
    verifierVersion: "1.0.0",
    reasonIfSkipped: null,
    attempts: 1,
  };
}

function recordingExecutor(
  log: { nodeId: string; startMs: number; endMs: number }[],
  delayMs = 100,
  status: VerificationResult["status"] = "pass",
): NodeExecutor {
  return {
    async execute(input: NodeExecutorInput): Promise<VerificationResult> {
      const start = Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const end = Date.now();
      log.push({ nodeId: input.node.id, startMs: start, endMs: end });
      return {
        ...passResult(input.node.id as unknown as Uuid7, input.node.id),
        status,
      };
    },
  };
}

// ────────────────────────── Parallel execution (§40.1) ───────────────────────

describe("VerificationEngine parallel execution", () => {
  test("two independent nodes run in parallel", async () => {
    const log: { nodeId: string; startMs: number; endMs: number }[] = [];
    const engine = new VerificationEngine({
      executorFor: () => recordingExecutor(log, 100, "pass"),
      idSource: () => fakeUuid(Math.floor(Math.random() * 1_000_000) + 1000),
      clock: fakeTs,
    });
    const plan = mkPlan([
      mkNode("a", "command"),
      mkNode("b", "command"),
    ]);
    const result = await engine.evaluate(plan, "rev-1", null, { parallelism: 4 });
    expect(result.results.length).toBe(2);
    // Both nodes should have run.
    const a = log.find((l) => l.nodeId === "a");
    const b = log.find((l) => l.nodeId === "b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Their execution windows must overlap (parallel).
    const overlap = a!.startMs <= b!.endMs && b!.startMs <= a!.endMs;
    expect(overlap).toBe(true);
  });

  test("dependent nodes run sequentially", async () => {
    const log: { nodeId: string; startMs: number; endMs: number }[] = [];
    const engine = new VerificationEngine({
      executorFor: () => recordingExecutor(log, 80, "pass"),
      idSource: () => fakeUuid(Math.floor(Math.random() * 1_000_000) + 1000),
      clock: fakeTs,
    });
    const plan = mkPlan([
      mkNode("a", "command"),
      mkNode("b", "command", { dependsOn: ["a"] }),
    ]);
    await engine.evaluate(plan, "rev-1", null, { parallelism: 4 });
    const a = log.find((l) => l.nodeId === "a")!;
    const b = log.find((l) => l.nodeId === "b")!;
    // b must start after a ends.
    expect(b.startMs >= a.endMs).toBe(true);
  });

  test("parallelism option limits concurrency", async () => {
    const log: { nodeId: string; startMs: number; endMs: number }[] = [];
    const engine = new VerificationEngine({
      executorFor: () => recordingExecutor(log, 80, "pass"),
      idSource: () => fakeUuid(Math.floor(Math.random() * 1_000_000) + 1000),
      clock: fakeTs,
    });
    const plan = mkPlan([
      mkNode("a", "command"),
      mkNode("b", "command"),
      mkNode("c", "command"),
      mkNode("d", "command"),
    ]);
    await engine.evaluate(plan, "rev-1", null, { parallelism: 1 });
    // With parallelism=1, at most one node is in flight at any time.
    const sorted = [...log].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.startMs >= sorted[i - 1]!.endMs).toBe(true);
    }
  });
});

// ────────────────────────── Changed-code invalidation (§40.5) ────────────────

describe("ChangedCodeInvalidator", () => {
  const invalidator = new ChangedCodeInvalidator();

  test("invalidates nodes whose paths match a changed file", () => {
    const plan = mkPlan([
      mkNode("parse", "command", {
        specification: serializeNodeSpec({
          predicateType: PredicateType.FILE_PARSES,
          paths: ["src/a.ts", "src/b.ts"],
          observations: {},
        }),
      }),
      mkNode("tests", "command", {
        specification: serializeNodeSpec({
          predicateType: PredicateType.UNIT_TEST,
          paths: ["tests/a.test.ts"],
          observations: {},
        }),
      }),
      mkNode("human", "human", { specification: "approve" }),
    ]);
    const invalidated = invalidator.invalidate(plan, {
      changedPaths: ["src/a.ts"],
      symbolDependencies: new Map(),
      testOwnership: new Map(),
      buildGraph: new Map(),
    });
    expect(invalidated.has("parse")).toBe(true);
    expect(invalidated.has("tests")).toBe(false);
    expect(invalidated.has("human")).toBe(false);
  });

  test("propagates via test ownership", () => {
    const plan = mkPlan([
      mkNode("tests", "command", {
        specification: serializeNodeSpec({
          predicateType: PredicateType.UNIT_TEST,
          paths: ["tests/a.test.ts"],
          observations: {},
        }),
      }),
    ]);
    const invalidated = invalidator.invalidate(plan, {
      changedPaths: ["src/a.ts"],
      symbolDependencies: new Map(),
      testOwnership: new Map([["tests/a.test.ts", ["src/a.ts"]]]),
      buildGraph: new Map(),
    });
    expect(invalidated.has("tests")).toBe(true);
  });

  test("propagates via build graph", () => {
    const plan = mkPlan([
      mkNode("build", "command", {
        specification: serializeNodeSpec({
          predicateType: PredicateType.FILE_PARSES,
          paths: ["dist/out.js"],
          observations: {},
        }),
      }),
    ]);
    const invalidated = invalidator.invalidate(plan, {
      changedPaths: ["src/input.ts"],
      symbolDependencies: new Map(),
      testOwnership: new Map(),
      buildGraph: new Map([["dist/out.js", ["src/input.ts"]]]),
    });
    expect(invalidated.has("build")).toBe(true);
  });

  test("falls back to conservative when no node declares paths", () => {
    const plan = mkPlan([
      mkNode("parse", "command"),
      mkNode("tests", "command"),
      mkNode("human", "human"),
    ]);
    const invalidated = invalidator.invalidate(plan, {
      changedPaths: ["anywhere"],
      symbolDependencies: new Map(),
      testOwnership: new Map(),
      buildGraph: new Map(),
    });
    // No paths declared → invalidate all non-human.
    expect(invalidated.has("parse")).toBe(true);
    expect(invalidated.has("tests")).toBe(true);
    expect(invalidated.has("human")).toBe(false);
  });

  test("no changed paths yields no invalidations", () => {
    const plan = mkPlan([mkNode("a", "command")]);
    const invalidated = invalidator.invalidate(plan, {
      changedPaths: [],
      symbolDependencies: new Map(),
      testOwnership: new Map(),
      buildGraph: new Map(),
    });
    expect(invalidated.size).toBe(0);
  });
});

// ────────────────────────── Flaky-test policy (§40.9) ────────────────────────

describe("evaluateFlaky", () => {
  const policy: FlakyTestPolicy = {
    knownFlakeIdentity: "tests/foo.test.ts::bar@rev-1",
    historicalRate: 0.9,
    independentRerunLimit: 3,
    isChangedCodeRelated: false,
    finalConfidence: 0.5,
  };

  function result(status: VerificationResult["status"]): VerificationResult {
    return {
      id: fakeUuid(Math.floor(Math.random() * 1_000_000) + 100),
      planId: fakeUuid(1),
      nodeId: "flake",
      status,
      startedAt: fakeTs(),
      completedAt: fakeTs(),
      sourceRevision: "rev-1",
      environmentImageDigest: null,
      commandOrQuery: "test",
      exitCode: null,
      structuredObservations: {},
      artifacts: [],
      toolCallId: null,
      verifierVersion: "1.0.0",
      reasonIfSkipped: null,
      attempts: 1,
    };
  }

  test("clean pass on first attempt → pass", () => {
    const e = evaluateFlaky([result("pass")], policy);
    expect(e.status).toBe("pass");
    expect(e.confidence).toBe(1);
  });

  test("failure with no flake identity → fail", () => {
    const e = evaluateFlaky([result("fail")], {
      ...policy,
      knownFlakeIdentity: "",
    });
    expect(e.status).toBe("fail");
  });

  test("eventual pass within rerun limit → flaky_pass", () => {
    const e = evaluateFlaky([result("fail"), result("pass")], policy);
    expect(e.status).toBe("flaky_pass");
    expect(e.confidence).toBeGreaterThan(0);
  });

  test("no pass after rerun limit exhausted → fail", () => {
    const e = evaluateFlaky(
      [result("fail"), result("fail"), result("fail"), result("fail")],
      policy,
    );
    expect(e.status).toBe("fail");
  });

  test("changed-code-related flake halves confidence", () => {
    const unrelated = evaluateFlaky([result("fail"), result("pass")], policy);
    const related = evaluateFlaky(
      [result("fail"), result("pass")],
      { ...policy, isChangedCodeRelated: true, finalConfidence: 0.1 },
    );
    expect(related.confidence).toBeCloseTo(unrelated.confidence * 0.5, 5);
  });

  test("flaky pass below finalConfidence is downgraded to fail", () => {
    const e = evaluateFlaky(
      [result("fail"), result("fail"), result("fail"), result("pass")],
      { ...policy, finalConfidence: 0.99, independentRerunLimit: 5 },
    );
    expect(e.status).toBe("fail");
  });
});

// ────────────────────────── Predicate registry (§40.2) ───────────────────────

describe("PredicateRegistry", () => {
  test("all 17 predicate types map to a node kind", () => {
    for (const pt of Object.values(PredicateType)) {
      const kind = predicateTypeToNodeKind(pt);
      expect(["command", "diagnostic", "diff_rule", "human", "external_query"]).toContain(kind);
    }
  });

  test("register, get, require, has", () => {
    const registry = new PredicateRegistry();
    const executor: PredicateExecutor = {
      predicateType: PredicateType.UNIT_TEST,
      async execute(input: NodeExecutorInput): Promise<VerificationResult> {
        return passResult(input.node.id as unknown as Uuid7, input.node.id);
      },
    };
    registry.register(executor);
    expect(registry.has(PredicateType.UNIT_TEST)).toBe(true);
    expect(registry.get(PredicateType.UNIT_TEST)).toBe(executor);
    expect(registry.require(PredicateType.UNIT_TEST)).toBe(executor);
    expect(() => registry.require(PredicateType.E2E_TEST)).toThrow();
  });

  test("toNodeExecutor dispatches by predicateType", async () => {
    const registry = new PredicateRegistry();
    let called = false;
    registry.register({
      predicateType: PredicateType.UNIT_TEST,
      async execute(input: NodeExecutorInput): Promise<VerificationResult> {
        called = true;
        return passResult(input.node.id as unknown as Uuid7, input.node.id);
      },
    });
    const fallback: NodeExecutor = {
      async execute(input: NodeExecutorInput): Promise<VerificationResult> {
        return passResult(input.node.id as unknown as Uuid7, input.node.id);
      },
    };
    const dispatch = registry.toNodeExecutor(fallback);
    const node = mkNode("u", "command", {
      specification: serializeNodeSpec({
        predicateType: PredicateType.UNIT_TEST,
        paths: [],
        observations: {},
      }),
    });
    await dispatch.execute({ node, workspaceRevision: "r", environmentImageDigest: null, signal: null });
    expect(called).toBe(true);
  });

  test("parseNodeSpec round-trips via serializeNodeSpec", () => {
    const spec = {
      predicateType: PredicateType.STATIC_DIAGNOSTICS,
      paths: ["src/a.ts"],
      observations: { foo: "bar" },
    };
    const round = parseNodeSpec(serializeNodeSpec(spec));
    expect(round.predicateType).toBe(spec.predicateType);
    expect(round.paths).toEqual(spec.paths);
    expect(round.observations).toEqual(spec.observations);
  });

  test("parseNodeSpec accepts freeform command strings", () => {
    const spec = parseNodeSpec("bun test");
    expect(spec.predicateType).toBeNull();
    expect(spec.paths).toEqual([]);
  });
});

describe("evaluateCompletionExpression tokenizer", () => {
  const pass = (nodeId: string): [string, VerificationResult] => [
    nodeId,
    passResult(fakeUuid(3), nodeId),
  ];

  test("rejects a lone & or | instead of looping forever", () => {
    // Regression: a single '&' or '|' previously stalled the atom scanner
    // without advancing the index, hanging the process on an empty-token
    // infinite loop.
    for (const bad of ["a & b", "a | b", "&", "|", "a && b | c"]) {
      expect(() => evaluateCompletionExpression(bad, new Map())).toThrow(ValidationError);
    }
  });

  test("still accepts well-formed && / || expressions", () => {
    const results = new Map([pass("parse"), pass("tests")]);
    expect(evaluateCompletionExpression("parse && tests", results)).toBe(true);
    expect(evaluateCompletionExpression("parse || tests", results)).toBe(true);
    expect(evaluateCompletionExpression("!parse && tests", results)).toBe(false);
    expect(evaluateCompletionExpression("(!missing) && tests", results)).toBe(true);
  });
});
