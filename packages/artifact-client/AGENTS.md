# @forge/artifact-client — local rules

## Non-negotiable

- Artifact bytes are immutable. Never write or mutate.
- Metadata is cached locally; bytes are always fetched from the kernel.
- GC dry-run is non-destructive.

## What NOT to add

- Direct filesystem access to the artifact store (the kernel owns the CAS).
- Compression/encoding logic (the kernel handles compression at ingest).
