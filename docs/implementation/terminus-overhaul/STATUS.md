# Terminus overhaul status

Updated: 2026-08-27

State vocabulary: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `DONE`, `REMOVED_BY_DESIGN`.

`DONE` below means the local implementation slice has a live caller, focused tests, exact command evidence, and a committed change. It does not imply hosted CI, live-provider, cross-platform, signed-release, or holdout-evaluation proof.

## Current gate summary

| Gate | State | Note |
| --- | --- | --- |
| A, evidence and baseline | IN_PROGRESS | Local checks, required platform matrix entries, a declarative ruleset, and an eval registry are present. Hosted bootstrap evidence and remote ruleset enforcement remain open. |
| B, runtime correctness | IN_PROGRESS | The live loop now records proposal, verification, repair, finalization, and cancellation phases. Durable repair continuation, completion admission recovery, coupled checkpoint/terminal publication recovery, atomic ambiguous-effect quarantine, provider-attempt identity/recovery, atomic task cancellation, candidate-branch admission recovery, and exact verification resume are wired; full crash-resume coverage and state-owner extraction remain open. |
| C, context/provider | IN_PROGRESS | Safe cited compaction, full-window sizing, instruction loading, provider abort propagation, stream retry guards, durable provider-attempt identity, native response metadata, one live anonymous Zen free-model path, revisioned kernel repository-map/native-recipe discovery, versioned retrieval selection metrics with deterministic scoring ablations, and durable provider cache observation read-back are proven locally. Bounded continuation consumption is complete-read validated; one fresh live cache observation is recorded, while a broader cache cohort, labeled retrieval outcomes, cache promotion, monorepo-scale, paid-account, alternate-protocol, and broader conformance evidence remain open. |
| D, verification | IN_PROGRESS | Completion is proposal-first and admission is verification-gated; one live task completed through verification and branch admission, and completion admission now has a durable PREPARED/COMMITTED recovery boundary. Durable repair attempts, fenced leases, signal-derived verification plans, and automatic repository-map/native-recipe signals are wired; repair metrics and full replay/live restart proof remain open. |
| E, efficiency | IN_PROGRESS | Catalog-derived read classification and default-off scout behavior are wired. Marginal-value telemetry and optimization evidence remain open. |
| F, secure expansion | IN_PROGRESS | The kernel boundary and fail-closed defaults are retained. Remote trust-root, browser/desktop, client-conformance, and promotion evidence remain open. |

## Requirement matrix

The package rows below expand the stable IDs in `MASTER_PLAN.md`. IDs with a range are tracked as individual requirements in the referenced package row.

