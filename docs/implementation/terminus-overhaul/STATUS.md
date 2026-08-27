# Terminus overhaul status

Updated: 2026-08-26

State vocabulary: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `DONE`, `REMOVED_BY_DESIGN`.

`DONE` below means the local implementation slice has a live caller, focused tests, exact command evidence, and a committed change. It does not imply hosted CI, live-provider, cross-platform, signed-release, or holdout-evaluation proof.

## Current gate summary

| Gate | State | Note |
| --- | --- | --- |
| A, evidence and baseline | IN_PROGRESS | Local checks, required platform matrix entries, a declarative ruleset, and an eval registry are present. Hosted bootstrap evidence and remote ruleset enforcement remain open. |
| B, runtime correctness | IN_PROGRESS | The live loop now records proposal, verification, repair, finalization, and cancellation phases. Durable repair continuation recovery is wired; full crash-resume coverage and state-owner extraction remain open. |
| C, context/provider | IN_PROGRESS | Safe cited compaction, full-window sizing, instruction loading, provider abort propagation, stream retry guards, and one live anonymous Zen free-model path are proven. Retrieval, cache, paid-account, alternate-protocol, and broader conformance evidence remain open. |
| D, verification | IN_PROGRESS | Completion is proposal-first and admission is verification-gated; one live task completed through verification and branch admission, and repair node identity is fixed. Durable repair attempts and fenced leases are wired; semantic plan derivation and repair metrics remain open. |
| E, efficiency | IN_PROGRESS | Catalog-derived read classification and default-off scout behavior are wired. Marginal-value telemetry and optimization evidence remain open. |
| F, secure expansion | IN_PROGRESS | The kernel boundary and fail-closed defaults are retained. Remote trust-root, browser/desktop, client-conformance, and promotion evidence remain open. |

## Requirement matrix

The package rows below expand the stable IDs in `MASTER_PLAN.md`. IDs with a range are tracked as individual requirements in the referenced package row.

| ID | State | Owner/files | Evidence or blocker |
| --- | --- | --- | --- |
| INV-01..INV-15 | IN_PROGRESS | control, runtime protocol, kernel, docs | The durable contracts and live slices cover many invariants; exact runtime and release proof is still pending. |
| CORE-001 | IN_PROGRESS | `.github`, `Justfile`, lockfiles | Platform matrix jobs are required locally; exact cold-clone/bootstrap and hosted evidence are not reproduced here. |
| CORE-002 | IN_PROGRESS | `.github/rulesets`, release scripts | Declarative ruleset and dry-run/apply/verify script exist. Read-only verification found the live ruleset weaker than required; apply is intentionally not authorized. |
| RUN-001 | IN_PROGRESS | `mini-services/terminus-control/src/index.ts` | Live source order is proposal -> verification -> admission -> finalization -> checkpoint attempt -> `turn.completed`; full runtime proof is pending. |
| RUN-002 | IN_PROGRESS | `index.ts`, repair controller, turn scheduler | Repair directive, cumulative budget, durable attempt identity, fenced lease claim/heartbeat, pending state, child admission, parent supersession, and automatic re-entry are wired. DB-backed schedule/admission/fencing replay scenarios pass; the full fault-injection/replay proof remains open. |
| RUN-003 | IN_PROGRESS | recovery/reconciler services | Safe pre-provider/tool-boundary resume and durable repair-child recovery are wired; `RESPONSE_VALIDATING`/`VERIFYING` resume is still conservative quarantine. |
| RUN-004 | IN_PROGRESS | `index.ts`, `src/services/*` | Large composition root remains. |
| RUN-005 | IN_PROGRESS | `turn-budget.ts`, `index.ts` | Abort signals, policy-denied outcomes, semantic-operation accounting, and typed doom-loop settlement are wired; restart-aware operation accounting remains open. |
| RUN-006 | IN_PROGRESS | `turn-budget.ts`, tool catalog | Live budgeting uses the catalog side-effect class and focused read/write tests pass; durable per-operation ledger coverage remains open. |
| RUN-007 | IN_PROGRESS | `coding-turn-engine.ts`, protocol/UX | Doom-loop is a first-class engine/live stop with focused coverage; client rendering and durable stop-evidence conformance remain open. |
| CTX-001 | IN_PROGRESS | `compaction-service.ts`, `index.ts` | Pruning now requires materialized source plus immutable provenance, summarizes before hiding, and has an atomic production store path; replay/migration coverage remains open. |
| CTX-002..CTX-007 | IN_PROGRESS | context compiler/control | Full-window sizing, authoritative overlays, scoped instruction loading, and source-derived hashes are wired; complete ledger, graph retrieval, cache, and ablation proof remain open. |
| PROV-001..PROV-006 | IN_PROGRESS | provider transports/runtime | Direct abort, incremental stream handling, stream-safe fallback, provider-native request paths, and anonymous OpenCode Zen free-model inference are proven; paid-account, cache, accounting, and alternate-protocol conformance remain open. |
| VER-001..VER-003 | IN_PROGRESS | verification/repair/index | Cumulative budget, durable failure signatures, source revision, automatic re-entry, durable attempt identity/leases, and one live completion/admission path are wired; semantic plan derivation, repair metrics, and full replay proof remain open. |
| ACI-001 | IN_PROGRESS | `packages/aci`, control tools | Bounded typed read/patch/exec/poll/search/fetch tools remain kernel-mediated; complete coding-ACI coverage and metrics remain open. |
| SEC-001..SEC-002 | IN_PROGRESS | kernel/policy/control | Kernel boundary exists; effective sandbox and trust-root restart proof remain open. |
| EVAL-001 | IN_PROGRESS | `evals`, `python/forge_evals` | Internal cohorts exist; held-out paired evidence is not present. |
| ROUTE-001 | IN_PROGRESS | router/control | Keep router shadow/default-off pending outcome evidence. |
| SCOUT-001 | IN_PROGRESS | scout runner/control | Scout is default-off and explicit opt-in is tested; utility accounting is still process-local and no promotion evidence exists. |
| CU-001 | NOT_STARTED | computer runtime | Current endpoint/model is not a governed browser loop. |
| UX-001 | IN_PROGRESS | protocol and clients | Multiple clients exist; shared lifecycle fidelity is unverified. |

