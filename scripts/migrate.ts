#!/usr/bin/env bun
/**
 * SQLite migration runner (SPEC §29.2).
 *
 * Applies pending `.sql` migrations from `migrations/sqlite/` to the database
 * at DATABASE_URL. Each migration runs in a transaction and is recorded in
 * `schema_migrations` with a sha256 checksum computed from the migration
 * file's bytes.
 *
 * Migrations are monotonic (add only). The runner verifies checksums of
 * already-applied migrations to detect tampering. Migration SQL files MUST NOT
 * insert their own `schema_migrations` row — the runner is the single source
 * of truth for the applied-migration ledger (a second INSERT would conflict on
 * the `version` primary key).
 */
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

const DB_PATH = (process.env.DATABASE_URL ?? "file:~/.local/share/terminus/terminus.db")
  .replace(/^file:/, "")
  .replace(/\?.*$/, "")
  .replace(/^~/, process.env.HOME ?? process.cwd());

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations", "sqlite");

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function migrationSql(sql: string): string {
  // Connection PRAGMAs are applied by the runner before any transaction.
  // Keeping them out of migration transactions avoids SQLite's
  // `Safety level may not be changed inside a transaction` restriction.
  // Pass the remaining program to SQLite intact. Splitting SQL on `;` is not
  // a parser: semicolons are legal in comments, strings, and trigger bodies.
  return sql.replace(/^\s*PRAGMA\s+[^;]+;\s*$/gim, "").trim();
}

function faultAfterStatement(version: number): number | null {
  const configured = process.env.TERMINUS_MIGRATION_TEST_FAIL_AFTER;
  if (!configured) return null;
  const match = /^(\d+):(\d+)$/.exec(configured);
  if (!match || Number(match[1]) !== version) return null;
  const count = Number(match[2]);
  return Number.isInteger(count) && count > 0 ? count : null;
}

function main(): void {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version         INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      applied_at      TEXT NOT NULL
    ) STRICT;
  `);

  const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  const migrationFiles = new Map<number, { file: string; name: string }>();
  for (const file of files) {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) throw new Error(`invalid migration filename: ${file}`);
    const version = Number.parseInt(match[1] ?? "", 10);
    if (migrationFiles.has(version)) throw new Error(`duplicate migration version ${version}`);
    migrationFiles.set(version, { file, name: match[2]! });
  }
  const appliedRows = db
    .query("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  for (const row of appliedRows) {
    if (!migrationFiles.has(row.version)) {
      throw new Error(`schema_migrations contains orphaned applied version ${row.version}`);
    }
  }

  let appliedCount = 0;
  for (const [version, migration] of migrationFiles) {
    const { file, name } = migration;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = sha256(sql);

    const existing = db
      .query("SELECT name, checksum_sha256 FROM schema_migrations WHERE version = ?")
      .get(version) as { checksum_sha256: string; name: string } | null;
    if (existing) {
      if (existing.checksum_sha256 !== checksum || existing.name !== name) {
        console.error(
          `checksum or name mismatch for migration ${version} (${name})`,
        );
        process.exit(1);
      }
      continue;
    }

    console.log(`applying migration ${version}: ${name}`);
    try {
      const program = migrationSql(sql);
      const injectedFailure = faultAfterStatement(version);
      db.exec("BEGIN IMMEDIATE");
      const committed = db
        .query("SELECT name, checksum_sha256 FROM schema_migrations WHERE version = ?")
        .get(version) as { checksum_sha256: string; name: string } | null;
      if (committed) {
        if (committed.checksum_sha256 !== checksum || committed.name !== name) {
          throw new Error(`checksum or name mismatch for migration ${version} (${name})`);
        }
        db.exec("COMMIT");
        continue;
      }
      db.exec(program);
      if (injectedFailure !== null) {
        // The hook deliberately fails after SQLite has executed the migration
        // program but before the ledger row and COMMIT. This proves DDL and
        // ledger publication share one rollback boundary without maintaining
        // a second, incomplete SQL parser in the runner.
        throw new Error(`injected migration failure before commit (requested statement ${injectedFailure})`);
      }
      db.query(
        "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)",
      ).run(version, name, checksum, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
      console.error(`migration ${version} failed: ${e}`);
      process.exit(1);
    }
    appliedCount++;
  }

  const totalMigrations = (db.query("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count;
  console.log(`migrations complete: ${appliedCount} applied, ${totalMigrations} total`);

  const integrity = db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  if (integrity[0]?.quick_check !== "ok") {
    console.error(`integrity check failed: ${JSON.stringify(integrity)}`);
    process.exit(1);
  }
  console.log("integrity check: ok");

  db.close();
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
