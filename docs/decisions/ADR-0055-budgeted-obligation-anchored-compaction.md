# ADR-0055: Provider-budgeted, obligation-anchored compaction

- **Status:** PROPOSED
- **Date:** 2026-08-30
- **Decision owner:** context owner
- **Supersedes:** fixed live defaults in the control-plane compaction path
- **Related:** SPEC §8, §9, §10, §33, §39; ADR-0009; ADR-0010; ADR-0023

## Context

The live control plane compacts model-visible episodes above a fixed 96,000-token estimate, retains a fixed 24,000-token tail, and renders each summary chunk with a fixed 400,000-token input ceiling. Those constants are unrelated to the selected provider/model's tested-safe window. They can compact too late for small windows, too early for large windows, or send an oversized summary request.

The persisted summary is source-backed and recallable, but its structured `goal` currently prefers model prose. A lossy summary must not restate the authoritative task contract. Repeated compaction also needs typed links to the earlier summaries it absorbs so exact recall remains recursively discoverable.

## Decision

1. Derive a versioned compaction decision from the provider-aware `ContextBudget` already reconciled for the current attempt. The initial policy compacts when episode history reaches 75% of the optional-context target, retains a bounded 25% recent tail, and sizes summary chunks from the selected model's hard input limit. A missing provider budget uses the previous fixed behavior as an explicit fallback. A known zero optional budget, an obligation anchor that consumes the summary input, or degraded tokenizer calibration disables compaction instead of inventing capacity. The degraded path preserves the baseline history window until calibration is trustworthy.
2. Persist an exact obligation anchor in every compaction summary: contract version and hash, objective, acceptance criteria and status, non-goals, constraints, and allowed scope. The anchor is supplied to the summarizer as a separate exact fragment. Model prose remains a lossy narrative and cannot override it. This is deliberately not a second copy of the complete task contract: `userOutcome`, verification hints, assumptions, unknowns, risk, budget, and change policy remain in the full contract that the Context Compiler hard-includes on every attempt.
3. Record parent summary hashes when a compaction absorbs earlier summary episodes. The immutable event/artifact log remains authoritative; the model-visible summary is an expandable view.
4. Record the policy version, derived limits, measured history, and outcome in compaction telemetry. Successful compaction starts the existing new-baseline lifecycle; failed compaction leaves every source episode visible.
5. Treat a committed compaction summary and its exact retained tail as required context. Before any summary call, require the fixed serialized scaffold plus retained tail to fit the model-visible byte and token allocation. Before commit, require the finalized summary plus retained tail to fit the same allocation.
6. Suppress an identical failed compaction fingerprint for the rest of the turn. New source episodes, task obligations, or policy values create a new fingerprint and one new attempt.
7. Preserve prompt-injection taint. Episode bodies and the model-produced narrative are JSON-serialized as untrusted data, the summary model is forbidden from following embedded instructions, and the persistent replacement remains `untrusted`/`high` injection risk even though it is required context.
8. Keep durable semantic memory disabled by default. This decision improves deterministic working continuity and episodic recall; it does not waive ADR-0023's precision/harm gate.

## Alternatives

- Keep global constants. Rejected because one value cannot be safe for 32k, 200k, and 1M windows.
- Use provider-native compaction as durable state. Rejected because opaque provider state cannot prove requirement retention, support provider changes, or replace local recovery.
- Turn on durable semantic memory to compensate for compaction loss. Rejected because stale-memory harm and cross-session utility remain unproven.
- Incrementally rewrite one old exchange every turn. Rejected as the default because it invalidates stable prompt-cache prefixes more often and adds a summarization call to every completed turn.

## Consequences

- The policy changes model input and requires the targeted context/recovery evaluation plus two approvals before merge.
- Small-window models compact before the provider limit instead of failing after it. Large-window models retain more exact history before paying summarization cost.
- CAS byte metadata is only a no-read pressure preflight. The live path materializes candidate sources and uses the selected model's calibrated tokenizer estimator for the trigger, retained tail, chunk fit, and finalized artifact. Calibrated estimates carry error headroom; degraded estimates use a conservative UTF-8 byte bound. Missing metadata forces measurement instead of suppressing compaction.
- Source episodes are never hidden for a replacement artifact that the episode loader cannot reopen, that crowds out the retained tail, or that the next context allocation cannot admit.
- A failed source/anchor/policy fingerprint spends at most one summary attempt per turn.
- Required inclusion does not upgrade trust: compaction output stays explicitly tainted and transcript instructions remain data.
- Anchored task obligations survive compaction even when the summary model omits or contradicts them; the next compiler pass remains responsible for the complete task contract.
- Summary lineage is a provenance graph rather than a chain discoverable only by parsing narrative text.

## Evaluation plan

- Unit/property coverage across small, medium, and large provider budgets.
- Compaction tests for exact obligation anchors, tool-pair integrity, source retention on failure, retained-tail admission, hostile transcript and summarizer-output serialization, and parent-summary lineage.
- Persisted-artifact conformance: compact, cross a serialization boundary, recover the obligation anchor, and expand exact source through the restart-bound recall store.
- Full restart conformance remains an evaluation gate: run the real persistence path and next context compilation, then prove unchanged complete task contract, checkpoint state, and effect settlements.
- Paired long-horizon cohort: full history versus recent complete tail plus anchored compaction, reporting task success, requirement recall, tokens, cache reads, summary failures, and recall expansions.

## Rollback

Disable the adaptive policy and use the explicit fixed fallback. Do not remove exact obligation anchors or source lineage from summaries that already exist.
