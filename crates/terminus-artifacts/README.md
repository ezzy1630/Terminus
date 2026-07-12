# terminus-artifacts

Content-addressed artifact store.

`ArtifactStore` ingests bytes into `$root/sha256/ab/cd/<hash>` while streaming
SHA-256, fsyncs the temp file, and atomically renames it into place (SPEC.md
Section 29.3). Metadata is persisted as JSON sidecars under `metadata/`.
Garbage collection is reference-aware, retention-class-aware, and always
dry-run capable; legal-hold artifacts are never collected (Section 29.4).

The store is intentionally dependency-light (`sha2`, `hex`, `serde_json`,
`tracing`) so it can be embedded by the kernel, the testkit, and the control
plane's export pipeline.
