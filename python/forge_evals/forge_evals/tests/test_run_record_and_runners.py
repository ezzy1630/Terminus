"""Run-record and runner tests (SPEC §41.5)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from forge_evals.run_record import (
    CostBreakdown,
    GraderResult,
    Outcome,
    RunRecord,
    RunRecordError,
)
from forge_evals.runners import (
    Budgets,
    FakeProviderBuilder,
    FakeScriptHarness,
    HarnessResult,
    HarnessRunner,
    ModelCapabilitySnapshot,
    RunRequest,
    TrajectoryRecorder,
    make_default_cost,
)


def _make_task_dir(d: Path) -> Path:
    """Build a minimal task package dir."""
    d.mkdir(parents=True, exist_ok=True)
    (d / "task.yaml").write_text("source_commit: abc\nimage_digest: sha:img\n", encoding="utf-8")
    (d / "setup.sh").write_text("echo hi\n", encoding="utf-8")
    (d / "environment.lock").write_text("python=3.12\n", encoding="utf-8")
    return d


def test_run_record_new_generates_id_and_start() -> None:
    """RunRecord.new sets run_id and start."""
    r = RunRecord.new(
        suite="s", task="t", harness="h", harness_commit="c",
        environment_digest="d", random_seed=42,
    )
    assert r.run_id
    assert r.start is not None
    assert r.end is None
    assert r.outcome is Outcome.MISSING


def test_run_record_score_validation() -> None:
    """GraderResult rejects scores outside [0, 1]."""
    with pytest.raises(RunRecordError):
        GraderResult(grader_id="x", grader_version="0", passed=True, score=1.5)
    with pytest.raises(RunRecordError):
        GraderResult(grader_id="x", grader_version="0", passed=True, score=-0.1)


def test_run_record_end_before_start_raises() -> None:
    """end before start raises."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    with pytest.raises(RunRecordError):
        RunRecord(
            run_id="x", suite="s", task="t", harness="h", harness_commit="c",
            model_capability_snapshot={}, environment_digest="d", random_seed=1,
            budgets={}, start=now, end=now - timedelta(seconds=1),
        )


def test_run_record_json_round_trip(tmp_path: Path) -> None:
    """Run record JSON round-trips."""
    r = RunRecord.new(
        suite="s", task="t", harness="h", harness_commit="c",
        environment_digest="d", random_seed=42,
    )
    r.outcome = Outcome.COMPLETED
    r.grader_results = [
        GraderResult(grader_id="g", grader_version="0.1", passed=True, score=1.0)
    ]
    r.cost = CostBreakdown(
        provider_reported_usd=0.01, computed_usd=0.01, input_tokens=10, output_tokens=5
    )
    p = r.to_json(tmp_path / "r.json")
    assert p.exists()
    r2 = RunRecord.from_json(p)
    assert r2.run_id == r.run_id
    assert r2.outcome is Outcome.COMPLETED
    assert r2.grader_results[0].grader_id == "g"
    assert r2.cost is not None and r2.cost.input_tokens == 10


def test_run_record_jsonl_round_trip(tmp_path: Path) -> None:
    """JSONL write + read round-trips multiple records."""
    p = tmp_path / "runs.jsonl"
    for i in range(3):
        r = RunRecord.new(
            suite="s", task=f"t{i}", harness="h", harness_commit="c",
            environment_digest="d", random_seed=i,
        )
        with p.open("a", encoding="utf-8") as fh:
            fh.write(r.to_jsonl_line() + "\n")
    records = RunRecord.from_jsonl(p)
    assert len(records) == 3
    assert {r.task for r in records} == {"t0", "t1", "t2"}


def test_run_record_parquet_round_trip(tmp_path: Path) -> None:
    """Parquet round-trip preserves scalar fields."""
    r = RunRecord.new(
        suite="s", task="t", harness="h", harness_commit="c",
        environment_digest="d", random_seed=42,
    )
    r.outcome = Outcome.COMPLETED
    r.grader_results = [
        GraderResult(grader_id="g", grader_version="0.1", passed=True, score=0.95)
    ]
    p = r.to_parquet(tmp_path / "r.parquet")
    assert p.exists()
    # Read back via Polars.
    import polars as pl

    df = pl.read_parquet(p)
    assert df.height == 1
    assert df["run_id"][0] == r.run_id
    assert df["outcome"][0] == "completed"


