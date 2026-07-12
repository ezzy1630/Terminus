"""Analysis-pipeline integration tests (SPEC §41.6)."""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from forge_evals.analysis.aggregate import (
    aggregate_by_cohort,
    aggregate_by_harness,
    aggregate_by_harness_cohort,
    summarize_runs,
)
from forge_evals.analysis.cache_analysis import compute_cache_stats
from forge_evals.analysis.cost_analysis import find_anomalies, reconcile_costs
from forge_evals.analysis.load_runs import (
    RunCatalog,
    load_runs_from_json_dir,
    load_runs_from_jsonl,
    load_runs_from_records,
)
from forge_evals.run_record import CostBreakdown, GraderResult, Outcome, RunRecord


def _make_record(
    *,
    harness: str,
    task: str,
    suite: str = "tiny_bugfix",
    seed: int = 42,
    passed: bool = True,
    score: float = 1.0,
    cost: CostBreakdown | None = None,
) -> RunRecord:
    """Build a minimal run record for analysis tests."""
    r = RunRecord.new(
        suite=suite,
        task=task,
        harness=harness,
        harness_commit="abc",
        environment_digest="sha:abc",
        random_seed=seed,
    )
    r.outcome = Outcome.COMPLETED if passed else Outcome.FAILED
    r.grader_results = [
        GraderResult(grader_id="end_state.noop", grader_version="0.1.0", passed=passed, score=score)
    ]
    r.cost = cost or CostBreakdown(
        provider_reported_usd=0.01, computed_usd=0.01, input_tokens=1000, output_tokens=500,
        cached_tokens=200, cache_write_tokens=100, cache_read_tokens=100,
    )
    r.end = r.start
    return r


def test_load_runs_from_jsonl_round_trip(tmp_path: Path) -> None:
    """JSONL write → load preserves records."""
    p = tmp_path / "runs.jsonl"
    records = [_make_record(harness="h", task=f"t{i}", seed=i) for i in range(5)]
    for r in records:
        with p.open("a", encoding="utf-8") as fh:
            fh.write(r.to_jsonl_line() + "\n")
    cat = load_runs_from_jsonl(p)
    assert cat.n == 5
    assert {r.task for r in cat.records} == {f"t{i}" for i in range(5)}


def test_load_runs_from_json_dir(tmp_path: Path) -> None:
    """Loading from a dir of JSON files works."""
    for i in range(3):
        r = _make_record(harness="h", task=f"t{i}", seed=i)
        r.to_json(tmp_path / f"r{i}.json")
    cat = load_runs_from_json_dir(tmp_path)
    assert cat.n == 3


def test_load_runs_from_records_builds_dataframe() -> None:
    """load_runs_from_records builds a Polars DataFrame."""
    records = [_make_record(harness="h", task=f"t{i}", seed=i) for i in range(3)]
    cat = load_runs_from_records(records)
    assert cat.n == 3
    assert cat.df.height == 3
    assert "passed" in cat.df.columns
    assert "primary_score" in cat.df.columns


def test_aggregate_by_cohort() -> None:
    """aggregate_by_cohort collapses across harnesses and seeds."""
    records = [
        _make_record(harness="h1", task="t1", seed=1, passed=True, score=0.9),
        _make_record(harness="h2", task="t1", seed=1, passed=False, score=0.4),
        _make_record(harness="h1", task="t2", seed=1, passed=True, score=0.8),
    ]
    summaries = aggregate_by_cohort(records, n_resamples=100, rng_seed=0)
    assert len(summaries) == 1
    assert summaries[0].cohort == "tiny_bugfix"
    assert summaries[0].n == 3
    assert summaries[0].success_rate == pytest.approx(2 / 3)


def test_aggregate_by_harness() -> None:
    """aggregate_by_harness collapses across cohorts and seeds."""
    records = [
        _make_record(harness="h1", task="t1", suite="s1", passed=True),
        _make_record(harness="h2", task="t2", suite="s2", passed=False),
    ]
    summaries = aggregate_by_harness(records, n_resamples=100, rng_seed=0)
    by_h = {s.harness: s for s in summaries}
    assert by_h["h1"].n == 1
    assert by_h["h1"].success_rate == 1.0
    assert by_h["h2"].success_rate == 0.0


