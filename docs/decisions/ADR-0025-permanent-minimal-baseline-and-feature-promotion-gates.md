# ADR-0025: Permanent minimal baseline and feature promotion gates

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** evaluation owner
- **Supersedes:** none
- **Related:** SPEC §3.7, §18.7, §41.12, §50, Appendix I.2

## Context

mini-SWE-agent's intentionally tiny Bash loop is strategically important: it proves that complexity has a high burden of proof (SPEC §3.7). Without a permanent minimal baseline, sophisticated features (memory, learned routing, multi-agent, compression, semantic retrieval) can accumulate without evidence that they improve outcomes. The result is a system that is complex, expensive, and no better than the baseline.

We need: (1) a permanent minimal baseline that is always runnable, (2) feature promotion gates that require evidence before any feature becomes default, (3) a component promotion matrix that names the primary metric, guardrails, and minimum comparison for each feature.

## Decision

Adopt a **permanent minimal baseline and feature promotion gates** per SPEC §3.7, §18.7, §41.12, §50, Appendix I.2:

1. **Permanent minimal baseline** (SPEC §3.7) — a minimal shell-oriented mode with one model, Bash-like execution, linear history, no advanced retrieval, no memory, no subagents. Always runnable. Always benchmarked. Defined in `evals/baselines/forge-minimal.yaml`.
2. **Feature promotion gates** (SPEC §18.7, §41.12) — a feature affecting context, tools, routing, compression, memory, or orchestration MUST carry a version and an evaluation record before becoming default. Promotion requires:
   - non-inferiority on safety sub-metrics (no safety regression hidden);
   - improvement on the primary metric (ADR-0001) on its target cohort;
   - no unacceptable regression on any other cohort;
   - guardrails active and tested;
   - evidence archived (URL, retrieval date, content hash, interpretation note per Appendix J.4).
3. **Component promotion matrix** (Appendix I.2) — for each component (context checkpointing, AST/LSP retrieval, repo map, tool palette, edit dialect, scout, parallel writers, reviewer, memory, compression, learned router, programmatic tool mode), name the primary metric, guardrails, and minimum comparison.
4. **No unpinned experiment as a default** (SPEC §26.3 #10) — every default feature carries a version and an evaluation record.
5. **Decisions deliberately left experimental** (SPEC §49.5) — the list of OPEN features (exact default tool count, `ask` tool, edit dialect, semantic embedding index, adaptive context allocator, provider-native compaction, external compression, learned router, automatic memory promotion, programmatic MCP/tool mode, parallel writer threshold, always-on vs. triggered verification nodes, WebSocket transport, container/micro-VM backend) each has an experiment owner and promotion gate. None blocks the secure core.

## Alternatives

- **No baseline; ship features as they're built.** Rejected: no way to know if features help; complexity grows without evidence (SPEC §3.7).
- **Baseline removed after initial validation.** Rejected: loses the control arm; future regressions undetectable.
- **Promotion by assertion.** Rejected (SPEC §26.3 #10): no evidence; no audit.
- **Single gate for all features.** Rejected: different features have different metrics and guardrails (Appendix I.2).

## Consequences

- The minimal baseline (`evals/baselines/forge-minimal.yaml`) is always runnable.
- The full baseline (`evals/baselines/forge-full.yaml`) is the configured default with all promoted features.
- Every feature ADR references its promotion gate and cohort.
- The promotion gate (SPEC §18.7, §41.12) is the contract for default status.
- Features that fail their gate remain opt-in (or are not shipped).

## Security Impact

Medium. The baseline provides a control arm for safety regressions: if a feature causes a safety regression, the baseline reveals it. Promotion gates prevent unsafe features from becoming default. "No unpinned experiment as a default" (SPEC §26.3 #10) is a release blocker.

## Evaluation Plan

- The Python eval lab runs the minimal baseline, the full baseline, and feature-specific ablations on every cohort.
- The promotion gate (SPEC §18.7, §41.12, §50) is the contract.
- Each feature's ADR references its cohort, metric, and guardrails.
- Features that fail their gate are documented as REJECTED or remain EXPERIMENTAL.

## Migration

The minimal baseline is introduced in M0 (SPEC §48.3). The full baseline grows as features pass their gates. Features that fail their gates are documented and remain opt-in.

## Rollback

If a promoted feature causes a regression, demote it (revert to opt-in or remove from default). The minimal baseline is always available. Do not silently keep a regressing feature as default — that violates SPEC §26.3 #10.
