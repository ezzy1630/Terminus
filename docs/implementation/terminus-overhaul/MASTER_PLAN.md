# Terminus overhaul master plan

Source: `/Users/ezzyrappeport/.codex/attachments/17506d6b-8510-4a0e-933c-16210b3c4263/pasted-text.txt`.

Baseline: `5f68925062cc3579e94c8e5f9a56b8b5ec46bfb9`, branch `main`, checkout `/Volumes/Neural/Terminus`.

This is the implementation ledger for the supplied overhaul brief. The brief is normative for this effort, while `Terminus — Research/SPEC.md` remains the repository contract. IDs below are stable and are used by `STATUS.md`, `EVIDENCE.md`, and commits.

## Stable IDs

### Cross-cutting invariants

| ID | Requirement |
| --- | --- |
| INV-01 | One canonical task, turn, and client lifecycle. |
| INV-02 | Durable intent and idempotency key precede every external effect. |
| INV-03 | Verification admission owns autonomous completion. |
| INV-04 | Terminal completion events follow the committed terminal transaction. |
| INV-05 | Nonterminal work is replayable and safely reconcilable after a crash. |
| INV-06 | Cancellation reaches every active stage. |
| INV-07 | The immutable journal remains authoritative during compaction. |
| INV-08 | Context fragments carry source, revision, cost, cache, trust, and selection provenance. |
| INV-09 | Effects and secrets remain kernel-mediated. |
| INV-10 | Secure execution is the default. Degraded execution is explicit and recorded. |
| INV-11 | Advanced features are removable, flagged, observable, and ablatable. |
| INV-12 | Clients render the shared protocol and do not own agent policy. |
| INV-13 | Retained features have marginal-value or security/reliability evidence. |
| INV-14 | Evaluation does not use benchmark-specific gaming. |
| INV-15 | Maturity and support claims are derived from evidence. |

### Defect mapping

| Defect | Resolved by |
| --- | --- |
| CORE-001 | A1, A2 |
| CORE-002 | A2, F1 |
| RUN-001 | B1, D1 |
| RUN-002 | B1, D3 |
| RUN-003 | B2 |
| RUN-004 | B4 |
| RUN-005 | B3 |
| RUN-006 | B3, E1 |
| RUN-007 | B3, F6 |
| CTX-001 | C1 |
| CTX-002 | C1, E2 |
| CTX-003 | C2 |
| CTX-004 | C2, C5 |
| CTX-005 | C3 |
| CTX-006 | C4 |
| CTX-007 | C4, E3 |
| PROV-001 | C6 |
| PROV-002 | C6 |
| PROV-003 | C6, B2 |
| PROV-004 | C6 |
| PROV-005 | C5, C6 |
| PROV-006 | A2, C5, C6 |
| VER-001 | D3 |
| VER-002 | B3, D3 |
| VER-003 | D2 |
| ACI-001 | E1 |
| SEC-001 | F1 |
| SEC-002 | F1 |
| EVAL-001 | A3 |
| ROUTE-001 | F2 |
| SCOUT-001 | E2, F3 |
| CU-001 | F5 |
| UX-001 | F6 |

## Gate A, evidence and baseline

| Package | Stable requirements |
| --- | --- |
| A1, CI and dependency reproducibility | A1-01 reproduce the exact setup failure; A1-02 repair lockfiles and preflight; A1-03 split setup stages; A1-04 avoid repeated setup failures; A1-05 upload setup evidence; A1-06 validate supported platforms; A1-07 content-address caches; A1-08 separate deterministic and live cohorts; A1-09 remove release `continue-on-error`; A1-10 expose required suites; A1-11 self-test the setup action; A1-12 cold-clone bootstrap. A1-P01 requires the 20-run release promotion evidence. |
| A2, branch and release evidence | A2-01 declarative ruleset; A2-02 required approval; A2-03 required evidence checks; A2-04 narrow audited emergency bypass; A2-05 apply remotely when authorized; A2-06 reproducible apply/verify fallback; A2-07 commit-bound evidence manifest; A2-08 bind evidence to commit and artifacts; A2-09 SBOM and provenance; A2-10 reject mismatched evidence. |
| A3, evaluation and telemetry | A3-01 registry and tier model; A3-02 task pinning; A3-03 cohort coverage; A3-04 run manifests; A3-05 cost, cache, latency, reliability, security, and intervention metrics; A3-06 paired multi-seed design; A3-07 invalid-task separation, holdout, and contamination controls. |

