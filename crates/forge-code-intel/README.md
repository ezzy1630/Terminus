# forge-code-intel

High-level symbol and diagnostics surface for the Forge kernel.

`CodeIntelService` exposes `inspect_symbol`, `find_references`,
`diagnose_files`, and `workspace_diff` (SPEC.md Section 34.13). The default
`InMemorySymbolIndex` provides a tiny heuristic scanner that picks up
`fn`/`function`/`def`/`class`/`struct`/`interface`/`enum`/`const`/`type`
declarations; real tree-sitter parsers are a M5 task. The high-level surface
is stable: callers can swap in a tree-sitter-backed index without changing
service code.
