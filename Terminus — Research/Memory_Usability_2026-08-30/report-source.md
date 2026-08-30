# Terminus memory and harness usability research

Audience: Terminus maintainers

Date: 2026-08-30

Scope: Hermes Agent, OpenAI Codex, and current Terminus memory, context, modes, tool discovery, compaction, cleanup, and efficiency. RLM is excluded.

## Direct answer

Terminus should not copy either reference harness wholesale. Hermes has the best user-facing raw session recovery model. Codex has the strongest bounded memory consolidation, progressive source disclosure, deterministic instruction loading, deferred tool search, and cache identity discipline. Terminus already has the strongest effect boundary, provenance contracts, immutable context manifests, and evidence-gated completion.

The immediate product gap was not another semantic memory subsystem. Terminus already has one, but correctly keeps it disabled because its precision and harm promotion gates have not passed. The live gap was that an agent could see only one bounded prior-turn excerpt, while exact historical turn artifacts and compaction sources already existed behind the control plane. The first safe vertical slice is therefore exact same-task session recall in the opt-in adaptive profile. It gives the model source-backed continuity without creating durable claims, changing the prompt automatically, or weakening scope.

## Source snapshot

- Terminus repository: main at `86a4402c8575c84c92d170f94c1a476303ebcb61` before this work.
- Hermes Agent: `4f22543509d1b91dc45bcb369447126c5eb14fb7`.
- OpenAI Codex: `94cbbddafc1776d5e377bca1b05932c697e82238`.

Primary upstream references:

