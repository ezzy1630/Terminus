# Runbook: SQLite database corruption or failed migration

## When to use

Use this runbook when Forge's SQLite database (`db/forge.db` or configured path) reports corruption, when a migration fails to apply, or when `PRAGMA integrity_check` returns errors. Database corruption is a release blocker and a recovery drill candidate (SPEC §50.2).

## Symptoms

- Kernel or control plane fails to start with `SQLITE_CORRUPT` or `database disk image is malformed`.
- `PRAGMA integrity_check` returns anything other than `ok`.
- Migration fails with a constraint violation or schema mismatch.
- Sessions/tasks appear with missing or garbage fields.
- WAL file grows unbounded.
- `SQLITE_BUSY` timeouts persist beyond `busy_timeout`.

## Diagnosis

1. **Stop Forge processes** (`just run` is not running).
2. Run integrity check:
   ```bash
   sqlite3 db/forge.db "PRAGMA integrity_check;"
   sqlite3 db/forge.db "PRAGMA foreign_key_check;"
   sqlite3 db/forge.db "PRAGMA journal_mode;"
   ```
3. Inspect the migration log:
   ```bash
   sqlite3 db/forge.db "SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 5;"
   ```
4. Check disk space and filesystem health (`df -h`, `dmesg | tail -50`).
5. Check for concurrent writers (other Forge processes, IDE extensions, manual `sqlite3` sessions).

## Immediate actions

1. **Do not retry writes.** Retrying can compound corruption.
2. **Back up the corrupted database before any recovery:**
   ```bash
   cp db/forge.db db/forge.db.corrupt.$(date +%s)
   cp db/forge.db-wal db/forge.db-wal.corrupt.$(date +%s) 2>/dev/null || true
   cp db/forge.db-shm db/forge.db-shm.corrupt.$(date +%s) 2>/dev/null || true
   ```
3. **Try `.recover`:**
   ```bash
   sqlite3 db/forge.db.corrupt.<ts> ".recover" > recovered.sql
   sqlite3 db/forge.recovered.db < recovered.sql
   sqlite3 db/forge.recovered.db "PRAGMA integrity_check;"
   ```
4. **If `.recover` fails or data is missing:** restore from the most recent backup (SPEC §29.6).
5. **If no backup exists:** escalate to the persistence owner. Treat as a data-loss incident.

## Recovery

1. Replace the corrupted database with the recovered/restored one:
   ```bash
   mv db/forge.db db/forge.db.lost.$(date +%s)
   mv db/forge.recovered.db db/forge.db
   rm -f db/forge.db-wal db/forge.db-shm
   ```
2. Run all migrations to bring the schema up to date:
   ```bash
   just codegen-sqlx
   # Apply any pending migrations
   ```
3. Run the startup recovery report:
   ```bash
   just run-kernel  # Watch for the recovery report log
   ```
4. Verify non-terminal records are reconciled (SPEC §29.5).
5. Run the backup/restore round-trip test to verify the recovered database is sound.

## Post-incident

- File an incident report (`docs/runbooks/security-incident.md` if security-relevant).
- Add the corruption signature to the recovery test suite (SPEC §46.9).
- Review disk/filesystem health (SQLite corruption is often a symptom of disk or kernel bugs).
- Verify the backup cadence is sufficient; consider increasing frequency.
- If migration-caused, add a regression test for the migration.

## Prevention

- Run `PRAGMA integrity_check` at startup (SPEC §29.2).
- Forward-test migrations in CI before release (SPEC §46.17).
- Maintain a rollback strategy for every migration (SPEC §46.17).
- Backup before irreversible migrations (SPEC §46.17).
- Use WAL mode and `synchronous=NORMAL` (not `OFF`) (SPEC §29.2).
- Avoid concurrent writers (Forge uses a single writer).

## Related

- `docs/runbooks/artifact-store-inconsistency.md` — artifact store issues.
- `docs/runbooks/orphaned-jobs.md` — jobs referencing missing database records.
- SPEC §29.2 (SQLite requirements), §46.17 (upgrade/rollback), §50.2 (acceptance).