## Gate B, runtime correctness and recovery

| Package | Stable requirements |
| --- | --- |
| B1, durable turn acceptance | B1-01 explicit durable phases; B1-02 single transition owner; B1-03 legal predecessor checks; B1-04 atomic transition plus semantic event; B1-05 intent before effect; B1-06 verification before terminal state; B1-07 terminal event after commit; B1-08 proposal is not proof; B1-09 typed terminal reason and evidence; B1-10 durable repair attempt identity; B1-11 remove pre-verification completion/checkpoint paths. |
| B2, idempotency and recovery | B2-01 canonical provider fingerprint; B2-02 provider idempotency and request/continuation IDs; B2-03 effect idempotency; B2-04 durable intent, receipt, and result; B2-05 startup reconciliation; B2-06 ambiguous provider handling; B2-07 ambiguous effect handling; B2-08 verification and repair resumption; B2-09 recovery event; B2-10 fault injection across all listed boundaries; B2-11 no duplicate effects and replayable event order. |
| B3, cancellation, budgets, and stagnation | B3-01 durable cancellation; B3-02 restart-aware abort controllers; B3-03 signal propagation; B3-04 truthful provider cancellation billing; B3-05 typed policy denial; B3-06 account every semantic operation; B3-07 catalog-derived effect classes; B3-08 normalized operation records; B3-09 semantic progress; B3-10 repeated read detection; B3-11 read-only calls preserve mutation history; B3-12 bounded replan then doom-loop stop; B3-13 structured stop evidence and user actions. |
| B4, lifecycle extraction | B4-01 separate composition; B4-02 separate routing; B4-03 separate admission; B4-04 separate executor/state machine; B4-05 separate context/provider/effect/verification services; B4-06 shared recovery service; B4-07 shared scheduler entry; B4-08 query/read models; B4-09 boundary tests and no client-specific lifecycle. |

## Gate C, context and provider correctness

| Package | Stable requirements |
| --- | --- |
| C1, compaction | C1-01 fail closed when content or provenance is missing; C1-02 retain source on summary failure/cancel; C1-03 never hide by byte count alone; C1-04 one journal projection mechanism; C1-05 versioned cited snapshot; C1-06 preserve tool pairs and recent turns; C1-07 carry structured snapshots; C1-08 token accounting and reserve; C1-09 atomic idempotent persistence; C1-10 stale revision invalidation; C1-11 cache-aware rewriting; C1-T01 through C1-T10 cover null content, failure, pairing, carry-forward, citation, unresolved failures, file operations, stale revisions, rollback, and replay. |
| C2, working set | C2-01 durable source-of-truth ledger; C2-02 derive it from effects, revisions, diagnostics, verification, criteria, policy, and admitted children; C2-03 track files, symbols, commands, failures, criteria, actions, artifacts, and next action; C2-04 include the projection on every request; C2-05 version and attribute the projection. |
| C3, instructions | C3-01 discover global/root/nested instructions; C3-02 enforce authority and precedence; C3-03 scope root and nested rules; C3-04 lazy-load relevant scopes; C3-05 record path/hash/revision/scope/precedence/reason/cost/cache; C3-06 invalidate on changes; C3-07 concise stable index; C3-08 precedence, symlink, generated-path, normalization, update, and token-limit tests. |
| C4, repository map and retrieval | C4-01 revision-keyed file/language index; C4-02 symbol/dependency/reference/test/config/instruction graph; C4-03 query from goal, criteria, working set, failures, symbols, verification, effects, and unknowns; C4-04 complete-symbol hydration; C4-05 bounded paging and exact revision; C4-06 persist candidate features, score, reason, cost, and use; C4-07 non-destructive scoring; C4-08 lexical/symbol/recent baseline; C4-09 weight ablation; C4-10 no learned ranker before held-out evidence; C4-11 recall, irrelevant rate, cost, correctness, repeat-read, cache, and monorepo metrics. |
| C5, cache layout | C5-01 canonical stable-to-volatile order; C5-02 deterministic rendering; C5-03 prefix digest and cache epoch; C5-04 source-specific invalidation; C5-05 exact request before dispatch; C5-06 predicted versus realized cache; C5-07 fork/resume continuation; C5-08 tool schema versioning; C5-09 compaction preserves reusable prefix. |
| C6, provider runtime | C6-01 versioned capability descriptors; C6-02 end-to-end abort; C6-03 incremental bounded streaming; C6-04 safe early tool execution only after finalization guarantee; C6-05 backpressure; C6-06 stage-aware retry; C6-07 exact token and cost fields; C6-08 provider-native cache rendering; C6-09 wire fixtures and conformance; C6-10 cold/warm/continued/forked/compacted/tool-loop/cache benchmarks. |

