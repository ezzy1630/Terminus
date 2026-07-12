"""Regression detector tests (SPEC §41.6)."""

from __future__ import annotations

import random
from typing import Iterable

import pytest

from forge_evals.analysis.regression_detector import (
    RegressionReport,
    detect_regressions,
    match_pairs,
)
from forge_evals.run_record import GraderResult, Outcome, RunRecord


def _make_record(
    *,
    harness: str,
    task: str,
    suite: str = "tiny_bugfix",
    seed: int = 42,
    passed: bool = True,
    score: float = 1.0,
) -> RunRecord:
    """Build a minimal run record for tests."""
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
    r.end = r.start
    return r


def test_match_pairs_by_task_and_seed() -> None:
    """Pairs are matched by (task, seed)."""
    baseline = [_make_record(harness="b", task="t1", seed=1), _make_record(harness="b", task="t2", seed=2)]
    candidate = [_make_record(harness="c", task="t2", seed=2), _make_record(harness="c", task="t1", seed=1)]
    pairs = match_pairs(baseline, candidate)
    assert len(pairs) == 2
    by_task = {b.task: (b, c) for b, c in pairs}
    assert by_task["t1"][0].harness == "b"
    assert by_task["t1"][1].harness == "c"


def test_match_pairs_drops_unmatched() -> None:
    """Unmatched tasks are dropped."""
    baseline = [_make_record(harness="b", task="t1"), _make_record(harness="b", task="t2")]
    candidate = [_make_record(harness="c", task="t1")]
    pairs = match_pairs(baseline, candidate)
    assert len(pairs) == 1
    assert pairs[0][0].task == "t1"


def test_detect_regressions_improvement() -> None:
    """A clear improvement is classified as 'improvement'."""
    random.seed(0)
    baseline = []
    candidate = []
    for i in range(20):
        s_b = 0.5
        s_c = 0.8
        baseline.append(_make_record(harness="b", task=f"t{i}", seed=42, passed=s_b > 0.5, score=s_b))
        candidate.append(_make_record(harness="c", task=f"t{i}", seed=42, passed=s_c > 0.5, score=s_c))
    report = detect_regressions(baseline, candidate)
    assert isinstance(report, RegressionReport)
    assert "tiny_bugfix" in report.improved_cohorts
    assert report.regressed_cohorts == []


def test_detect_regressions_regression() -> None:
    """A clear regression is classified as 'regression'."""
    baseline = []
    candidate = []
    for i in range(20):
        baseline.append(_make_record(harness="b", task=f"t{i}", seed=42, passed=True, score=0.8))
        candidate.append(_make_record(harness="c", task=f"t{i}", seed=42, passed=False, score=0.2))
    report = detect_regressions(baseline, candidate)
    assert "tiny_bugfix" in report.regressed_cohorts


def test_detect_regressions_no_change() -> None:
    """Small random deltas → 'no_change'."""
    random.seed(1)
    baseline = []
    candidate = []
    for i in range(20):
        s_b = 0.5
        s_c = s_b + random.gauss(0, 0.02)  # tiny noise
        baseline.append(_make_record(harness="b", task=f"t{i}", seed=42, score=s_b, passed=s_b > 0.5))
        candidate.append(_make_record(harness="c", task=f"t{i}", seed=42, score=s_c, passed=s_c > 0.5))
    report = detect_regressions(baseline, candidate)
    assert report.regressed_cohorts == []
    assert report.improved_cohorts == []
    # Verdict should be no_change or inconclusive.
    verdicts = [c.verdict for c in report.cohort_results]
    assert all(v in ("no_change", "inconclusive") for v in verdicts)


def test_detect_regressions_inconclusive_for_small_n() -> None:
    """n_pairs < 5 → 'inconclusive'."""
    baseline = [_make_record(harness="b", task=f"t{i}", seed=42, score=0.9) for i in range(3)]
    candidate = [_make_record(harness="c", task=f"t{i}", seed=42, score=0.1) for i in range(3)]
    report = detect_regressions(baseline, candidate)
    assert report.cohort_results[0].verdict == "inconclusive"


def test_detect_regressions_multiple_cohorts() -> None:
    """Multiple cohorts produce multiple cohort results."""
    baseline = []
    candidate = []
    for suite in ("tiny_bugfix", "refactor"):
        for i in range(10):
            baseline.append(_make_record(harness="b", task=f"{suite}-{i}", suite=suite, seed=42, score=0.5))
            candidate.append(_make_record(harness="c", task=f"{suite}-{i}", suite=suite, seed=42, score=0.6))
    report = detect_regressions(baseline, candidate)
    cohort_names = {c.cohort for c in report.cohort_results}
    assert cohort_names == {"tiny_bugfix", "refactor"}


def test_regression_report_to_dict_round_trip() -> None:
    """The report serializes to a dict cleanly."""
    baseline = [_make_record(harness="b", task=f"t{i}", seed=42, score=0.5) for i in range(10)]
    candidate = [_make_record(harness="c", task=f"t{i}", seed=42, score=0.7) for i in range(10)]
    report = detect_regressions(baseline, candidate)
    d = report.to_dict()
    assert "baseline_label" in d
    assert "candidate_label" in d
    assert "cohort_results" in d
    assert isinstance(d["cohort_results"], list)
    assert len(d["cohort_results"]) == 1
