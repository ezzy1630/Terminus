/**
 * SPEC §46.10 clean-room install / upgrade / downgrade drill.
 *
 * Downgrade strategy for Terminus SQLite is restore-from-backup (migrations
 * are monotonic add-only; there is no reverse SQL path).
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const ROOT = join(import.meta.dir, "..", "..");

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

describe("clean install / upgrade / downgrade", () => {
  test("clean install, idempotent upgrade, downgrade via backup restore", () => {
    const testDir = join(tmpdir(), `terminus-clean-install-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "terminus.db");
    const backupPath = join(testDir, "terminus.db.bak");

    try {
      // Clean install.
      expect(runMigrate(dbPath)).toBe(0);
      const installed = migrationCount(dbPath);
      expect(installed).toBeGreaterThan(0);
      copyFileSync(dbPath, backupPath);

      // Upgrade = re-run migrate (idempotent).
      expect(runMigrate(dbPath)).toBe(0);
      expect(migrationCount(dbPath)).toBe(installed);

      // Downgrade strategy: restore-from-backup (documented + performed).
      copyFileSync(backupPath, dbPath);
      expect(migrationCount(dbPath)).toBe(installed);
      const db = new Database(dbPath);
      const integrity = db.query("PRAGMA quick_check").all() as Array<{
        quick_check: string;
      }>;
      expect(integrity[0]?.quick_check).toBe("ok");
      db.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
