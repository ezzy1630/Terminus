#!/usr/bin/env bun
/**
 * SQLite migration runner (SPEC §29.2).
 *
 * Applies pending `.sql` migrations from `migrations/sqlite/` to the database
 * specified by `DATABASE_URL`. Each migration runs in a transaction and is
 * recorded in the `schema_migrations` table with a checksum.
 *
 * Migrations are monotonic: they only add tables/columns/indexes, never drop.
 * The runner verifies checksums of already-applied migrations to detect
 * tampering.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "node:sqlite3";

const DB_PATH = (process.env.DATABASE_URL ?? "file:db/custom.db")
  .replace(/^file:/, "")
  .replace(/\?.*$/, "");

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations", "sqlite");

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  // Ensure schema_migrations table exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version         INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      applied_at      TEXT NOT NULL
    ) STRICT;
  `);

  // Load applied migrations.
  const applied = new Map<number, { checksum: string; name: string }>();
  const rows = db.prepare("SELECT version, name, checksum_sha256 FROM schema_migrations").all() as Array<{ version: number; name: string; checksum_sha256: string }>;
  for (const r of rows) {
    applied.set(r.version, { checksum: r.checksum_sha256, name: r.name });
  }

  // Load pending migration files, sorted by version.
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
    const checksum = await sha256(sql);

    const existing = applied.get(version);
    if (existing) {
      if (existing.checksum !== checksum) {
        console.error(`checksum mismatch for migration ${version} (${name}): expected ${existing.checksum}, got ${checksum}`);
        process.exit(1);
      }
      continue; // already applied
    }

    console.log(`applying migration ${version}: ${name}`);
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)")
        .run(version, name, checksum, new Date().toISOString());
    });
    tx();
    appliedCount++;
  }

  console.log(`migrations complete: ${appliedCount} applied, ${applied.size} total`);

  // Verify integrity.
  const integrity = db.pragma("quick_check") as Array<{ quick_check: string }>;
  if (integrity[0]?.quick_check !== "ok") {
    console.error(`integrity check failed: ${JSON.stringify(integrity)}`);
    process.exit(1);
  }
  console.log("integrity check: ok");

  db.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
