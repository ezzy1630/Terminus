/**
 * Provider-attempt identity and persistence tests.
 *
 * The fingerprint must be stable for one exact durable submission, must
 * change when any request-routing input changes, and must be published with
 * the attempt row atomically. The unique provider idempotency key prevents a
 * replay from creating a second durable attempt.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  deriveProviderAttemptIdentity,
  type ProviderAttemptIdentityInput,
} from "../../mini-services/terminus-control/src/services/provider-attempt-identity.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORKSPACE_ID = "workspace-provider-attempt-identity";
const SESSION_ID = "session-provider-attempt-identity";
const THREAD_ID = "thread-provider-attempt-identity";
const TASK_ID = "task-provider-attempt-identity";
const TURN_ID = "turn-provider-attempt-identity";
const EPOCH_ID = "epoch-provider-attempt-identity";
const MANIFEST_ID = "manifest-provider-attempt-identity";

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

function identityInput(attemptId = "attempt-provider-identity"): ProviderAttemptIdentityInput {
  return {
    attemptId,
    providerId: "open_code_zen",
    modelKey: "open_code_zen/hy3-free",
    modelSnapshotHash: `sha256:${"1".repeat(64)}`,
    requestArtifactHash: `sha256:${"2".repeat(64)}`,
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    toolSchemaHash: `sha256:${"3".repeat(64)}`,
    contextEpochId: EPOCH_ID,
  };
}

function withDatabase(testBody: (db: Database) => Promise<void>): Promise<void> {
  const testDir = join(tmpdir(), `terminus-provider-attempt-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, "test.db");
  return migrate(dbPath)
    .then(() => testBody(new Database(dbPath)))
    .finally(() => rmSync(testDir, { recursive: true, force: true }));
}

function seedLineage(db: Database): void {
  const now = Date.now();
  db.query(
    "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(WORKSPACE_ID, "local_directory", "file:///workspace", "/workspace-provider-attempt", "trusted", "default", now, now);
  db.query(
    "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(SESSION_ID, WORKSPACE_ID, "tester", "provider attempt identity", "active", "default", "default", "{}", now, now);
  db.query(
    "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(THREAD_ID, SESSION_ID, "active", now, now);
  db.query(
    "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(TASK_ID, SESSION_ID, THREAD_ID, "ACTIVE", "EXECUTE", "{}", "sha256:scope", now, now);
  db.query(
    "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(TURN_ID, THREAD_ID, TASK_ID, 1, "CONTEXT_COMPILING", "agent");
  db.query(
    `INSERT INTO context_epochs (
      id, thread_id, generation, provider_compatibility_key,
      baseline_artifact, baseline_hash, snapshot_artifact, state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    EPOCH_ID,
    THREAD_ID,
    1,
    "opencode-zen-chat_completions-hy3-free",
    `artifact://sha256/${"4".repeat(64)}`,
    `sha256:${"4".repeat(64)}`,
    `artifact://sha256/${"5".repeat(64)}`,
    "active",
    now,
  );
  db.query(
    `INSERT INTO context_manifests (
      id, provider_attempt_id, compiler_version, policy_version, epoch_id,
      provider_key, model_key, manifest_artifact, rendered_request_hash,
      estimated_tokens_json, cache_plan_json, experiment_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    MANIFEST_ID,
    null,
    "v1",
    "v1",
    EPOCH_ID,
    "open_code_zen",
    "open_code_zen/hy3-free",
    `artifact://sha256/${"6".repeat(64)}`,
    `sha256:${"2".repeat(64)}`,
    "{}",
    "{}",
    "{}",
    now,
  );
}

function insertAttempt(
  db: Database,
  attemptId: string,
  identity: ReturnType<typeof deriveProviderAttemptIdentity>,
): void {
  db.query(
    `INSERT INTO provider_attempts (
      id, turn_id, attempt_number, provider_id, model_key,
      capability_snapshot_hash, context_manifest_id, request_artifact,
      request_fingerprint, provider_idempotency_key, provider_request_id,
      continuation_id, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attemptId,
    TURN_ID,
    1,
    "open_code_zen",
    "open_code_zen/hy3-free",
    `sha256:${"1".repeat(64)}`,
    MANIFEST_ID,
    `artifact://sha256/${"2".repeat(64)}`,
    identity.requestFingerprint,
    identity.providerIdempotencyKey,
    null,
    null,
    "running",
    Date.now(),
  );
  db.query("UPDATE context_manifests SET provider_attempt_id = ? WHERE id = ?").run(attemptId, MANIFEST_ID);
  db.query("UPDATE turns SET state = 'PROVIDER_RUNNING' WHERE id = ? AND state = 'CONTEXT_COMPILING'").run(TURN_ID);
}

describe("provider attempt identity", () => {
  test("fingerprint is canonical and changes with each routing identity component", () => {
    const input = identityInput();
    const identity = deriveProviderAttemptIdentity(input);
    expect(identity).toEqual(deriveProviderAttemptIdentity({ ...input }));
    expect(identity.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(identity.providerIdempotencyKey).toBe("provider-attempt:attempt-provider-identity");

    for (const [field, value] of [
      ["requestArtifactHash", `sha256:${"7".repeat(64)}`],
      ["modelSnapshotHash", `sha256:${"8".repeat(64)}`],
      ["endpoint", "https://opencode.ai/zen/v1/responses"],
      ["toolSchemaHash", `sha256:${"9".repeat(64)}`],
      ["contextEpochId", "epoch-provider-attempt-identity-2"],
      ["attemptId", "attempt-provider-identity-2"],
    ] as const) {
      const changed = deriveProviderAttemptIdentity({ ...input, [field]: value });
      expect(changed.requestFingerprint, field).not.toBe(identity.requestFingerprint);
    }
  });

  test("publishes typed identity atomically and rejects duplicate provider idempotency keys", async () => {
    await withDatabase(async (db) => {
      try {
        seedLineage(db);
        const identity = deriveProviderAttemptIdentity(identityInput());

        db.exec("BEGIN IMMEDIATE");
        try {
          insertAttempt(db, "attempt-rolled-back", identity);
          throw new Error("injected provider-attempt publication failure");
        } catch (error: unknown) {
          db.exec("ROLLBACK");
          expect(error).toEqual(new Error("injected provider-attempt publication failure"));
        }
        expect(db.query("SELECT COUNT(*) AS count FROM provider_attempts").get()).toEqual({ count: 0 });
        expect(db.query("SELECT provider_attempt_id FROM context_manifests WHERE id = ?").get(MANIFEST_ID)).toEqual({ provider_attempt_id: null });
        expect(db.query("SELECT state FROM turns WHERE id = ?").get(TURN_ID)).toEqual({ state: "CONTEXT_COMPILING" });

        db.exec("BEGIN IMMEDIATE");
        insertAttempt(db, "attempt-committed", identity);
        db.exec("COMMIT");
        expect(db.query(
          "SELECT request_fingerprint, provider_idempotency_key, provider_request_id, continuation_id, status FROM provider_attempts WHERE id = ?",
        ).get("attempt-committed")).toEqual({
          request_fingerprint: identity.requestFingerprint,
          provider_idempotency_key: identity.providerIdempotencyKey,
          provider_request_id: null,
          continuation_id: null,
          status: "running",
        });

        expect(() => db.query(
          `INSERT INTO provider_attempts (
            id, turn_id, attempt_number, provider_id, model_key,
            capability_snapshot_hash, context_manifest_id, request_artifact,
            request_fingerprint, provider_idempotency_key, status, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "attempt-duplicate-key",
          TURN_ID,
          2,
          "open_code_zen",
          "open_code_zen/hy3-free",
          `sha256:${"1".repeat(64)}`,
          MANIFEST_ID,
          `artifact://sha256/${"2".repeat(64)}`,
          identity.requestFingerprint,
          identity.providerIdempotencyKey,
          "running",
          Date.now(),
        )).toThrow();
        expect(db.query("SELECT COUNT(*) AS count FROM provider_attempts").get()).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    });
  });
});