| ID | State | Owner/files | Evidence or blocker |
| --- | --- | --- | --- |
| INV-01..INV-15 | IN_PROGRESS | control, runtime protocol, kernel, docs | The durable contracts and live slices cover many invariants; exact runtime and release proof is still pending. |
| CORE-001 | IN_PROGRESS | `.github`, `Justfile`, lockfiles | Platform matrix jobs are required locally; exact cold-clone/bootstrap and hosted evidence are not reproduced here. |
| CORE-002 | IN_PROGRESS | `.github/rulesets`, release scripts | Declarative ruleset and dry-run/apply/verify script exist. Read-only verification found the live ruleset weaker than required; apply is intentionally not authorized. |
| RUN-001 | IN_PROGRESS | `mini-services/terminus-control/src/index.ts` | Live source order is proposal -> PREPARED completion intent -> branch admission -> atomic task/turn/record completion -> finalization -> PREPARED checkpoint -> atomic checkpoint/terminal publication -> `turn.completed`; checkpoint preparation failure remains an explicit best-effort fallback and full runtime proof is pending. |
| RUN-002 | IN_PROGRESS | `index.ts`, repair controller, turn scheduler | Repair directive, cumulative budget, durable attempt identity, fenced lease claim/heartbeat, pending state, child admission, parent supersession, and automatic re-entry are wired. DB-backed schedule/admission/fencing replay scenarios pass; the full fault-injection/replay proof remains open. |
| RUN-003 | IN_PROGRESS | recovery/reconciler services | Safe pre-provider/tool-boundary resume and exact `RESPONSE_VALIDATING`/`VERIFYING` resume are wired from durable response/plan/result identity; stale, malformed, and legacy state fails closed, while full crash injection and later-state reconciliation remain open. |
| RUN-004 | IN_PROGRESS | `index.ts`, `src/services/*` | Large composition root remains. |
| RUN-005 | IN_PROGRESS | `turn-budget.ts`, `index.ts` | Abort signals, policy-denied outcomes, semantic-operation accounting, and typed doom-loop settlement are wired; restart-aware operation accounting remains open. |
| RUN-006 | IN_PROGRESS | `turn-budget.ts`, tool catalog | Live budgeting uses the catalog side-effect class and focused read/write tests pass; durable per-operation ledger coverage remains open. |
| RUN-007 | IN_PROGRESS | `coding-turn-engine.ts`, protocol/UX | Doom-loop is a first-class engine/live stop with focused coverage; client rendering and durable stop-evidence conformance remain open. |
| CTX-001 | IN_PROGRESS | `compaction-service.ts`, `index.ts` | Pruning now requires materialized source plus immutable provenance, summarizes before hiding, and has an atomic production store path; replay/migration coverage remains open. |
| CTX-002..CTX-007 | IN_PROGRESS | context compiler/control | Full-window sizing, authoritative overlays, scoped instruction loading, source-derived hashes, versioned selection metrics, deterministic scoring ablations, and strict durable cache-observation read-back are wired; complete ledger, graph retrieval, fresh live cache cohort, labeled outcome, and promotion proof remain open. |
| PROV-001..PROV-006 | IN_PROGRESS | provider transports/runtime | Direct abort, incremental stream handling, stream-safe fallback, provider-native request paths, durable request fingerprints/idempotency keys, native response metadata, anonymous OpenCode Zen free-model inference, exact provider-attempt cost-source separation, and provider predicted/realized cache observation persistence are proven; provider-reported billing receipts, endpoint-level deduplication, fresh live cache telemetry, paid-account, and alternate-protocol conformance remain open. |
| VER-001..VER-003 | IN_PROGRESS | verification/repair/index | Cumulative budget, durable failure signatures, source revision, automatic re-entry, durable attempt identity/leases, durable completion admission recovery, typed signal-derived plan selection, revisioned scoped repository-map retrieval, native-recipe source/version signals, a fail-closed `ui_e2e` predicate boundary, and repair metrics are wired; actual governed UI execution and full replay proof remain open. |
| ACI-001 | IN_PROGRESS | `packages/aci`, control tools, kernel code intelligence | Bounded typed read/patch/exec/poll/search/fetch and revisioned repository-map RPCs remain kernel-mediated; complete map reads are continuation-validated and capped, selection metrics/ablation and provider cache observations are persisted, while complete coding-ACI coverage, labeled outcome, broader fresh live cache, and monorepo-scale evidence remain open. |
| SEC-001..SEC-002 | IN_PROGRESS | kernel/policy/control | Kernel boundary exists; effective sandbox and trust-root restart proof remain open. |
| EVAL-001 | IN_PROGRESS | `evals`, `python/forge_evals` | Internal cohorts exist; held-out paired evidence is not present. |
| ROUTE-001 | IN_PROGRESS | router/control | Keep router shadow/default-off pending outcome evidence. |
| SCOUT-001 | IN_PROGRESS | scout runner/control | Scout is default-off and explicit opt-in is tested; utility accounting is still process-local and no promotion evidence exists. |
| CU-001 | NOT_STARTED | computer runtime | The verification layer now records and blocks an unavailable governed-UI capability, but the current endpoint/model is not a governed browser loop. |
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
| B1-01..B1-11 | IN_PROGRESS | Explicit lifecycle events, verification-gated terminal publication, durable repair-attempt identity/lease association, atomic completion-record admission, and atomic successful checkpoint/terminal publication are wired; single transition-owner extraction remains open. |
| B2-01..B2-11 | IN_PROGRESS | Provider/effect recovery classification, atomic `UNKNOWN`/`MANUAL_REVIEW` effect quarantine, no-duplicate in-flight provider recovery, safe boundary resume, exact verification resume, fenced repair continuation recovery, proposal quarantine, completion admission replay, coupled checkpoint/terminal replay, atomic cancellation, durable provider-attempt identity, and candidate-branch `ADMITTING` -> `MANUAL_REVIEW` recovery are wired; DB-backed effect/repair/proposal/cancellation/completion/checkpoint/provider/branch/verification scenarios pass, while trusted receipt reconciliation and complete fault-injection/replay proof remain open. |
| B3-01..B3-13 | IN_PROGRESS | Atomic task/turn cancellation and signal propagation, catalog effect classes, operation normalization, semantic progress, policy denial, and doom-loop stops are wired; durable restart accounting remains open. |
| B4-01..B4-09 | IN_PROGRESS | Service extraction exists, but `index.ts` remains the composition and business-logic root. |

