/**
 * SPEC §50.2 backup / restore drill.
 *
 * Create DB → backup copy → corrupt original → restore from backup →
 * PRAGMA quick_check ok.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

describe("backup / restore drill", () => {
  test("corrupt original then restore from backup passes quick_check", () => {
    const testDir = join(tmpdir(), `terminus-backup-restore-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "terminus.db");
    const backupPath = join(testDir, "terminus.db.bak");

    try {
      const db = new Database(dbPath);
      db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, val TEXT) STRICT;");
      db.exec("INSERT INTO records (id, val) VALUES (1, 'intact');");
      db.close();

      copyFileSync(dbPath, backupPath);

      // Corrupt the live database.
      const garbage = new Uint8Array(2048);
      garbage.fill(0xff);
      writeFileSync(dbPath, garbage);

      let corruptDetected = false;
      try {
        const bad = new Database(dbPath);
        const check = bad.query("PRAGMA quick_check").all() as Array<{
          quick_check: string;
        }>;
        if (check.length === 0 || check[0]?.quick_check !== "ok") {
          corruptDetected = true;
        }
        bad.close();
      } catch {
        corruptDetected = true;
      }
      expect(corruptDetected).toBe(true);

      // Restore from backup.
      copyFileSync(backupPath, dbPath);
      const restored = new Database(dbPath);
      const integrity = restored.query("PRAGMA quick_check").all() as Array<{
        quick_check: string;
      }>;
      expect(integrity[0]?.quick_check).toBe("ok");
      const row = restored
        .query("SELECT val FROM records WHERE id = 1")
        .get() as { val: string } | null;
      expect(row?.val).toBe("intact");
      restored.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
