/**
 * DB-backed proposal and cancellation crash/replay tests.
 *
 * A completion proposal is evidence of model intent, never a completion
 * claim. Cancellation is one logical task transition: all active turns,
 * their abort events, the task row, and the task event must commit or roll
 * back together.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const WORKSPACE_ID = "workspace-proposal-cancel-recovery";
const SESSION_ID = "session-proposal-cancel-recovery";
const THREAD_ID = "thread-proposal-cancel-recovery";
const TASK_ID = "task-proposal-cancel-recovery";
const PROPOSAL_TURN_ID = "turn-proposal-recovery";
const CANCEL_TURN_IDS = ["turn-cancel-provider", "turn-cancel-repair"] as const;
const PROPOSAL_EVENT_ID = "event-completion-proposal-recovery";
const PROPOSAL_RECOVERY_EVENT_ID = "event-proposal-recovery-interrupted";
const CANCEL_EVENT_IDS = [
  "event-cancel-turn-provider",
  "event-cancel-turn-repair",
  "event-cancel-task",
] as const;

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

function appendEvent(
  db: Database,
  input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly aggregateSequence: number;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly idempotencyKey?: string | null;
  },
): void {
  db.query(
    `INSERT INTO semantic_events (
      event_id, event_type, schema_version, aggregate_type, aggregate_id,
      aggregate_sequence, occurred_at, actor_json, correlation_id,
      causation_id, idempotency_key, payload_json, artifact_refs_json, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.eventType,
    1,
    input.aggregateType,
    input.aggregateId,
    input.aggregateSequence,
    Date.now(),
    "{}",
    TASK_ID,
    null,
    input.idempotencyKey ?? null,
    JSON.stringify(input.payload),
    "[]",
    null,
  );
}

function seedBase(db: Database): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(WORKSPACE_ID, "local_directory", "file:///workspace", "/workspace-proposal-cancel-recovery", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, WORKSPACE_ID, "tester", "proposal and cancellation recovery", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(THREAD_ID, SESSION_ID, "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(TASK_ID, SESSION_ID, THREAD_ID, "ACTIVE", "IMPLEMENT", "{}", "sha256:scope", now, now);
}

function seedProposalTurn(db: Database): void {
  seedBase(db);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(PROPOSAL_TURN_ID, THREAD_ID, TASK_ID, 1, "RESPONSE_VALIDATING", "agent");
}

function publishCompletionProposal(db: Database, injectFailure = false): void {
  transaction(db, () => {
    appendEvent(db, {
      eventId: PROPOSAL_EVENT_ID,
      eventType: "completion.proposed",
      aggregateType: "turn",
      aggregateId: PROPOSAL_TURN_ID,
      aggregateSequence: 1,
      payload: {
        status: "PROPOSED",
        response_artifact: `artifact://sha256/${"a".repeat(64)}`,
      },
    });
    if (injectFailure) throw new Error("injected crash after completion proposal publication");
  });
}

function reconcileProposedTurn(db: Database): boolean {
  const turn = db.query(
    "SELECT state FROM turns WHERE id = ? AND state = 'RESPONSE_VALIDATING'",
  ).get(PROPOSAL_TURN_ID) as QueryRow | null;
  if (turn === null) return false;

  return transaction(db, () => {
    appendEvent(db, {
      eventId: PROPOSAL_RECOVERY_EVENT_ID,
      eventType: "turn.recovery_interrupted",
      aggregateType: "turn",
      aggregateId: PROPOSAL_TURN_ID,
      aggregateSequence: 2,
      idempotencyKey: `proposal-recovery:${PROPOSAL_TURN_ID}`,
      payload: {
        previous_state: "RESPONSE_VALIDATING",
        state: "INTERRUPTED",
        reason: "process_restart_after_work_began",
        reconciliation_required: true,
      },
    });
    const interrupted = db.query(
      "UPDATE turns SET state = 'INTERRUPTED', completed_at = ?, terminal_error_json = ? WHERE id = ? AND state = 'RESPONSE_VALIDATING'",
    ).run(Date.now(), JSON.stringify({
      reason: "process_restart_after_work_began",
      previous_state: "RESPONSE_VALIDATING",
      reconciliation_required: true,
    }), PROPOSAL_TURN_ID);
    if (interrupted.changes !== 1) throw new Error("proposal turn changed during recovery");
    const blocked = db.query(
      "UPDATE tasks SET status = 'BLOCKED', phase = 'IMPLEMENT', completed_at = NULL, terminal_reason_json = ? WHERE id = ? AND status IN ('ACTIVE', 'VERIFYING')",
    ).run(JSON.stringify({
      reason: "startup_reconciliation_required",
      turn_id: PROPOSAL_TURN_ID,
      previous_turn_state: "RESPONSE_VALIDATING",
    }), TASK_ID);
    if (blocked.changes !== 1) throw new Error("proposal task changed during recovery");
    return true;
  });
}

function seedCancellationTurns(db: Database): void {
  seedBase(db);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(CANCEL_TURN_IDS[0], THREAD_ID, TASK_ID, 1, "PROVIDER_RUNNING", "agent");
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(CANCEL_TURN_IDS[1], THREAD_ID, TASK_ID, 2, "REPAIR_PENDING", "agent");
}

function cancelTask(db: Database, injectFailure = false): boolean {
  const task = db.query(
    "SELECT status FROM tasks WHERE id = ? AND status IN ('DRAFT', 'ACTIVE', 'NEEDS_USER_DECISION', 'BLOCKED', 'VERIFYING')",
  ).get(TASK_ID) as QueryRow | null;
  if (task === null) return false;

  return transaction(db, () => {
    const turns = db.query(
      "SELECT id, state FROM turns WHERE task_id = ? AND state IN ('PENDING', 'CONTEXT_COMPILING', 'PROVIDER_RUNNING', 'RESPONSE_VALIDATING', 'TOOL_SETTLEMENT', 'VERIFYING', 'REPAIRING', 'FINALIZING', 'REPAIR_PENDING') ORDER BY sequence ASC",
    ).all(TASK_ID) as QueryRow[];
    for (const [index, turn] of turns.entries()) {
      const turnId = String(turn.id);
      const previousState = String(turn.state);
      appendEvent(db, {
        eventId: CANCEL_EVENT_IDS[index] ?? `event-cancel-turn-${turnId}`,
        eventType: "turn.aborted",
        aggregateType: "turn",
        aggregateId: turnId,
        aggregateSequence: 1,
        idempotencyKey: `task-cancel:${TASK_ID}:turn:${turnId}`,
        payload: { reason: "user_cancelled", previous_state: previousState, phase: previousState },
      });
      const updated = db.query(
        "UPDATE turns SET state = 'ABORTED', completed_at = ?, terminal_error_json = ? WHERE id = ? AND task_id = ? AND state IN ('PENDING', 'CONTEXT_COMPILING', 'PROVIDER_RUNNING', 'RESPONSE_VALIDATING', 'TOOL_SETTLEMENT', 'VERIFYING', 'REPAIRING', 'FINALIZING', 'REPAIR_PENDING')",
      ).run(Date.now(), JSON.stringify({ reason: "user_cancelled", cancellation: true }), turnId, TASK_ID);
      if (updated.changes !== 1) throw new Error(`turn ${turnId} changed during cancellation`);
    }
    appendEvent(db, {
      eventId: CANCEL_EVENT_IDS[2],
      eventType: "task.aborted",
      aggregateType: "task",
      aggregateId: TASK_ID,
      aggregateSequence: 1,
      idempotencyKey: `task-cancel:${TASK_ID}`,
      payload: { reason: "user_cancelled", turn_ids: turns.map((turn) => String(turn.id)) },
    });
    if (injectFailure) throw new Error("injected crash before task cancellation commit");
    const updatedTask = db.query(
      "UPDATE tasks SET status = 'ABORTED', completed_at = ?, terminal_reason_json = ? WHERE id = ? AND status IN ('DRAFT', 'ACTIVE', 'NEEDS_USER_DECISION', 'BLOCKED', 'VERIFYING')",
    ).run(Date.now(), JSON.stringify({ reason: "user_cancelled" }), TASK_ID);
    if (updatedTask.changes !== 1) throw new Error("task changed during cancellation");
    return true;
  });
}

function withDatabase(testBody: (db: Database) => Promise<void>): Promise<void> {
  const testDir = join(tmpdir(), `terminus-proposal-cancel-recovery-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

describe("DB-backed proposal and cancellation recovery", () => {
  test("keeps a completion proposal non-terminal and quarantines it after restart", async () => {
    await withDatabase(async (db) => {
      try {
        seedProposalTurn(db);
        expect(() => publishCompletionProposal(db, true)).toThrow("injected crash after completion proposal publication");
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(PROPOSAL_TURN_ID)).toEqual({ state: "RESPONSE_VALIDATING" });
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "ACTIVE" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(PROPOSAL_EVENT_ID)).toEqual({ count: 0 });

        publishCompletionProposal(db);
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(PROPOSAL_EVENT_ID)).toEqual({ count: 1 });
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "ACTIVE" });
        expect(db.query("SELECT COUNT(*) AS count FROM completion_records WHERE task_id = ?").get(TASK_ID)).toEqual({ count: 0 });

        expect(reconcileProposedTurn(db)).toBe(true);
        expect(reconcileProposedTurn(db)).toBe(false);
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(PROPOSAL_TURN_ID)).toEqual({ state: "INTERRUPTED" });
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "BLOCKED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE aggregate_id = ?").get(PROPOSAL_TURN_ID)).toEqual({ count: 2 });
      } finally {
        db.close();
      }
    });
  });

  test("rolls back every turn/task cancellation row and event together", async () => {
    await withDatabase(async (db) => {
      try {
        seedCancellationTurns(db);
        expect(() => cancelTask(db, true)).toThrow("injected crash before task cancellation commit");
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "ACTIVE" });
        expect(db.query("SELECT id, state FROM turns WHERE task_id = ? ORDER BY sequence").all(TASK_ID)).toEqual([
          { id: CANCEL_TURN_IDS[0], state: "PROVIDER_RUNNING" },
          { id: CANCEL_TURN_IDS[1], state: "REPAIR_PENDING" },
        ]);
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE aggregate_id IN (?, ?, ?)").get(
          CANCEL_TURN_IDS[0], CANCEL_TURN_IDS[1], TASK_ID,
        )).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  test("makes committed cancellation replay-safe without re-emitting abort events", async () => {
    await withDatabase(async (db) => {
      try {
        seedCancellationTurns(db);
        expect(cancelTask(db)).toBe(true);
        expect(cancelTask(db)).toBe(false);
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "ABORTED" });
        expect(db.query("SELECT id, state FROM turns WHERE task_id = ? ORDER BY sequence").all(TASK_ID)).toEqual([
          { id: CANCEL_TURN_IDS[0], state: "ABORTED" },
          { id: CANCEL_TURN_IDS[1], state: "ABORTED" },
        ]);
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE aggregate_id IN (?, ?, ?)").get(
          CANCEL_TURN_IDS[0], CANCEL_TURN_IDS[1], TASK_ID,
        )).toEqual({ count: 3 });
        expect(db.query("SELECT idempotency_key FROM semantic_events WHERE event_id = ?").get(CANCEL_EVENT_IDS[2])).toEqual({
          idempotency_key: `task-cancel:${TASK_ID}`,
        });
      } finally {
        db.close();
      }
    });
  });
});