def test_aggregate_by_harness_cohort() -> None:
    """aggregate_by_harness_cohort produces one row per (harness, cohort)."""
    records = [
        _make_record(harness="h1", task="t1", suite="s1"),
        _make_record(harness="h1", task="t2", suite="s2"),
        _make_record(harness="h2", task="t1", suite="s1"),
    ]
    summaries = aggregate_by_harness_cohort(records, n_resamples=100, rng_seed=0)
    assert len(summaries) == 3
    pairs = {(s.harness, s.cohort) for s in summaries}
    assert pairs == {("h1", "s1"), ("h1", "s2"), ("h2", "s1")}


def test_summarize_runs_returns_dataframe() -> None:
    """summarize_runs returns a Polars DataFrame."""
    records = [_make_record(harness="h", task=f"t{i}", seed=i) for i in range(5)]
    df = summarize_runs(records, n_resamples=100, rng_seed=0)
    assert df.height >= 1
    assert "success_rate" in df.columns
    assert "success_rate_ci_low" in df.columns


def test_reconcile_costs_flags_anomaly() -> None:
    """reconcile_costs flags a known anomaly."""
    records = []
    for i in range(5):
        c = CostBreakdown(
            provider_reported_usd=0.05, computed_usd=0.01,  # 400% discrepancy
            input_tokens=1000, output_tokens=500,
        )
        records.append(_make_record(harness="h", task=f"t{i}", seed=i, cost=c))
    recs = reconcile_costs(records)
    flagged = [r for r in recs if r.flagged]
    assert len(flagged) == 5


def test_find_anomalies_severity_classification() -> None:
    """find_anomalies classifies severity by delta_pct."""
    # High severity (large discrepancy).
    c_high = CostBreakdown(
        provider_reported_usd=10.0, computed_usd=0.01,
        input_tokens=1000, output_tokens=500,
    )
    # Medium severity.
    c_med = CostBreakdown(
        provider_reported_usd=0.015, computed_usd=0.01,
        input_tokens=1000, output_tokens=500,
    )
    records = [
        _make_record(harness="h", task="t1", seed=1, cost=c_high),
        _make_record(harness="h", task="t2", seed=2, cost=c_med),
    ]
    anomalies = find_anomalies(records)
    by_sev = {a.run_id: a.severity for a in anomalies}
    assert any(v == "high" for v in by_sev.values())


def test_compute_cache_stats() -> None:
    """compute_cache_stats extracts per-run cache stats."""
    c = CostBreakdown(
        provider_reported_usd=0.01, computed_usd=0.01,
        input_tokens=1000, output_tokens=500,
        cached_tokens=200, cache_write_tokens=100, cache_read_tokens=100,
    )
    r = _make_record(harness="h", task="t", seed=1, cost=c)
    stats = compute_cache_stats([r])
    assert len(stats) == 1
    s = stats[0]
    assert s.input_tokens == 1000
    assert s.cached_tokens == 200
    assert s.hit_rate == pytest.approx(0.2)
    assert s.read_rate == pytest.approx(0.1)
    assert s.write_rate == pytest.approx(0.1)


def test_run_catalog_by_harness() -> None:
    """RunCatalog.by_harness groups records correctly."""
    records = [
        _make_record(harness="h1", task="t1", seed=1),
        _make_record(harness="h2", task="t2", seed=2),
        _make_record(harness="h1", task="t3", seed=3),
    ]
    cat = RunCatalog(records=records)
    by_h = cat.by_harness()
    assert len(by_h["h1"]) == 2
    assert len(by_h["h2"]) == 1


def test_run_catalog_filter() -> None:
    """RunCatalog.filter returns a sub-catalog."""
    records = [
        _make_record(harness="h1", task="t1", seed=1, passed=True),
        _make_record(harness="h2", task="t2", seed=2, passed=False),
    ]
    cat = RunCatalog(records=records)
    passed_cat = cat.filter(lambda r: r.passed)
    assert passed_cat.n == 1
    assert passed_cat.records[0].harness == "h1"


def test_aggregate_empty_records_returns_empty() -> None:
    """Empty records → empty list of summaries."""
    assert aggregate_by_cohort([]) == []
    assert aggregate_by_harness([]) == []
    assert aggregate_by_harness_cohort([]) == []


def test_summarize_runs_empty_records_returns_empty_df() -> None:
    """Empty records → empty DataFrame (not error)."""
    df = summarize_runs([])
    assert df.height == 0
