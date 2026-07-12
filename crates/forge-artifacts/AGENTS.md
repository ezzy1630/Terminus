# AGENTS.md — forge-artifacts

## Local rules

- **Hash is identity.** `sha256:<64-hex>` is the canonical key. Never store
  by content address derived from anything other than SHA-256 over the raw
  (post-decompression) bytes.
- **Atomic ingest.** Always write to `tmp/` then `rename(2)` into the CAS
  path. Never write directly into the CAS path. Always fsync the temp file
  before rename; fsync the parent directory where supported.
- **Idempotency.** Re-ingesting identical bytes MUST return the same hash
  without mutating the store.
- **GC is dry-run first.** `gc_collect` MUST internally call `gc_dry_run` and
  only delete hashes that are both unreferenced and not on `legal_hold`
  retention. Never delete in-place without a prior dry-run report.
- **No panics.** Typed `ArtifactError` everywhere; no `unwrap`/`expect`.
- **No `unsafe`.**
