# Phase 6 — ACI, Editing and Verification

**parent:** [Wayfinder Map — Phase 6 ACI, Editing and Verification](wayfinder-phase-6-map.md)
**label:** wayfinder:task
**status:** local-slice-complete; roadmap-exit-unverified
**assignee:** codex

## Question

What implementation and evidence are required to make Phase 6 real on this
checkout, including any Phase 0–5 gap that blocks its acceptance surface?

## Acceptance

- bounded read/search report source identity, explicit truncation, artifacts or
  continuation, and stable query-bound cursors;
- retrieval exposes lexical, structural, graph/history and diagnostic signals
  through the canonical ACI without raw provider/LSP wire leakage;
- patch application is isolated, source-hash anchored, journaled, reversible on
  failure, and admits only validated candidate state;
- edit operations reject stale and ambiguous anchors and expose a complete diff;
- code intelligence returns real symbols/references/diagnostics/workspace diff
  semantics rather than success-shaped placeholders;
- verification plans are acyclic, criterion-complete, revision/environment-bound,
  persisted with attempts/evidence, invalidated after relevant edits, and unable
  to turn actor self-report, missing tests, manual gaps, or stale evidence into
  completion;
- admission is the only authoritative merge/completion path and enforces clean,
  independent review where required;
- focused tests, security tests, recovery tests, eval-smoke, `just check`,
  `just check-all`, `just codegen-check`, and applicable CI/release checks are
  run, with blocked environment gates named exactly.

## Resolution

Implemented the Phase 6 vertical slice and repaired the directly blocking
earlier-phase gaps. Verification is recorded in the map, final response, and
repository diff. Roadmap and release evidence remain fail-closed as recorded in
`terminus-research-execution-ledger.md`; this ticket does not mark them passed.
