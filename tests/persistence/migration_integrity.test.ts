import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

describe("Database Migration Integrity & Corruption Detection", () => {
  test("Database migrations apply monotonically and populate schema_migrations ledger", () => {
    const testDir = join(tmpdir(), `terminus-mig-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, "test.db");

    try {
      const proc = Bun.spawnSync(["bun", "run", "scripts/migrate.ts"], {
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      });
      expect(proc.exitCode).toBe(0);

      const db = new Database(dbPath);
      const rows = db
        .query("SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number; name: string; checksum_sha256: string }>;

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.version).toBe(1);
      expect(rows[0]?.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

      const integrity = db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
      expect(integrity[0]?.quick_check).toBe("ok");
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