def test_run_record_passed_property() -> None:
    """``passed`` requires COMPLETED and all graders pass."""
    r = RunRecord.new(
        suite="s", task="t", harness="h", harness_commit="c",
        environment_digest="d", random_seed=42,
    )
    assert not r.passed  # MISSING outcome, no graders.
    r.outcome = Outcome.COMPLETED
    r.grader_results = [GraderResult(grader_id="g", grader_version="0", passed=True, score=1.0)]
    assert r.passed
    r.grader_results.append(GraderResult(grader_id="g2", grader_version="0", passed=False, score=0.0))
    assert not r.passed


def test_trajectory_recorder_records_events() -> None:
    """TrajectoryRecorder appends events with monotonic seq."""
    rec = TrajectoryRecorder(run_id="r1")
    e1 = rec.record("run.started", {"task": "t"})
    e2 = rec.record("turn.started", {"turn": 1})
    e3 = rec.record("turn.completed", {"turn": 1})
    assert e1.seq == 1
    assert e2.seq == 2
    assert e3.seq == 3
    assert e1.ts <= e2.ts <= e3.ts


def test_trajectory_recorder_finalizes_and_blocks_after() -> None:
    """finalize() closes the recorder; further record() raises."""
    rec = TrajectoryRecorder(run_id="r1")
    rec.record("run.started", {})
    rec.finalize()
    with pytest.raises(RuntimeError):
        rec.record("run.ended", {})


def test_trajectory_recorder_to_parquet(tmp_path: Path) -> None:
    """TrajectoryRecorder.to_parquet writes a valid Parquet file."""
    rec = TrajectoryRecorder(run_id="r1")
    rec.record("run.started", {"task": "t"})
    rec.record("turn.started", {"turn": 1})
    p = rec.to_parquet(tmp_path / "traj.parquet")
    assert p.exists()
    import polars as pl

    df = pl.read_parquet(p)
    assert df.height == 2
    assert df["event_type"].to_list() == ["run.started", "turn.started"]


def test_fake_provider_builder_text() -> None:
    """FakeProviderBuilder.text() emits TEXT chunks."""
    p = FakeProviderBuilder().text("hello").text(" world").done().build()
    chunks = p.collect()
    kinds = [c.kind.value for c in chunks]
    assert kinds == ["text", "text", "done"]
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.output_tokens > 0


def test_fake_provider_builder_tool_call() -> None:
    """FakeProviderBuilder.tool_call() emits a TOOL_CALL chunk."""
    p = (
        FakeProviderBuilder()
        .tool_call("edit", {"path": "a.py"})
        .done()
        .build()
    )
    chunks = p.collect()
    tool_chunks = [c for c in chunks if c.kind.value == "tool_call"]
    assert len(tool_chunks) == 1
    assert tool_chunks[0].tool_name == "edit"
    assert tool_chunks[0].tool_arguments == {"path": "a.py"}


def test_fake_provider_builder_error_stops_stream() -> None:
    """An error chunk stops the stream."""
    p = FakeProviderBuilder().text("hi").error("ERR", "boom").text("never").build()
    chunks = p.collect()
    kinds = [c.kind.value for c in chunks]
    assert "text" in kinds
    assert "error" in kinds
    assert "done" not in kinds  # error terminates.


def test_fake_provider_builder_rate_limited_emits_retry_after() -> None:
    """A rate_limited step emits an error with retry_after_ms."""
    p = FakeProviderBuilder().rate_limited(retry_after_ms=500).build()
    chunks = p.collect()
    assert chunks[0].kind.value == "error"
    assert chunks[0].error_code == "PROVIDER_RATE_LIMITED"
    assert chunks[0].retry_after_ms == 500


def test_fake_provider_builder_cache_usage() -> None:
    """cache_usage step sets cached_tokens on the final usage."""
    p = (
        FakeProviderBuilder()
        .text("hi")
        .cache_usage(100)
        .done()
        .build()
    )
    chunks = p.collect()
    done = [c for c in chunks if c.kind.value == "done"][0]
    assert done.usage is not None
    assert done.usage.cached_tokens == 100


