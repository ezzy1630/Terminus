# Evaluation laboratory

This document is the deep dive for the Python evaluation laboratory (SPEC §18, §41). The eval lab is offline, non-privileged, and never on the production enforcement path. It is governed by ADR-0001 (primary metric), ADR-0025 (permanent baseline + promotion gates), ADR-0056 (causal baseline-vs-candidate tiers), and ADR-0003 (Python is eval-only).

## Why an eval lab (SPEC §18, §41, J.3)

Without pinned baselines, environment graders, and exact cost/trajectory records, architectural changes become anecdotes (SPEC §48.3). The eval lab is what makes Terminus's primary metric (ADR-0001) measurable and what governs feature promotion (ADR-0025, ADR-0056).

The eval lab is **offline and non-privileged**: it reads exported traces/artifacts; it never owns production effects. It runs in `python/forge_evals/`.

## Causal baseline-vs-candidate system (ADR-0056)

The lab answers one question with paired evidence instead of intuition: *did this Context Compiler / router / verification change actually improve Terminus?* Three tiers, all on the existing artifact model:

### Tier 1 — deterministic lifecycle conformance (every PR, no live model)

The turn-lifecycle reference loop runs fixed adversarial schedules plus seeded schedule permutations on a virtual clock, and **measures** the causal tier-1 properties (see `mini-services/terminus-control/src/agent/turn-lifecycle/conformance.ts`, report `terminus.lifecycle.conformance/v1`):

- stuck-state rate (must be 0);
- duplicate-attempt behavior — duplicate deliveries absorbed (must be 1.0);
- recovery correctness and reconstruction from persisted events (crash replay must be exact);
- cancellation correctness (cancel settles ABORTED once, spawns nothing);
- exactly one valid terminal/waiting outcome (post-quiescence redelivery is inert);
- idempotency after redelivery (quiescence within two rounds);
- injected-clock deadline behavior (stale expiries absorbed, current expiries settle BUDGET_EXHAUSTED once).

Fast and mandatory: `just test-reference-loop` (CI budget 5k seeds, well under a second). `just lifecycle-conformance` retains a 50k-seed report under `evals/results/lifecycle/`.

### Tier 2 — small live-provider canary (relevant PRs)

Five compact tasks under `python/forge_evals/evals/tasks/canary/` cover read-only diagnosis, single-file edit, multi-file edit, failing-test repair, and repository discovery with incomplete initial context. Deterministic graders (repository state + tests) decide success; LLM judges never sit on the success path.

```bash
just canary-fixture            # offline machinery check (fixture-only evidence)
just canary-live <base> <cand> # live paired comparison, two control planes, fails closed without them
```

`terminus-eval canary` runs the pinned baseline and the candidate under identical model snapshot, reasoning effort, task, environment, seed, and budget; enforces the model-fixed identity key; and emits `terminus.canary.comparison/v1` with per-cell automatic trajectory, context-manifest, and tool-sequence diffs (`forge_evals.trajectory_diff`).

### Tier 3 — larger held-out scheduled cohort

- **Partitions**: `evals/holdout-partitions.yaml` (`forge_evals.holdout`) classifies every (suite, task) cell as `dev`, `holdout`, or `blocked`; blocked cells fail run sets closed, holdout cells must be stamped on the record, unlisted cells default to dev.
- **Metrics**: `forge_evals.cohort_metrics` computes resolved-task rate, false-completion rate, median/p95 latency, token breakdowns, cost per resolved task, tool calls per resolved task, verification cost share and false-block rate, context-compilation latency and selected-token count, provider retries, lifecycle recoveries, stuck-state rate, cache-prefix survival between turns, and repair turns — with repetitions and bootstrap CIs, sliced by cohort and archetype. Unmeasured is `None`, never zero.
- **Comparison**: `just cohort-compare <baseline-dir> <candidate-dir>` (CLI `terminus-eval cohort-compare`) emits `terminus.cohort.comparison/v1` plus a markdown summary: paired deltas with McNemar and bootstrap CIs, per-slice metric tables for both arms, per-pair trajectory/manifest/tool-sequence comparisons, and reliability gates. Verdicts at small n report `no_change` instead of reacting to single runs.
- **Promotion**: the gate's seventh gate (`reliability`) consumes `ReliabilityEvidence`; a candidate regressing false-completion, stuck-state, verification false-block, or cache-prefix survival beyond margin is rejected regardless of mean primary-metric improvement (ADR-0056).

