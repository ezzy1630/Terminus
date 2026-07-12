# ADR-0024: External text compression shadow-only by default

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** context owner
- **Supersedes:** none
- **Related:** SPEC §3.x, §49.5, §49.6, Appendix J.3

## Context

External text compression services (e.g., The Token Company) can reduce token cost for some natural-language QA workloads (SPEC Appendix B, J.3). However: (1) aggressive compression can degrade quality on coding tasks, (2) sending context to a third-party compression service is a privacy/confidentiality concern, (3) compression of code, policy, or structured state is forbidden (SPEC §49.6), (4) vendor-reported results are treated as vendor-reported until independently reproduced (SPEC Appendix J.2).

We need compression to be available for research but never the default, never on code/policy/structured state, and always behind a privacy gate.

## Decision

Adopt **external text compression shadow-only by default** per SPEC §3.x, §49.5, §49.6, Appendix J.3:

1. **Shadow-only by default** — compression runs in shadow mode (compress, observe what would have been sent, but send the uncompressed version) by default. No production traffic is compressed without an explicit gate.
2. **Never compress code, policy, or structured state** (SPEC §49.6) — only natural-language text is eligible. Compression of code/policy/structured state is forbidden and architecture-boundary-checked.
3. **Privacy gate** — compression services are behind the experimental privacy gate. The Token Company is integrated only behind this gate (SPEC §48.10 task 13).
4. **Exactness/privacy tests** — compression must not alter semantics (exactness) and must not leak confidential content (privacy).
5. **Vendor-reported results are hypotheses** (SPEC Appendix J.2) — compression benchmarks are reproduced independently before promotion.
6. **Promotion gate** — compression is promoted from shadow to opt-in only after: total cost reduction observed, no quality regression, no privacy regression, exactness verified.
7. **Deterministic compression always available** — deterministic, local compression (e.g., elision, summarization via the Context Compiler) is always available and is the baseline. External compression is compared against this.

## Alternatives

- **Compression on by default.** Rejected (SPEC §49.6): quality risk; privacy risk; vendor-reported results not reproduced.
- **Compression of code/policy.** Rejected (SPEC §49.6): semantic corruption; integrity risk.
- **No compression at all.** Rejected: deterministic local compression (elision, summarization) is valuable and safe; external compression is researched.
- **Compression without privacy gate.** Rejected (SPEC §36.18): confidentiality violation.

## Consequences

- The Context Compiler (ADR-0009) performs deterministic local compression (elision, summarization) always.
- External compression runs in shadow mode; results are recorded but not sent.
- The Token Company integration is behind the experimental privacy gate.
- Architecture-boundary checks forbid compression of code/policy/structured state.
- The promotion gate (SPEC §18.7, §41.12) governs promotion from shadow to opt-in.

## Security Impact

Medium. Confidentiality policy (SPEC §36.18) blocks compression of secret-adjacent content. Privacy gate prevents unintended third-party data sharing. Exactness tests prevent semantic corruption.

## Evaluation Plan

- Shadow-mode harness: compress, observe, compare to uncompressed outcome.
- Exactness tests: compressed+decompressed text matches original (for eligible text).
- Privacy tests: compressed content does not leak confidential information.
- Cost/quality ablation: compressed vs. uncompressed on target cohorts.
- (If promoted) non-inferiority tests on quality; cost reduction observed.

## Migration

Shadow mode is introduced in M7 (SPEC §48.10 task 12). The Token Company integration is M7 task 13, behind the privacy gate. Promotion to opt-in requires the gate.

## Rollback

If compression causes quality regression in shadow mode, adjust the eligibility rules (do not disable shadow mode — it's observational). If promoted compression causes regression, demote to shadow (do not silently keep it on). Do not compress code/policy/structured state — ever.