def test_fake_provider_cancel_after_chunks() -> None:
    """cancel_after_chunks emits a CANCELLED error after N chunks."""
    p = (
        FakeProviderBuilder()
        .text("a")
        .text("b")
        .text("c")
        .done()
        .build()
    )
    chunks = list(p.stream(cancel_after_chunks=2))
    kinds = [c.kind.value for c in chunks]
    assert kinds[-1] == "error"
    assert chunks[-1].error_code == "CANCELLED"


def test_make_default_cost_computes_correctly() -> None:
    """make_default_cost multiplies tokens by per-1M rates."""
    cost = make_default_cost(
        {"input_tokens": 1_000_000, "output_tokens": 1_000_000},
        {"input": 3.0, "output": 15.0},
    )
    assert cost.computed_usd == pytest.approx(18.0)
    assert cost.provider_reported_usd == cost.computed_usd
    assert not cost.reconciliation_flagged


def test_make_default_cost_flags_anomaly() -> None:
    """Provider-reported cost diverging from computed flags an anomaly."""
    cost = make_default_cost(
        {
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
            "_provider_reported_usd": 50.0,
        },
        {"input": 3.0, "output": 15.0},
    )
    assert cost.reconciliation_flagged
    assert cost.provider_reported_usd == 50.0
    assert cost.computed_usd == pytest.approx(18.0)


def test_harness_runner_produces_complete_record(tmp_path: Path) -> None:
    """HarnessRunner.run produces a fully populated RunRecord."""
    task_dir = _make_task_dir(tmp_path / "task")
    cost = make_default_cost(
        {"input_tokens": 100, "output_tokens": 50}, {"input": 3.0, "output": 15.0}
    )
    from forge_evals.runners import GraderOutcome

    result = HarnessResult(
        outcome=Outcome.COMPLETED,
        final_revision="deadbeef",
        cost=cost,
        artifacts=[],
        context_manifests=[],
        grader_outcomes=[
            GraderOutcome(
                grader_id="end_state.noop",
                grader_version="0.1.0",
                passed=True,
                score=1.0,
            )
        ],
    )
    harness = FakeScriptHarness(result=result)
    runner = HarnessRunner(harness=harness)
    request = RunRequest(
        suite="tiny_bugfix",
        task="t1",
        task_dir=task_dir,
        harness_id="forge-minimal",
        harness_commit="abc",
        model_snapshot=ModelCapabilitySnapshot(
            provider="fake",
            model="fake-1",
            api_version="v1",
            context_window=128000,
            max_output_tokens=8192,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
            pricing={"input": 3.0, "output": 15.0},
        ),
        random_seed=42,
        budgets=Budgets(),
    )
    rec = runner.run(request)
    assert rec.outcome is Outcome.COMPLETED
    assert rec.cost is not None
    assert rec.cost.computed_usd > 0
    assert rec.end is not None
    assert len(rec.trajectory) > 0
    assert rec.trajectory[0]["event_type"] == "run.started"
    assert rec.trajectory[-1]["event_type"] == "run.ended"


def test_run_record_serialization_includes_all_fields(tmp_path: Path) -> None:
    """to_dict includes every SPEC §41.5 field."""
    r = RunRecord.new(
        suite="s", task="t", harness="h", harness_commit="c",
        environment_digest="d", random_seed=42,
    )
    r.outcome = Outcome.COMPLETED
    r.end = r.start
    r.cost = CostBreakdown(provider_reported_usd=0.01, computed_usd=0.01, input_tokens=1, output_tokens=1)
    d = r.to_dict()
    expected_keys = {
        "run_id", "suite", "task", "harness", "harness_commit",
        "model_capability_snapshot", "environment_digest", "random_seed",
        "budgets", "experiment_assignments", "start", "end", "outcome",
        "grader_results", "cost", "artifacts", "context_manifests",
        "trajectory", "notes",
    }
    assert expected_keys.issubset(d.keys())
    # JSON-serializable.
    json.dumps(d, default=str)
