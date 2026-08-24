# ADR-0009: Context IR and provider-specific renderers

- **Status:** ADOPTED
- **Date:** 2025-07-11
- **Decision owner:** context owner
- **Supersedes:** none
- **Related:** SPEC §8, §33, §38

## Context

Most coding-agent harnesses accumulate a raw transcript of model messages and tool results, then send the whole thing as the next prompt. This loses: (1) what was actually sent (no manifest), (2) why each fragment was included (no selection reasoning), (3) provider-specific optimization opportunities (cache prefixes, continuation IDs, tool schema dialects), (4) the ability to replay or ablate context decisions, and (5) the ability to detect when a requirement was dropped during compaction.

OpenCode has a typed context source registry and context epochs, which is a useful substrate, but it is provider-coupled and lacks exact manifests and counterfactual replay.

## Decision

Adopt a **canonical Context IR with provider-specific renderers** per SPEC §8 and §33:

1. **Context IR** (`packages/context-ir`) — typed, sourced, versioned fragment schemas independent of any provider message format. Fragment kinds: `authority`, `project_rule`, `task_contract`, `world_state`, `code`, `test`, `documentation`, `tool_result`, `recent_episode`, `checkpoint`, `memory`, `tool_schema`, `user_attachment` (SPEC §8.2, Appendix E.2). Each fragment carries source, source version, authority, priority, trust, confidentiality, injection risk, exactness, scope, freshness, dependencies, invalidation, estimated tokens, and selection features.
2. **Compilation pipeline** (`packages/context-compiler`) — produce, deduplicate, score, allocate budget, and assemble fragments into a canonical ordered sequence (SPEC §33.12).
3. **Provider renderers** (`packages/provider-*`) — map the canonical sequence into a provider-specific request (OpenAI/Anthropic/Google/local) with exact cache prefixes, tool schema dialects, and continuation metadata. Project the provider response back into canonical Context IR (SPEC §33.14).
4. **Exact manifests** — persist the exact manifest (what was considered, selected, transformed, ordered, sent) before every provider send (ADR-0010).
5. **Counterfactual replay** — re-render any manifest under a different renderer or model (SPEC §33.16).

Provider-specific request bodies MUST NOT appear in canonical domain packages (SPEC §42.4).

## Alternatives

- **Raw transcript accumulation.** Rejected: no manifest; no replay; loses cache optimization; loses requirement-recall.
- **Provider-native state as the only durable state.** Rejected (SPEC §49.6): cannot switch providers; cannot replay; loses audit.
- **Single canonical request format sent to all providers.** Rejected: loses provider-specific caching/continuation; provider concepts leak into the canonical domain.

## Consequences

- Every provider request has a durable manifest before send (SPEC §26.3 #2).
- The Context Compiler is a first-class subsystem with its own evaluation (ADR-0001).
- Provider renderers are isolated in `packages/provider-*`; canonical packages do not import them (SPEC §42.4).
- Counterfactual replay supports A/B testing of context policies (SPEC §33.16).
- The World State Registry recomputes current environmental state at safe turn boundaries (SPEC §33.5).

## Security Impact

High. Confidentiality labels on fragments prevent secret-adjacent content from reaching providers that disallow it (SPEC §36.18). Injection-risk labels drive taint tracking (SPEC §36.15). Authority fragments are distinct from untrusted data (SPEC §26.3 #8). Provider confidentiality policy blocks disallowed providers (SPEC §36.18).

## Evaluation Plan

- Context ablations: checkpoint/recent-window vs. full history; retrieval position; budget allocation (SPEC §33.16, §48.9).
- Provider renderer exactness tests: rendered request matches expected prefix/cache structure.
- Requirement-recall tests: compaction cannot drop hard-required fragments (SPEC §46.3).
- Counterfactual replay: same manifest re-rendered under a different provider produces equivalent model-visible content (modulo provider dialect).

## Migration

Terminus Context IR and context epochs are first-party contracts (ADR-0039). M6 verifies their manifests, selection behavior, and provider renderings directly.

## Rollback

If the Context Compiler fails to improve outcomes (Risk R4), disable or simplify the component via feature flag (SPEC §49.5). The minimal baseline (ADR-0025) does not depend on it. The Context IR schema remains stable for any future re-enablement.
