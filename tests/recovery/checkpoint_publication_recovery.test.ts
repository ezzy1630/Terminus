/**
 * DB-backed checkpoint publication and replay tests.
 *
 * These tests exercise the SQLite half of the checkpoint admission protocol:
 * a PREPARED row is not visible as a committed checkpoint, publication is
 * atomic with its semantic event, and replay is idempotent.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const CHECKPOINT_ID = "checkpoint-recovery-1";
const CHECKPOINT_HASH = `sha256:${"b".repeat(64)}`;
const CHECKPOINT_URI = `artifact://sha256/${"b".repeat(64)}`;
const EVENT_ID = "event-checkpoint-created";

type QueryRow = Record<string, unknown>;

async function migrate(dbPath: string): Promise<void> {
  const migrationProcess = Bun.spawn(["bun", "run", "scripts/migrate.ts"], {
    cwd: ROOT,
    env: { ...globalThis.process.env, DATABASE_URL: `file:${dbPath}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await migrationProcess.exited;
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

function seedLineage(db: Database): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("workspace-checkpoint-recovery", "local_directory", "file:///workspace", "/workspace-checkpoint-recovery", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("session-checkpoint-recovery", "workspace-checkpoint-recovery", "tester", "checkpoint recovery", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("thread-checkpoint-recovery", "session-checkpoint-recovery", "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("task-checkpoint-recovery", "session-checkpoint-recovery", "thread-checkpoint-recovery", "COMPLETED", "COMPLETE", "{}", "sha256:scope", now, now);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("turn-checkpoint-recovery", "thread-checkpoint-recovery", "task-checkpoint-recovery", 1, "COMPLETED", "agent");
}

function seedArtifact(db: Database): void {
  const now = Date.now();
  db.query(
    `INSERT INTO artifacts (
      hash, size_bytes, media_type, content_encoding, storage_path,
      confidentiality, trust, retention_class, redaction_status,
      created_at, last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(CHECKPOINT_HASH, 128, "application/json", "identity", "/artifacts/checkpoint-recovery-1", "workspace", "derived", "session", "clean", now, now);
}

function prepareCheckpoint(db: Database): void {
  const now = Date.now();
  db.query(
    `INSERT INTO checkpoints (
      id, session_id, thread_id, task_id, checkpoint_artifact, schema_version,
      last_committed_sequences_json, active_context_epoch_id,
      promoted_input_cursor, unsettled_tool_calls_json, active_jobs_json,
      workspace_revision, dirty_state_digest, unsettled_effects_json,
      artifact_refs_json, continuation_json, admission_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    CHECKPOINT_ID,
    "session-checkpoint-recovery",
    "thread-checkpoint-recovery",
    "task-checkpoint-recovery",
    CHECKPOINT_URI,
    1,
    JSON.stringify({ task: 1, turn: 1, sourceTurnId: "turn-checkpoint-recovery", episodeRange: { from: 0, to: 0 } }),
    null,
    null,
    "[]",
    "[]",
    null,
    null,
    "[]",
    "[]",
    null,
    "PREPARED",
    now,
  );
}

function linkCheckpointArtifact(db: Database): void {
  db.query(
    `INSERT OR IGNORE INTO artifact_links (
      id, artifact_hash, owner_type, owner_id, purpose, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("checkpoint-link-recovery-1", CHECKPOINT_HASH, "checkpoint", CHECKPOINT_ID, "content", Date.now());
}

function appendCheckpointEvent(db: Database): void {
  const now = Date.now();
  db.query(
    `INSERT OR IGNORE INTO semantic_events (
      event_id, event_type, schema_version, aggregate_type, aggregate_id,
      aggregate_sequence, occurred_at, actor_json, correlation_id, causation_id,
      idempotency_key, payload_json, artifact_refs_json, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EVENT_ID,
    "checkpoint.created",
    1,
    "checkpoint",
    CHECKPOINT_ID,
    1,
    now,
    "{}",
    "task-checkpoint-recovery",
    null,
    null,
    JSON.stringify({ task_id: "task-checkpoint-recovery", artifact_hash: CHECKPOINT_HASH }),
    JSON.stringify([CHECKPOINT_URI]),
    null,
  );
}

function publishCheckpoint(db: Database): void {
  transaction(db, () => {
    const existingEvent = db.query(
      "SELECT event_id FROM semantic_events WHERE event_id = ?",
    ).get(EVENT_ID) as QueryRow | null;
    if (existingEvent !== null) {
      const committed = db.query(
        "UPDATE checkpoints SET admission_state = 'COMMITTED' WHERE id = ? AND admission_state = 'PREPARED'",
      ).run(CHECKPOINT_ID);
      if (committed.changes !== 1) {
        const checkpoint = db.query(
          "SELECT admission_state FROM checkpoints WHERE id = ?",
        ).get(CHECKPOINT_ID) as QueryRow | null;
        if (checkpoint?.admission_state !== "COMMITTED") {
          throw new Error("checkpoint publication state changed during recovery");
        }
      }
      return;
    }
    appendCheckpointEvent(db);
    const committed = db.query(
      "UPDATE checkpoints SET admission_state = 'COMMITTED' WHERE id = ? AND admission_state = 'PREPARED'",
    ).run(CHECKPOINT_ID);
    if (committed.changes !== 1) throw new Error("checkpoint admission changed before publication");
  });
}

function recoverPreparedCheckpoints(db: Database): void {
  const rows = db.query(
    "SELECT id FROM checkpoints WHERE admission_state = 'PREPARED' ORDER BY id",
  ).all() as QueryRow[];
  for (const row of rows) {
    if (row.id !== CHECKPOINT_ID) throw new Error("unexpected checkpoint in recovery fixture");
    publishCheckpoint(db);
  }
}

function withDatabase(testBody: (db: Database) => Promise<void>): Promise<void> {
  const testDir = join(tmpdir(), `terminus-checkpoint-recovery-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

describe("DB-backed checkpoint publication recovery", () => {
  test("does not expose a prepared checkpoint when publication rolls back", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        seedArtifact(db);
        prepareCheckpoint(db);

        expect(db.query("SELECT admission_state FROM checkpoints WHERE id = ?").get(CHECKPOINT_ID) as QueryRow).toEqual({ admission_state: "PREPARED" });
        expect(() => transaction(db, () => {
          appendCheckpointEvent(db);
          db.query("UPDATE checkpoints SET admission_state = 'COMMITTED' WHERE id = ? AND admission_state = 'PREPARED'").run(CHECKPOINT_ID);
          throw new Error("injected crash before checkpoint publication commit");
        })).toThrow("injected crash before checkpoint publication commit");
        expect(db.query("SELECT admission_state FROM checkpoints WHERE id = ?").get(CHECKPOINT_ID) as QueryRow).toEqual({ admission_state: "PREPARED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(EVENT_ID) as QueryRow).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  test("replays checkpoint publication and artifact linking without duplicates", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        seedArtifact(db);
        prepareCheckpoint(db);
        linkCheckpointArtifact(db);
        linkCheckpointArtifact(db);

        recoverPreparedCheckpoints(db);
        recoverPreparedCheckpoints(db);

        expect(db.query("SELECT admission_state FROM checkpoints WHERE id = ?").get(CHECKPOINT_ID) as QueryRow).toEqual({ admission_state: "COMMITTED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(EVENT_ID) as QueryRow).toEqual({ count: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM artifact_links WHERE owner_type = 'checkpoint' AND owner_id = ?").get(CHECKPOINT_ID) as QueryRow).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    });
  });
});