## Evaluation modes (SPEC §41.1, §18.1)

1. **Harness-controlled** — drive a harness (Terminus or external) against a pinned task; measure outcome.
2. **Product comparison** — compare Terminus against an external harness (codex, claude-code, pi, oh-my-pi, omnigent, openhands) on the same task.
3. **Component ablation** — disable a Terminus component (retrieval, memory, multi-agent, compression) and measure impact.

## Permanent baselines (SPEC §18.1, §41.2)

- `terminus-minimal` — minimal shell mode (ADR-0025): one model, Bash-like execution, linear history, no advanced retrieval/memory/subagents. Always runnable.
- `terminus-full` — the configured Terminus default with all promoted features.

Baselines are pinned (harness commit, configuration hash, model snapshot, environment image, source commit, task list, token/cost/time budgets, number of runs, seeds, grader versions, success/failure definitions, confidence intervals, raw task-level results, known limitations, leakage notes per Appendix I.3).

## Benchmark cohorts (SPEC §18.2, §41.3)

19 cohort task catalogs under `python/forge_evals/forge_evals/cohort_tasks/`:

- tiny-bugfix, small-feature, refactor, security-sensitive, long-horizon, multi-file, test-debug, build-fix, dependency-upgrade, docs-update, performance-fix, api-design, database-migration, frontend-change, config-change, ci-fix, release-prep, code-review, research-task.

External benchmarks:

- SWE-bench Verified (`evals/suites/swe-bench-verified.yaml`).
- Terminal-Bench (`evals/suites/terminal-bench.yaml`).
- Terminus-internal (`evals/suites/terminus-internal.yaml`).

## Experimental controls (SPEC §18.3, §41.6)

