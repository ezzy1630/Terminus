# @terminus/memory

Durable memory: candidate extraction queue, privacy filtering, lease-protected
curator consolidation, BM25 (+ optional semantic) retrieval, revalidation,
explanation, controls, telemetry, procedure→skill promotion, and M10 exit gate.

Per SPEC §16, §39, §48.13 and ADR-0023.

## Public API

- `MemoryService` — extract / consolidate / retrieve / invalidate / quarantine /
  disable / export / reset / telemetry / promoteToSkill
- `MemoryRepository` + `InMemoryMemoryRepository`
- `ExtractionQueue` — candidate extraction queue
- `filterPrivateData` — secret / PII gate before storage
- `consolidateMemories` + `createCuratorSandbox` — isolated curator (no network)
- `retrieveMemories` — scoped BM25; semantic opt-in via `SemanticScorer`
- `revalidateClaim` — cheap TTL / file-hash / symbol / authority hooks
- `explainRetrieval` — why / source / scope / confidence / freshness
- `promoteProcedureToSkill` — after repeated verified success
- `evaluateExitGate` / `runAllExperiments` — held-out precision, utility, stale,
  contradiction, harm
- `WorkingMemoryService` — deterministic task-state projection (§16.1)

## Invariants

- Disabled by default (`enabled: false`). Remains disabled until the M10 gate
  passes and an explicit promotion decision is made.
- Candidates never promote directly to active — consolidation only.
- Curator sandbox: `networkAllowed: false`; writes only via repository.
- Memory cannot override repository authority.
- Incomplete provenance is rejected at extract and consolidate.
- Harmful-use counter auto-quarantines at threshold.
- No default cross-workspace sharing.
