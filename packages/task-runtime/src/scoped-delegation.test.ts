/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  IdempotencyConflictError,
  artifactUriSchema,
  byteCountSchema,
  contentHashSchema,
  nowTimestamp,
  type ArtifactRef,
  type DelegationContractV2,
  type Rfc3339Timestamp,
} from "@terminus/domain";
import {
  InMemoryDurableTaskRepository,
  SqliteDatabaseAdapter,
  SqliteDurableTaskRepository,
  type ScopedDelegationKernelPort,
  type ScopedDelegationKernelRequest,
  type ScopedDelegationKernelReceipt,
  type SqliteDatabaseDriver,
  type SqliteStatement,
  type SqliteValue,
  DurableScopedDelegationService,
} from "./index.js";

const hash = (digit: string) => contentHashSchema.parse(`sha256:${digit.repeat(64)}`);
const artifact = (digit: string): ArtifactRef => ({
  hash: hash(digit),
  uri: artifactUriSchema.parse(`artifact://sha256/${digit.repeat(64)}`),
  mediaType: "application/json",
  bytes: byteCountSchema.parse(128n),
});

const contract = (objective = "inspect the bounded task"): DelegationContractV2 => ({
  id: "delegation:task-1:scout",
  parentTaskId: "task-1",
  role: "scout",
  objective,
  authorityCeiling: {
    allowedOperations: ["read", "search"],
    allowedPaths: ["packages/example/**"],
    deniedEffects: ["write", "network"],
  },
  inputHandles: [],
  expectedValue: 0.4,
  outputSchemaVersion: "2.0",
  evidenceRequirements: ["source_revision", "test_receipt"],
  budgetMicros: 10n,
  deadline: null,
  writeIsolation: "read_only",
  returnRoute: "task://task-1/delegation-return",
});

const evidence = {
  status: "completed" as const,
  summary: "read-only inspection completed",
  sourceRevision: "git:abc123",
  environmentImageDigest: hash("1"),
  claims: [{ claimId: "claim-1", status: "satisfied" as const, evidenceRefs: [artifact("2")] }],
  artifacts: [artifact("2")],
  changedFiles: [],
  tests: [{
    testId: "test-1",
    status: "passed" as const,
    summary: "targeted test passed",
    evidenceRef: artifact("3"),
  }],
  continuationToken: null,
  truncated: false,
  nextAction: "none" as const,
};

function receipt(
  overrides: Partial<ScopedDelegationKernelReceipt> = {},
): ScopedDelegationKernelReceipt {
  return {
    source: "terminus.kernel.v1",
    trusted: true,
    executionId: "execution-1",
    taskId: "task-1",
    idempotencyKey: "idem-1",
    requestHash: hash("4"),
    attempt: 1,
    status: "SUCCEEDED",
    workerId: null,
    leaseId: null,
    fencingToken: null,
    operationHash: hash("5"),
    receiptArtifact: artifact("6"),
    evidence,
    observedAt: "2026-08-27T00:00:00Z" as Rfc3339Timestamp,
    recoveryRequired: false,
    ...overrides,
  };
}

class FixtureKernel implements ScopedDelegationKernelPort {
  readonly starts: string[] = [];
  readonly recoveries: string[] = [];
  startResult: ScopedDelegationKernelReceipt | Error = receipt();
  recoveryResult: ScopedDelegationKernelReceipt | Error = receipt({ attempt: 2 });
  bindStartReceipt = true;
  bindRecoveryReceipt = true;

  async start(request: ScopedDelegationKernelRequest, _signal: AbortSignal): Promise<ScopedDelegationKernelReceipt> {
    this.starts.push(request.executionId);
    if (this.startResult instanceof Error) throw this.startResult;
    return this.bindStartReceipt ? {
      ...this.startResult,
      executionId: request.executionId,
      taskId: request.taskId,
      idempotencyKey: request.idempotencyKey,
      requestHash: request.requestHash,
      attempt: request.attempt,
    } : this.startResult;
  }

  async recover(request: ScopedDelegationKernelRequest, _signal: AbortSignal): Promise<ScopedDelegationKernelReceipt> {
    this.recoveries.push(request.executionId);
    if (this.recoveryResult instanceof Error) throw this.recoveryResult;
    return this.bindRecoveryReceipt ? {
      ...this.recoveryResult,
      executionId: request.executionId,
      taskId: request.taskId,
      idempotencyKey: request.idempotencyKey,
      requestHash: request.requestHash,
      attempt: request.attempt,
    } : this.recoveryResult;
  }
}

function makeService(
  repo: InMemoryDurableTaskRepository,
  kernel: FixtureKernel,
  overrides: Partial<ConstructorParameters<typeof DurableScopedDelegationService>[0]> = {},
): DurableScopedDelegationService {
  let sequence = 0;
  return new DurableScopedDelegationService({
    repo,
    kernel,
    idSource: () => `generated-${++sequence}`,
    clock: () => "2026-08-27T00:00:00Z" as Rfc3339Timestamp,
    ...overrides,
  });
}

