/**
 * M8 exit gate: false completion is prevented; invalidation/expiry/binding
 * failures deny CompletionRecord construction.
 */
import { describe, test, expect } from "bun:test";
import type {
  AcceptanceCriterion,
  Micros,
  Uuid7,
  Rfc3339Timestamp,
  ArtifactRef,
} from "@terminus/domain";
import {
  InMemoryVerificationStore,
  VerificationEngine,
  VerificationLifecycle,
  createStandardPredicateRegistry,
  criterionNode,
  evaluateCompletionGate,
  bindAcceptanceCriteria,
  contentArtifactRef,
  type PredicateCommandRunner,
} from "./index.js";

function fakeUuid(n: number): Uuid7 {
  const tail = n.toString(16).padStart(12, "0");
  return `018f0000-0000-7000-8000-${tail}` as Uuid7;
}

function fakeTs(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

const checkpoint: ArtifactRef = {
  hash: ("sha256:" + "ab".repeat(32)) as ArtifactRef["hash"],
  uri: ("artifact://sha256/" + "ab".repeat(32)) as ArtifactRef["uri"],
  mediaType: "application/json",
  bytes: 0n as ArtifactRef["bytes"],
};

function makeRuntime(runner: PredicateCommandRunner, withArtifacts = true) {
  let planId = fakeUuid(1);
  const store = new InMemoryVerificationStore();
  const registry = createStandardPredicateRegistry({
    runner,
    idSource: () => fakeUuid(Math.floor(Math.random() * 100000) + 10),
    clock: fakeTs,
    planId: () => planId,
    ...(withArtifacts ? {
      artifactWriter: {
        async write(input: { readonly bytes: Uint8Array; readonly mediaType: string }) {
          return contentArtifactRef(input.bytes, input.mediaType);
        },
      },
    } : {}),
  });
  const engine = new VerificationEngine({
    executorFor: () => registry.toNodeExecutor(),
    idSource: () => fakeUuid(Math.floor(Math.random() * 100000) + 10),
    clock: fakeTs,
  });
  const lifecycle = new VerificationLifecycle({ store, engine, idSource: () => fakeUuid(7), clock: fakeTs });
  return {
    lifecycle,
    setPlanId: (id: Uuid7) => {
      planId = id;
    },
  };
}

describe("M8 verification exit gate", () => {
  test("completion cannot succeed without a required acceptance criterion", () => {
    const decision = evaluateCompletionGate({
      taskId: fakeUuid(1),
      contractVersion: 1,
      plan: {
        id: fakeUuid(2),
        taskContractId: fakeUuid(3),
        taskContractVersion: 1,
        sourceRevision: "rev-a",
        nodes: [],
        edges: [],
        completionExpression: "",
        createdAt: fakeTs(),
      },
      criteria: [],
      results: [],
      findings: [],
      sourceRevision: "rev-a",
      environmentImageDigest: "env:1",
      now: fakeTs(),
      expiresAt: null,
      invalidatedNodeIds: new Set(),
      completionExpressionSatisfied: true,
      unresolvedRisks: [],
      acceptedRisks: [],
      externalEffects: [],
      costMicros: 0n as Micros,
      durationSeconds: 1,
      finalCheckpoint: checkpoint,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.detail).toMatch(/required acceptance criterion/i);
  });

  test("required acceptance criteria must bind to predicates", () => {
    const criteria: AcceptanceCriterion[] = [
      { id: "ac1", statement: "tests pass", verificationHint: null, required: true },
    ];
    const report = bindAcceptanceCriteria(criteria, [
      criterionNode({
        id: "n1",
        criterionId: null,
        predicateType: "unit_test",
        paths: ["."],
        required: true,
      }),
    ]);
    expect(report.complete).toBe(false);
    expect(report.uncoveredRequired).toContain("ac1");
  });

  test("false completion prevented when required predicate fails", async () => {
    const runner: PredicateCommandRunner = {
      async run(req) {
        return {
          exitCode: req.predicateType === "unit_test" ? 1 : 0,
          stdout: "",
          stderr: "fail",
        };
      },
    };
    const { lifecycle, setPlanId } = makeRuntime(runner);
    const criteria: AcceptanceCriterion[] = [
      { id: "ac1", statement: "unit tests", verificationHint: null, required: true },
    ];
    const plan = await lifecycle.createPlan({
      taskContractId: fakeUuid(2),
      taskContractVersion: 1,
      sourceRevision: "rev-a",
      criteria,
      nodes: [
        criterionNode({
          id: "unit",
          criterionId: "ac1",
          predicateType: "unit_test",
          paths: ["src"],
          required: true,
        }),
      ],
      completionExpression: "unit",
    });
    setPlanId(plan.id);
    const evaluation = await lifecycle.evaluate(plan.id, "rev-a", "env:1", null);
    expect(evaluation.allRequiredPassed).toBe(false);

    await expect(
      lifecycle.complete({
        taskId: fakeUuid(3),
        planId: plan.id,
        criteria,
        findings: [],
        sourceRevision: "rev-a",
        environmentImageDigest: "env:1",
        expiresAt: null,
        unresolvedRisks: [],
        acceptedRisks: [],
        externalEffects: [],
        costMicros: 0n as Micros,
        durationSeconds: 1,
        finalCheckpoint: checkpoint,
      }),
    ).rejects.toThrow(/false completion|completion denied|gate/i);
  });

  test("changed-code invalidation blocks stale completion", async () => {
    const runner: PredicateCommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const { lifecycle, setPlanId } = makeRuntime(runner);
    const criteria: AcceptanceCriterion[] = [
      { id: "ac1", statement: "parses", verificationHint: null, required: true },
    ];
    const plan = await lifecycle.createPlan({
      taskContractId: fakeUuid(2),
      taskContractVersion: 1,
      sourceRevision: "rev-a",
      criteria,
      nodes: [
        criterionNode({
          id: "parse",
          criterionId: "ac1",
          predicateType: "file_parses",
          paths: ["src/a.ts"],
          required: true,
        }),
      ],
      completionExpression: "parse",
    });
    setPlanId(plan.id);
    await lifecycle.evaluate(plan.id, "rev-a", "env:1", null);
    const invalidated = await lifecycle.invalidateForChangedPaths(plan.id, ["src/a.ts"]);
    expect(invalidated.has("parse")).toBe(true);

    await expect(
      lifecycle.complete({
        taskId: fakeUuid(3),
        planId: plan.id,
        criteria,
        findings: [],
        sourceRevision: "rev-a",
        environmentImageDigest: "env:1",
        expiresAt: null,
        unresolvedRisks: [],
        acceptedRisks: [],
        externalEffects: [],
        costMicros: 0n as Micros,
        durationSeconds: 1,
        finalCheckpoint: checkpoint,
      }),
    ).rejects.toThrow();
  });

  test("digest mismatch denies completion gate", () => {
    const decision = evaluateCompletionGate({
      taskId: fakeUuid(1),
      contractVersion: 1,
      plan: {
        id: fakeUuid(2),
        taskContractId: fakeUuid(3),
        taskContractVersion: 1,
        sourceRevision: "rev-a",
        nodes: [
          criterionNode({
            id: "n",
            criterionId: "ac1",
            predicateType: "file_parses",
            paths: ["."],
            required: true,
          }),
        ],
        edges: [],
        completionExpression: "n",
        createdAt: fakeTs(),
      },
      criteria: [
        { id: "ac1", statement: "ok", verificationHint: null, required: true },
      ],
      results: [
        {
          id: fakeUuid(9),
          planId: fakeUuid(2),
          nodeId: "n",
          status: "pass",
          startedAt: fakeTs(),
          completedAt: fakeTs(),
          sourceRevision: "rev-a",
          environmentImageDigest: "env:old",
          commandOrQuery: "",
          exitCode: 0,
          structuredObservations: {},
          artifacts: [],
          toolCallId: null,
          verifierVersion: "1.0.0",
          reasonIfSkipped: null,
          attempts: 1,
        },
      ],
      findings: [],
      sourceRevision: "rev-a",
      environmentImageDigest: "env:new",
      now: fakeTs(),
      expiresAt: null,
      invalidatedNodeIds: new Set(),
      completionExpressionSatisfied: true,
      unresolvedRisks: [],
      acceptedRisks: [],
      externalEffects: [],
      costMicros: 0n as Micros,
      durationSeconds: 1,
      finalCheckpoint: checkpoint,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe("binding_invalid");
  });

  test("successful gated completion persists CompletionRecord", async () => {
    const runner: PredicateCommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const { lifecycle, setPlanId } = makeRuntime(runner);
    const criteria: AcceptanceCriterion[] = [
      { id: "ac1", statement: "ok", verificationHint: null, required: true },
    ];
    const plan = await lifecycle.createPlan({
      taskContractId: fakeUuid(2),
      taskContractVersion: 1,
      sourceRevision: "rev-a",
      criteria,
      nodes: [
        criterionNode({
          id: "parse",
          criterionId: "ac1",
          predicateType: "file_parses",
          paths: ["."],
          required: true,
        }),
      ],
      completionExpression: "parse",
    });
    setPlanId(plan.id);
    await lifecycle.evaluate(plan.id, "rev-a", "env:1", null);
    const record = await lifecycle.complete({
      taskId: fakeUuid(3),
      planId: plan.id,
      criteria,
      findings: [],
      sourceRevision: "rev-a",
      environmentImageDigest: "env:1",
      expiresAt: null,
      unresolvedRisks: [],
      acceptedRisks: [],
      externalEffects: [],
      costMicros: 0n as Micros,
      durationSeconds: 1,
      finalCheckpoint: checkpoint,
    });
    expect(record.status).toBe("completed");
    expect(record.criteria[0]?.status).toBe("satisfied");
  });

  test("a passing predicate without immutable evidence cannot complete", async () => {
    const runner: PredicateCommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const { lifecycle, setPlanId } = makeRuntime(runner, false);
    const criteria: AcceptanceCriterion[] = [
      { id: "ac1", statement: "ok", verificationHint: null, required: true },
    ];
    const plan = await lifecycle.createPlan({
      taskContractId: fakeUuid(2),
      taskContractVersion: 1,
      sourceRevision: "rev-a",
      criteria,
      nodes: [criterionNode({ id: "parse", criterionId: "ac1", predicateType: "file_parses", paths: ["."], required: true })],
      completionExpression: "parse",
    });
    setPlanId(plan.id);
    await lifecycle.evaluate(plan.id, "rev-a", "env:1", null);
    await expect(lifecycle.complete({
      taskId: fakeUuid(3),
      planId: plan.id,
      criteria,
      findings: [],
      sourceRevision: "rev-a",
      environmentImageDigest: "env:1",
      expiresAt: null,
      unresolvedRisks: [],
      acceptedRisks: [],
      externalEffects: [],
      costMicros: 0n as Micros,
      durationSeconds: 1,
      finalCheckpoint: checkpoint,
    })).rejects.toThrow(/evidence|false completion/i);
  });

  test("a manual required criterion cannot complete without an independent predicate", async () => {
    const { lifecycle } = makeRuntime({
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    const criteria: AcceptanceCriterion[] = [
      { id: "manual", statement: "human says it is okay", verificationHint: "manual: inspect the UI", required: true },
    ];
    const plan = await lifecycle.createPlan({
      taskContractId: fakeUuid(2),
      taskContractVersion: 1,
      sourceRevision: "rev-a",
      criteria,
      nodes: [],
      completionExpression: "",
    });
    await expect(lifecycle.complete({
      taskId: fakeUuid(3),
      planId: plan.id,
      criteria,
      findings: [],
      sourceRevision: "rev-a",
      environmentImageDigest: "env:1",
      expiresAt: null,
      unresolvedRisks: [],
      acceptedRisks: [],
      externalEffects: [],
      costMicros: 0n as Micros,
      durationSeconds: 1,
      finalCheckpoint: checkpoint,
    })).rejects.toThrow(/manual|false completion/i);
  });
});
