# ADR-0023: Durable memory disabled until precision/harm gate passes

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** memory owner
- **Supersedes:** none
- **Related:** SPEC §16, §39, §26.5

## Context

Durable memory — persistent claims about the codebase, user preferences, or past sessions that the model can retrieve and use — could reduce repeated work across sessions. But memory can also inject stale or incorrect claims (Risk R6): a memory claim that "we always use library X" might be wrong two months later; a memory claim that "the user prefers approach Y" might bias the model away from a better solution.

Memory without provenance, revalidation, expiration, or harm measurement is dangerous. SPEC §26.5 explicitly lists "permanent model-generated memory by default" as a non-goal for the first production release.

## Decision

Adopt **durable memory disabled until precision/harm gate passes** per SPEC §16, §39, §26.5:

1. **Disabled by default** — durable memory is off in the default configuration. The minimal baseline (ADR-0025) and the secure-local-default profile do not include memory.
2. **Provenance required** — every memory claim has provenance (source session, source turn, source fragment). Memory without provenance is rejected (SPEC §49.6).
3. **Revalidation hooks** — memory claims have cheap revalidation hooks that re-check the claim against current state. Stale claims are expired or flagged.
4. **Expiration** — memory claims have TTLs; expired claims are quarantined, not used.
5. **Contradiction and supersession** — new claims that contradict old claims trigger a resolution process; superseded claims are marked.
6. **Scope filters** — memory is scoped to a workspace/session; cross-workspace memory requires explicit capability.
7. **Harm telemetry** — memory usage is tracked: helpful retrievals, harmful retrievals, stale retrievals, contradiction events.
8. **Promotion gate** — memory is promoted to opt-in (not default) only after: positive held-out utility, low harmful-retrieval rate, complete provenance. Promotion to default requires a further gate (SPEC §18.7, §41.12).
9. **User controls** — explanation, disable, export, reset, quarantine (SPEC §39).

## Alternatives

- **Memory on by default.** Rejected (SPEC §26.5, §49.6): Risk R6; stale/incorrect claims; insufficient measurement.
- **Memory without provenance.** Rejected (SPEC §49.6): cannot audit; cannot detect harm.
- **Memory without revalidation/expiration.** Rejected: stale claims; harm.
- **Memory as the only context policy.** Rejected (SPEC §49.6): full transcript retention is not the only policy; memory is one source among many.

## Consequences

- Memory is implemented (`packages/memory`) but disabled by default.
- The promotion gate (SPEC §18.7, §41.12) is the contract for enabling memory.
- Memory harm suite (`evals/security/` + memory-specific evals) measures harmful retrievals.
- User controls (explanation, disable, export, reset, quarantine) are required.
- Procedure-to-skill promotion workflow: useful memory claims can be promoted to skills (ADR-0017).

## Security Impact

Medium. Memory is a vector for stale-claim injection (Risk R6). Provenance enables forensic investigation. Harm telemetry detects regressions. Scope filters prevent cross-workspace leakage. User controls (disable, quarantine) provide kill switches.

## Evaluation Plan

- Memory harm suite: held-out tasks where memory could help or hurt; measure both.
- Revalidation tests: stale claim is detected and expired.
- Provenance tests: every claim has provenance; claims without provenance are rejected.
- Expiration tests: expired claim is quarantined, not used.
- Contradiction tests: new contradicting claim triggers resolution.
- User control tests: disable/export/reset/quarantine work as specified.

## Migration

Memory is implemented in M10 (SPEC §48.13) but disabled by default. Promotion to opt-in requires the M10 exit gate: positive held-out utility with low harmful-retrieval rate and complete provenance. Promotion to default requires a further gate.

## Rollback

If memory causes harm on a cohort (Risk R6), quarantine that class of claims or disable memory entirely. The minimal baseline (ADR-0025) does not depend on memory. Do not silently re-enable quarantined memory.
