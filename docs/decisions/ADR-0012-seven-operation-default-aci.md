# ADR-0012: Seven-operation default ACI

- **Status:** EXPERIMENTAL
- **Date:** 2025-07-11
- **Decision owner:** ACI owner
- **Supersedes:** none
- **Related:** SPEC §11.1, §34, §49.5

## Context

The Agent–Computer Interface (ACI) is a first-order performance variable (SPEC §3.4). SWE-agent's experiments showed a large improvement from a purpose-built interface at fixed model in its 2024 setup, but the exact magnitude should not be assumed for current models, and the exact optimal tool count is unknown.

Too few tools and the model can't express necessary operations; too many and the model gets confused (Risk R5). SPEC §11.1 proposes seven default always-visible operations: `read`, `search`, `patch`, `exec`, `job`, `inspect`, `capability`. But the exact count, the inclusion of `ask` vs. a structured user-decision outcome, and the best edit dialect per model are deliberately left experimental (SPEC §49.5).

## Decision

Adopt a **seven-operation default ACI** per SPEC §11.1 and §34, marked EXPERIMENTAL:

1. `read` — outline, ranges, symbols, hashes, elisions, artifacts (SPEC §34.5).
2. `search` — lexical with rank/facets/continuation; structural via Tree-sitter (SPEC §34.6).
3. `patch` — transactional edits with snapshot anchors, journal, rollback (SPEC §34.7–34.10).
4. `exec` — bounded structured command execution (SPEC §34.11).
5. `job` — durable, restart-survivable processes (SPEC §34.12).
6. `inspect` — diagnostics, symbols, references, diff, test status (SPEC §34.13).
7. `capability` — search/activate optional tools, skills, MCP, plugins (SPEC §34.14).

Each tool has: canonical input/result validators, provider-specific schema dialects (OpenAI/Anthropic/Google/local), concise and full descriptions, token estimates, docs, golden examples, policy metadata, and tool-selection evaluation cases (SPEC §45.6).

Status is EXPERIMENTAL because:
- The exact default tool count (7 vs. 6 vs. 8) is subject to evaluation (SPEC §49.5).
- `ask` vs. structured user-decision outcome is OPEN.
- Best edit dialect per model is OPEN.
- Programmatic tool-composition mode is OPEN.

None of these block the secure core (SPEC §49.5 closing note).

## Alternatives

- **Minimal shell (Bash only).** Rejected as default (kept as baseline, ADR-0025): too low-level for token efficiency; harder to enforce scope.
- **Large tool palette (15+ tools).** Rejected: model confusion (Risk R5); harder token budgeting; harder policy.
- **Single multi-purpose tool.** Rejected: loses progressive disclosure; harder model selection.
- **`ask` as an 8th default tool.** OPEN: deferred to evaluation; structured user-decision outcome may subsume it.

## Consequences

- Tool definitions live in `schemas/tools/*.json`; codegen produces provider dialects (SPEC §45.6).
- The default ACI is benchmarked against the minimal shell baseline and alternate palettes (SPEC §48.8 exit gate).
- Tool-selection and argument-error rates are tracked (SPEC §50.4).
- Progressive disclosure: only 7 tools are always-visible; more are activated via `capability` (SPEC §11.2).
- All tool results use the universal envelope (SPEC §34.4, Appendix E.3): status, summary, data, artifacts, source versions, truncation, diagnostics, side effects, trust, confidentiality, timing.

## Security Impact

Medium. Bounded tool results prevent silent truncation (SPEC §26.3 #4). Source versions prevent stale writes (SPEC §26.3 #5). Trust/confidentiality labels on results prevent secret leakage (SPEC §26.3 #6). Capability-based activation prevents implicit extension authority (SPEC §26.3 #8).

## Evaluation Plan

- ACI conformance tests: every tool matches its schema; every result matches the envelope (SPEC §34.17).
- Model-selection tests: tool-selection and argument-error rates meet target (SPEC §50.4).
- Cohort ablation: default 7-tool palette vs. minimal shell vs. alternate palettes (SPEC §48.8).
- Edit-dialect experiments: exact-text vs. range vs. symbol vs. unified-diff per model (SPEC §49.5).

## Migration

The seven tools are introduced in M5 (SPEC §48.8). The minimal shell baseline (ADR-0025) remains runnable as a control arm. Promotion from EXPERIMENTAL to ADOPTED requires the M5 exit gate: ACI v1 improves edit-application success or final task success on its target cohort without unacceptable cost/security regression.

## Rollback

If the seven-tool palette causes model confusion (Risk R5), merge/split tools or alter activation. The minimal baseline (ADR-0025) is always runnable. Demotion to EXPERIMENTAL or REJECTED requires a new ADR with evidence.