async function admit(service: DurableScopedDelegationService, objective = "inspect the bounded task") {
  return service.admit({
    id: "execution-1",
    taskId: "task-1",
    parentTurnId: "turn-1",
    contract: contract(objective),
    idempotencyKey: "idem-1",
  });
}

describe("DurableScopedDelegationService", () => {
  it("persists admission, returns the original record for a replay, and rejects key reuse", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const service = makeService(repo, new FixtureKernel());

    const first = await admit(service);
    const replay = await admit(service);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.execution.id).toBe(first.execution.id);
    await expect(admit(service, "different objective")).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await repo.listScopedDelegations("task-1"))).toHaveLength(1);
  });

  it("requires a trusted bound receipt before settling compact evidence", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const kernel = new FixtureKernel();
    const service = makeService(repo, kernel);
    await admit(service);

    const completed = await service.start("execution-1");
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.result?.artifacts[0]?.uri).toContain("artifact://sha256/");
    expect(completed.lastReceiptArtifact?.hash).toBe(hash("6"));
    expect(kernel.starts).toEqual(["execution-1"]);
    expect((await repo.listPendingOutboxMessages()).map((message) => message.eventType)).toEqual([
      "agent.spawned",
      "agent.completed",
    ]);
  });

  it("marks an identity-mismatched kernel receipt for manual review", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const kernel = new FixtureKernel();
    kernel.startResult = receipt({ taskId: "task-attacker" });
    kernel.bindStartReceipt = false;
    const service = makeService(repo, kernel);
    await admit(service);

    const result = await service.start("execution-1");
    expect(result.state).toBe("MANUAL_REVIEW");
    expect(result.result).toBeNull();
    expect(result.recovery.nextAction).toBe("manual_review");
  });

  it("reconciles an interrupted worker once and stops at the durable attempt bound", async () => {
    const repo = new InMemoryDurableTaskRepository();
    const kernel = new FixtureKernel();
    kernel.startResult = new Error("worker process exited");
    kernel.recoveryResult = new Error("worker still unavailable");
    const service = makeService(repo, kernel, { maxRecoveryAttempts: 1 });
    await admit(service);

    const interrupted = await service.start("execution-1");
    expect(interrupted.state).toBe("INTERRUPTED");
    const recovery = await service.recoverAfterRestart("task-1");
    expect(recovery[0]?.outcome).toBe("manual_review");
    expect(recovery[0]?.execution.recovery.restartCount).toBe(1);
    expect(kernel.recoveries).toEqual(["execution-1"]);
    expect(await service.recoverAfterRestart("task-1")).toEqual([]);
  });
});

class BunSqliteDriver implements SqliteDatabaseDriver {
  readonly database = new Database(":memory:");

  exec(sql: string): void {
    this.database.exec(sql);
  }

  query(sql: string): SqliteStatement {
    const statement = this.database.query(sql);
    return {
      get: (...parameters: SqliteValue[]) => statement.get(...parameters),
      all: (...parameters: SqliteValue[]) => statement.all(...parameters),
      run: (...parameters: SqliteValue[]) => ({ changes: statement.run(...parameters).changes }),
    };
  }

  transaction<TResult>(operation: () => TResult): TResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

describe("scoped delegation persistence", () => {
  it("reloads the admitted record and idempotency key after repository reopen", async () => {
    const driver = new BunSqliteDriver();
    const firstRepo = new SqliteDurableTaskRepository(new SqliteDatabaseAdapter(driver));
    const firstService = new DurableScopedDelegationService({
      repo: firstRepo,
      kernel: new FixtureKernel(),
      idSource: () => "execution-1",
      clock: nowTimestamp,
    });
    const first = await firstService.admit({
      id: "execution-1",
      taskId: "task-1",
      parentTurnId: "turn-1",
      contract: contract(),
      idempotencyKey: "idem-1",
    });

    const restartedRepo = new SqliteDurableTaskRepository(new SqliteDatabaseAdapter(driver));
    const restartedService = new DurableScopedDelegationService({
      repo: restartedRepo,
      kernel: new FixtureKernel(),
      clock: nowTimestamp,
    });
    const replay = await restartedService.admit({
      id: "different-id",
      taskId: "task-1",
      parentTurnId: "turn-1",
      contract: contract(),
      idempotencyKey: "idem-1",
    });

    expect(first.execution.id).toBe("execution-1");
    expect(replay.duplicate).toBe(true);
    expect((await restartedRepo.getScopedDelegation("execution-1"))?.state).toBe("ADMITTED");
    driver.database.close();
  });
});