## Gate A package states

| ID range | State | Notes |
| --- | --- | --- |
| A1-01..A1-12, A1-P01 | IN_PROGRESS | Required platform matrix entries no longer use the previous ARM/Intel job-level `continue-on-error`; bootstrap, cold-clone, and 20-run promotion evidence remain open. |
| A2-01..A2-10 | IN_PROGRESS | Checked-in ruleset and apply/verify fallback exist; live verification is intentionally failing until the exact remote settings are approved and applied. |
| A3-01..A3-07 | IN_PROGRESS | `evals/registry.yaml` defines tiers, cohorts, manifests, metrics, paired seeds, and holdout policy; no run is release evidence yet. |

## Gate B package states

| ID range | State | Notes |
| --- | --- | --- |
| B1-01..B1-11 | IN_PROGRESS | Explicit lifecycle events, verification-gated terminal publication, and durable repair-attempt identity/lease association are wired; single transition-owner extraction remains open. |
| B2-01..B2-11 | IN_PROGRESS | Provider/effect recovery classification, safe boundary resume, fenced repair continuation recovery, cancellation, and quarantine are wired; DB-backed repair replay scenarios pass, while complete fault-injection/replay proof remains open. |
| B3-01..B3-13 | IN_PROGRESS | Cancellation signal propagation, catalog effect classes, operation normalization, semantic progress, policy denial, and doom-loop stops are wired; durable restart accounting remains open. |
| B4-01..B4-09 | IN_PROGRESS | Service extraction exists, but `index.ts` remains the composition and business-logic root. |

## Gate C package states

| ID range | State | Notes |
| --- | --- | --- |
| C1-01..C1-11, C1-T01..C1-T10 | IN_PROGRESS | Safe cited compaction and atomic production commit path are implemented and focused-tested; stale-revision/replay and full transaction suites remain open. |
| C2-01..C2-05 | IN_PROGRESS | `ContextStateBuilder` is an in-memory projection from episodes, not yet an authoritative ledger. |
| C3-01..C3-08 | IN_PROGRESS | Kernel-read repository instruction discovery is wired for relevant scopes with precedence and source hashes; full invalidation/symlink/generated-path coverage remains open. |
| C4-01..C4-11 | IN_PROGRESS | Retrieval and hydration modules exist; measure and source-attributed map still need work. |
| C5-01..C5-09 | IN_PROGRESS | Context IR and epochs exist; exact stable-prefix and provider controls need conformance. |
| C6-01..C6-10 | IN_PROGRESS | Provider packages and retry/runtime modules exist; current behavior needs stage-aware tests and signal wiring. |

