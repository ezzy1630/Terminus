# Terminus context/prompt audit — HEAD c2cd9d5 (2026-08-29)

Subagent: claude-opus-5[1m]. Measured from 55 real compiled manifests + rendered requests in `.terminus-dev/kernel-data/artifacts/` (artifact `sha256:484e8672…`, attempt completed on account:zen). Token estimates = bytes/4 (`context-compiler/src/tokenizer.ts:200-204`). ✔ = lead re-verified at cited lines.

Headline: `prompts/` is dead. Nothing loads `prompts/authority/*.md`, checkpoint, memory, delegation, review, or provider-renderers. Shipped prompt = three TS constants `mini-services/terminus-control/src/agent/system-prompt.ts:19-63`.

## A. Reconstructed prompt

Order: `allocateBudget` (`context-compiler/src/index.ts:1335-1420`): hard-required (authority ≥80, :1288) in insertion order, then optional sorted by `utility = score/tokenCost` desc (:1352) — i.e. smallest first ✔.

| # | Layer | Source | Role | Tok measured | Tok this repo | Stable |
|---|---|---|---|---|---|---|
| 0 | Platform authority | system-prompt.ts:19-37 | developer | 275 | 275 | ✅ |
| 1 | Safety rules | :39-48 | developer | 219 | 219 | ✅ |
| 2 | Tool contract | :50-63 | developer | 439 | 439 | ✅ |
| 3 | required:policy:command | ctx-compiler:659 | developer | 48 | 48 | ✅ |
| — | required:task_contract | :636-657 | — | **0 — DROPPED** ✔ | 0 | ❌ never sent |
| 4 | Acceptance criterion ×N | :686-712 | developer | 46 | 46×N | per task |
| — | AGENTS.md chain | project-instructions.ts:169-206 | developer | 0 (scratch) | ~2,910 root + ~200/nested | per file |
| — | tool schemas | agent-tools.ts:379-573 | tools | 746 (3 tools) | ~1,250 (6) | ✅ |
| 5..15 | world_state ×11 msgs (changes, verification, request_phase, last_command, environment, memory, task, workspace, request, tool_capabilities, repository_signals) | :785-819 | user, one msg each | 406 | 500–1,500 | ❌ reorders by size |
| — | recent_history (prior turn) | turn-continuity.ts:55-64; index.ts:15253-15257 | user | — | ≤1,500 attempt 1 only | ❌ |
| — | kernel repository map (kind code, auth 55) | retrieval-hydrator.ts:142-172; index.ts:12242-12321 | user | 17 (scratch) | ≈16–18k (200 files) | ❌ recomputed/attempt |
| 16..19 | episodes: tool_result THEN its tool_call | :828-895 | tool/assistant | 60+57, 137+58 | 40–8,192 each | ❌ |
| 20 | checkpoint | :898-936 | user | 66 | 100–400 | ❌ evictable (auth 78) |

Measured: manifest predictedInput 1821 / predictedCached 1027 / breakpoints [4]; provider-observed inputTokens 3180, cachedInputTokens 2304 ⇒ estimator under-predicts 43%; `observeUsage`/`reconcileUsage` have zero call sites ⇒ `calibrationReason` always `degraded` (`tokenizer.ts:216-221`).
Fixed prefix for a real task ≈ 3,940 tok developer + ~1,250 tools ≈ 5.2k; only 1,027 marked cacheable. Per-episode: tool_call 40–60 tok (`{"protocol":"terminus.tool-call.v1",...}`), tool_result `{status,summary,data}` JSON ≤32 KiB (`agent-tools.ts:30`).
Attempt N = full recompile (`coding-turn-engine.ts:295`): 16 kernel metadata reads, AGENTS chain, repo-map paging (≤64 pages), two retrieval passes — no memoization.

Verbatim from rendered request: `[16] role=tool …call_da22…` then `[17] role=assistant tool_calls[0].id=call_da22…` — every result precedes its call. Cause: `bundle=[...closure.dependencies, s]` (:1409-1416 ✔); tool_call wins utility sort because smaller. Also: episode `kind='user_message'` renders as `role:"assistant"`.

## B. Prompt instructions referencing mechanisms the model cannot use (live prompt)
1. :28 "Activated skill bodies" — no skill ever injected; `/skills` (69 dirs) never reaches the model; `compileSkill` (`index.ts:9126`) authoring only.
2. :26 "Organization policy" — never compiled in.
3. :27 root/nested AGENTS.md — delivered as undifferentiated developer msg, no precedence marker.
4. :45 secrets brokered — no secret tool.
5. :46 approval bound to action hash — no such tool.
6. :36-37 output profiles — hardcoded "terse" (`context-compiler/src/index.ts:1836`); on Anthropic becomes `temperature:0.2`.
7. :41 "no direct filesystem/network/process access" — exec shell mode is arbitrary shell.
Dead `prompts/authority/system.md` additionally claims trust/confidentiality/policy_decision_id envelope fields (false: `projectModelVisibleResult` `agent-tools.ts:858-874` emits status/summary/data/error/truncation/is_error), a classify step, NEEDS_USER_DECISION outcome, four output profiles.
Missing vs Codex/Claude Code/OpenCode: persistence/autonomy clause; when-to-stop; verify-before-done; parallel tool calls instruction (engine supports batches; prompt never asks); preamble style; plan/todo; file-reading discipline; edit→test loop; final-message format (loop ends on first no-tool message `index.ts:16383-16391`, model never told); never-fabricate; repo etiquette.

