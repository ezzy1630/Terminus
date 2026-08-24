# ADR-0040: Sealed evolution and evidence-derived conformance

- **Status:** ADOPTED
- **Date:** 2026-08-23
- **Decision owner:** evaluation owner + security owner
- **Supersedes:** none
- **Related:** ADR-0001, ADR-0025, ADR-0032, `Terminus — Research/SPEC.md` §35–36, §43

## Context

An optimizer that can read hidden tasks, change graders, or promote its own
candidate can manufacture apparent progress. A conformance label inferred from
source presence or a lower-level test suite creates the same failure at the
release boundary. Terminus needs useful local evolution machinery without
turning a fixture, an unsigned report, or a declaration into product evidence.

## Decision

1. The optimizer, isolated evaluator, and promotion service are separate roles.
   The optimizer may read training failures and development data only. Hidden
   holdouts remain evaluator-only; the promotion service consumes receipts, not
   raw tasks.
2. Every candidate is grounded in immutable traces and a structured failure
   attribution. It declares the target and changed components, forbidden
   components, predicted improvements and regression floors, resource/security
   effects, required tests, and an immutable causal-ablation plan before
   evaluation.
3. Evaluation proceeds in order: static, replay, focused holdout, broad
   holdout, then security/chaos. Receipts are bound to the candidate identity,
   version, exact partition, and immutable artifact. Broad holdout evidence must
   transfer across at least two cohorts and two model profiles.
4. A separate promotion signature binds the candidate and the ordered receipt
   set. Canary observations are candidate-bound. A violated prediction,
   regression floor, or hard guardrail automatically rolls the candidate back.
5. Conformance is assessed for one exact commit and platform from current,
   unexpired, passed, immutable evidence. Levels L0 through L6 are contiguous:
   missing evidence at one level prevents every higher claim.
6. Local unit tests prove these contracts only. Phase 11 promotion and Phase 12
   dominance remain unverified until real held-out runs, a real canary, signed
   release evidence, independent reproduction, and adoption evidence exist.
7. The offline evaluation package performs structural receipt inspection only.
   It has no caller-controlled path to emit a cryptographically verified level
   or dominance claim. A separately trusted verifier must resolve immutable
   artifacts, validate signatures and signer authority, and emit the release
   system card.

## Alternatives

- **Let the optimizer run the hidden tests.** Rejected because it leaks the
  objective and rewards benchmark overfitting.
- **Use one weighted readiness score.** Rejected because a strong average can
  conceal a critical security, durability, or cohort regression.
- **Infer conformance from implemented modules.** Rejected because code
  presence is not execution evidence.
- **Permit non-contiguous levels.** Rejected because a distributed or
  evolutionary feature cannot compensate for a missing safe local substrate.

## Consequences

- Evolution changes carry more preregistration and evidence metadata.
- Bundled changes require baseline, singleton, and full-bundle ablation cells.
- Promotion and conformance tooling fails closed when evidence is missing,
  stale, cross-platform, cross-commit, failed, or structurally incomplete.
- Offline structural inspection always reports public conformance as
  `UNVERIFIED`, even when the receipt set is structurally sufficient for L6.
- The repository may implement later research phases experimentally while its
  public system card continues to report them as unverified.

## Security and privacy impact

Hidden partitions, graders, promotion policy, production secrets, and raw
release holdouts are outside optimizer authority. Candidate security and
privacy effects are preregistered. The Python evaluation plane receives no
production effect authority.

## Evaluation plan

- Unit tests for partition isolation, candidate invariants, ablation coverage,
  ordered receipts, signature binding, automatic rollback, repair memory, and
  Pareto dominance.
- Unit and CLI tests for exact commit/platform identity, expiry, failed
  evidence, contiguous levels, and independent-reproduction requirements.
- Before any Phase 11 claim: run a real failure-to-candidate-to-canary loop with
  induced regression and rollback.
- Before any L6 claim: run the locked competitor comparison and obtain an
  independent reproduction artifact.

## Migration and rollback

The contracts are additive and live in the offline `terminus-evals` package.
Existing fixture promotion utilities remain non-release evidence. Removing the
role separation or evidence identity rules requires a superseding ADR and
security/evaluation review; it is not a runtime feature flag.
