# ADR-0020: Single-agent default and expected-value scheduling

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** orchestration owner
- **Supersedes:** none
- **Related:** SPEC §14, §37

## Context

Multi-agent systems can be token-intensive and coding work often overlaps (SPEC §3.8, J.3). Defaulting to parallel writers or always-on scouts would burn cost without measured benefit on most tasks. The "verified successful tasks per dollar-hour" metric (ADR-0001) penalizes cost; a multi-agent default would have to justify itself against a single-agent baseline on every cohort.

At the same time, some tasks genuinely benefit from a read-only scout, a parallel writer, or a detached reviewer. We need a scheduler that defaults to one agent, escalates to more only when the expected value exceeds the expected cost, and remains disabled or neutral on cohorts where multi-agent doesn't help.

## Decision

Adopt **single-agent default with expected-value scheduling** per SPEC §14 and §37:

1. **Single-agent default** — the default topology is one agent. Multi-agent is opt-in or scheduler-escalated, never default (SPEC §14.1, §37.6).
2. **Expected-value scheduler** (SPEC §14.2, §37.5) — escalates to scouts/writers/reviewers only when the expected value (probability of success improvement × value of success) exceeds the expected cost (model + compute + wall-clock + human attention). The scheduler is deterministic before it is learned (ADR-0022).
3. **Task-specific verification DAG** (ADR-0021) — completion requires evidence; a single agent must still produce verification evidence.
4. **Delegation contract** (SPEC §14.4, §37.7) — delegations are typed: `scout` (read-only), `implementer` (writing worktree), `reviewer` (detached review). Each has a typed result schema.
5. **Worktree ownership** (SPEC §14.5, §37.9) — managed writers get isolated worktrees; the integration coordinator merges.
6. **Reviewer triggers** (SPEC §14.6, §37.11) — the reviewer is triggered by risk class, not by default.
7. **Loop protection** (SPEC §14.7, §37.14) — loop detection and interventions prevent bounded failure cases from running forever.
8. **Budget control** (SPEC §37.16) — hard budgets (model micros, compute seconds, wall-clock, human approvals) are enforced.

## Alternatives

- **Default parallel writers.** Rejected (SPEC §49.6): token-intensive; merge conflicts; cost without measured benefit on most tasks.
- **Always-on scout/reviewer.** Rejected: cost; not all tasks benefit.
- **Fixed orchestration levels (ORCHESTRATION.md original).** Rejected (SPEC Appendix A): replace with expected-value scheduler; reduce compulsory confirmation.
- **Learned scheduler from day one.** Rejected (ADR-0022): deterministic routing before learned routing.

## Consequences

- The default is one agent; multi-agent is a measured escalation.
- The expected-value scheduler is deterministic (rule-based) initially; learned routing is OPEN (ADR-0022).
- Delegations are typed with structured results.
- Worktrees are isolated per writer.
- Loop protection terminates bounded failure cases.
- Hard budgets are enforced; budget exhaustion triggers cancellation (SPEC §37.17).

## Security Impact

Medium. Single-agent default reduces attack surface (fewer concurrent privileged operations). Worktree isolation prevents writer scope violations (SPEC §37.9, Appendix I.1). Loop protection prevents resource exhaustion. Budget control prevents cost runaway.

## Evaluation Plan

- One-agent vs. scout/writer/reviewer ablations on separable and non-separable cohorts (SPEC §48.8, §48.11).
- Expected-value scheduler: escalation decisions are logged and auditable.
- Loop protection: bounded failure cases terminate within budget.
- Budget control: hard budgets enforced; cancellation propagates and reconciles effects (SPEC §37.17).

## Migration

The single-agent default is the founding topology. Multi-agent escalation is introduced in M8 (SPEC §48.11) and remains opt-in until the exit gate passes: multi-agent mode improves the separable cohort and remains disabled or neutral on non-separable tasks.

## Rollback

If multi-agent proves harmful on a cohort (Risk R8), raise the escalation threshold or disable the topology for that cohort. The single-agent default is always available. Do not silently default to multi-agent.
