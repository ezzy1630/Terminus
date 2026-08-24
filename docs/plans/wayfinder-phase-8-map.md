# Wayfinder Map — Phase 8 Deep Model Profiles, Routing & Expected-Value Orchestration

**tracker:** local-markdown
**label:** wayfinder:map
**status:** local-slice-complete; roadmap-exit-unverified

## Destination

The Phase 8 local slice is complete when Terminus provides model-profile contracts, stage-aware deterministic routing, empirical Bayesian posteriors, expected-value subagent scheduling, candidate workspace isolation, independent clean-context reviewers, and stagnation/safety supervision for the declared provider profiles.

Earlier-phase source exists, but its roadmap gates remain independently evidence-bound. No earlier phase is inferred complete from source declarations.

## Notes

Domain: provider-neutral coding-agent operating system; Phase 8 implementation and verification are executed end-to-end. Keep Rust effects behind the kernel RPC, keep provider wire details in provider packages, preserve unrelated work, and report observed/proven/blocked facts separately.

Canonical terms:

- **ModelProfile**: versioned profile capturing dialect, reasoning policy, continuation, compaction, caching, structured repair, and error mitigations;
- **ModelCohortPosterior**: conjugate Beta-Binomial reliability and Log-Normal latency posterior distribution updated from telemetry;
- **StageRouter**: deterministic capability-based model selector matching workflow node stage, circuit breakers, rate limits, and confidentiality;
- **ExpectedValueScheduler**: subagent spawn evaluator enforcing $EV = \text{InfoGain} + \text{SpecGain} + \text{ParallelGain} - \text{TokenCost} - \text{CoordCost} - \text{ConflictRisk} - \text{ReviewCost} > \text{Threshold}$;
- **CandidateWorkspace**: isolated worktree/branch for speculative writers with read-only effect epochs;
- **CleanContextReviewer**: independent code reviewer receiving stripped context without author biases, with model family diversity preferred;
- **StagnationSupervisor**: long-horizon supervisor monitoring 11 diagnostic signals with an escalating intervention ladder.

## Decisions so far

- [Phase 8 destination and scope](wayfinder-phase-8-ticket.md): implement deep model profiles, profile registry, empirical Bayesian posterior tracker, stage-aware deterministic router, provider continuation manager, expected-value scheduler, candidate workspace manager, clean-context reviewer, and stagnation supervisor. ADR-0037 recorded.

## Completion evidence

The Phase 8 model profiles, routing, and orchestration local slice is implemented:
- Deep model profiles for Anthropic, OpenAI, Google, and Local open-weight models with tested-safe tokens, caching breakpoints, and structured repair.
- Pinned, versioned Profile Registry with provider, local/offline, and confidentiality policy filtering.
- Online conjugate Beta-Binomial and Log-Normal posterior updating from verified execution observations.
- Stage-aware deterministic router with stage affinity scoring (classifier, implementer, reviewer, specialist, vision, local_safe).
- Resumable provider continuation manager classifying failures (rate limit, quota, refusal, timeout, format) and tracking restart tokens.
- Expected-value subagent scheduler calculating net EV and emitting DelegationContractV2 with authority ceilings and write isolation.
- Candidate workspace manager providing branch isolation for speculative writers and gating merge through the admission service.
- Clean-context reviewer stripping actor rationalizations, enforcing read-only authority, and preferring model family diversity.
- Stagnation supervisor detecting 11 diagnostic signals and triggering the structured intervention ladder.
- OpenAPI definitions in `@terminus/public-api`, client methods in `@terminus/public-client`, and HTTP endpoints in `terminus-control`.
- ADR-0037 records the decision. Integrated checks are rerun at handoff.

Live-provider conformance and preregistered routing/orchestration benefit remain
unverified; see `terminus-research-execution-ledger.md`.
