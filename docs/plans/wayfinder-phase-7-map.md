# Wayfinder Map — Phase 7 Workflow and Skill Compiler

**tracker:** local-markdown
**label:** wayfinder:map
**status:** local-slice-complete; roadmap-exit-unverified

## Destination

The Phase 7 local slice is complete when Terminus provides a typed Workflow and Skill
Compiler that combines dynamic orchestration with deterministic safety:
compiling natural-language skills, prose procedures, and structured workflows
into statically verified, typed Workflow IR with exact source-span provenance,
owner-test classification, taint/temporal/reachability/bounded-loop static analysis,
mandatory-step witness paths, capability attenuation, verifier independence,
a deterministic verify-repair-commit controller, and reusable organizational workflows.

Phase 0–6 work is complete enough for this destination when any blocker found in
those phases is either fixed in scope or explicitly recorded as an external gate;
no earlier-phase claim is treated as complete from source declarations alone.

## Notes

Domain: provider-neutral coding-agent operating system; Phase 7 implementation and
verification are explicitly authorized by the user for this map. Consult the
`grilling`, `domain-modeling`, and `principle-prove-it-works` disciplines. Keep
Rust effects behind the kernel RPC, keep provider wire details in provider
packages, preserve unrelated work, and report observed/proven/blocked facts
separately.

Canonical terms:

- **Workflow IR**: typed, versioned directed graph of deterministic and model-owned nodes;
- **SourceSpan**: exact line/column character range in the original source document;
- **Owner Test**: classification determining whether code or a model/human owns a node;
- **Deterministic Controller**: execution engine owning graph traversal, loop bounds, and guarded edges;
- **Verify-Repair-Commit**: runtime pattern where postconditions are checked before state commit;
- **Witness Path**: execution path proving mandatory security/quality steps cannot be bypassed.

## Decisions so far

- [Phase 7 destination and scope](wayfinder-phase-7-ticket.md): implement the
  Phase 7 workflow and skill compiler vertical slice in place, static validation
  suite, deterministic controller, standard workflows, and API/UI integration.

## Not yet specified

- Phase 8 learned model-routing optimization and multi-agent expected-value scheduler
  require the Phase 7 workflow IR foundation and will be addressed in Phase 8.

## Completion evidence

The Phase 7 workflow and skill compiler local slice is implemented:
- Typed Workflow IR with source-span provenance and ambiguity classification.
- Natural-language skill compiler parsing SKILL.md and structured procedures into Workflow IR.
- Owner-test classifier cleanly separating deterministic derivation from model/human judgment.
- Static validation engine checking reachability, bounded loops, taint flow, temporal ordering,
  mandatory-step witness paths, capability attenuation, and verifier independence.
- Deterministic runtime controller owning traversal, guarded edges, loop counters, and verify-repair-commit.
- Reusable organizational workflows for software patches, database migrations, security reviews, and releases.
- ADR-0036 records the contract. Current integrated checks are rerun at handoff.

This is not the roadmap exit gate. Representative outcome comparisons and
candidate-bound evidence remain unverified; see
`terminus-research-execution-ledger.md`.

## Out of scope

- Phase 8 learned routing and expected-value multi-agent scheduling.
- Phase 9–12 client cockpits, computer-use, evolution lab, and ecosystem dominance.
