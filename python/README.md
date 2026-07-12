# terminus-evals

The Terminus offline evaluation and research laboratory (SPEC §18, §41, §43.3).

Python is **NOT** on the production enforcement boundary. This package runs
offline: analysis, statistical tests, retrieval/compression experiments,
model-routing research, benchmark data preparation, dashboards.

## Layout

```
forge_evals/
  __init__.py
  run_record.py            # SPEC §41.5 run record schema
  cohort_tasks.py          # SPEC §18.2 / §41.3 cohorts
  baselines.py             # SPEC §18.1 / §41.2 baselines
  experiment_manifest.py   # SPEC §18.6 / §41.7 manifest + decision
  promotion_gate.py        # SPEC §18.7 / §41.12 / §50 promotion rule
  cli.py                   # terminus-eval CLI
  runners/                 # harness_runner, cross_harness, fake_provider, trajectory_recorder
  graders/                 # end_state, acceptance, security_graders, conformance
  analysis/                # load_runs, aggregate, cost_analysis, cache_analysis, regression_detector
  statistics/              # paired, bootstrap, multiple_comparisons, effect_size, noninferiority
  dashboards/              # cohort_dashboard, feature_contribution, security_report
  research/                # context_ablations, aci_ablations, orchestration_ablations, routing_research
  tests/
```

## Develop

```bash
cd python/forge_evals
uv sync --extra dev
uv run ruff check .
uv run mypy forge_evals
uv run pytest
```
