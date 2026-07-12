# Runbook: Artifact store inconsistency

## When to use

Use this runbook when the content-addressed artifact store has missing blobs, hash mismatches, orphaned metadata, or unresolvable `artifact://sha256/<hex>` references. Artifact integrity is a release blocker (SPEC §50.2).

## Symptoms

- `artifact://sha256/<hex>` references return "not found" for hashes recorded in SQLite.
- `sha256(content) != recorded_hash` (hash mismatch on read).
- Artifact directory grows unbounded (GC not running).
- Disk full from artifact store.
- Provider attempt records reference missing full-response artifacts.

## Diagnosis

1. Run artifact integrity check:
   ```bash
   # For each artifact_link in SQLite, verify the file exists and hashes match
   sqlite3 db/forge.db "SELECT sha256, size_bytes, media_type FROM artifacts LIMIT 100;" | while read row; do
     sha=$(echo "$row" | cut -d'|' -f1)
     # Path: <artifact-root>/sha256/<aa>/<bb>/<64-hex>/content
     path="<artifact-root>/sha256/${sha:0:2}/${sha:2:2}/${sha}/content"
     [ -f "$path" ] || echo "MISSING: $sha"
     [ "$(sha256sum "$path" | cut -d' ' -f1)" = "$sha" ] || echo "MISMATCH: $sha"
   done
   ```
2. Check for orphaned files (files on disk not referenced in SQLite):
   ```bash
   # Reverse check: walk artifact directory, verify each file is in artifacts table
   ```
3. Check disk space:
   ```bash
   df -h <artifact-root>
   ```
4. Check GC log for recent runs.

## Immediate actions

1. **Stop Forge processes.**
2. **Back up the artifact directory** (or snapshot the filesystem).
3. **For missing blobs:** attempt to recover from backup. If unrecoverable, mark the referencing records as `artifact_missing` in SQLite and quarantine the affected sessions/tasks.
4. **For hash mismatches:** treat as a security incident (`docs/runbooks/security-incident.md`). A hash mismatch suggests tampering or disk corruption.
5. **For orphaned files:** do not delete immediately. Move to a quarantine directory and review.
6. **For disk full:** run GC dry-run, then GC for real if safe:
   ```bash
   just run-kernel --gc-dry-run
   just run-kernel --gc
   ```

## Recovery

1. Restore missing blobs from backup.
2. Verify all `artifact_link` rows resolve.
3. Run the artifact corruption test suite (SPEC §50.2).
4. Restart Forge and verify the startup recovery report.
5. For quarantined sessions/tasks, decide: re-run (if eval), restore from backup (if production), or mark as lost.

## Post-incident

- File an incident report.
- Add the inconsistency signature to the artifact integrity test suite.
- Review GC policy (frequency, retention TTL).
- If hash mismatch, escalate to security owner (potential tampering).
- Verify backup includes the artifact directory (not just SQLite).

## Prevention

- Atomic ingest (write temp, fsync, rename) (SPEC §29.3).
- Hash verification on read.
- GC with dry-run before real GC (SPEC §29.3).
- Regular integrity checks (nightly).
- Backup SQLite + artifact directory + Git (SPEC §29.6).
- Disk space alerts at 70% / 85% / 95%.

## Related

- `docs/runbooks/database-corruption.md` — database issues affecting artifact links.
- `docs/runbooks/security-incident.md` — if hash mismatch suggests tampering.
- SPEC §29.3 (artifact store layout), §29.4 (retention), §50.2 (acceptance).
