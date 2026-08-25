/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type {
  AuthorizationInstance,
  Rfc3339Timestamp,
  TaskContractV2,
  TaskV2,
} from "@terminus/domain";
import {
  ConflictError,
  IdempotencyConflictError,
  ValidationError,
  nowTimestamp,
} from "@terminus/domain";
import {
  SqliteDatabaseAdapter,
  SqliteDurableTaskRepository,
  type SqliteDatabaseDriver,
  type SqliteStatement,
  type SqliteValue,
} from "./index.js";
import { TransactionalInbox, TransactionalOutbox } from "./outbox.js";

class BunSqliteDriver implements SqliteDatabaseDriver {
  readonly database = new Database(":memory:");
  failOutboxInsert = false;

  exec(sql: string): void {
    this.database.exec(sql);
  }

  query(sql: string): SqliteStatement {
    const statement = this.database.query(sql);
    return {
      get: (...parameters: SqliteValue[]) => statement.get(...parameters),
      all: (...parameters: SqliteValue[]) => statement.all(...parameters),
      run: (...parameters: SqliteValue[]) => {
        if (this.failOutboxInsert && sql.includes("INSERT INTO task_runtime_outbox")) {
          throw new ValidationError("injected outbox failure");
        }
        const result = statement.run(...parameters);
        return { changes: result.changes };
      },
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

  close(): void {
    this.database.close();
  }
}

function openRepository(): {
  readonly driver: BunSqliteDriver;
  readonly repository: SqliteDurableTaskRepository;
} {
  const driver = new BunSqliteDriver();
  const repository = new SqliteDurableTaskRepository(new SqliteDatabaseAdapter(driver));
  return { driver, repository };
}

const contract: TaskContractV2 = {
  version: 1,
  mission: "Persist this task",
  scope: {
    resources: [],
    allowedEffectClasses: ["READ"],
    excludedPathsOrSystems: [],
  },
  acceptance: [],
  constraints: {
    security: [],
    costMicros: 100n,
    timeoutSeconds: 60,
  },
  authorityCeiling: ["READ"],
  mode: "AGENTIC",
};

function task(version = 1): TaskV2 {
  const timestamp = nowTimestamp();
  return {
    id: "task-sqlite-1",
    missionId: null,
    organizationId: "org-1",
    departmentId: "dept-1",
    createdBy: "principal-1",
    conversationContext: null,
    contract,
    status: "DRAFT",
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

describe("SqliteDurableTaskRepository", () => {
  it("persists state across a repository reopen and rolls back state with a failed outbox write", async () => {
    const { driver, repository } = openRepository();
    try {
      const outboxIds = ["outbox-create", "outbox-update"];
      const outbox = new TransactionalOutbox(
        repository,
        () => outboxIds.shift() ?? "outbox-unexpected",
        nowTimestamp,
      );
      const message = outbox.createMessage(
        "task",
        "task-sqlite-1",
        1,
        "task.created",
        { taskId: "task-sqlite-1" },
      );
      const created = await repository.createTaskV2(task(), message);

      const restarted = new SqliteDurableTaskRepository(new SqliteDatabaseAdapter(driver));
      expect(await restarted.getTaskV2(created.id)).toEqual(created);
      expect(await restarted.listAllOutboxMessages()).toEqual([message]);

      driver.failOutboxInsert = true;
      await expect(
        restarted.updateTaskV2(
          { ...created, version: 2, updatedAt: nowTimestamp() },
          outbox.createMessage("task", created.id, 2, "task.running", { version: 2 }),
        ),
      ).rejects.toThrow(ValidationError);
      driver.failOutboxInsert = false;

      expect((await restarted.getTaskV2(created.id))?.version).toBe(1);
      expect((await restarted.listPendingOutboxMessages()).map((item) => item.id)).toEqual([
        "outbox-create",
      ]);
    } finally {
      driver.close();
    }
  });

  it("rejects stale versioned updates with a persisted compare-and-swap", async () => {
    const { driver, repository } = openRepository();
    try {
      const created = await repository.createTaskV2(task());
      const updated = await repository.updateTaskV2({ ...created, version: 2 });
      expect(updated.version).toBe(2);

      await expect(repository.updateTaskV2({ ...created, version: 2 })).rejects.toThrow(ConflictError);
      expect((await repository.getTaskV2(created.id))?.version).toBe(2);
    } finally {
      driver.close();
    }
  });

  it("limits authorization CAS updates to consumption or revocation fields", async () => {
    const { driver, repository } = openRepository();
    try {
      const authorization: AuthorizationInstance = {
        id: "authorization-sqlite-1",
        principal: "principal-1",
        taskId: "task-sqlite-1",
        taskVersion: 1,
        effectClass: "READ",
        maxScope: ["workspace/**"],
        useLimit: 2,
        consumedCount: 0,
        expiry: new Date(Date.now() + 60_000).toISOString() as Rfc3339Timestamp,
        humanApprovalId: null,
        approvalHash: null,
      };
      await repository.createAuthorization(authorization);

      await expect(
        repository.updateAuthorization({
          ...authorization,
          consumedCount: 1,
          principal: "different-principal",
        }),
      ).rejects.toThrow(ConflictError);

      const consumed = await repository.updateAuthorization({ ...authorization, consumedCount: 1 });
      await expect(
        repository.updateAuthorization({
          ...consumed,
          useLimit: 1,
          effectClass: "WRITE",
        }),
      ).rejects.toThrow(ConflictError);

      const revoked = await repository.updateAuthorization({ ...consumed, useLimit: 1 });
      expect(revoked.useLimit).toBe(1);
      expect(revoked.consumedCount).toBe(1);
    } finally {
      driver.close();
    }
  });

  it("keeps inbox idempotency durable and rejects a reused key with a different payload", async () => {
    const { driver, repository } = openRepository();
    try {
      const inbox = new TransactionalInbox(repository, () => "inbox-1", nowTimestamp);
      let executions = 0;
      const first = await inbox.process(
        "command-1",
        "worker-1",
        "task.start",
        { taskId: "task-sqlite-1" },
        async () => {
          executions += 1;
          return "started";
        },
      );
      expect(first).toEqual({ duplicate: false, result: "started" });

      const restarted = new SqliteDurableTaskRepository(new SqliteDatabaseAdapter(driver));
      const duplicate = await new TransactionalInbox(restarted).process(
        "command-1",
        "worker-1",
        "task.start",
        { taskId: "task-sqlite-1" },
        async () => {
          executions += 1;
          return "should-not-run";
        },
      );
      expect(duplicate).toEqual({ duplicate: true });
      expect(executions).toBe(1);

      await expect(
        new TransactionalInbox(restarted).process(
          "command-1",
          "worker-1",
          "task.start",
          { taskId: "different-task" },
          async () => "should-not-run",
        ),
      ).rejects.toThrow(IdempotencyConflictError);
    } finally {
      driver.close();
    }
  });

  it("allocates sequence and epoch values atomically and durably", async () => {
    const { driver, repository } = openRepository();
    try {
      const allocated = await Promise.all([
        repository.nextSequence("task-sqlite-1"),
        repository.nextSequence("task-sqlite-1"),
        repository.nextSequence("task-sqlite-1"),
      ]);
      expect(allocated.sort((left, right) => left - right)).toEqual([1, 2, 3]);
      expect(await repository.nextEpoch("task-sqlite-1")).toBe(1);

      const restarted = new SqliteDurableTaskRepository(new SqliteDatabaseAdapter(driver));
      expect(await restarted.nextSequence("task-sqlite-1")).toBe(4);
      expect(await restarted.nextEpoch("task-sqlite-1")).toBe(2);
    } finally {
      driver.close();
    }
  });
});
