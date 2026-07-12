# Context Compiler

This document is the deep dive for the Context Compiler subsystem (SPEC §8, §33). The Context Compiler replaces transcript accumulation with typed, inspectable, provider-rendered context. It is governed by ADR-0009 (Context IR + provider-specific renderers), ADR-0010 (immutable epochs + exact manifests), and ADR-0011 (provenance DAG checkpoints).

## Why a Context Compiler (SPEC §8, J.3)

Raw transcript accumulation loses: what was sent (no manifest), why each fragment was included (no selection reasoning), provider-specific optimization opportunities, replay/ablation ability, and requirement-loss detection. Research evidence (SPEC J.3) shows:

- Long-context position degradation → bounded high-signal working set; authority/recent state placed deliberately.
- Recent complete tool window + summary can outperform full history → checkpoint/recent-episode policy; no full-history default.
- Prompt-cache effectiveness depends on stable prefixes → immutable epochs and provider-specific renderers.

## Canonical Context IR (SPEC §8.1, §33.2, Appendix E.2)

Fragment kinds (SPEC §8.2):

```
authority | project_rule | task_contract | world_state | code | test |
documentation | tool_result | recent_episode | checkpoint | memory |
tool_schema | user_attachment
```

Each fragment carries (Appendix E.2):

- `id`, `kind`, `contentRef` (artifact URI).
- `source`: uri, producer, producerVersion, observedAt, observedBy (kernel/control/provider/user/external), evidenceRefs.
- `sourceVersion`: sha256 or null.
- `authority` (0–100), `priority`, `trust` (trusted/derived/untrusted).
- `confidentiality` (public/workspace/secret_adjacent/secret), `injectionRisk` (none/low/medium/high).
- `exactness` (exact/semantics_preserving/recoverable_by_reference).
- `scope`, `freshness`, `dependencies`, `invalidation`.
- `estimatedTokens` (per provider), `selectionFeatures`.

## Layers (SPEC §8.2)

The Context Compiler assembles fragments in layers:

1. **Authority** — system prompt, safety rules, project rules (`.terminus/`, AGENTS.md).
2. **Task contract** — objective, acceptance criteria, scope, budget, constraints.
3. **World state** — current diagnostics, test status, git state, jobs (recomputed at safe turn boundaries).
4. **Code** — files, ranges, symbols (via `read`, `search`).
5. **Recent episode** — complete tool call+result episodes (never split).
6. **Checkpoint** — structured continuation state (ADR-0011).
7. **Memory** — (disabled by default, ADR-0023).
8. **Tool schema** — provider-specific tool definitions (ADR-0012).

## Exactness classes (SPEC §8.3, §33.4)

- **Exact** — byte-identical to source (e.g., file ranges, tool results). Hash-stable.
- **Semantics-preserving** — meaning preserved but bytes differ (e.g., elided file with marker).
- **Recoverable-by-reference** — represented by a reference; full content reachable via artifact (e.g., checkpoint, summary).

Exact fragments MUST remain exact across all renders. Semantics-preserving and recoverable-by-reference fragments are labeled as such in the manifest.

## Assembly algorithm (SPEC §33.12)

```
1. Collect candidate fragments from all producers (world-state registry, retrieval, recent episodes, checkpoints, memory).
2. Deduplicate by content hash + source version.
3. Validate source versions (reject stale).
4. Score candidates (authority, priority, relevance, freshness, exactness, cost).
5. Allocate budget (per-provider token estimates; hard budget cap).
6. Select: hard-required fragments first, then by score within budget.
7. Apply transformations (elision, ordering, role assignment, provider-specific formatting).
8. Render to provider-specific request (ADR-0009 renderer).
9. Persist exact manifest BEFORE send (ADR-0010).
10. Send; on response, project back to canonical Context IR (tool results, assistant message).
```

## Context epochs (SPEC §8.7, §33.15)

A context epoch owns one immutable provider-cache baseline. Within an epoch, the prefix sent to the provider is byte-stable. Epochs change only when the cache baseline must change: model swap, tool palette change, authority update, compaction event.

## Exact manifests (SPEC §8.6, §33.13, ADR-0010)

Persisted **before** every provider send. Records:

- every fragment considered (selected and rejected);
- selection reasoning;
- transformations applied;
- final order, roles, tool schemas, omissions, elisions;
- provider continuation metadata;
- content hashes;
- token estimates.

Manifests are immutable and replayable (counterfactual replay, §33.16).

## World State Registry (SPEC §33.5)

Typed current environmental state recomputed and admitted at safe turn boundaries:

- Diagnostics (LSP).
- Test status.
- Git state (branch, dirty, recent commits).
- Jobs (running, completed).
- Source versions (per file).

The registry prevents stale world-state fragments from reaching the model.

## Retrieval pipeline (SPEC §33.8, §33.9, §33.10, §33.11)

1. **Query generation** (§33.7) — from task contract + recent episode + diagnostics, generate retrieval queries.
2. **Candidate retrieval** — lexical (FTS5/BM25), structural (Tree-sitter AST), LSP (references, definitions), dependency/import/test graph.
3. **Rank fusion** — combine candidate sources; rank by relevance + authority + freshness.
4. **Evidence-coverage pass** (§33.9) — ensure hard-required evidence is covered; expand gaps.
5. **Candidate scoring** (§33.10) — authority, priority, relevance, freshness, exactness, cost.
6. **Budget allocation** (§33.11) — hard budget; hard-required fragments first.

## Checkpoints (SPEC §9, §33.16, ADR-0011)

Structured checkpoint schema (`prompts/checkpoint/template.md`): objective, completed steps, pending steps, requirements, assumptions, unknowns, decisions, failures, open questions, source versions.

Checkpoint validator (§33.13): before a checkpoint is used as context, it is validated against the active task contract, acceptance criteria, and recorded failures. A checkpoint that drops a hard-required fragment is rejected.

## Counterfactual replay (SPEC §33.16)

Any manifest can be re-rendered under a different renderer or model. Used for:

- A/B testing of context policies.
- Provider swap mid-task.
- Audit (what would model X have seen?).
- Ablation (what if we removed this fragment?).

## Provider renderer contract (SPEC §33.14)

Each provider renderer (`packages/provider-openai/anthropic/google/local`) implements:

- `render(manifest) → ProviderRequest` — map canonical sequence to provider-specific request (cache prefixes, tool schema dialect, continuation IDs).
- `project(ProviderResponse) → ContextIR` — project response back to canonical fragments (assistant message, tool calls, tool results).
- `estimateTokens(fragment) → per-provider estimate` — for budget allocation.

Provider-specific request bodies MUST NOT appear in canonical domain packages (SPEC §42.4).

## Evaluation plan (SPEC §48.9)

- Full-history vs. checkpoint/recent-window experiments.
- Retrieval and position ablations.
- Provider-specific cache and compaction experiments.
- Requirement-recall tests (compaction cannot drop hard-required fragments).
- Counterfactual replay tests.

Exit gate (M6, SPEC §48.9): long-horizon target tasks achieve non-inferior or improved success with lower context/cost, and requirement-loss tests pass. Every provider request is explainable from a manifest.
