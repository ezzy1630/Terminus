# ADR-0010: Immutable context epochs and exact manifests

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** context owner
- **Supersedes:** none
- **Related:** SPEC §8.6, §8.7, §33.13, §33.15

## Context

Provider prompt caching is effective only when the cache prefix is stable (SPEC §3.3, "Don't Break the Cache"). If the canonical context is mutated in place between turns, the cache misses every time and cost explodes. Additionally, if we cannot reconstruct exactly what was sent to a provider, we cannot: audit a security incident, replay a decision under a different model, ablate a context feature, or detect when a compaction dropped a requirement.

The non-negotiable invariant "No hidden model input" (SPEC §26.3 #2) requires an exact, persisted record of every provider request.

## Decision

Adopt **immutable context epochs and exact manifests** per SPEC §8.6, §8.7, §33.13, §33.15:

1. **Context epoch** — a period in which one immutable provider-cache baseline remains active. Within an epoch, the prefix sent to the provider is byte-stable. Epochs change only when the cache baseline must change (model swap, tool palette change, authority update, compaction event).
2. **Exact context manifest** — persisted **before** every provider send. Records: every fragment considered (selected and rejected), selection reasoning, transformations applied, final order, roles, tool schemas, omissions, elisions, provider continuation metadata, content hashes, and token estimates.
3. **Immutable** — manifests and epochs are append-only. A new turn creates a new manifest; it does not mutate the prior one.
4. **Replayable** — any manifest can be re-rendered under a different renderer or model (counterfactual replay, SPEC §33.16).
5. **Auditable** — every provider attempt links to its manifest; every manifest links to its epoch; every epoch links to its fragments' source versions.

Manifests are stored in SQLite (`context_manifests` table) with full content in the artifact store.

## Alternatives

- **Mutable context with delta logs.** Rejected: cache misses; harder replay; audit requires reconstruction.
- **Manifests only on demand.** Rejected: violates "No hidden model input" (SPEC §26.3 #2); cannot audit retrospectively.
- **Provider-native continuation as the only state.** Rejected (SPEC §49.6): cannot switch providers; cannot detect requirement loss.

## Consequences

- Every provider attempt has a `manifest_id` foreign key.
- Epochs are explicitly managed: a turn that changes the cache baseline creates a new epoch.
- The Context Compiler must produce a manifest before every send, even if the manifest is identical to the prior turn's (which would reuse the epoch).
- Manifest storage grows with provider attempts; retention policy applies (SPEC §29.4).
- Counterfactual replay reads manifests, not raw transcripts.

## Security Impact

High. Manifests are the audit trail for "what did the model see." They are required for incident investigation (e.g., prompt-injection forensics) and for verifying that secret-adjacent content did not reach a disallowed provider (SPEC §36.18).

## Evaluation Plan

- Property tests: manifest hash is stable for the same input; manifest persisted before send; manifest links to all source versions.
- Requirement-recall tests: compaction cannot drop hard-required fragments (manifest comparison).
- Counterfactual replay: same manifest re-rendered under a different provider produces equivalent content.
- Cache-hit rate telemetry: stable epochs produce high cache-hit rates on compatible providers.

## Migration

Terminus-owned context epochs and manifests are introduced in M6 (SPEC §48.9) and are the source of truth (ADR-0039).

## Rollback

If manifests prove too expensive to store, apply a retention policy (keep manifests for N turns, archive older ones to artifact store). Do not silently stop recording manifests — that violates SPEC §26.3 #2.
