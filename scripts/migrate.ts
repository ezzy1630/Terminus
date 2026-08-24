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

  const applied = new Map<number, { checksum: string; name: string }>();
  const rows = db
    .query("SELECT version, name, checksum_sha256 FROM schema_migrations")
    .all() as Array<{ version: number; name: string; checksum_sha256: string }>;
  for (const r of rows) {
    applied.set(r.version, { checksum: r.checksum_sha256, name: r.name });
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let appliedCount = 0;
  for (const file of files) {
    const m = file.match(/^(\d+)_(.+)\.sql$/);
    if (!m) {
      console.warn(`skipping non-migration file: ${file}`);
      continue;
    }
    const version = parseInt(m[1]!, 10);
    const name = m[2]!;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = sha256(sql);

    const existing = applied.get(version);
    if (existing) {
      if (existing.checksum !== checksum) {
        console.error(
          `checksum mismatch for migration ${version} (${name}): expected ${existing.checksum}, got ${checksum}`,
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

  console.log(
    `migrations complete: ${appliedCount} applied, ${applied.size + appliedCount} total`,
  );

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