## Gate D, verification-closed quality

| Package | Stable requirements |
| --- | --- |
| D1, completion admission | D1-01 verification in executor; D1-02 `completion.proposed`; D1-03 plan before admission; D1-04 source and environment binding; D1-05 invalidate on workspace change; D1-06 persist predicates/results/artifacts/criterion mappings; D1-07 terminal transition/checkpoint/event only after admission; D1-08 explicit durable user override. |
| D2, plan derivation | D2-01 derive from contract; D2-02 changed files and languages; D2-03 configuration and instructions; D2-04 migration/security risk; D2-05 UI/computer risk; D2-06 generated code; D2-07 current failures; D2-08 native recipes; D2-09 typed predicate selection; D2-10 cheap incremental and full admission checks. |
| D3, repair | D3-01 one task-level budget; D3-02 no renewal per turn; D3-03 structured directive; D3-04 automatic re-entry; D3-05 same lifecycle; D3-06 reverify; D3-07 no-progress detection; D3-08 truthful blocked/budget/user/failure stops; D3-M01 success, repair, cost, repeat, false-positive, and classification metrics. |
| D4, independent review | D4-01 use only where paired evidence supports it; D4-02 real independence; D4-03 tests outrank opinion; D4-04 persist impact or keep the reviewer experimental/off. |

## Gate E, efficiency and simplification

| Package | Stable requirements |
| --- | --- |
| E1, coding ACI | E1-01 bounded workspace snapshot; E1-02 structured Git operations; E1-03 atomic expected-version edit transaction; E1-04 symbol/reference/enclosing/diagnostic tools; E1-05 native test selection/run; E1-06 artifact paging; E1-07 optional read-only tool discovery; E1-08 no unrestricted programmable writes; E1-09 ACI metrics. |
| E2, live graph and quarantine | E2-01 versioned feature registry; E2-02 prove or classify each advanced component; E2-03 remove unused startup construction; E2-04 default-off experiments; E2-05 remove duplicate state/policy; E2-06 retain rationale; E2-07 truthful maturity/docs; E2-08 scout-specific durable, bounded, read-only, cancellable, cited utility. |
| E3, optimization | E3-01 stage profile; E3-02 remove redundant work; E3-03 safe batching; E3-04 preserve request/prefix bytes; E3-05 track tail and verified-success cost; E3-06 paired regression benchmark; E3-07 prefer deletion over speculative schedulers. |

## Gate F, secure expansion and clients

