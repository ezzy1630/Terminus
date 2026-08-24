import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

export interface MigrationResult {
  readonly applied: number;
  readonly total: number;
}

function databasePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("the packaged control runtime supports only a file: SQLite DATABASE_URL");
  }
  const path = databaseUrl.replace(/^file:/, "").replace(/\?.*$/, "");
  if (path.length === 0) throw new Error("DATABASE_URL must name a SQLite database file");
  return path.replace(/^~/, process.env.HOME ?? process.cwd());
}

function migrationProgram(sql: string): string {
  return sql.replace(/^\s*PRAGMA\s+[^;]+;\s*$/gim, "").trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function runControlMigrations(databaseUrl: string, migrationsDirectory: string): MigrationResult {
  const path = databasePath(databaseUrl);
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const files = readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    const migrationFiles = new Map<number, string>();
    for (const file of files) {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) throw new Error(`invalid migration filename: ${file}`);
      const version = Number.parseInt(match[1] ?? "", 10);
      if (migrationFiles.has(version)) {
        throw new Error(`duplicate migration version ${version}`);
      }
      migrationFiles.set(version, file);
    }
    const appliedRows = database
      .query("SELECT version FROM schema_migrations")
      .all() as Array<{ version: number }>;
    for (const row of appliedRows) {
      if (!migrationFiles.has(row.version)) {
        throw new Error(`schema_migrations contains orphaned applied version ${row.version}`);
      }
    }
    let appliedCount = 0;
    for (const file of files) {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) throw new Error(`invalid migration filename: ${file}`);
      const version = Number.parseInt(match[1] ?? "", 10);
      const name = match[2] ?? "";
      const sql = readFileSync(join(migrationsDirectory, file), "utf8");
      const checksum = sha256(sql);
      const existing = database
        .query("SELECT name, checksum_sha256 FROM schema_migrations WHERE version = ?")
        .get(version) as { name: string; checksum_sha256: string } | null;
      if (existing) {
        if (existing.checksum_sha256 !== checksum || existing.name !== name) {
          throw new Error(`checksum or name mismatch for migration ${version} (${name})`);
        }
        continue;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        // Another runtime may have committed this version after the
        // preflight read. Re-read while the write lock is held so the loser
        // treats the migration as already applied instead of colliding with
        // the ledger primary key.
        const committed = database
          .query("SELECT name, checksum_sha256 FROM schema_migrations WHERE version = ?")
          .get(version) as { name: string; checksum_sha256: string } | null;
        if (committed) {
          if (committed.checksum_sha256 !== checksum || committed.name !== name) {
            throw new Error(`checksum or name mismatch for migration ${version} (${name})`);
          }
          database.exec("COMMIT");
          continue;
        }
        database.exec(migrationProgram(sql));
        database.query(
          "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)",
        ).run(version, name, checksum, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error: unknown) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The transaction may have failed before BEGIN completed.
        }
        throw error;
      }
      appliedCount += 1;
    }

    const integrity = database.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (integrity[0]?.quick_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
    }
    const total = database
      .query("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    return { applied: appliedCount, total: total.count };
  } finally {
    database.close();
  }
}
