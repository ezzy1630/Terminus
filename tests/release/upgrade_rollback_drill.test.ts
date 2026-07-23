/**
 * SPEC §46.10 / §50.2 upgrade + rollback drill.
 *
 * Migrate forward via scripts/migrate.ts, backup the DB file, simulate
 * rollback by restoring the backup, then re-upgrade. Uses bun:sqlite + tmpdir.
 */
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");
const EVIDENCE_PATH = join(ROOT, "artifacts", "release-gate", "upgrade-rollback.json");

function runMigrate(dbPath: string): number {
  const proc = Bun.spawnSync(["bun", "run", "scripts/migrate.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  });
  return proc.exitCode ?? 1;
}

function migrationCount(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    const row = db
      .query("SELECT COUNT(*) AS c FROM schema_migrations")
      .get() as { c: number } | null;
    return row?.c ?? 0;
  } finally {
    db.close();
  }
}

describe("upgrade / rollback drill", () => {
  test("migrate → backup → restore rollback → re-upgrade", () => {
    const testDir = join(tmpdir(), `terminus-upgrade-rollback-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(ROOT, "artifacts", "release-gate"), { recursive: true });
    const dbPath = join(testDir, "terminus.db");
    const backupPath = join(testDir, "terminus.db.bak");

    try {
      expect(runMigrate(dbPath)).toBe(0);
      expect(existsSync(dbPath)).toBe(true);
      const afterUpgrade = migrationCount(dbPath);
      expect(afterUpgrade).toBeGreaterThan(0);

      copyFileSync(dbPath, backupPath);
      expect(existsSync(backupPath)).toBe(true);

      // Simulate forward drift after backup: add a sentinel table.
      {
        const db = new Database(dbPath);
        db.exec("CREATE TABLE IF NOT EXISTS drill_sentinel (id INTEGER PRIMARY KEY) STRICT;");
        db.close();
      }

      // Rollback = restore backup file.
      copyFileSync(backupPath, dbPath);
      {
        const db = new Database(dbPath);
        const tables = db
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='drill_sentinel'",
          )
          .all() as Array<{ name: string }>;
        expect(tables.length).toBe(0);
        const integrity = db.query("PRAGMA quick_check").all() as Array<{
          quick_check: string;
        }>;
        expect(integrity[0]?.quick_check).toBe("ok");
        db.close();
      }

      // Re-upgrade from restored baseline.
      expect(runMigrate(dbPath)).toBe(0);
      expect(migrationCount(dbPath)).toBe(afterUpgrade);

      const evidence = {
        status: "passed",
        generatedAt: new Date().toISOString(),
        migrationsApplied: afterUpgrade,
        steps: ["migrate", "backup", "restore", "re-upgrade"],
      };
      writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      const written = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as {
        status: string;
      };
      expect(written.status).toBe("passed");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