| Package | Stable requirements |
| --- | --- |
| F1, security | F1-01 secure sandbox default; F1-02 requested versus effective profile; F1-03 fail closed or explicit degraded consent; F1-04 scoped expiring consent; F1-05 no silent fallback; F1-06 risk-tier guarantees; F1-07 persistent capability trust root and rotation; F1-08 brokered secrets; F1-09 network allowlist and receipts; F1-10 download quarantine; F1-11 provenance/taint labels; F1-12 injection treated as data; F1-13 action-hash approvals; F1-14 threat-model delta. F1-T01 through F1-T13 cover the listed red-team cases. |
| F2, routing | F2-01 verified-outcome data; F2-02 fixed baseline; F2-03 deterministic shadow policy; F2-04 offline outcome tuning; F2-05 uncertainty-aware posteriors; F2-06 normalized economics; F2-07 regret; F2-08 stratum-specific routing; F2-09 cache and continuation cost; F2-10 evidence-based escalation; F2-11 versioned statistics; F2-12 rollback and fixed fallback; F2-P01 held-out promotion gate. |
| F3, subagents | F3-01 read-only scout; F3-02 independent reviewer; F3-03 isolated implementation worker; F3-04 narrow contracts; F3-05 source/path/tool/budget/evidence lineage; F3-06 typed child return; F3-07 no shared writes; F3-08 cancellation and cleanup; F3-09 parent evidence consumption; F3-10 diff/conflict review; F3-11 deterministic merge; F3-12 paired promotion evidence. |
| F4, extensions and memory | F4-01 versioned skill packages; F4-02 lazy skill index; F4-03 kernel/policy execution; F4-04 install/update/disable/rollback/conflict handling; F4-05 immutable history separate from curated memory; F4-06 attributed scoped memory; F4-07 versioned bounded sandboxed hooks; F4-08 action-hash approval rebinding; F4-09 refinement off by default; F4-10 evidence, review, held-out checks, lineage, and rollback. |
| F5, computer use | F5-01 governed browser runtime; F5-02 bounded observation contract; F5-03 typed semantic actions; F5-04 pre/post/action receipts; F5-05 disposable and secure profiles; F5-06 kernel/policy checks; F5-07 untrusted page data; F5-08 quarantine and approval; F5-09 takeover/pause/resume; F5-10 consequential-action reconciliation; F5-11 visual and task predicates; F5-12 one accessibility-first desktop platform; F5-13 honest unavailable capability; F5-14 computer-use evaluation. |
| F6, protocol and UX | F6-01 one versioned protocol; F6-02 shared core entities; F6-03 complete lifecycle event set; F6-04 breaking-change/version rules; F6-05 generated clients; F6-06 deterministic replay/resume/fork; F6-07 artifact references and no secrets; F6-08 compatibility tests; F6-09 truthful primary CLI/TUI state and controls; F6-10 no client policy duplication. |
| F7, background continuity | F7-01 shared executor for long-running tasks; F7-02 detach/reattach continuity; F7-03 budgeted policy-bound schedules; F7-04 goal/evidence persistence; F7-05 no bypass; F7-06 ownership/lease/duplicate/clock tests. |

## Cross-cutting requirements

| ID | Requirement |
| --- | --- |
| X-DB-01 through X-DB-08 | Inspect data; expand/dual-write/backfill/read-switch migrations; previous-state tests; old-session readability; no enum reuse; artifact/event versioning; concurrency uniqueness; rollback/recovery. |
| X-OBS-01 through X-OBS-08 | Correlated structured bounded events, stage timings, usage, cache prediction/actual, stop reason, effective policy, replay diagnostics, schema version, privacy, and retention. |
| X-TEST-01 through X-TEST-07 | State/concurrency, context, provider, effects/ACI, verification, security, and client/protocol test groups from the brief. |
| X-PROM-01 through X-PROM-07 | Promote only with credible quality, cost/latency, reliability/security, held-out repeat, exact provenance, rollback, and truthful docs. |
| X-DOC-01 through X-DOC-15 | Update architecture, lifecycle, recovery, context, provider, verification, ACI, security, evaluation, routing, agents, extensions, computer use, protocol, operations, release instructions, SPEC/README/maturity. |
| X-FINAL-01 through X-FINAL-27 | Final definition of done items 1 through 27 in the brief. Each is tracked separately in `STATUS.md`. |

## Execution order

1. Gate A establishes reproducibility and evidence.
2. Gate B makes the lifecycle durable and truthful.
3. Gate C repairs context and provider behavior.
4. Gate D closes verification and repair.
5. Gate E measures efficiency and removes dormant complexity.
6. Gate F expands secure capabilities and clients only after earlier gates hold.

Each coherent slice gets focused tests, evidence, a diff review, and a commit. External GitHub settings, live providers, signed artifacts, multi-platform enforcement, and paid/held-out evaluations remain explicit blockers until their exact evidence exists.
