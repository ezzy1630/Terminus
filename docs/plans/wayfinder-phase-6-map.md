# Wayfinder Map — Phase 6 ACI, Editing and Verification

**tracker:** local-markdown
**label:** wayfinder:map
**status:** local-slice-complete; roadmap-exit-unverified

## Destination

Phase 6 is complete when Terminus provides an executable, evidence-backed ACI and
verification path: bounded read/search with source identity and continuation,
model-appropriate and hash-anchored edits through isolated transactions, useful
code intelligence, task-specific verification DAGs, independent claim/evidence
admission, and no authoritative merge or completion path outside admission.

Phase 0–5 work is complete enough for this destination when any blocker found in
those phases is either fixed in scope or explicitly recorded as an external gate;
no earlier-phase claim is treated as complete from source declarations alone.

## Notes

Domain: provider-neutral coding-agent operating system; Phase 6 implementation and
verification are explicitly authorized by the user for this map. Consult the
`grilling`, `domain-modeling`, and `principle-prove-it-works` disciplines. Keep
Rust effects behind the kernel RPC, keep provider wire details in provider
packages, preserve unrelated work, and report observed/proven/blocked facts
separately.

Canonical terms:

- **candidate**: isolated workspace state proposed by an actor;
- **evidence**: immutable observation tied to source/environment identity;
- **claim**: acceptance proposition whose status is admitted only from evidence;
- **admission**: the sole authority allowed to merge a candidate or mark a claim
  satisfied.

## Decisions so far

- [Phase 6 destination and scope](wayfinder-phase-6-ticket.md): implement the
  Phase 6 vertical slice in place and repair directly blocking phase-0–5 gaps.

## Not yet specified

- Full provider-specific edit-dialect factorial results and broad competitor
  comparisons require the evaluation environments and models available to CI.
- Production-scale remote verifier isolation and managed artifact retention may
  remain an operational gate after the local vertical slice.

## Completion evidence

The local Phase 6 vertical slice is implemented and has prior local test evidence. The acceptance
surface is now backed by bounded immutable artifacts and continuation cursors,
source-bound retrieval, provider-appropriate edit dialects, hash-anchored
transactional patches, real code-intelligence results, persisted verification
attempts and claim/evidence graphs, and durable candidate admission. Control
plane process execution runs through the kernel UDS; completion only updates
the task after an independent admission readback succeeds.

Observed proof from this execution:

- `mise exec -- just check-all`: passed; Rust workspace unit/integration,
  mini-kernel checks, strict TypeScript/Python checks, codegen, security,
  truth checks, 395 Bun unit tests, and 194 Bun integration tests passed.
- `just e2e`: passed twice, including SQLite persistence, restart/resume,
  recovery integrity, immutable evidence, admission, and seven live ARP v2
  parity tests.
- `mise exec -- just fuzz-smoke`, `fault-injection`, and `release-drills`:
  passed.
- `mise exec -- just build`: passed after repairing the Python build recipe to
  use `uv build`.
- Historical fork checks reported pass, but their repository declarations did
  not prove live behavior parity. ADR-0039 retires them in favor of
  `just standalone-check` and public-path verification.

The roadmap and stable-release gates remain blocked by evidence outside this
source slice, including fixed-model cohort comparisons, current signed Linux
enforcement, and release-scale recovery. No fixture or degraded platform result
is promoted to release proof. See `terminus-research-execution-ledger.md`.

## Out of scope

- Phase 7 workflow/skill compiler implementation.
- Phase 8 learned routing and expected-value multi-agent scheduler.
- Phase 9–12 client, computer-use, evolution-lab, ecosystem, and dominance work
  except for interfaces required to keep Phase 6 contracts honest.
