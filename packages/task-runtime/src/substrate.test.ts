/**
 * Phase 2 Durable Task Substrate Comprehensive Tests.
 *
 * Covers:
 * - Transactional Outbox atomic delivery & tracking
 * - Transactional Inbox deduplication & payload hashing
 * - Worker leases, monotonic fencing tokens, renewal, release, and fencing of stale workers
 * - Workflow engine DAG validation, node execution, completion, and failure
 * - Questions, decisions, risk mitigation, and budget exhaustion
 * - Crash recovery & event log replay reconstructing full aggregate state
 */
import { describe, it, expect } from "bun:test";
import type { TaskContractV2, WorkflowNode, GuardedEdge } from "@terminus/domain";
import { nowTimestamp, generateUuid7 } from "@terminus/domain";
import type { EventEnvelopeV2 } from "@terminus/runtime-protocol";
import {
  InMemoryDurableTaskRepository,
  TransactionalOutbox,
  TransactionalInbox,
  WorkerLeaseManager,
  WorkflowEngine,
  DecisionRiskBudgetManager,
  DurableTaskSubstrate,
  FencingError,
  LeaseError,
  BudgetExhaustedError,
} from "./index.js";

const sampleContract: TaskContractV2 = {
  version: 1,
  mission: "Test durable task execution",
  scope: {
    resources: [],
    allowedEffectClasses: ["READ", "EXEC"],
    excludedPathsOrSystems: [],
  },
  acceptance: [
    {
      claimId: "claim-1",
      statement: "criterion 1",
      evidenceRequirement: "test_log",
    },
  ],
  constraints: {
    timeoutSeconds: 3600,
    costMicros: 1_000_000n, // $1.00 limit
    security: ["READ", "EXEC"],
  },
  authorityCeiling: ["READ", "EXEC"],
  mode: "AGENTIC",
};

describe("Phase 2 — Transactional Outbox & Inbox", () => {
  it("should create outbox messages and dispatch them atomically", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const outbox = new TransactionalOutbox(repo);

    const now = nowTimestamp();
    const msg = outbox.createMessage("task", "task-1", 1, "task.created", { foo: "bar" });
    await repo.createTaskV2(
      {
        id: "task-1",
        missionId: null,
        organizationId: "org-1",
        departmentId: "dept-1",
        createdBy: "user-1",
        contract: sampleContract,
        status: "DRAFT",
        version: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      msg,
    );

    const pending = await repo.listPendingOutboxMessages();
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe(msg.id);

    const dispatched: string[] = [];
    const count = await outbox.dispatchPending(async (m) => {
      dispatched.push(m.eventType);
    });

    expect(count).toBe(1);
    expect(dispatched).toEqual(["task.created"]);

    const pendingAfter = await repo.listPendingOutboxMessages();
    expect(pendingAfter.length).toBe(0);
  });

  it("should deduplicate inbox messages with payload hashing", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const inbox = new TransactionalInbox(repo);

    let executionCount = 0;
    const processCommand = async () => {
      return inbox.process(
        "idemp-key-1",
        "client-1",
        "task.start",
        { taskId: "task-1" },
        async () => {
          executionCount++;
          return { status: "started" };
        },
      );
    };

    // First call executes
    const res1 = await processCommand();
    expect(res1.duplicate).toBe(false);
    expect(res1.result).toEqual({ status: "started" });
    expect(executionCount).toBe(1);

    // Duplicate call returns duplicate without executing handler again
    const res2 = await processCommand();
    expect(res2.duplicate).toBe(true);
    expect(executionCount).toBe(1);
  });
});