- [Hermes session search implementation](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1b91dc45bcb369447126c5eb14fb7/tools/session_search_tool.py)
- [Hermes memory tool](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1b91dc45bcb369447126c5eb14fb7/tools/memory_tool.py)
- [Hermes profiles](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1b91dc45bcb369447126c5eb14fb7/website/docs/user-guide/profiles.md)
- [Hermes session documentation](https://github.com/NousResearch/hermes-agent/blob/4f22543509d1b91dc45bcb369447126c5eb14fb7/website/docs/user-guide/sessions.md)
- [Codex memory system](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/memories/README.md)
- [Codex memory extraction prompt](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/memories/write/templates/memories/stage_one_system.md)
- [Codex memory consolidation prompt](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/memories/write/templates/memories/consolidation.md)
- [Codex compaction implementation](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/core/src/compact.rs)
- [Codex deferred tool search](https://github.com/openai/codex/blob/94cbbddafc1776d5e377bca1b05932c697e82238/codex-rs/core/src/tools/handlers/tool_search.rs)

## What the systems actually do

### Hermes

Hermes separates two kinds of continuity.

1. `session_search` returns actual stored messages from SQLite. It infers browse, search, read, and scroll operations from arguments, uses FTS5 for discovery, keeps search bounded, follows session lineage, excludes hidden operational sessions, and avoids treating compaction-generated summaries as authoritative conversation bookends. It makes no model call. This is history retrieval, not memory inference.
2. `memory` manages bounded `MEMORY.md` and `USER.md` files. The prompt uses a frozen snapshot. Writes persist for later sessions rather than silently changing the current prompt. The tool scans proposed memory for injection, fails closed on drift or read failure, and stops after bounded consolidation retries so memory cannot prevent the user response.

Hermes profiles are stronger isolation units than Terminus modes. A profile owns separate configuration, environment, identity prompt, memory, skills, sessions, cron state, and database. The documentation warns against multiple processes sharing one profile. This is useful for personas and operational separation, but it is not a workspace security boundary.

Hermes also gets model usability right in several small ways: surfaces have explicit toolsets, raw session recovery is available without loading all history into every prompt, and stable prompt material is separated from volatile material for provider caching.

### Codex

Codex durable memory is a gated, asynchronous, two-stage pipeline. Stage one reads bounded rollout evidence under a lease and can decide that no useful memory exists. The extraction prompt treats user statements as primary evidence, tool output as corroboration, and assistant claims as weaker. Stage two consolidates under a global lock, with bounded inputs, redaction, no network, and no collaboration tools. This limits both races and amplification.

Its read path is progressive. A small `memory_summary.md` is the routing index. The agent then searches `MEMORY.md` and opens only one or two relevant rollout summaries or skills. The prompt explicitly budgets this pass and asks for current verification when a remembered fact can drift. That is more efficient and more honest than injecting a large memory corpus.

Codex compaction uses a dedicated compaction request, retains recent user messages, reinjects deterministic initial and world context, persists the replacement, retries boundedly, and records usage and cache metrics. Its deferred tool search indexes only deferred tools, caches by source identity and dynamic metadata, and uses lexical ranking before loading full schemas. Its shell snapshot cache is small, keyed by the environment that affects correctness, and retry-bounded.

Codex modes are coherent execution contracts: collaboration posture, multi-agent policy, reasoning effort, personality, approval policy, and sandbox policy. They are not a bag of unrelated booleans. Exact mode and profile identity is retained in evidence.

### Terminus before this change

Terminus has three distinct continuity mechanisms, but only one was model-usable in the live standalone loop.

1. `WorkingMemoryService` can project objectives, criteria, decisions, failures, changed files, diagnostics, jobs, budgets, and blockers. It has no production reader or writer.
2. Automatic end-of-turn checkpoints are live, but their decision record is shallow. They record the acceptance count and terminal error, not the actual decisions, modified files, failed approaches, and unresolved diagnostics from the episode stream.
3. Prior-turn continuity injects one bounded excerpt from only the immediately previous completed turn. Exact user and assistant artifacts remain available, but the model had no session-history tool.

The durable memory package is deliberately off by default. `ADR-0023` requires provenance, scope, confidence, freshness, contradiction handling, expiry, quarantine, revalidation, user controls, and a precision/harm evaluation before promotion. This is correct. Enabling it merely because Hermes and Codex have memory would violate Terminus's own safety contract.

Terminus compaction already persists exact source episodes and has a recall adapter. The missing part is a provider-facing route to retrieve those sources. Context epochs and cache-stable prefixes are also already stronger than the reference implementations at the contract level.

The permanent minimal profile is a valid control arm. The adaptive profile previously changed `subagentsEnabled` only, while the live scout path was hard-disabled. In practice it offered no model-visible benefit. The live tool discovery path also exposed no capability cards, even though tool-card infrastructure exists.

## Implemented vertical slice

The adaptive profile now adds one tool after workspace activation: `recall`.

Properties:

- Minimal profile remains version 1 and never receives recall, even if an environment capability string requests it.
- Adaptive profile moves to version 2 and records recall in its exact profile hash and provider schema hash.
- Recall is restricted to earlier `COMPLETED` turns with the same `taskId` and `threadId`.
- `browse` pages recent turns, `search` scans at most 50 turns with deterministic lexical ranking, and `read` retrieves one exact turn.
- Every result includes user and assistant artifact URIs, content hashes through `sourceVersions`, per-role truncation flags, and explicit pagination or source continuation.
- Returned content is capped at 16,000 characters. Search and page sizes are capped independently.
- A source artifact above 1 MiB is refused with an explicit partial-result warning rather than loaded into the control process.
- Artifact bytes still use the kernel-backed `ArtifactClient` and checksum verification.
- A 64-entry LRU caches at most 64 KiB per immutable artifact URI. It does not cache by task text, inferred identity, or mutable profile state.
- Recall does not write memory, cross tasks, invoke a model, access the network, mutate context automatically, require effect approval, or enter the semantic side-effect ledger.
- Every call still gets the normal proposed and settled tool records and model transcript pair.

This combines Hermes's direct session recovery with Codex's progressive source retrieval, while retaining Terminus's scoped evidence boundary.

## Claim-to-source gap matrix

| Claim | Evidence | Confidence | Remaining gap |
| --- | --- | --- | --- |
| Raw same-scope history recall has lower semantic risk than automatic durable memory. | Hermes returns actual DB messages; Terminus `ADR-0023` treats inferred memory as fallible and promotion-gated. | High | Measure whether models over-trust old source text despite explicit scope. |
| Frozen prompt memory preserves cache identity and prevents mid-turn prompt drift. | Hermes freezes memory for the session; Terminus `ADR-0010` changes epochs when prompt-affecting state changes. | High | No live Terminus durable-memory prompt exists yet. |
| Progressive index then exact source read reduces prompt cost. | Codex memory summary and rollout routing; Hermes FTS session discovery. | High | Terminus needs a comparative token and latency cohort. |
| Adaptive mode previously had no live model-visible advantage. | Profile source differed only on delegation; live scout path was hard-disabled. | High | A future delegation slice still needs durable settlement. |
| Profile identity should cover every tool and prompt-affecting behavior. | Codex caches and Terminus evidence identities both key behavior-affecting state. | High | Add automatic regression assertions when new mode fields are introduced. |
| Semantic memory should remain off until evaluation proves value and low harm. | Terminus `ADR-0023` and `ADR-0025`; Codex Stage 1 has an explicit no-op gate. | High | Build and run the held-out promotion cohort. |

## What should be done next

### 1. Make deterministic working memory real

Project actual episode and verification state into the existing `WorkingMemoryService` at checkpoint time. Record decisions, changed files, failed approaches, open diagnostics, active jobs, and budget state from authoritative records. Do not use a model for this first pass. Feed the bounded projection into the next context epoch and test recovery after restart.

### 2. Add a session index, not a vector database

Move lexical recall from bounded row scanning to an FTS5 index over exact turn text and summaries. Keep task/thread scope in the query, lineage explicit, and source artifacts authoritative. Evaluate precision, latency, and token savings against the new scan implementation before enabling broader history windows.

### 3. Expose exact compaction-source recall

Extend `recall` with a source-oriented compaction action backed by the existing `recallCompaction` adapter. The model should be able to move from a compaction summary to the exact episode artifact that supports it. Never let a generated summary become the only retained authority.

### 4. Turn profiles into coherent postures

Keep only a few versioned profiles:

- `minimal`: permanent control, bounded coding tools, no recall, no delegation.
- `adaptive`: exact session recall, then bounded read-only delegation once durable child settlement is complete.
- A future research posture should add web and larger retrieval budgets only if its separate eval passes.

Do not create one mode per feature. A profile must state tool surface, authority, context policy, reasoning budget, orchestration policy, and evidence identity as one contract. User-selectable persona or account isolation should be a separate concept, closer to Hermes profiles.

### 5. Finish progressive tool and skill discovery

Populate live capability cards, index only deferred tools and skills, rank lexically, and load full schemas only after selection. Cache the index by source identity, trust metadata, and schema hash. Poisoned descriptors, missing tools, and rug-pull changes need the extension security cohort. Procedures should become skills only after repeated verified success, focused tests, and approval, as the memory package already requires.

### 6. Keep durable semantic memory frozen and gated

When the precision/harm cohort passes, use a Codex-like two-stage pipeline: bounded evidence extraction with an explicit no-op result, then serialized consolidation. Store provenance, scope, confidence, invalidation rules, and expiry. Inject only a small frozen routing summary per context epoch. Exact source reads should remain available through recall. Live memory edits should take effect only in the next epoch.

### 7. Add efficiency telemetry before promotion

Compare minimal and adaptive cohorts on:

- task success and evidence admission;
- input and output tokens;
- provider prefix-cache hit ratio;
- time to first useful action;
- tool calls and repeated reads;
- recall calls, scans, cache hits, source failures, and selected-turn yield;
- stale-history harm and cross-scope denial counts;
- intervention and repair rates.

The new recall cache needs hit, miss, eviction, and bytes-avoided telemetry before its size is tuned. No default should change from these measurements alone; promotion still requires the documented reliability and security gate.

### 8. Add retention and cleanup as explicit policy

Borrow Hermes's opt-in cleanup posture: dry-run first, never prune active sessions, never delete evidence still referenced by tasks or checkpoints, and make retention visible. Terminus's process cleanup is already strong. The remaining work is session and artifact retention with reference-aware GC, not another background janitor.

## Deliberately not done

- Durable semantic memory was not enabled.
- No vector or embedding dependency was added.
- No cross-task or cross-workspace recall was added.
- No desktop mode selector was changed. The existing dirty UI work controls steering behavior, not harness profile identity.
- No default was changed. `TERMINUS_HARNESS_PROFILE` still defaults to `minimal`.
- No RLM work was included.

## Verification record

- Focused tests: 86 passed, 408 assertions.
- Full control-service suite: 614 passed, 2,195 assertions.
- Changed-file ESLint: passed.
- Strict package typecheck inside `just check`: passed.
- `just standalone-check`: passed.
- `just eval-smoke`: passed, including the deterministic provider to control to kernel path. Evidence class is `fixture_only`.
- `TERMINUS_HARNESS_PROFILE=adaptive just eval-runtime-smoke`: passed with 4 provider attempts and 3 tool settlements. The fixture exercised adaptive profile selection and schema construction, but did not call recall against historical turns.
- `just check`: blocked in the untouched `mini-services/terminus-control/src/permission-profiles.ts:110` by an existing missing-return error.
- `just codegen-check`: blocked by the already-dirty mixed `docs/generated/inventory.md`; the file includes unrelated Python and desktop test count changes, so it was not staged as part of this work.
- Live recall quality against a multi-turn task remains unverified. The adaptive deterministic runtime path is green, but the fixture does not contain historical turns or invoke recall.

## Limitations

The lexical search implementation is deliberately simple. It is a safe baseline, not an assertion that substring ranking is the final retrieval design. Artifact reads are bounded and cached, but cache telemetry is not yet emitted. No comparative live cohort has established a performance or completion lift. The implementation therefore remains opt-in and must not be described as promoted or release-proven.
