# @terminus/artifact-client

Client for the kernel's ArtifactIngestService. Per SPEC §29.3, §31.1.

## Public API

- `ArtifactClient` with `ingest(bytes, metadata)`, `get(hash)`,
  `metadata(hash)`, `link(hash, ownerType, ownerId, purpose)`, `gc(dryRun)`,
  `toArtifactRef(meta)`.
- `ArtifactKernelClient` interface (bridges to kernel RPC).
- `streamBytes(bytes, chunkSize)` — async iterable for chunked streaming.

## Invariants

- Artifacts are immutable. Logical records may supersede one another, but
  artifact bytes never mutate.
- Metadata is cached locally for repeated lookups; bytes are always fetched
  from the kernel.
- GC dry-run reports what would be deleted; `gc(true)` only reports,
  `gc(false)` applies.