describe("Phase 2 — Worker Leases & Fencing Tokens", () => {
  it("should enforce monotonic fencing tokens and lease renewals", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const outbox = new TransactionalOutbox(repo);
    const leaseMgr = new WorkerLeaseManager(repo, outbox);

    // Worker 1 acquires lease
    const lease1 = await leaseMgr.acquireLease("task-100", "worker-1", 30);
    expect(lease1.fencingToken).toBe(1);
    expect(lease1.status).toBe("ACQUIRED");

    // Worker 1 verifies fencing token
    const valid1 = await leaseMgr.verifyFencingToken("task-100", "worker-1", 1);
    expect(valid1).toBe(true);

    // Worker 1 renews lease
    const renewed = await leaseMgr.renewLease(lease1.id, 1, 60);
    expect(renewed.status).toBe("RENEWED");

    // Worker 1 releases lease
    const released = await leaseMgr.releaseLease(lease1.id, 1);
    expect(released.status).toBe("RELEASED");

    // Worker 2 acquires new lease after release -> fencing token increments to 2
    const lease2 = await leaseMgr.acquireLease("task-100", "worker-2", 30);
    expect(lease2.fencingToken).toBe(2);
    expect(lease2.status).toBe("ACQUIRED");
  });

  it("should reject stale workers with outdated fencing tokens", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const outbox = new TransactionalOutbox(repo);
    const leaseMgr = new WorkerLeaseManager(repo, outbox);

    const lease1 = await leaseMgr.acquireLease("task-200", "worker-1", 1); // 1 sec lease
    expect(lease1.fencingToken).toBe(1);

    // Expire lease
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Worker 2 acquires new lease -> gets fencing token 2
    const lease2 = await leaseMgr.acquireLease("task-200", "worker-2", 30);
    expect(lease2.fencingToken).toBe(2);

    // Stale worker 1 attempts renewal with token 1 -> rejected
    await expect(leaseMgr.renewLease(lease1.id, 1, 30)).rejects.toThrow();

    // Stale worker 1 attempts release with token 1 -> rejected
    await expect(leaseMgr.releaseLease(lease1.id, 1)).rejects.toThrow();
  });
});

describe("Phase 2 — Workflow & Node State Machine Engine", () => {
  const nodes: readonly WorkflowNode[] = [
    {
      id: "plan",
      kind: "deterministic",
      owner: "worker-1",
      inputs: {},
      outputs: {},
      requiredCapabilities: [],
      effectClass: null,
      timeoutSeconds: 60,
      compensationNodeId: null,
    },
    {
      id: "execute",
      kind: "deterministic",
      owner: "worker-1",
      inputs: {},
      outputs: {},
      requiredCapabilities: [],
      effectClass: "read_only",
      timeoutSeconds: 60,
      compensationNodeId: null,
    },
    {
      id: "verify",
      kind: "verifier",
      owner: "independent_verifier",
      inputs: {},
      outputs: {},
      requiredCapabilities: [],
      effectClass: null,
      timeoutSeconds: 60,
      compensationNodeId: null,
    },
  ];
  const edges: readonly GuardedEdge[] = [
    { sourceNodeId: "plan", targetNodeId: "execute", condition: "true" },
    { sourceNodeId: "execute", targetNodeId: "verify", condition: "true" },
  ];

  it("should validate DAG acyclicity and track node runs", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const outbox = new TransactionalOutbox(repo);
    const engine = new WorkflowEngine(repo, outbox);

    const wf = await engine.createWorkflow("task-300", nodes, edges);
    expect(wf.id).toBeDefined();
    expect(wf.nodes.length).toBe(3);

    // Cycle detection check
    const cyclicEdges: GuardedEdge[] = [
      { sourceNodeId: "plan", targetNodeId: "execute", condition: "true" },
      { sourceNodeId: "execute", targetNodeId: "plan", condition: "true" },
    ];
    await expect(engine.createWorkflow("task-300", nodes, cyclicEdges)).rejects.toThrow(
      "Workflow graph contains cycles",
    );

    // Execute node
    const nodeRun = await engine.executeNode(wf.id, "plan", "att-1", { foo: "bar" });
    expect(nodeRun.status).toBe("RUNNING");

    // Complete node
    const completed = await engine.completeNode(nodeRun.id, { planResult: "ok" });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.outputs).toEqual({ planResult: "ok" });
  });
});

