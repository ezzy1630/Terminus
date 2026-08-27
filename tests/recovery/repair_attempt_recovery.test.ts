/**
 * DB-backed verification-repair crash and replay tests.
 *
 * These tests exercise the same SQLite transaction boundaries used by the
 * control plane: durable schedule intent, parent/child admission, and fenced
 * continuation claims. They intentionally do not import the process-owning
 * control entrypoint, so the database invariants remain testable in isolation.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const DIRECTIVE_ARTIFACT = `artifact://sha256/${"a".repeat(64)}`;
const LEASE_KEY = "terminus-repair-attempt:attempt-1";

type QueryRow = Record<string, unknown>;

async function migrate(dbPath: string): Promise<void> {
  const process = Bun.spawn(["bun", "run", "scripts/migrate.ts"], {
    cwd: ROOT,
    env: { ...globalThis.process.env, DATABASE_URL: `file:${dbPath}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`migration failed with exit code ${exitCode}`);
}

function transaction<T>(db: Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the injected failure */ }
    throw error;
  }
}

function seedLineage(db: Database, parentState = "VERIFYING"): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("workspace-repair-recovery", "local_directory", "file:///workspace", "/workspace-repair-recovery", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("session-repair-recovery", "workspace-repair-recovery", "tester", "repair recovery", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("thread-repair-recovery", "session-repair-recovery", "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("task-repair-recovery", "session-repair-recovery", "thread-repair-recovery", "VERIFYING", "VERIFY", "{}", "sha256:scope", now, now);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("turn-repair-parent", "thread-repair-recovery", "task-repair-recovery", 1, parentState, "agent");
}

function appendEvent(
  db: Database,
  input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly aggregateSequence: number;
    readonly occurredAt: number;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): void {
  db.query(
    `INSERT OR IGNORE INTO semantic_events (
      event_id, event_type, schema_version, aggregate_type, aggregate_id,
      aggregate_sequence, occurred_at, actor_json, correlation_id, causation_id,
      idempotency_key, payload_json, artifact_refs_json, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.eventType,
    1,
    input.aggregateType,
    input.aggregateId,
    input.aggregateSequence,
    input.occurredAt,
    "{}",
    "task-repair-recovery",
    null,
    null,
    JSON.stringify(input.payload),
    "[]",
    null,
  );
}

function persistScheduledRepair(db: Database, now: number): void {
  db.query(
    "UPDATE tasks SET status = 'ACTIVE', phase = 'EXECUTE', updated_at = ? WHERE id = 'task-repair-recovery' AND status = 'VERIFYING'",
  ).run(now);
  appendEvent(db, {
    eventId: "event-repair-scheduled",
    eventType: "task.repair_scheduled",
    aggregateType: "task",
    aggregateId: "task-repair-recovery",
    aggregateSequence: 1,
    occurredAt: now,
    payload: {
      repair_attempt: 1,
      repair_attempt_id: "attempt-1",
      directive_artifact: DIRECTIVE_ARTIFACT,
    },
  });
  db.query(
    "INSERT INTO leases (lease_key, owner_instance, fencing_token, acquired_at, expires_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(LEASE_KEY, "unclaimed", 0, now, 0, JSON.stringify({ role: "verification-repair" }));
  db.query(
    `INSERT INTO repair_attempts (
      id, task_id, parent_turn_id, lease_key, attempt_number, max_attempts,
      state, directive_artifact, failed_node_ids_json, failure_signatures_json,
      changed_files_json, source_revision, environment_digest, remaining_budget_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "attempt-1",
    "task-repair-recovery",
    "turn-repair-parent",
    LEASE_KEY,
    1,
    2,
    "PENDING",
    DIRECTIVE_ARTIFACT,
    '["verify-tests"]',
    '["sig-1"]',
    '["src/calc.ts"]',
    "git:source-1",
    "sha256:environment-1",
    '{"remaining_attempts":1}',
    now,
  );
}

function recoverParent(db: Database, now: number): void {
  transaction(db, () => {
    db.query(
      "UPDATE turns SET state = 'REPAIR_PENDING' WHERE id = 'turn-repair-parent' AND state = 'VERIFYING'",
    ).run();
    appendEvent(db, {
      eventId: "event-repair-pending",
      eventType: "turn.repair_pending",
      aggregateType: "turn",
      aggregateId: "turn-repair-parent",
      aggregateSequence: 1,
      occurredAt: now,
      payload: { repair_attempt_id: "attempt-1", state: "REPAIR_PENDING" },
    });
  });
}

function admitRepairChild(db: Database, now: number): void {
  transaction(db, () => {
    const attempt = db.query(
      "SELECT repair_turn_id FROM repair_attempts WHERE id = 'attempt-1'",
    ).get() as QueryRow | null;
    const existingChild = typeof attempt?.repair_turn_id === "string" ? attempt.repair_turn_id : null;
    const repairTurnId = existingChild ?? "turn-repair-child";
    if (existingChild === null) {
      db.query(
        "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor, initiating_input_artifact) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(repairTurnId, "thread-repair-recovery", "task-repair-recovery", 2, "REPAIRING", "repair-controller", DIRECTIVE_ARTIFACT);
      const associated = db.query(
        "UPDATE repair_attempts SET repair_turn_id = ?, state = 'ADMITTED' WHERE id = 'attempt-1' AND repair_turn_id IS NULL AND state IN ('PENDING', 'ADMITTED')",
      ).run(repairTurnId);
      if (associated.changes !== 1) throw new Error("repair child association was not admitted");
    }
    appendEvent(db, {
      eventId: "event-repairing-child",
      eventType: "turn.repairing",
      aggregateType: "turn",
      aggregateId: repairTurnId,
      aggregateSequence: 1,
      occurredAt: now,
      payload: { repair_attempt_id: "attempt-1", state: "REPAIRING" },
    });
  });
}

function supersedeRepairParent(db: Database, now: number): void {
  transaction(db, () => {
    const changed = db.query(
      "UPDATE turns SET state = 'ABORTED', completed_at = ? WHERE id = 'turn-repair-parent' AND state = 'REPAIR_PENDING'",
    ).run(now);
    if (changed.changes !== 1) return;
    appendEvent(db, {
      eventId: "event-repair-parent-superseded",
      eventType: "turn.superseded",
      aggregateType: "turn",
      aggregateId: "turn-repair-parent",
      aggregateSequence: 2,
      occurredAt: now,
      payload: { repair_attempt_id: "attempt-1", repair_turn_id: "turn-repair-child" },
    });
  });
}

type LeaseClaim = { readonly owner: string; readonly fencingToken: number };

function claimRepair(
  db: Database,
  owner: string,
  now: number,
  leaseDurationMs: number,
): LeaseClaim | null {
  return transaction(db, () => {
    const row = db.query(
      `SELECT repair_attempts.state, repair_attempts.repair_turn_id,
              leases.owner_instance, leases.fencing_token, leases.expires_at
         FROM repair_attempts
         JOIN leases ON leases.lease_key = repair_attempts.lease_key
        WHERE repair_attempts.id = 'attempt-1'`,
    ).get() as QueryRow | null;
    if (row === null || typeof row.repair_turn_id !== "string") return null;
    if (row.state === "SUCCEEDED" || row.state === "FAILED" || row.state === "BLOCKED" || row.state === "ABORTED" || row.state === "SUPERSEDED") return null;
    if (typeof row.expires_at !== "number" || row.expires_at > now) return null;
    if (typeof row.fencing_token !== "number") throw new Error("repair lease token was not numeric");
    const nextToken = row.fencing_token + 1;
    const expiresAt = now + leaseDurationMs;
    const leased = db.query(
      `UPDATE leases
          SET owner_instance = ?, fencing_token = ?, acquired_at = ?, expires_at = ?
        WHERE lease_key = ? AND owner_instance = ? AND fencing_token = ? AND expires_at = ?`,
    ).run(owner, nextToken, now, expiresAt, LEASE_KEY, row.owner_instance, row.fencing_token, row.expires_at);
    if (leased.changes !== 1) return null;
    const running = db.query(
      "UPDATE repair_attempts SET state = 'RUNNING', started_at = ? WHERE id = 'attempt-1' AND repair_turn_id IS NOT NULL AND state IN ('PENDING', 'ADMITTED', 'RUNNING')",
    ).run(now);
    if (running.changes !== 1) throw new Error("repair attempt changed during claim");
    return { owner, fencingToken: nextToken };
  });
}

function settleRepair(
  db: Database,
  claim: LeaseClaim,
  state: "SUCCEEDED" | "FAILED",
  observedAt: number,
): number {
  return transaction(db, () => db.query(
    `UPDATE repair_attempts
        SET state = ?, completed_at = ?, terminal_reason_json = ?
      WHERE id = 'attempt-1' AND state = 'RUNNING'
        AND EXISTS (
          SELECT 1 FROM leases
           WHERE leases.lease_key = repair_attempts.lease_key
             AND leases.owner_instance = ?
             AND leases.fencing_token = ?
             AND leases.expires_at > ?
        )`,
  ).run(state, observedAt, JSON.stringify({ reason: "repair_turn_completed" }), claim.owner, claim.fencingToken, observedAt).changes);
}

function withDatabase<T>(testBody: (db: Database) => Promise<T>): Promise<T> {
  const testDir = join(tmpdir(), `terminus-repair-recovery-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

describe("DB-backed verification-repair recovery", () => {
  test("rolls back schedule intent and its event together", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        expect(() => transaction(db, () => {
          persistScheduledRepair(db, Date.now());
          throw new Error("injected crash before schedule commit");
        })).toThrow("injected crash before schedule commit");

        const task = db.query("SELECT status FROM tasks WHERE id = 'task-repair-recovery'").get() as QueryRow;
        expect(task.status).toBe("VERIFYING");
        expect(db.query("SELECT COUNT(*) AS count FROM repair_attempts").get() as QueryRow).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM leases").get() as QueryRow).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events").get() as QueryRow).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  test("replays parent and child admission without duplicate rows or events", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        const now = Date.now();
        transaction(db, () => persistScheduledRepair(db, now));
        recoverParent(db, now + 1);
        admitRepairChild(db, now + 2);
        admitRepairChild(db, now + 3);
        supersedeRepairParent(db, now + 4);
        supersedeRepairParent(db, now + 5);

        expect(db.query("SELECT COUNT(*) AS count FROM repair_attempts WHERE id = 'attempt-1'").get() as QueryRow).toEqual({ count: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM turns WHERE initiating_actor = 'repair-controller'").get() as QueryRow).toEqual({ count: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_type IN ('task.repair_scheduled', 'turn.repair_pending', 'turn.repairing', 'turn.superseded')").get() as QueryRow).toEqual({ count: 4 });
        const attempt = db.query("SELECT state, repair_turn_id FROM repair_attempts WHERE id = 'attempt-1'").get() as QueryRow;
        expect(attempt).toEqual({ state: "ADMITTED", repair_turn_id: "turn-repair-child" });
        const parent = db.query("SELECT state FROM turns WHERE id = 'turn-repair-parent'").get() as QueryRow;
        expect(parent.state).toBe("ABORTED");
      } finally {
        db.close();
      }
    });
  });

  test("fences a stale claimant before allowing replay after lease expiry", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db, "REPAIR_PENDING");
        const now = Date.now();
        transaction(db, () => {
          persistScheduledRepair(db, now);
          db.query("UPDATE tasks SET status = 'ACTIVE', phase = 'EXECUTE' WHERE id = 'task-repair-recovery'").run();
          db.query(
            "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor, initiating_input_artifact) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run("turn-repair-child", "thread-repair-recovery", "task-repair-recovery", 2, "REPAIRING", "repair-controller", DIRECTIVE_ARTIFACT);
          db.query("UPDATE repair_attempts SET repair_turn_id = ?, state = 'ADMITTED' WHERE id = 'attempt-1'").run("turn-repair-child");
        });

        const first = claimRepair(db, "control-a", now + 1, 5_000);
        expect(first).toEqual({ owner: "control-a", fencingToken: 1 });
        expect(claimRepair(db, "control-b", now + 2, 5_000)).toBeNull();

        db.query("UPDATE leases SET expires_at = ? WHERE lease_key = ?").run(now + 3, LEASE_KEY);
        expect(settleRepair(db, first!, "SUCCEEDED", now + 4)).toBe(0);
        const second = claimRepair(db, "control-b", now + 4, 5_000);
        expect(second).toEqual({ owner: "control-b", fencingToken: 2 });
        expect(settleRepair(db, second!, "SUCCEEDED", now + 5)).toBe(1);

        const attempt = db.query("SELECT state FROM repair_attempts WHERE id = 'attempt-1'").get() as QueryRow;
        expect(attempt.state).toBe("SUCCEEDED");
        const lease = db.query("SELECT owner_instance, fencing_token FROM leases WHERE lease_key = ?").get(LEASE_KEY) as QueryRow;
        expect(lease).toEqual({ owner_instance: "control-b", fencing_token: 2 });
      } finally {
        db.close();
      }
    });
  });
});
