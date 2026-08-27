/**
 * DB-backed provider-attempt recovery tests.
 *
 * An in-flight provider request may have been accepted after the control
 * process lost its response. Recovery must make the attempt and task
 * interruption durable in one transaction, then skip the row on replay.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const WORKSPACE_ID = "workspace-provider-recovery";
const SESSION_ID = "session-provider-recovery";
const THREAD_ID = "thread-provider-recovery";
const TASK_ID = "task-provider-recovery";
const TURN_ID = "turn-provider-recovery";
const ATTEMPT_ID = "attempt-provider-recovery";
const PROVIDER_IDEMPOTENCY_KEY = "provider-attempt:attempt-provider-recovery";
const REQUEST_FINGERPRINT = `sha256:${"1".repeat(64)}`;
const IN_FLIGHT_STATUSES = new Set(["running", "submitted", "streaming", "starting"]);

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

function withDatabase(testBody: (db: Database) => Promise<void>): Promise<void> {
  const testDir = join(tmpdir(), `terminus-provider-recovery-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

function seedLineage(db: Database, attemptStatus = "streaming"): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(WORKSPACE_ID, "local_directory", "file:///workspace", "/workspace-provider-recovery", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, WORKSPACE_ID, "tester", "provider recovery", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(THREAD_ID, SESSION_ID, "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(TASK_ID, SESSION_ID, THREAD_ID, "ACTIVE", "EXECUTE", "{}", "sha256:scope", now, now);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(TURN_ID, THREAD_ID, TASK_ID, 1, "PROVIDER_RUNNING", "agent", now);
  db.query(
    `INSERT INTO provider_attempts (
      id, turn_id, attempt_number, provider_id, model_key,
      capability_snapshot_hash, context_manifest_id, request_artifact,
      request_fingerprint, provider_idempotency_key, provider_request_id,
      continuation_id, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ATTEMPT_ID,
    TURN_ID,
    1,
    "open_code_zen",
    "open_code_zen/hy3-free",
    `sha256:${"2".repeat(64)}`,
    "manifest-provider-recovery",
    `artifact://sha256/${"3".repeat(64)}`,
    REQUEST_FINGERPRINT,
    PROVIDER_IDEMPOTENCY_KEY,
    null,
    null,
    attemptStatus,
    now,
  );
  db.query(
    `INSERT INTO semantic_events (
      event_id, event_type, schema_version, aggregate_type, aggregate_id,
      aggregate_sequence, occurred_at, actor_json, correlation_id,
      causation_id, idempotency_key, payload_json, artifact_refs_json, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "event-provider-running",
    "turn.provider_running",
    1,
    "turn",
    TURN_ID,
    1,
    now,
    JSON.stringify({ kind: "system", id: "test" }),
    TASK_ID,
    null,
    PROVIDER_IDEMPOTENCY_KEY,
    JSON.stringify({ provider_attempt_id: ATTEMPT_ID, status: "running" }),
    JSON.stringify([`artifact://sha256/${"3".repeat(64)}`]),
    null,
  );
}

function recoverInFlightProviderAttempt(db: Database, injectFailure = false): boolean {
  const attempt = db.query(
    `SELECT id, turn_id, status, provider_idempotency_key, request_fingerprint, request_artifact
     FROM provider_attempts WHERE status IN ('running', 'submitted', 'streaming', 'starting')
     ORDER BY started_at, id LIMIT 1`,
  ).get() as {
    id: string;
    turn_id: string;
    status: string;
    provider_idempotency_key: string | null;
    request_fingerprint: string | null;
    request_artifact: string;
  } | null;
  if (attempt === null || !IN_FLIGHT_STATUSES.has(attempt.status.toLowerCase())) return false;

  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.query("SELECT status FROM provider_attempts WHERE id = ?").get(attempt.id) as { status: string } | null;
    if (current === null || !IN_FLIGHT_STATUSES.has(current.status.toLowerCase())) {
      db.exec("ROLLBACK");
      return false;
    }
    const now = Date.now();
    const sequence = db.query(
      "SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence FROM semantic_events WHERE aggregate_type = 'turn' AND aggregate_id = ?",
    ).get(attempt.turn_id) as { next_sequence: number };
    db.query(
      `INSERT INTO semantic_events (
        event_id, event_type, schema_version, aggregate_type, aggregate_id,
        aggregate_sequence, occurred_at, actor_json, correlation_id,
        causation_id, idempotency_key, payload_json, artifact_refs_json, trace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "event-provider-recovery",
      "turn.recovery_interrupted",
      1,
      "turn",
      attempt.turn_id,
      sequence.next_sequence,
      now,
      JSON.stringify({ kind: "system", id: "terminus-control" }),
      TASK_ID,
      null,
      `provider-recovery:${attempt.id}`,
      JSON.stringify({
        previous_state: "PROVIDER_RUNNING",
        state: "INTERRUPTED",
        reason: "provider_attempt_in_flight_on_process_restart",
        reconciliation_required: true,
        provider_attempt_id: attempt.id,
        provider_idempotency_key: attempt.provider_idempotency_key,
        request_fingerprint: attempt.request_fingerprint,
      }),
      JSON.stringify([attempt.request_artifact]),
      null,
    );
    const attemptUpdate = db.query(
      `UPDATE provider_attempts
       SET status = 'interrupted', completed_at = ?,
           error_json = ?
       WHERE id = ? AND status IN ('running', 'submitted', 'streaming', 'starting')`,
    ).run(
      now,
      JSON.stringify({
        reason: "process_restart_before_provider_response",
        reconciliation_required: true,
        provider_idempotency_key: attempt.provider_idempotency_key,
      }),
      attempt.id,
    );
    if (attemptUpdate.changes !== 1) throw new Error("provider attempt changed during recovery");

    const turnUpdate = db.query(
      `UPDATE turns SET state = 'INTERRUPTED', completed_at = ?, terminal_error_json = ?
       WHERE id = ? AND state IN ('PENDING', 'CONTEXT_COMPILING', 'PROVIDER_RUNNING', 'RESPONSE_VALIDATING', 'TOOL_SETTLEMENT', 'VERIFYING', 'REPAIRING', 'FINALIZING')`,
    ).run(
      now,
      JSON.stringify({
        reason: "provider_attempt_in_flight_on_process_restart",
        provider_attempt_id: attempt.id,
        reconciliation_required: true,
      }),
      attempt.turn_id,
    );
    if (turnUpdate.changes !== 1) throw new Error("turn changed during provider recovery");

    db.query(
      `UPDATE tasks SET status = 'BLOCKED', phase = 'IMPLEMENT', completed_at = NULL,
       terminal_reason_json = ?, updated_at = ?
       WHERE id = ? AND status IN ('ACTIVE', 'VERIFYING')`,
    ).run(
      JSON.stringify({
        reason: "provider_recovery_required",
        provider_attempt_id: attempt.id,
        turn_id: attempt.turn_id,
        reconciliation_required: true,
      }),
      now,
      TASK_ID,
    );
    if (injectFailure) throw new Error("injected crash before provider recovery commit");
    db.exec("COMMIT");
    return true;
  } catch (error: unknown) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("DB-backed provider-attempt recovery", () => {
  test("rolls back the recovery event and state changes together", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        expect(() => recoverInFlightProviderAttempt(db, true)).toThrow(
          "injected crash before provider recovery commit",
        );
        expect(db.query("SELECT status FROM provider_attempts WHERE id = ?").get(ATTEMPT_ID)).toEqual({ status: "streaming" });
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(TURN_ID)).toEqual({ state: "PROVIDER_RUNNING" });
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "ACTIVE" });
        expect(db.query(
          "SELECT COUNT(*) AS count FROM semantic_events WHERE event_type = 'turn.recovery_interrupted'",
        ).get()).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  test("interrupts and blocks an in-flight attempt, then replays without another recovery event", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        expect(recoverInFlightProviderAttempt(db)).toBe(true);
        expect(db.query("SELECT status FROM provider_attempts WHERE id = ?").get(ATTEMPT_ID)).toEqual({ status: "interrupted" });
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(TURN_ID)).toEqual({ state: "INTERRUPTED" });
        expect(db.query("SELECT status, phase FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "BLOCKED", phase: "IMPLEMENT" });
        expect(db.query(
          "SELECT idempotency_key, payload_json FROM semantic_events WHERE event_type = 'turn.recovery_interrupted'",
        ).get()).toEqual({
          idempotency_key: `provider-recovery:${ATTEMPT_ID}`,
          payload_json: JSON.stringify({
            previous_state: "PROVIDER_RUNNING",
            state: "INTERRUPTED",
            reason: "provider_attempt_in_flight_on_process_restart",
            reconciliation_required: true,
            provider_attempt_id: ATTEMPT_ID,
            provider_idempotency_key: PROVIDER_IDEMPOTENCY_KEY,
            request_fingerprint: REQUEST_FINGERPRINT,
          }),
        });
        expect(recoverInFlightProviderAttempt(db)).toBe(false);
        expect(db.query(
          "SELECT COUNT(*) AS count FROM semantic_events WHERE event_type = 'turn.recovery_interrupted'",
        ).get()).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    });
  });

  test("does not emit recovery evidence for an attempt already settled", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db, "completed");
        db.query(
          "UPDATE provider_attempts SET response_artifact = ?, completed_at = ? WHERE id = ?",
        ).run(`artifact://sha256/${"4".repeat(64)}`, Date.now(), ATTEMPT_ID);
        expect(recoverInFlightProviderAttempt(db)).toBe(false);
        expect(db.query(
          "SELECT COUNT(*) AS count FROM semantic_events WHERE event_type = 'turn.recovery_interrupted'",
        ).get()).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });
});