describe("Phase 2 — Decisions, Risks & Budgets", () => {
  it("should record questions, decisions, risks, and enforce cost budgets", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const outbox = new TransactionalOutbox(repo);
    const substrate = new DurableTaskSubstrate(repo);

    const task = await substrate.createTask({
      contract: sampleContract,
    });

    const mgr = substrate.decisions;

    // Ask & answer question
    const q = await mgr.askQuestion(task.id, "Which database?", ["sqlite", "postgres"]);
    expect(q.status).toBe("PENDING");
    const answered = await mgr.answerQuestion(q.id, "sqlite", "Simpler single-node model");
    expect(answered.status).toBe("ANSWERED");
    expect(answered.selectedOption).toBe("sqlite");

    // Record decision
    const dec = await mgr.recordDecision(
      task.id,
      "Use SQLite for local durability",
      "Robust single-file transactional model",
      "architecture-review",
      { questionId: q.id },
    );
    expect(dec.statement).toBe("Use SQLite for local durability");

    // Record & mitigate risk
    const risk = await mgr.recordRisk(task.id, "HIGH", "Storage corruption risk");
    expect(risk.status).toBe("IDENTIFIED");
    const mitigated = await mgr.mitigateRisk(risk.id, "Use WAL mode with atomic snapshots");
    expect(mitigated.status).toBe("MITIGATED");

    // Consume within budget ($0.50 of $1.00)
    const b1 = await mgr.consumeBudget(task.id, { costMicros: 500_000n });
    expect(b1.consumedCostMicros).toBe(500_000n);

    // Exceed budget ($0.60 additional -> $1.10 > $1.00)
    await expect(
      mgr.consumeBudget(task.id, { costMicros: 600_000n }),
    ).rejects.toThrow(BudgetExhaustedError);
  });
});

describe("Phase 2 — Full Event Log Replay & Crash Recovery", () => {
  it("should rebuild all task, lease, attempt, and budget aggregates after restart", async () => {
    const repo1 = new InMemoryDurableTaskRepository();
    const substrate1 = new DurableTaskSubstrate(repo1);

    // Perform state changes
    const task = await substrate1.createTask({ contract: sampleContract });
    await substrate1.transitionTask(task.id, "READY");
    await substrate1.transitionTask(task.id, "RUNNING");

    const lease = await substrate1.leases.acquireLease(task.id, "worker-prod", 30);
    const attempt = await substrate1.startAttempt(task.id, "worker-prod", lease.fencingToken);

    await substrate1.decisions.askQuestion(task.id, "Proceed?", ["yes", "no"]);
    await substrate1.decisions.recordRisk(task.id, "LOW", "Network timeout risk");
    await substrate1.decisions.consumeBudget(task.id, { costMicros: 100_000n });

    // Collect all outbox messages as the event log
    const allOutbox = await repo1.listAllOutboxMessages();
    const eventLog: EventEnvelopeV2[] = allOutbox.map((m) => ({
      eventId: generateUuid7(),
      eventType: m.eventType as any,
      schemaVersion: 2,
      aggregateType: m.aggregateType,
      aggregateId: m.aggregateId,
      aggregateSequence: m.sequence,
      occurredAt: m.createdAt,
      actor: { kind: "system", id: "worker" },
      correlationId: generateUuid7(),
      causationId: null,
      idempotencyKey: m.idempotencyKey,
      payload: m.payload,
      artifactRefs: [],
      traceId: null,
    }));

    expect(eventLog.length).toBeGreaterThanOrEqual(6);

    // Simulate crash restart: new repository and substrate instance
    const repo2 = new InMemoryDurableTaskRepository();
    const substrate2 = new DurableTaskSubstrate(repo2);

    await substrate2.recover(eventLog);

    // Verify all aggregates recovered
    const recoveredTask = await repo2.getTaskV2(task.id);
    expect(recoveredTask).toBeDefined();
    expect(recoveredTask?.status).toBe("RUNNING");
    expect(recoveredTask?.version).toBe(3);

    const recoveredLease = await repo2.getLease(lease.id);
    expect(recoveredLease).toBeDefined();
    expect(recoveredLease?.status).toBe("ACQUIRED");
    expect(recoveredLease?.fencingToken).toBe(1);

    const recoveredAttempt = await repo2.getAttempt(attempt.id);
    expect(recoveredAttempt).toBeDefined();
    expect(recoveredAttempt?.status).toBe("RUNNING");

    const recoveredBudget = await repo2.getBudgetConsumption(task.id);
    expect(recoveredBudget).toBeDefined();
    expect(recoveredBudget?.consumedCostMicros).toBe(100_000n);
  });
});