## Gate C package states

| ID range | State | Notes |
| --- | --- | --- |
| C1-01..C1-11, C1-T01..C1-T10 | IN_PROGRESS | Safe cited compaction and atomic production commit path are implemented and focused-tested; stale-revision/replay and full transaction suites remain open. |
| C2-01..C2-05 | IN_PROGRESS | `ContextStateBuilder` is an in-memory projection from episodes, not yet an authoritative ledger. |
| C3-01..C3-08 | IN_PROGRESS | Kernel-read repository instruction discovery is wired for relevant scopes with precedence and source hashes; full invalidation/symlink/generated-path coverage remains open. |
| C4-01..C4-11 | IN_PROGRESS | Revisioned, source-attributed, scoped repository-map retrieval follows and validates all bounded continuations before model projection; candidate features, additive score, exact cost, selection reason, versioned selection metrics, deterministic one-at-a-time ablations, and strict provider cache observation read-back are persisted. One fresh live cache observation exists; labeled outcome, no-learned-ranker promotion, a broader cache cohort, and monorepo-scale evidence remain open. |
| C5-01..C5-09 | IN_PROGRESS | Context IR and epochs exist; one fresh live cache probe now has a persisted predicted/realized observation, but broader cache conformance, stable-prefix/provider controls, and promotion evidence remain open. Valid predicted/realized cached-token observations survive provider settlement and manifest read-back; malformed or absent values remain unavailable. |
| C6-01..C6-10 | IN_PROGRESS | Provider packages and retry/runtime modules exist; current behavior needs stage-aware tests and signal wiring. |

## Gate D package states

| ID range | State | Notes |
| --- | --- | --- |
| D1-01..D1-08 | IN_PROGRESS | Completion proposal, PREPARED completion intent, verification plan/results/evidence, fenced branch admission, atomic task/turn/record admission, post-admission terminal ordering, and atomic successful checkpoint/terminal publication are wired; full live runtime/fault proof remains open. |
| D2-01..D2-10 | IN_PROGRESS | `deriveVerificationNodes` now selects typed predicates from contract criteria, changed/scope paths, risk, instruction hashes, failures, diagnostics, generated paths, supplied native commands, and repository-map/native-recipe source signals. UI criteria select `ui_e2e`; unavailable governed computer use produces an explicit blocked result and does not invoke the generic command runner. Admission and incremental modes have focused tests and a live caller; configured governed UI execution and complete semantic plan coverage remain open. |
| D3-01..D3-08, D3-M01 | IN_PROGRESS | One task-level budget, durable signatures including evidence identity, typed directive, durable attempt/lease identity, automatic child re-entry, parent supersession, re-verification, DB-backed fencing replay, and a database-backed aggregate producer are wired. Replayable repair metrics are derived in `@terminus/verification` and exposed on `GET /v1/tasks/:id`; exact cost-source separation is wired, while provider-reported billing, live export, classification labels, and restart/fault proof remain open. |
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
| F5-01..F5-14 | NOT_STARTED | The typed `ui_e2e` boundary is fail-closed, but no browser/desktop vertical slice is claimed. |
| F6-01..F6-10 | IN_PROGRESS | Runtime protocol exists; client conformance and complete lifecycle need proof. |
| F7-01..F7-06 | NOT_STARTED | Background work must use the canonical executor first. |