## C. Ranked findings
1. Task contract silently dropped ✔: `worldState.sourceVersions["task://<id>"]=contractRow.contentHash` (`index.ts:14559`) vs fragment `sourceVersion:"v"+version` (`ctx:640,646`); `deduplicateAndExplain` (:1058-1067) omits as stale. 55/55 manifests. Model never sees objective/non-goals/constraints/unknowns. Fix: same version key on both sides.
2. Tool results before tool calls (:1409-1416). Fix: after allocation, re-sort runtime fragments by episode sequence.
3. User messages render as assistant (`provider-openai/src/index.ts:353-354`, `provider-anthropic/src/index.ts:268-292`).
4. Message array sorted by size ⇒ cache dies every attempt (:1287,1352). Fix: score for inclusion only; fixed order.
5. `context_headroom_exhausted` fires early: `turn-budget.ts:462-468` subtracts each attempt's full inputTokens cumulatively from testedSafeTokens pool (`index.ts:11347,11363`); ~40k/attempt vs 200k ⇒ dies after ~5 steps; 96k compaction threshold (`compaction-service.ts:30`) unreachable. Fix: track current window size.
6. Repository map ≈16–18k tok per attempt, alphabetically-first 200 files (`persistent_index.rs:599-601`), symbol extractor skips `export function/class/const` (`persistent_index.rs:336-392`); no eval. Fix: delete or ≤1k task-scoped list.
7. Live retrieval = exact symbol-name equality (`inspect.rs:247-261`) fed NL queries; relabeled `lexical_bm25` (`index.ts:12429-12440`); two passes per compile (:1552); `LexicalRetrieval` and `memory/bm25.ts` dead.
8. `max_tokens:1024`, `reasoning:0` (`index.ts:11347-11348`).
9. Compaction preflight caches 0 on error (`index.ts:15083-15085`).
10. Compaction summary appended at newest sequence (`index.ts:15510`), authority 45 ⇒ evictable.
11. `recallCompaction` unimplemented (`index.ts:15442-15520`; `compaction-service.ts:510-512` throws).
12. Silent window drop past 384 KB with no marker (`tool-episode-service.ts:112-144`).
13. Model never told remaining budget (`context-state-builder.ts:118-148`). (Note: Anthropic guidance says do NOT show a countdown to Fable 5; show steps, not tokens.)
14. `previousCacheEpoch` never supplied (`ctx:1626`) ⇒ cache-debug blind.
15. Memory unreachable: `@terminus/memory` zero imports; five hardcoded false literals (`ctx:1760`, `index.ts:14568,7494`, `minimal-profile.ts:36`); `memory_claims` no writer; event contract `memory.claim_created` (`runtime-protocol/src/events.ts:135-136`) no emitter; `buildEvidenceCoverage` (:1113-1132) demands memory fragment per unknown ⇒ permanent gap ⇒ `expandForGaps`. Minimum safe enablement: `AGENTS.local.md`-style file written by explicit `remember` tool, loaded via `DEFAULT_INSTRUCTION_FILENAMES` (`project-instructions.ts:41-46`).
16. Multi-turn: prior turns NOT replayed; `loadModelVisibleEpisodes(turnId)` per-turn (`tool-episode-service.ts:108-113`); cross-turn = 6,000-char `recent_history` excerpt only when turn has zero episodes (`turn-continuity.ts:18-19,67-69`) + latest checkpoint. Turn 2 starts from 1.5k-token excerpt of turn 1.
17. Dead compiler modules: handoff.ts, durable-goal-state.ts, world-state-registry.ts, checkpoint.ts, context-explanation.ts, replay.ts, compaction.ts (gated `index.ts:15282`).

**Hardening note (bounded, not a live defect).** Instruction-file discovery (`packages/context-compiler/src/project-instructions.ts:75-130`, `mini-services/terminus-control/src/index.ts:11931-12046`) has no `vendor/`, `node_modules/`, or `.git/` exclusion, and `DEFAULT_INSTRUCTION_FILENAMES` (`project-instructions.ts:41-46`) includes `CLAUDE.md` and `.cursorrules`. The tree vendors an OpenCode checkout whose `packages/llm/AGENTS.md` is 24,684 B (~6,170 tok) — larger than the root `AGENTS.md` (11,640 B, ~2,910 tok) — plus copies under vendored `node_modules` and the only four `CLAUDE.md` files in the repo. A task whose contract scopes a literal path under `vendor/` or a `node_modules/` directory would promote that third-party document into the hard-required developer prefix (authority 80–95, `project-instructions.ts:184`), more than doubling the fixed prefix and ranking third-party instructions above skills and retrieved content. Exposure is bounded because `instructionCandidateDirectories` (`index.ts:11912-11918`) only enumerates segments before the first wildcard, so a `**` scope collapses to `.` and reaches root `AGENTS.md` only. One-line fix: skip candidate directories containing `node_modules`, `vendor`, or `.git` segments. First-party instruction files total 42,687 B across ~40 files; nested ones are 700–1,250 B each.

## D. Recommended prompt architecture
| Tier | Contents | Target |
|---|---|---|
| Stable prefix (breakpoint) | one merged authority doc; tool schemas; root+nested AGENTS.md; skills index (name+1 line) | ≤3,000 tok |
| Per-task (breakpoint) | full task contract | ≤600 |
| Per-turn | checkpoint; recent_history; ONE world-state block incl. steps used/remaining | ≤800 |
| Volatile tail | episodes strict sequence order, assistant(tool_call)→tool(result), append-only; compaction summary at pruned position | ~remainder |
Rules: score for inclusion never order; collapse 11 world-state msgs to 1 (drop request/memory/task dupes); replace 16k repo map with ≤1k list + "use grep/glob"; put behavioural guidance in stable block; delete `prompts/` or load from it.
