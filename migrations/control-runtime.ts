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

    const applied = new Map<number, { readonly checksum: string; readonly name: string }>();
    const rows = database
      .query("SELECT version, name, checksum_sha256 FROM schema_migrations")
      .all() as Array<{ version: number; name: string; checksum_sha256: string }>;
    for (const row of rows) {
      applied.set(row.version, { checksum: row.checksum_sha256, name: row.name });
    }

    const files = readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    let appliedCount = 0;
    for (const file of files) {
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) throw new Error(`invalid migration filename: ${file}`);
      const version = Number.parseInt(match[1] ?? "", 10);
      const name = match[2] ?? "";
      const sql = readFileSync(join(migrationsDirectory, file), "utf8");
      const checksum = sha256(sql);
      const existing = applied.get(version);
      if (existing) {
        if (existing.checksum !== checksum || existing.name !== name) {
          throw new Error(`checksum or name mismatch for migration ${version} (${name})`);
        }
        continue;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
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
    return { applied: appliedCount, total: applied.size + appliedCount };
  } finally {
    database.close();
  }
}
