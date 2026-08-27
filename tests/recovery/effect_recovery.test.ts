/**
 * DB-backed external-effect recovery tests.
 *
 * These tests model the control-plane transaction around an ambiguous kernel
 * receipt. Recovery must either roll back completely, or persist the tool
 * UNKNOWN state, effect MANUAL_REVIEW state, and recovery event together.
 * Replaying recovery must not append a second event or retry the effect.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const TASK_ID = "task-effect-recovery";
const THREAD_ID = "thread-effect-recovery";
const TURN_ID = "turn-effect-recovery";
const TOOL_CALL_ID = "tool-call-effect-recovery";
const EFFECT_ID = "effect-effect-recovery";
const EVENT_ID = "event-effect-recovery";
const EFFECT_IDEMPOTENCY_KEY = "effect-operation-recovery";
const RECOVERY_IDEMPOTENCY_KEY = `effect-recovery:${EFFECT_ID}`;

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

function seedLineage(db: Database, effectState = "STARTED", toolState = "STARTED"): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("workspace-effect-recovery", "local_directory", "file:///workspace", "/workspace-effect-recovery", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("session-effect-recovery", "workspace-effect-recovery", "tester", "effect recovery", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(THREAD_ID, "session-effect-recovery", "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "session-effect-recovery", THREAD_ID, "ACTIVE", "EXECUTE", "{}", "sha256:scope", now, now);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(TURN_ID, THREAD_ID, TASK_ID, 1, "TOOL_SETTLEMENT", "agent");
  db.query(
    `INSERT INTO tool_calls (
      id, turn_id, provider_attempt_id, tool_id, tool_version,
      arguments_artifact, normalized_operation_hash, state, proposed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TOOL_CALL_ID,
    TURN_ID,
    null,
    "patch",
    "v1",
    `artifact://sha256/${"a".repeat(64)}`,
    "sha256:operation",
    toolState,
    now,
  );
  db.query(
    `INSERT INTO side_effects (
      id, tool_call_id, effect_type, resource_uri, idempotency_key,
      state, reversibility, request_artifact, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EFFECT_ID,
    TOOL_CALL_ID,
    "WRITE_LOCAL",
    "workspace://src/file.ts",
    EFFECT_IDEMPOTENCY_KEY,
    effectState,
    "reversible",
    `artifact://sha256/${"b".repeat(64)}`,
    now,
  );
}

function appendUnknownEvent(db: Database, now: number): void {
  db.query(
    `INSERT INTO semantic_events (
      event_id, event_type, schema_version, aggregate_type, aggregate_id,
      aggregate_sequence, occurred_at, actor_json, correlation_id,
      causation_id, idempotency_key, payload_json, artifact_refs_json, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EVENT_ID,
    "tool.settlement_unknown",
    1,
    "tool_call",
    TOOL_CALL_ID,
    1,
    now,
    "{}",
    TASK_ID,
    null,
    RECOVERY_IDEMPOTENCY_KEY,
    JSON.stringify({
      tool_call_id: TOOL_CALL_ID,
      side_effect_id: EFFECT_ID,
      error: "process restarted before a trusted kernel receipt was persisted; manual reconciliation is required",
      reconciliation_required: true,
    }),
    "[]",
    null,
  );
}

function recoverUnsettledEffect(db: Database, injectFailure = false): boolean {
  const current = db.query(
    "SELECT id, state FROM side_effects WHERE id = ? AND state IN ('STARTED', 'UNKNOWN', 'RECONCILING')",
  ).get(EFFECT_ID) as QueryRow | null;
  if (current === null) return false;

  return transaction(db, () => {
    const now = Date.now();
    appendUnknownEvent(db, now);
    const effect = db.query(
      "UPDATE side_effects SET state = 'MANUAL_REVIEW', reconciliation_json = ? WHERE id = ? AND state IN ('STARTED', 'UNKNOWN', 'RECONCILING')",
    ).run(JSON.stringify({
      message: "process restarted before a trusted kernel receipt was persisted; manual reconciliation is required",
      reconciliation_required: true,
    }), EFFECT_ID);
    if (effect.changes !== 1) return false;
    db.query(
      "UPDATE tool_calls SET state = 'UNKNOWN', settled_at = ?, result_status = 'unknown', error_json = ? WHERE id = ? AND state IN ('AUTHORIZED', 'STARTED', 'UNKNOWN', 'RECONCILING')",
    ).run(now, JSON.stringify({
      message: "process restarted before a trusted kernel receipt was persisted; manual reconciliation is required",
      reconciliation_required: true,
    }), TOOL_CALL_ID);
    if (injectFailure) throw new Error("injected crash before effect recovery commit");
    return true;
  });
}

function withDatabase(testBody: (db: Database) => Promise<void>): Promise<void> {
  const testDir = join(tmpdir(), `terminus-effect-recovery-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

describe("DB-backed external-effect recovery", () => {
  test("rolls back the unknown event and both state transitions together", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        expect(() => recoverUnsettledEffect(db, true)).toThrow("injected crash before effect recovery commit");
        expect(db.query("SELECT state FROM side_effects WHERE id = ?").get(EFFECT_ID)).toEqual({ state: "STARTED" });
        expect(db.query("SELECT state FROM tool_calls WHERE id = ?").get(TOOL_CALL_ID)).toEqual({ state: "STARTED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(EVENT_ID)).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  test("persists one manual-review decision and replays without another event", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        expect(recoverUnsettledEffect(db)).toBe(true);
        expect(recoverUnsettledEffect(db)).toBe(false);
        expect(db.query("SELECT state, reconciliation_json FROM side_effects WHERE id = ?").get(EFFECT_ID)).toMatchObject({ state: "MANUAL_REVIEW" });
        expect(db.query("SELECT state, result_status FROM tool_calls WHERE id = ?").get(TOOL_CALL_ID)).toEqual({ state: "UNKNOWN", result_status: "unknown" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE aggregate_id = ?").get(TOOL_CALL_ID)).toEqual({ count: 1 });
        expect(db.query("SELECT idempotency_key FROM semantic_events WHERE event_id = ?").get(EVENT_ID)).toEqual({ idempotency_key: RECOVERY_IDEMPOTENCY_KEY });
        const payload = db.query("SELECT payload_json FROM semantic_events WHERE event_id = ?").get(EVENT_ID) as QueryRow;
        expect(JSON.parse(String(payload.payload_json))).toMatchObject({
          tool_call_id: TOOL_CALL_ID,
          side_effect_id: EFFECT_ID,
          reconciliation_required: true,
        });
      } finally {
        db.close();
      }
    });
  });

  test("does not emit recovery evidence for an effect already settled", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db, "SETTLED", "SETTLED");
        expect(recoverUnsettledEffect(db)).toBe(false);
        expect(db.query("SELECT state FROM side_effects WHERE id = ?").get(EFFECT_ID)).toEqual({ state: "SETTLED" });
        expect(db.query("SELECT state FROM tool_calls WHERE id = ?").get(TOOL_CALL_ID)).toEqual({ state: "SETTLED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE aggregate_id = ?").get(TOOL_CALL_ID)).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });
});
