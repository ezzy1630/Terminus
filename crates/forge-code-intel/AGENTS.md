# AGENTS.md — forge-code-intel

## Local rules

- **High-level surface is stable.** `CodeIntelService` exposes four methods
  only: `inspect_symbol`, `find_references`, `diagnose_files`,
  `workspace_diff`. Adding a new method requires SPEC amendment.
- **Stub-friendly.** The default `InMemorySymbolIndex` is intentionally
  simple. Do not embed full parsers in this crate; wire tree-sitter through
  a separate `SymbolIndex` impl in M5.
- **No LSP/DAP exposure.** The model never sees raw LSP methods. Compose
  them here and return bounded semantic results.
- **No `unsafe`.** No panics.
- **`rename_preview` is read-only.** If added, it MUST return a patch plan,
  not mutate the workspace.