- Paired comparisons (same task, two configs).
- Bootstrap confidence intervals.
- Multiple-comparison corrections (Benjamini-Hochberg).
- Effect size (Cohen's d).
- Non-inferiority tests.
- Random seeds recorded.
- p-value-only conclusions forbidden (SPEC §44.4).

Implementation: `python/forge_evals/forge_evals/statistics/`.

## Eval task package (SPEC §41.4, §18.4)

Each eval task package (`evals/tasks/<cohort>/<id>/`) contains:

- `task.yaml` — source_commit, image_digest, timeout, budget, allowed_network, secrets, grader_version.
- `prompt.md` — the task prompt.
- `environment.lock` — digest-pinned environment.
- `setup.sh` — sets up the broken source + tests + hidden tests.
- `grader/run.py` — Python grader checking end-state, scope, signature, hidden tests.
- `hidden/test_*.py` — separate directory, NEVER projected to model context.
- `expected-properties.yaml` — outcome, changed_files, tests, verification_plan, cost_usd_max, turns_max, rejection_triggers.
- `policy.yaml` — sandbox_profile, command/network/secrets policy refs, risk_class, approval thresholds.
- `README.md` — purpose.

Example packages: `tiny-bugfix/01-fix-typo`, `tiny-bugfix/02-null-check`, `refactor/01-extract-function`, `security-sensitive/01-add-auth-check`.

## Run record (SPEC §41.5, §18.5)

Every eval run produces a RunRecord:

```yaml
run_id:
experiment_id:
harness_commit:
configuration_hash:
model_snapshot:
environment_image:
source_commit:
task_id:
seed:
started_at:
ended_at:
status:
turns:
provider_attempts:
tool_calls:
tokens: { input, output, cached, reasoning, tool_schema }
cost: { model_micros, compute_seconds, wall_clock_seconds, human_approvals }
artifacts: []
trace_artifact:
end_state_artifact:
grader_version:
grader_result: { status, evidence, score }
```

RunRecords are exported as JSONL and Parquet for analysis.

## Feature experiment manifest (SPEC §41.7, §18.6)

```yaml
experiment_id:
feature:
hypothesis:
primary_metric:
cohorts: []
baselines: []
configurations: []
runs_per_configuration:
seeds:
statistical_tests: []
promotion_gate:
  safety_non_inferiority:
  primary_metric_improvement:
  no_unacceptable_regression:
  guardrails_active:
evidence_archive:
```

## Context experiments (SPEC §41.8)

- Full-history vs. checkpoint/recent-window.
- Retrieval position ablations.
- Budget allocation ablations.
- Counterfactual replay (same manifest, different renderer/model).

## ACI experiments (SPEC §41.9)

- Default 7-tool palette vs. minimal shell vs. alternate palettes.
- Edit-dialect: exact-text vs. range vs. symbol vs. unified-diff per model.
- Tool-selection and argument-error rates.

## Orchestration experiments (SPEC §41.10)

- One-agent vs. scout/writer/reviewer on separable and non-separable cohorts.
- Expected-value scheduler escalation decisions.
- Loop protection termination.
- Budget control enforcement.

## Security evaluation (SPEC §41.11, §18.5)

5 security evals under `evals/security/`:

- `workspace-escape.yaml` — sandbox escape attempts.
- `network-bypass.yaml` — direct socket, DNS rebinding, private address.
- `secret-extraction.yaml` — encoded exfiltration, env-var access.
- `prompt-injection.yaml` — poisoned repo, issue, web content.
- `mcp-poisoning.yaml` — single-tool and distributed-tool poisoning.

Each has `passes_when` and `fails_when` criteria.

## Feature promotion rule (SPEC §41.12, §18.7, §50, ADR-0025)

A feature is promoted from EXPERIMENTAL to ADOPTED (default) when:

1. Non-inferiority on safety sub-metrics (no safety regression hidden).
2. Improvement on the primary metric (ADR-0001) on its target cohort.
3. No unacceptable regression on any other cohort.
4. Guardrails active and tested.
5. Evidence archived (URL, retrieval date, content hash, interpretation note per Appendix J.4).

The promotion gate is implemented in `python/forge_evals/forge_evals/promotion_gate.py`.

## Statistical practice (SPEC §41.6)

- Paired comparisons (same task, two configs).
- Bootstrap CIs.
- Multiple-comparison corrections.
- Effect size.
- Non-inferiority tests.
- Random seeds recorded.
- No p-value-only conclusions.

## Component promotion matrix (Appendix I.2)

| Component | Primary metric | Guardrails | Minimum comparison |
|---|---|---|---|
| Context checkpointing | verified success/cost | requirement recall, stale use | full history |
| AST/LSP retrieval | success and tool calls | compile latency | lexical only |
| Repo map | first useful action | omission harm | no map |
| Tool palette | success/tool errors | schema tokens | shell + alternate palettes |
| Edit dialect | application/final success | changed-line excess | exact text/unified diff |
| Scout | success/latency | total tokens | one agent |
| Parallel writers | wall-clock/success | merge conflicts/cost | one writer |
| Reviewer | severe defects caught | cost/false positives | no reviewer |
| Memory | cross-session success | harmful retrieval | no memory |
| Compression | total cost/success | exactness/privacy | deterministic only |
| Learned router | success/cost | cohort regressions | deterministic router |
| Programmatic tool mode | cost/latency/success | security surface | direct tools |

## CLI

```bash
cd python
uv run terminus-eval run \
  --suite terminus-internal \
  --task build-failure/build-001 \
  --task-dir forge_evals/evals/tasks/build-failure/build-001 \
  --harness terminus-minimal \
  --seeds 1
uv run terminus-eval aggregate --runs-dir evals/results/smoke --output -
uv run terminus-eval dashboard --runs-dir evals/results/smoke --output evals/results/smoke/dashboard.html
```

## Evaluation tiers (SPEC §46.11)

- `eval-smoke` — small deterministic tasks, required per PR for agent-behavior changes.
- `eval-targeted` — cohort associated with changed component.
- `eval-nightly` — broad pinned suite with repeated runs as budget permits.
- `eval-release` — full promotion suite and baseline comparison.
- `eval-research` — exploratory and non-gating.

## Benchmark metadata checklist (Appendix I.3)

Every published result includes: harness commit and configuration hash; model/provider snapshot and date; environment image and source commit; task list and exclusions; token/cost/time budgets; number of runs and seeds; grader versions; success and failure definition; confidence intervals; raw or accessible task-level results; known limitations and possible leakage.
