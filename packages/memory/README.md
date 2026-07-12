# @forge/memory

Memory candidate extraction, consolidation curator, retrieval. Per SPEC §16, §39.

## Public API

- `MemoryService` with `extractCandidates(task)`, `consolidate()` (lease-
  protected), `retrieve(query, scope)`, `invalidate(fileHash)`,
  `quarantine(claimId)`, `disable()`, `export()`, `reset()`.
- `MemoryRepository` interface for persistence.
- `isContradiction(a, b)` — naive contradiction heuristic.

## Invariants

- Disabled by default (SPEC §39 — "memory: enabled: false" in defaults).
- Candidates are never promoted directly to active memory — they go through
  consolidation.
- The curator has no network and writes only to the memory workspace/store.
- A memory cannot override current repository state or higher authority.
- Harmful-use counter triggers automatic quarantine.
