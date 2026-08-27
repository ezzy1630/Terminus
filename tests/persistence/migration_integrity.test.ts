import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";

const ROOT = join(import.meta.dir, "..", "..");
const SQLITE_MIGRATIONS_DIR = join(ROOT, "migrations", "sqlite");

async function runMigrations(
  dbPath: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<number> {
  const proc = Bun.spawn(["bun", "run", "scripts/migrate.ts"], {
    env: { ...process.env, ...extraEnv, DATABASE_URL: `file:${dbPath}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

function applyMigrationsThrough(db: Database, lastVersion: number): void {
  for (const file of readdirSync(SQLITE_MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (match === null) throw new Error(`invalid migration filename: ${file}`);
    const version = Number.parseInt(match[1]!, 10);
    if (version > lastVersion) break;
    const sql = readFileSync(join(SQLITE_MIGRATIONS_DIR, file), "utf8");
    db.exec(sql);
    db.query(
      "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)",
    ).run(version, match[2]!, createHash("sha256").update(sql, "utf8").digest("hex"), new Date(0).toISOString());
  }
}

describe("Database Migration Integrity & Corruption Detection", () => {
  test("Database migrations apply monotonically and populate schema_migrations ledger", async () => {
    const testDir = join(tmpdir(), `terminus-mig-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "test.db");

    try {
      expect(await runMigrations(dbPath)).toBe(0);
      expect(await runMigrations(dbPath)).toBe(0);

      const db = new Database(dbPath);
      const rows = db
        .query("SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number; name: string; checksum_sha256: string }>;

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.version).toBe(1);
      expect(rows[0]?.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

      const checkpointColumns = db
        .query("PRAGMA table_info(checkpoints)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      expect(checkpointColumns).toContainEqual(expect.objectContaining({
        name: "admission_state",
        notnull: 1,
        dflt_value: "'PREPARED'",
      }));
      const completionColumns = db
        .query("PRAGMA table_info(completion_records)")
        .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      expect(completionColumns).toContainEqual(expect.objectContaining({
        name: "admission_state",
        notnull: 1,
        dflt_value: "'COMMITTED'",
      }));
      expect(completionColumns.map((column) => column.name)).toContain("candidate_branch_id");
      const contractColumns = db
        .query("PRAGMA table_info(task_contract_versions)")
        .all() as Array<{ name: string }>;
      expect(contractColumns.map((column) => column.name)).toContain("v2_projection_json");
      const providerAttemptColumns = db
        .query("PRAGMA table_info(provider_attempts)")
        .all() as Array<{ name: string }>;
      expect(providerAttemptColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "provider_reported_cost_micros",
        "computed_cost_micros",
        "cost_source",
      ]));

      const now = Date.now();
      db.query(
        "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("workspace-admission", "local_directory", "file:///workspace", "/workspace", "trusted", "default", now, now);
      db.query(
        "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("session-admission", "workspace-admission", "tester", "test", "active", "default", "default", "{}", now, now);
      db.query(
        "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("thread-admission", "session-admission", "active", now, now);
      db.query(
        "INSERT INTO checkpoints (id, session_id, thread_id, checkpoint_artifact, schema_version, last_committed_sequences_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("checkpoint-default", "session-admission", "thread-admission", `artifact://sha256/${"a".repeat(64)}`, 1, "{}", now);
      const defaultAdmission = db
        .query("SELECT admission_state AS state FROM checkpoints WHERE id = ?")
        .get("checkpoint-default") as { state: string };
      expect(defaultAdmission.state).toBe("PREPARED");
      expect(() => db.query(
        "INSERT INTO checkpoints (id, session_id, thread_id, checkpoint_artifact, schema_version, last_committed_sequences_json, admission_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("checkpoint-invalid", "session-admission", "thread-admission", `artifact://sha256/${"b".repeat(64)}`, 1, "{}", "VISIBLE", now)).toThrow();

      const integrity = db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
      expect(integrity[0]?.quick_check).toBe("ok");
      db.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("DateTime migration converts provider timestamps to Prisma-compatible epoch milliseconds", async () => {
    const testDir = join(tmpdir(), `terminus-mig-datetime-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "test.db");
    const createdAt = "2026-08-26T12:34:56.789Z";
    const updatedAt = "2026-08-26T12:35:57.001Z";

    try {
      const legacy = new Database(dbPath);
      applyMigrationsThrough(legacy, 10);
      legacy.query(
        "INSERT INTO provider_configurations (id, program, args_json, model, timeout_seconds, tools_enabled, revision, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("legacy-local", "opencode", "[]", "hy3-free", 120, 0, 1, "legacy", createdAt, updatedAt);
      legacy.query(
        "INSERT INTO gateway_provider_configurations (id, deployment, protocol, model, secret_uri, credential_configured, tools_enabled, free_model, workspace_access, privacy_terms_admitted, privacy_terms_version, revision, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("legacy-gateway", "zen", "chat_completions", "hy3-free", "secret://opencode/zen", 0, 1, 1, 0, 1, "opencode-zen-privacy-v1", 1, "legacy", createdAt, updatedAt);
      legacy.close();

      expect(await runMigrations(dbPath)).toBe(0);
      const upgraded = new Database(dbPath);
      const provider = upgraded.query(
        "SELECT typeof(created_at) AS created_type, typeof(updated_at) AS updated_type, created_at, updated_at FROM provider_configurations WHERE id = ?",
      ).get("legacy-local") as { created_type: string; updated_type: string; created_at: number; updated_at: number };
      const gateway = upgraded.query(
        "SELECT typeof(created_at) AS created_type, typeof(updated_at) AS updated_type, created_at, updated_at FROM gateway_provider_configurations WHERE id = ?",
      ).get("legacy-gateway") as { created_type: string; updated_type: string; created_at: number; updated_at: number };
      const providerColumns = upgraded.query("PRAGMA table_info(provider_configurations)").all() as Array<{ name: string; type: string }>;
      expect(providerColumns.find((column) => column.name === "created_at")?.type).toBe("BIGINT");
      expect(provider.created_type).toBe("integer");
      expect(provider.updated_type).toBe("integer");
      expect(provider.created_at).toBe(Date.parse(createdAt));
      expect(provider.updated_at).toBe(Date.parse(updatedAt));
      expect(gateway.created_type).toBe("integer");
      expect(gateway.updated_type).toBe("integer");
      expect(gateway.created_at).toBe(Date.parse(createdAt));
      expect(gateway.updated_at).toBe(Date.parse(updatedAt));
      upgraded.close();

      const prisma = new PrismaClient({
        datasources: { db: { url: `file:${dbPath}` } },
      });
      try {
        const prismaCreatedAt = new Date("2026-08-27T12:00:00.123Z");
        const prismaUpdatedAt = new Date("2026-08-27T12:01:00.456Z");
        const persistedProvider = await prisma.providerConfiguration.create({
          data: {
            id: "prisma-local",
            program: "opencode",
            argsJson: "[]",
            model: "hy3-free",
            timeoutSeconds: 120,
            toolsEnabled: false,
            revision: 1,
            updatedBy: "migration-test",
            createdAt: prismaCreatedAt,
            updatedAt: prismaUpdatedAt,
          },
        });
        const persistedGateway = await prisma.gatewayProviderConfiguration.create({
          data: {
            id: "prisma-gateway",
            deployment: "zen",
            protocol: "chat_completions",
            model: "hy3-free",
            secretUri: "secret://opencode/zen",
            credentialConfigured: false,
            toolsEnabled: false,
            freeModel: true,
            workspaceAccess: true,
            privacyTermsAdmitted: true,
            privacyTermsVersion: "opencode-zen-privacy-v1",
            revision: 1,
            updatedBy: "migration-test",
            createdAt: prismaCreatedAt,
            updatedAt: prismaUpdatedAt,
          },
        });
        expect(persistedProvider.createdAt.getTime()).toBe(prismaCreatedAt.getTime());
        expect(persistedProvider.updatedAt.getTime()).toBe(prismaUpdatedAt.getTime());
        expect(persistedGateway.createdAt.getTime()).toBe(prismaCreatedAt.getTime());
        expect(persistedGateway.updatedAt.getTime()).toBe(prismaUpdatedAt.getTime());
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("A mid-migration failure rolls back schema and can be retried", async () => {
    const testDir = join(tmpdir(), `terminus-mig-retry-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "test.db");

    try {
      expect(await runMigrations(dbPath, { TERMINUS_MIGRATION_TEST_FAIL_AFTER: "5:1" })).not.toBe(0);
      const partial = new Database(dbPath);
      const columnsAfterFailure = partial
        .query("PRAGMA table_info(checkpoints)")
        .all() as Array<{ name: string }>;
      expect(columnsAfterFailure.map((column) => column.name)).not.toContain("admission_state");
      const migrationFive = partial
        .query("SELECT version FROM schema_migrations WHERE version = 5")
        .get();
      expect(migrationFive).toBeNull();
      partial.close();

      expect(await runMigrations(dbPath)).toBe(0);
      const upgraded = new Database(dbPath);
      const upgradedColumns = upgraded
        .query("PRAGMA table_info(checkpoints)")
        .all() as Array<{ name: string }>;
      expect(upgradedColumns.map((column) => column.name)).toContain("admission_state");
      upgraded.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("repair attempts persist identity, provenance, and lease association", async () => {
    const testDir = join(tmpdir(), `terminus-mig-repair-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "test.db");

    try {
      expect(await runMigrations(dbPath)).toBe(0);
      const db = new Database(dbPath);
      db.exec("PRAGMA foreign_keys = ON");
      const columns = db.query("PRAGMA table_info(repair_attempts)").all() as Array<{ name: string; type: string; notnull: number }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "id",
        "task_id",
        "parent_turn_id",
        "repair_turn_id",
        "lease_key",
        "attempt_number",
        "directive_artifact",
        "failure_signatures_json",
        "source_revision",
        "environment_digest",
      ]));
      expect(columns.find((column) => column.name === "id")?.notnull).toBe(1);

      const now = Date.now();
      db.query(
        "INSERT INTO workspaces (id, kind, root_uri, canonical_root, trust, policy_profile_id, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("workspace-repair", "local_directory", "file:///workspace", "/workspace-repair", "trusted", "default", now, now);
      db.query(
        "INSERT INTO sessions (id, workspace_id, owner_principal, title, status, default_model_profile, default_permission_profile, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("session-repair", "workspace-repair", "tester", "repair", "active", "default", "default", "{}", now, now);
      db.query(
        "INSERT INTO threads (id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("thread-repair", "session-repair", "active", now, now);
      db.query(
        "INSERT INTO tasks (id, session_id, thread_id, status, phase, budget_json, scope_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("task-repair", "session-repair", "thread-repair", "ACTIVE", "EXECUTE", "{}", "sha256:scope", now, now);
      db.query(
        "INSERT INTO turns (id, thread_id, task_id, sequence, state, initiating_actor) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("turn-repair-parent", "thread-repair", "task-repair", 1, "REPAIR_PENDING", "agent");
      db.query(
        "INSERT INTO leases (lease_key, owner_instance, fencing_token, acquired_at, expires_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("terminus-repair-attempt:repair-1", "unclaimed", 0, now, 0, "{}");
      db.query(
        `INSERT INTO repair_attempts (
          id, task_id, parent_turn_id, lease_key, attempt_number, max_attempts,
          state, directive_artifact, failed_node_ids_json, failure_signatures_json,
          changed_files_json, source_revision, environment_digest, remaining_budget_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "repair-1",
        "task-repair",
        "turn-repair-parent",
        "terminus-repair-attempt:repair-1",
        1,
        2,
        "PENDING",
        `artifact://sha256/${"a".repeat(64)}`,
        '["verify-tests"]',
        '["sig-1"]',
        '["src/calc.ts"]',
        "git:source-1",
        "sha256:environment-1",
        '{"remaining_attempts":1}',
        now,
      );
      const persisted = db.query(
        "SELECT state, attempt_number, max_attempts, source_revision, environment_digest, lease_key FROM repair_attempts WHERE id = ?",
      ).get("repair-1") as { state: string; attempt_number: number; max_attempts: number; source_revision: string; environment_digest: string; lease_key: string };
      expect(persisted).toEqual({
        state: "PENDING",
        attempt_number: 1,
        max_attempts: 2,
        source_revision: "git:source-1",
        environment_digest: "sha256:environment-1",
        lease_key: "terminus-repair-attempt:repair-1",
      });

      db.query(
        "INSERT INTO leases (lease_key, owner_instance, fencing_token, acquired_at, expires_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("terminus-repair-attempt:repair-2", "unclaimed", 0, now, 0, "{}");
      expect(() => db.query(
        `INSERT INTO repair_attempts (
          id, task_id, parent_turn_id, lease_key, attempt_number, max_attempts,
          state, directive_artifact, failed_node_ids_json, failure_signatures_json,
          changed_files_json, source_revision, remaining_budget_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "repair-2",
        "task-repair",
        "turn-repair-parent",
        "terminus-repair-attempt:repair-2",
        1,
        2,
        "PENDING",
        `artifact://sha256/${"b".repeat(64)}`,
        "[]",
        "[]",
        "[]",
        "git:source-2",
        "{}",
        now,
      )).toThrow();
      db.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("Database integrity check rejects corrupted database files", () => {
    const testDir = join(tmpdir(), `terminus-corrupt-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "corrupt.db");

    try {
      // Create valid DB
      const db = new Database(dbPath);
      db.exec("CREATE TABLE test_data (id INT PRIMARY KEY, val TEXT) STRICT;");
      db.exec("INSERT INTO test_data VALUES (1, 'hello');");
      db.close();

      // Corrupt database bytes
      const bytes = new Uint8Array(writeFileSync ? 1024 : 1024);
      bytes.fill(0xff);
      writeFileSync(dbPath, bytes);

      // Attempt to query or run quick_check on corrupted DB
      let corruptDetected = false;
      try {
        const corruptDb = new Database(dbPath);
        const integrity = corruptDb.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
        if (integrity.length === 0 || integrity[0]?.quick_check !== "ok") {
          corruptDetected = true;
        }
        corruptDb.close();
      } catch {
        corruptDetected = true;
      }

      expect(corruptDetected).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