## Cross-cutting states

| ID range | State | Notes |
| --- | --- | --- |
| X-DB-01..X-DB-08 | IN_PROGRESS | Existing SQLite migrations are monotonic; migrations `0012_repair_attempts`, `0013_completion_admission`, `0014_provider_attempt_identity`, `0015_candidate_branch_admission_recovery`, `0016_verification_recovery_identity`, `0017_provider_attempt_cost_accounting`, and `0018_provider_datetime_bigint` persist repair, completion-admission, provider-attempt identity/cost, branch recovery, verification resume, and Prisma-compatible provider timestamps, while the existing effect ledger records atomic recovery evidence without a new migration. DB-backed effect, repair, proposal/cancellation, completion, coupled checkpoint/terminal, provider-identity, candidate-branch, verification rollback/replay/fencing, and provider timestamp write/read coverage passes; journal completeness and other boundary coverage remain open. |
| X-OBS-01..X-OBS-08 | IN_PROGRESS | Semantic events, provider telemetry, and predicted/realized cache observations exist; one fresh live cache probe is correlated through the kernel and durable database, while a broader cohort, export, threshold, and artifact-bound audits remain open. |
| X-TEST-01..X-TEST-07 | IN_PROGRESS | Focused context/provider/lifecycle/security-adjacent tests, complete bounded repository-map continuation tests, native-recipe and signal-derived plan tests, versioned retrieval metrics/scoring ablation tests, durable cache read-back tests, typed unavailable-UI blocking tests, fresh live anonymous Zen completion with cache observation, Prisma migration regression, and DB-backed effect/repair/proposal/cancellation/completion/coupled checkpoint-terminal/provider identity/provider-recovery/candidate-branch/verification replay tests pass; the deterministic lifecycle harness still has an unchanged 1,005/1,006 SSE overlap timeout, while labeled outcome cohorts, broader cache behavior, trusted receipt reconciliation, alternate live paths, cross-platform, client, and actual governed UI tests remain. |
| X-PROM-01..X-PROM-07 | NOT_STARTED | No new advanced default is promoted by this ledger without evidence. |
| X-DOC-01..X-DOC-15 | IN_PROGRESS | This ledger is the first durable documentation slice. |
| X-FINAL-01..X-FINAL-27 | IN_PROGRESS | Local implementation and evidence ledgers are updated; external release, runtime, holdout, and client gates remain open. |

## Current next actions

1. Obtain approval before applying the checked-in ruleset, then run `just github-ruleset-verify` against the exact repository.
2. Wire a configured governed computer-use backend into the typed `ui_e2e` predicate and prove the real browser/desktop loop. Expand the fresh live cache cohort and run labeled retrieval cohorts around the new repository signals.
3. Add a trusted external merge-receipt query and test the later state transition; the conservative DB-backed `ADMITTING` -> `MANUAL_REVIEW` branch recovery and no-duplicate replay path are now covered.
4. Add full crash-injection coverage around verification persistence and exercise the live restart path with a completed response artifact and a partially completed plan.
5. Run tiered paired multi-seed evaluations with live and private-holdout evidence before promoting routing, scout, reviewer, browser, or optimization features.
