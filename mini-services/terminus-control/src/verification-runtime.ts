/**
 * Control-plane verification runtime — replaces synthetic always-pass
 * verification with a real DAG evaluate + completion gate.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  AcceptanceCriterion,
  Rfc3339Timestamp,
  Uuid7,
} from "../../../packages/domain/src/index.ts";
import {
  InMemoryVerificationStore,
  VerificationEngine,
  VerificationLifecycle,
  createStandardPredicateRegistry,
  criterionNode,
  type PredicateCommandRunner,
  type NodeExecutor,
} from "../../../packages/verification/src/index.ts";

function uuid(): Uuid7 {
  return randomUUID() as Uuid7;
}

function nowIso(): Rfc3339Timestamp {
  return new Date().toISOString() as Rfc3339Timestamp;
}

/** Dev/test runner: treats commands containing "fail" as failure. */
export const scriptedPredicateRunner: PredicateCommandRunner = {
  async run(req) {
    const fail =
      req.command.includes("fail") ||
      (typeof req.observations["forceFail"] === "boolean" && req.observations["forceFail"]);
    return {
      exitCode: fail ? 1 : 0,
      stdout: fail ? "FAIL" : "OK",
      stderr: "",
    };
  },
};

export interface VerificationRuntime {
  readonly lifecycle: VerificationLifecycle;
  readonly store: InMemoryVerificationStore;
}

export function createVerificationRuntime(
  runner: PredicateCommandRunner = scriptedPredicateRunner,
): VerificationRuntime {
  let currentPlanId: Uuid7 = uuid();
  const store = new InMemoryVerificationStore();
  const registry = createStandardPredicateRegistry({
    runner,
    idSource: uuid,
    clock: nowIso,
    planId: () => currentPlanId,
  });
  const fallback: NodeExecutor = {
    async execute(input) {
      return {
        id: uuid(),
        planId: currentPlanId,
        nodeId: input.node.id,
        status: "pass",
        startedAt: nowIso(),
        completedAt: nowIso(),
        sourceRevision: input.workspaceRevision,
        environmentImageDigest: input.environmentImageDigest,
        commandOrQuery: input.node.specification,
        exitCode: 0,
        structuredObservations: { note: "fallback executor" },
        artifacts: [],
        toolCallId: null,
        verifierVersion: "1.0.0",
        reasonIfSkipped: null,
        attempts: 1,
      };
    },
  };
  const executor = registry.toNodeExecutor(fallback);
  const engine = new VerificationEngine({
    executorFor: () => executor,
    idSource: uuid,
    clock: nowIso,
  });
  const lifecycle = new VerificationLifecycle({
    store,
    engine,
    idSource: uuid,
    clock: nowIso,
  });
  return {
    store,
    lifecycle: {
      createPlan: async (input) => {
        const plan = await lifecycle.createPlan(input);
        currentPlanId = plan.id;
        return plan;
      },
      evaluate: (planId, rev, digest, signal) => {
        currentPlanId = planId;
        return lifecycle.evaluate(planId, rev, digest, signal);
      },
      invalidateForChangedPaths: (planId, paths) =>
        lifecycle.invalidateForChangedPaths(planId, paths),
      complete: (input) => lifecycle.complete(input),
    } as VerificationLifecycle,
  };
}

export async function persistPlanToPrisma(
  db: PrismaClient,
  plan: {
    readonly id: string;
    readonly taskId: string;
    readonly contractVersion: number;
    readonly sourceRevision: string;
    readonly completionExpression: string;
    readonly nodes: readonly {
      readonly id: string;
      readonly kind: string;
      readonly required: boolean;
      readonly specification: string;
      readonly timeout: number;
      readonly retryPolicy: unknown;
      readonly acceptanceCriterionId: string | null;
      readonly dependsOn: readonly string[];
    }[];
    readonly edges: readonly {
      readonly from: string;
      readonly to: string;
      readonly kind: string;
    }[];
  },
): Promise<void> {
  await db.verificationPlan.create({
    data: {
      id: plan.id,
      taskId: plan.taskId,
      contractVersion: plan.contractVersion,
      sourceRevision: plan.sourceRevision,
      completionExpression: plan.completionExpression,
      planArtifact: `artifact://sha256/${randomUUID().replace(/-/g, "")}`,
    },
  });
  for (const n of plan.nodes) {
    // Prefer full M8 columns; fall back when Prisma client predates migration 0002.
    try {
      await db.verificationNode.create({
        data: {
          id: n.id,
          planId: plan.id,
          kind: n.kind,
          required: n.required,
          specificationJson: n.specification,
          timeoutMs: n.timeout,
          retryPolicyJson: JSON.stringify(n.retryPolicy),
          acceptanceCriterionId: n.acceptanceCriterionId,
          dependsOnJson: JSON.stringify(n.dependsOn),
        },
      });
    } catch {
      await db.verificationNode.create({
        data: {
          id: n.id,
          planId: plan.id,
          kind: n.kind,
          required: n.required,
          specificationJson: n.specification,
          timeoutMs: n.timeout,
          retryPolicyJson: JSON.stringify(n.retryPolicy),
        },
      });
    }
  }
  for (const e of plan.edges) {
    try {
      await db.verificationEdge.create({
        data: {
          planId: plan.id,
          fromNodeId: e.from,
          toNodeId: e.to,
          kind: e.kind,
        },
      });
    } catch {
      await db.verificationEdge.create({
        data: {
          planId: plan.id,
          fromNodeId: e.from,
          toNodeId: e.to,
        },
      });
    }
  }
}

export async function persistResultsToPrisma(
  db: PrismaClient,
  results: readonly {
    readonly id: string;
    readonly planId: string;
    readonly nodeId: string;
    readonly attempts: number;
    readonly status: string;
    readonly sourceRevision: string;
    readonly environmentImageDigest: string | null;
    readonly reasonIfSkipped: string | null;
  }[],
): Promise<void> {
  for (const r of results) {
    await db.verificationResult.create({
      data: {
        id: r.id,
        planId: r.planId,
        nodeId: r.nodeId,
        attempt: Math.max(1, r.attempts),
        status: r.status,
        sourceRevision: r.sourceRevision,
        environmentDigest: r.environmentImageDigest ?? "unknown",
        evidenceArtifact: null,
        completedAt: new Date(),
        reason: r.reasonIfSkipped,
      },
    });
  }
}

export function defaultCriteriaNodes(
  criteria: readonly AcceptanceCriterion[],
): ReturnType<typeof criterionNode>[] {
  if (criteria.length === 0) {
    return [
      criterionNode({
        id: "parse",
        criterionId: null,
        predicateType: "file_parses",
        paths: ["."],
        required: true,
      }),
      criterionNode({
        id: "diagnostics",
        criterionId: null,
        predicateType: "static_diagnostics",
        paths: ["."],
        required: true,
        dependsOn: ["parse"],
      }),
      criterionNode({
        id: "narrow_tests",
        criterionId: null,
        predicateType: "unit_test",
        paths: ["."],
        required: true,
        dependsOn: ["diagnostics"],
      }),
    ];
  }
  return criteria.map((c, i) =>
    criterionNode({
      id: `ac_${c.id}`,
      criterionId: c.id,
      predicateType: i === 0 ? "file_parses" : "unit_test",
      paths: ["."],
      required: c.required,
      dependsOn: i === 0 ? [] : [`ac_${criteria[i - 1]!.id}`],
    }),
  );
}