## Gate D package states

| ID range | State | Notes |
| --- | --- | --- |
| D1-01..D1-08 | IN_PROGRESS | Completion proposal, verification plan/results/evidence, branch admission, and post-admission terminal ordering are wired; full live runtime/fault proof remains open. |
| D2-01..D2-10 | NOT_STARTED | Current default plan is criteria-driven but not fully semantic. |
| D3-01..D3-08, D3-M01 | IN_PROGRESS | One task-level budget, durable signatures, typed directive, durable attempt/lease identity, automatic child re-entry, parent supersession, re-verification, and DB-backed fencing replay are wired; repair metrics remain open. |
| D4-01..D4-04 | IN_PROGRESS | Clean-review helper exists and must stay experimental until paired evidence. |

## Gate E and F package states

| ID range | State | Notes |
| --- | --- | --- |
| E1-01..E1-09 | IN_PROGRESS | Existing bounded tools are kernel-mediated and focused-tested; full structured Git/symbol/diagnostic/native-test ACI remains open. |
| E2-01..E2-08 | IN_PROGRESS | Live graph ledger, catalog side-effect classification, and default-off scout gate are implemented; complete feature registry and marginal-value evidence remain open. |
| E3-01..E3-07 | NOT_STARTED | Requires Gate A telemetry. |
| F1-01..F1-14, F1-T01..F1-T13 | IN_PROGRESS | Kernel/policy boundary is retained and degraded execution remains explicit in local paths; effective backend matrix, trust-root rotation, and red-team proof remain open. |
| F2-01..F2-12, F2-P01 | IN_PROGRESS | Router remains shadow/default-off until outcome data exists. |
| F3-01..F3-12 | IN_PROGRESS | Child roles and feature gates exist; durable contracts and isolated worker path need proof. |
| F4-01..F4-10 | NOT_STARTED | Skill/memory/hook promotion remains disabled. |
| F5-01..F5-14 | NOT_STARTED | No browser vertical slice is claimed. |
| F6-01..F6-10 | IN_PROGRESS | Runtime protocol exists; client conformance and complete lifecycle need proof. |
| F7-01..F7-06 | NOT_STARTED | Background work must use the canonical executor first. |

## Cross-cutting states

| ID range | State | Notes |
| --- | --- | --- |
| X-DB-01..X-DB-08 | IN_PROGRESS | Existing SQLite migrations are monotonic; migration `0012_repair_attempts` now persists repair identity, provenance, budget, child association, and lease linkage. DB-backed repair rollback/replay/fencing coverage passes; journal completeness and other boundary coverage remain open. |
| X-OBS-01..X-OBS-08 | IN_PROGRESS | Semantic events and provider telemetry exist; correlation and artifact bounds need audit. |
| X-TEST-01..X-TEST-07 | IN_PROGRESS | Focused context/provider/lifecycle/security-adjacent tests, an exact live anonymous Zen completion pass, and DB-backed repair replay tests pass; the remaining fault-injection boundaries, alternate live paths, cross-platform, and client tests remain. |
| X-PROM-01..X-PROM-07 | NOT_STARTED | No new advanced default is promoted by this ledger without evidence. |
| X-DOC-01..X-DOC-15 | IN_PROGRESS | This ledger is the first durable documentation slice. |
| X-FINAL-01..X-FINAL-27 | IN_PROGRESS | Local implementation and evidence ledgers are updated; external release, runtime, holdout, and client gates remain open. |

## Current next actions

1. Obtain approval before applying the checked-in ruleset, then run `just github-ruleset-verify` against the exact repository.
2. Add DB-backed fault-injection/replay tests for proposal, branch admission, completion record, checkpoint, and cancellation boundaries; the repair schedule/admission/fencing slice is now covered.
3. Decide and test a durable recovery policy for `RESPONSE_VALIDATING` and `VERIFYING` without duplicate provider effects; current behavior remains conservative quarantine.
4. Run tiered paired multi-seed evaluations with live and private-holdout evidence before promoting routing, scout, reviewer, browser, or optimization features.
