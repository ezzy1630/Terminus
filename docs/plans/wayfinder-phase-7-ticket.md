# Phase 7 — Workflow and Skill Compiler

**parent:** [Wayfinder Map — Phase 7 Workflow and Skill Compiler](wayfinder-phase-7-map.md)
**label:** wayfinder:task
**status:** complete
**assignee:** codex

## Question

What implementation and evidence are required to make Phase 7 real on this
checkout, including any Phase 0–6 gap that blocks its acceptance surface?

## Acceptance

- Workflow IR represents typed deterministic, model_judgment, human, connector,
  effect, verifier, and subworkflow nodes with preconditions, postconditions,
  evidence requirements, retry/timeout/budget constraints, and guarded edges;
- natural-language/skill compiler parses markdown skills and procedures with exact
  character/line `SourceSpan` tracking and explicit ambiguity classification;
- owner-test classifier cleanly separates deterministically derivable steps (code)
  from model judgment, human approval, and external effects;
- static validation suite verifies graph reachability, bounded loops, taint flow,
  temporal sequence safety, mandatory-step witness paths, capability attenuation,
  and verifier independence;
- deterministic controller owns graph traversal, loop counters, and verify-repair-commit
  cycles without letting generated scripts own privileged execution;
- reusable organizational workflows are available for software patches, migrations,
  reviews, and release preparation;
- malicious skill tests verify prompt injection and privilege escalation rejection;
- `just boundary-check`, `just codegen`, `just codegen-check`, `just check`,
  `just check-all`, and eval smoke tests all pass cleanly.

## Resolution

Implemented the Phase 7 workflow and skill compiler vertical slice end to end,
with comprehensive static validation, deterministic controller, standard workflows,
and verified test suites. ADR-0036 recorded.
