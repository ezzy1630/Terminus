/**
 * DB-backed completion admission crash and replay tests.
 *
 * A PREPARED completion record is an immutable intent, not a completion
 * claim. The task, verified turn, semantic event, and record become visible
 * together; startup may replay the transition only after an ADMITTED branch
 * proves that the completion gate already passed.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const TASK_ID = "task-completion-recovery";
const THREAD_ID = "thread-completion-recovery";
const TURN_ID = "turn-completion-recovery";
const PLAN_ID = "plan-completion-recovery";
const BRANCH_ID = "completion:task-completion-recovery:plan-completion-recovery";
const RECORD_ID = "completion:task-completion-recovery";
const COMPLETION_EVENT_ID = "event-completion-admitted";

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

function seedCompletionAdmission(db: Database, branchStatus: "OPEN" | "ADMITTED"): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("workspace-completion-recovery", "local_directory", "file:///workspace", "/workspace-completion-recovery", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("session-completion-recovery", "workspace-completion-recovery", "tester", "completion recovery", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(THREAD_ID, "session-completion-recovery", "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "session-completion-recovery", THREAD_ID, "VERIFYING", "VERIFY", "{}", "sha256:scope", now, now);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(TURN_ID, THREAD_ID, TASK_ID, 1, "VERIFYING", "agent");
  db.query(
    "INSERT INTO verification_plans (id, task_id, contract_version, source_revision, completion_expression, plan_artifact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(PLAN_ID, TASK_ID, 1, "git:source-1", "all_required_nodes_pass", "artifact://sha256/plan", now);
  db.query(
    `INSERT INTO candidate_branches (
      id, task_id, attempt_id, actor_principal, worktree_path, epoch,
      base_revision, head_revision, scope_digest, effect_ids_json, proof_json,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    BRANCH_ID,
    TASK_ID,
    TURN_ID,
    "agent:verification-runtime",
    "/workspace-completion-recovery",
    1,
    "git:source-1",
    "git:source-1",
    "sha256:scope",
    "[]",
    JSON.stringify({ verification_plan_id: PLAN_ID, completion_expression_satisfied: true }),
    branchStatus,
    now,
    now,
  );
  db.query(
    `INSERT INTO completion_records (
      id, task_id, contract_version, final_revision, status, criteria_json,
      verification_plan_id, unresolved_risks_json, accepted_risks_json,
      external_effects_json, cost_micros, duration_seconds, final_checkpoint_json,
      generated_at, admission_state, candidate_branch_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    RECORD_ID,
    TASK_ID,
    1,
    "git:source-1",
    "completed",
    "[]",
    PLAN_ID,
    "[]",
    "[]",
    "[]",
    0,
    0,
    "{}",
    now,
    "PREPARED",
    BRANCH_ID,
  );
}

function appendCompletionEvent(db: Database, now: number): void {
  db.query(
    `INSERT OR IGNORE INTO semantic_events (
      event_id, event_type, schema_version, aggregate_type, aggregate_id,
      aggregate_sequence, occurred_at, actor_json, correlation_id, causation_id,
      idempotency_key, payload_json, artifact_refs_json, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    COMPLETION_EVENT_ID,
    "task.completed",
    1,
    "task",
    TASK_ID,
    1,
    now,
    "{}",
    TASK_ID,
    null,
    null,
    JSON.stringify({ phase: "COMPLETE", status: "COMPLETED", verification_plan_id: PLAN_ID }),
    "[]",
    null,
  );
}

function admitCompletion(db: Database, now: number): void {
  transaction(db, () => {
    const task = db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID) as QueryRow | null;
    const turn = db.query("SELECT state FROM turns WHERE id = ?").get(TURN_ID) as QueryRow | null;
    const record = db.query("SELECT admission_state FROM completion_records WHERE id = ?").get(RECORD_ID) as QueryRow | null;
    if (task?.status === "COMPLETED" && turn?.state === "VERIFIED" && record?.admission_state === "COMMITTED") return;
    if (task?.status !== "VERIFYING" || turn?.state !== "VERIFYING" || record?.admission_state !== "PREPARED") {
      throw new Error("completion admission state changed during recovery");
    }

    appendCompletionEvent(db, now);
    const taskUpdate = db.query(
      "UPDATE tasks SET status = 'COMPLETED', phase = 'COMPLETE', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'VERIFYING'",
    ).run(now, now, TASK_ID);
    if (taskUpdate.changes !== 1) throw new Error("task changed during completion admission");
    const turnUpdate = db.query(
      "UPDATE turns SET state = 'VERIFIED' WHERE id = ? AND state = 'VERIFYING'",
    ).run(TURN_ID);
    if (turnUpdate.changes !== 1) throw new Error("turn changed during completion admission");
    const recordUpdate = db.query(
      "UPDATE completion_records SET admission_state = 'COMMITTED' WHERE id = ? AND task_id = ? AND admission_state = 'PREPARED'",
    ).run(RECORD_ID, TASK_ID);
    if (recordUpdate.changes !== 1) throw new Error("completion record changed during admission");
  });
}

function recoverPreparedCompletion(db: Database, now: number): "recovered" | "quarantined" | "none" {
  const record = db.query(
    "SELECT admission_state, candidate_branch_id FROM completion_records WHERE id = ?",
  ).get(RECORD_ID) as QueryRow | null;
  if (record?.admission_state !== "PREPARED") return "none";
  const branch = db.query(
    "SELECT status, task_id FROM candidate_branches WHERE id = ?",
  ).get(BRANCH_ID) as QueryRow | null;
  if (branch?.status !== "ADMITTED" || branch.task_id !== TASK_ID) {
    transaction(db, () => {
      db.query(
        "UPDATE completion_records SET admission_state = 'QUARANTINED' WHERE id = ? AND admission_state = 'PREPARED'",
      ).run(RECORD_ID);
    });
    return "quarantined";
  }
  admitCompletion(db, now);
  return "recovered";
}

function withDatabase(testBody: (db: Database) => Promise<void>): Promise<void> {
  const testDir = join(tmpdir(), `terminus-completion-recovery-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

describe("DB-backed completion admission recovery", () => {
  test("rolls back the event, task, turn, and completion claim together", async () => {
    await withDatabase(async (db) => {
      try {
        seedCompletionAdmission(db, "ADMITTED");
        expect(() => transaction(db, () => {
          appendCompletionEvent(db, Date.now());
          db.query(
            "UPDATE tasks SET status = 'COMPLETED', phase = 'COMPLETE' WHERE id = ? AND status = 'VERIFYING'",
          ).run(TASK_ID);
          db.query("UPDATE turns SET state = 'VERIFIED' WHERE id = ? AND state = 'VERIFYING'").run(TURN_ID);
          db.query(
            "UPDATE completion_records SET admission_state = 'COMMITTED' WHERE id = ? AND admission_state = 'PREPARED'",
          ).run(RECORD_ID);
          throw new Error("injected crash before completion admission commit");
        })).toThrow("injected crash before completion admission commit");

        expect(db.query("SELECT status, phase FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "VERIFYING", phase: "VERIFY" });
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(TURN_ID)).toEqual({ state: "VERIFYING" });
        expect(db.query("SELECT admission_state FROM completion_records WHERE id = ?").get(RECORD_ID)).toEqual({ admission_state: "PREPARED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(COMPLETION_EVENT_ID)).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  test("replays an admitted completion without rerunning provider inference", async () => {
    await withDatabase(async (db) => {
      try {
        seedCompletionAdmission(db, "ADMITTED");

        expect(recoverPreparedCompletion(db, Date.now())).toBe("recovered");
        expect(recoverPreparedCompletion(db, Date.now())).toBe("none");

        expect(db.query("SELECT status, phase FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "COMPLETED", phase: "COMPLETE" });
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(TURN_ID)).toEqual({ state: "VERIFIED" });
        expect(db.query("SELECT admission_state FROM completion_records WHERE id = ?").get(RECORD_ID)).toEqual({ admission_state: "COMMITTED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(COMPLETION_EVENT_ID)).toEqual({ count: 1 });
        expect(db.query("SELECT COUNT(*) AS count FROM provider_attempts WHERE turn_id = ?").get(TURN_ID)).toEqual({ count: 0 });
        expect(db.query("SELECT COUNT(*) AS count FROM candidate_branches WHERE id = ?").get(BRANCH_ID)).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    });
  });

  test("quarantines a prepared record when the candidate branch was not admitted", async () => {
    await withDatabase(async (db) => {
      try {
        seedCompletionAdmission(db, "OPEN");

        expect(recoverPreparedCompletion(db, Date.now())).toBe("quarantined");
        expect(db.query("SELECT admission_state FROM completion_records WHERE id = ?").get(RECORD_ID)).toEqual({ admission_state: "QUARANTINED" });
        expect(db.query("SELECT status, phase FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "VERIFYING", phase: "VERIFY" });
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(TURN_ID)).toEqual({ state: "VERIFYING" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(COMPLETION_EVENT_ID)).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });
});
