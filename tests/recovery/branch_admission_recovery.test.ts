/**
 * DB-backed candidate-branch admission recovery tests.
 *
 * ADMITTING is a durable fence around the external merge boundary. Recovery
 * must never turn it back into OPEN or invoke the merge a second time when a
 * trusted receipt is unavailable.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const WORKSPACE_ID = "workspace-branch-admission-recovery";
const SESSION_ID = "session-branch-admission-recovery";
const THREAD_ID = "thread-branch-admission-recovery";
const TASK_ID = "task-branch-admission-recovery";
const TURN_ID = "turn-branch-admission-recovery";
const BRANCH_ID = "branch-branch-admission-recovery";
const EVENT_ID = "event-branch-admission-recovery";

type QueryRow = Record<string, unknown>;

async function migrate(dbPath: string): Promise<void> {
  const child = Bun.spawn(["bun", "run", "scripts/migrate.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
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

function seed(db: Database, branchStatus: "OPEN" | "ADMITTING" | "ADMITTED"): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(WORKSPACE_ID, "local_directory", "file:///workspace", "/workspace-branch-admission-recovery", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, WORKSPACE_ID, "tester", "branch admission recovery", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(THREAD_ID, SESSION_ID, "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(TASK_ID, SESSION_ID, THREAD_ID, "VERIFYING", "VERIFY", "{}", "sha256:scope", now, now);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(TURN_ID, THREAD_ID, TASK_ID, 1, "VERIFYING", "agent");
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
    "/workspace-branch-admission-recovery",
    branchStatus === "OPEN" ? 1 : 2,
    "git:source-1",
    "git:source-1",
    "sha256:scope",
    "[]",
    null,
    branchStatus,
    now,
    now,
  );
}

function claimOpenBranch(db: Database): boolean {
  return transaction(db, () => {
    const result = db.query(
      "UPDATE candidate_branches SET status = 'ADMITTING', epoch = epoch + 1 WHERE id = ? AND status = 'OPEN' AND epoch = 1",
    ).run(BRANCH_ID);
    return result.changes === 1;
  });
}

function appendRecoveryEvent(db: Database): void {
  db.query(
    `INSERT INTO semantic_events (
      event_id, event_type, schema_version, aggregate_type, aggregate_id,
      aggregate_sequence, occurred_at, actor_json, correlation_id,
      causation_id, idempotency_key, payload_json, artifact_refs_json, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EVENT_ID,
    "candidate_branch.recovery_manual_review",
    1,
    "task",
    TASK_ID,
    1,
    Date.now(),
    "{}",
    TASK_ID,
    null,
    `candidate-branch-recovery:${BRANCH_ID}`,
    JSON.stringify({
      task_id: TASK_ID,
      branch_id: BRANCH_ID,
      previous_status: "ADMITTING",
      reason: "candidate_branch_merge_receipt_unavailable_after_restart",
      admission_operation_id: `completion-admission:${BRANCH_ID}`,
    }),
    "[]",
    null,
  );
}

function recoverAdmittingBranch(db: Database, injectFailure = false): boolean {
  const branch = db.query(
    "SELECT status, epoch, task_id FROM candidate_branches WHERE id = ? AND status = 'ADMITTING'",
  ).get(BRANCH_ID) as QueryRow | null;
  if (branch === null) return false;

  transaction(db, () => {
    appendRecoveryEvent(db);
    if (injectFailure) throw new Error("injected crash before branch recovery commit");
    const updated = db.query(
      "UPDATE candidate_branches SET status = 'MANUAL_REVIEW', epoch = epoch + 1, updated_at = ? WHERE id = ? AND task_id = ? AND status = 'ADMITTING' AND epoch = ?",
    ).run(Date.now(), BRANCH_ID, TASK_ID, branch.epoch);
    if (updated.changes !== 1) throw new Error("candidate branch changed during recovery");
    const blocked = db.query(
      "UPDATE tasks SET status = 'BLOCKED', phase = 'VERIFY', completed_at = NULL, terminal_reason_json = ?, updated_at = ? WHERE id = ? AND status IN ('ACTIVE', 'VERIFYING')",
    ).run(JSON.stringify({
      reason: "candidate_branch_admission_recovery_required",
      branch_id: BRANCH_ID,
      attempt_id: TURN_ID,
      reconciliation_required: true,
    }), Date.now(), TASK_ID);
    if (blocked.changes !== 1) throw new Error("task changed during branch recovery");
  });
  return true;
}

function withDatabase(testBody: (db: Database) => Promise<void>): Promise<void> {
  const testDir = join(tmpdir(), `terminus-branch-admission-recovery-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

describe("DB-backed candidate branch admission recovery", () => {
  test("fences an admitted merge boundary and recovers it once into manual review", async () => {
    await withDatabase(async (db) => {
      try {
        seed(db, "OPEN");
        expect(claimOpenBranch(db)).toBe(true);
        expect(claimOpenBranch(db)).toBe(false);
        expect(db.query("SELECT status, epoch FROM candidate_branches WHERE id = ?").get(BRANCH_ID)).toEqual({
          status: "ADMITTING",
          epoch: 2,
        });

        expect(() => recoverAdmittingBranch(db, true)).toThrow("injected crash before branch recovery commit");
        expect(db.query("SELECT status, epoch FROM candidate_branches WHERE id = ?").get(BRANCH_ID)).toEqual({
          status: "ADMITTING",
          epoch: 2,
        });
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "VERIFYING" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(EVENT_ID)).toEqual({ count: 0 });

        expect(recoverAdmittingBranch(db)).toBe(true);
        expect(recoverAdmittingBranch(db)).toBe(false);
        expect(db.query("SELECT status, epoch FROM candidate_branches WHERE id = ?").get(BRANCH_ID)).toEqual({
          status: "MANUAL_REVIEW",
          epoch: 3,
        });
        expect(db.query("SELECT status FROM tasks WHERE id = ?").get(TASK_ID)).toEqual({ status: "BLOCKED" });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(EVENT_ID)).toEqual({ count: 1 });
        expect(db.query("SELECT idempotency_key FROM semantic_events WHERE event_id = ?").get(EVENT_ID)).toEqual({
          idempotency_key: `candidate-branch-recovery:${BRANCH_ID}`,
        });
      } finally {
        db.close();
      }
    });
  });

  test("does not scan a branch whose admission is already durably settled", async () => {
    await withDatabase(async (db) => {
      try {
        seed(db, "ADMITTED");
        expect(recoverAdmittingBranch(db)).toBe(false);
        expect(db.query("SELECT status, epoch FROM candidate_branches WHERE id = ?").get(BRANCH_ID)).toEqual({
          status: "ADMITTED",
          epoch: 2,
        });
        expect(db.query("SELECT COUNT(*) AS count FROM semantic_events WHERE event_id = ?").get(EVENT_ID)).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  });
});
