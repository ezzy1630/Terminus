# terminus-patch

Transactional patch engine for the Terminus kernel.

`PatchEngine` applies a list of `PatchEdit`s — `CreateFile`, `ReplaceRange`,
`ReplaceExactText`, `ReplaceSymbol`, `Insert`, `DeleteRange`, `MoveFile`,
`DeleteFile`, `UnifiedDiff` — against a `WorkspaceBaseline`. Each transaction
snapshots affected files into an overlay, verifies per-file source hashes,
acquires per-path leases in sorted order (to avoid deadlock), applies all
edits, runs validators (UTF-8, line count, brace balance), writes a durable
journal, and rolls back atomically on failure (SPEC.md Section 34.7, 34.8).

The patch is atomic at the Terminus transaction layer, not at the native
filesystem layer. The journal and snapshots guarantee recovery from partial
host-level application.
