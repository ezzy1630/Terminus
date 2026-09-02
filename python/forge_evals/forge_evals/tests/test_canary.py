"""Canary pairing, identity enforcement, and trajectory diff tests.

Offline: the pair runner returns synthetic baseline/candidate records built
exactly like the paired-evidence tests construct theirs. No control plane,
no provider, no model judge.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from forge_evals.canary import (
    CANARY_REPORT_VERSION,
    CANARY_TASKS,
    CanaryTaskSpec,
    run_canary,
)
from forge_evals.evidence import EvidenceClass
from forge_evals.identity import EvaluationIdentity
from forge_evals.run_record import CostBreakdown, GraderResult, Outcome, RunRecord
from forge_evals.trajectory_diff import (
    diff_context_manifests,
    diff_tool_sequences,
    diff_trajectories,
)


def _identity(task: str, seed: int, harness: str, *, model: str = "model-v1") -> EvaluationIdentity:
    return EvaluationIdentity(
        task_id=task,
        task_version="task-v1",
        repository_digest="sha256:repo",
        environment_digest="sha256:env",
        harness_id=harness,
        harness_commit=f"commit:{harness}",
        harness_config_hash=f"config:{harness}",
        provider="provider",
        model=model,
        model_version="model-version-1",
        model_capability_snapshot_hash="sha256:capabilities",
        random_seed=seed,
        sampling_config_hash="sha256:sampling",
        sandbox_policy_hash="sha256:sandbox",
        network_policy="proxy-only",
        budget_hash="sha256:budget",
        tool_schema_hash="sha256:tools",
        instruction_hash="sha256:instructions",
        provider_endpoint_hash="sha256:" + "e" * 64,
        provider_account_hash="sha256:" + "a" * 64,
    )


def _record(
    task: str,
    seed: int,
    harness: str,
    passed: bool,
    *,
    model: str = "model-v1",
    trajectory: list[dict[str, Any]] | None = None,
    manifests: list[dict[str, Any]] | None = None,
    harness_admitted: bool = False,
) -> RunRecord:
    record = RunRecord.new(
        suite="canary",
        task=task,
        harness=harness,
        harness_commit=f"commit:{harness}",
        environment_digest="sha256:env",
        random_seed=seed,
        evaluation_identity=_identity(task, seed, harness, model=model),
        evidence_class=EvidenceClass.EXTERNAL_LIVE,
    )
    record.outcome = Outcome.COMPLETED if passed else Outcome.FAILED
    record.grader_results = [
        GraderResult(
            grader_id="canary.deterministic",
            grader_version="1.0.0",
            passed=passed,
            score=1.0 if passed else 0.0,
        )
    ]
    record.harness_verdict = {
        "admitted": harness_admitted,
        "status": "admitted" if harness_admitted else "failed",
    }
    record.trajectory = list(trajectory or [])
    record.context_manifests = list(manifests or [])
    record.cost = CostBreakdown(
        provider_reported_usd=0.01, computed_usd=0.01, input_tokens=100, output_tokens=50
    )
    record.tokens_input_fresh = 100
    record.tokens_output = 50
    record.steps = 3
    return record


def _pair_runner(
    baseline_passed: bool, candidate_passed: bool, *, candidate_model: str = "model-v1"
) -> Callable[[CanaryTaskSpec, int], tuple[RunRecord, RunRecord]]:
    def run_pair(spec: CanaryTaskSpec, seed: int) -> tuple[RunRecord, RunRecord]:
        return (
            _record(spec.task_id, seed, "baseline", baseline_passed),
            _record(spec.task_id, seed, "candidate", candidate_passed, model=candidate_model),
        )

    return run_pair


def test_canary_report_version_and_tasks() -> None:
    assert CANARY_REPORT_VERSION == "terminus.canary.comparison/v1"
    assert len(CANARY_TASKS) == 5
    archetypes = {spec.archetype for spec in CANARY_TASKS}
    assert archetypes == {
        "read_only_diagnosis",
        "single_file_edit",
        "multi_file_edit",
        "failing_test_repair",
        "repository_discovery",
    }
    for spec in CANARY_TASKS:
        assert spec.package_dir.is_dir(), f"missing canary task package {spec.task_id}"
        assert (spec.package_dir / "task.yaml").is_file()
        assert (spec.package_dir / "grader" / "run.py").is_file()


def test_canary_eligible_pair_and_aggregation() -> None:
    report = run_canary(
        _pair_runner(baseline_passed=True, candidate_passed=True),
        baseline_commit="a" * 40,
        candidate_commit="b" * 40,
        seed=42,
    )
    assert report.eligible is True
    assert report.identity_locked is True
    assert report.ineligible_reason is None
    assert report.aggregate["baseline_resolved"] == 5
    assert report.aggregate["candidate_resolved"] == 5
    assert report.aggregate["resolved_delta"] == 0
    assert len(report.tasks) == 5
    for row in report.tasks:
        assert row["identity_locked"] is True
        assert row["baseline"]["passed"] is True
        assert row["candidate"]["passed"] is True
        assert "trajectory_diff" in row


def test_canary_detects_resolved_delta_and_false_completion() -> None:
    def runner(spec: CanaryTaskSpec, seed: int) -> tuple[RunRecord, RunRecord]:
        baseline = _record(spec.task_id, seed, "baseline", passed=True)
        # Candidate admits completion but the grader rejects it.
        candidate = _record(spec.task_id, seed, "candidate", passed=False, harness_admitted=True)
        return baseline, candidate

    report = run_canary(
        runner,
        baseline_commit="a" * 40,
        candidate_commit="b" * 40,
        seed=42,
    )
    assert report.aggregate["baseline_resolved"] == 5
    assert report.aggregate["candidate_resolved"] == 0
    assert report.aggregate["false_completions"] == {"baseline": 0, "candidate": 5}
    row = report.tasks[0]
    assert row["candidate"]["false_completion"] is True


def test_canary_rejects_identical_commits() -> None:
    report = run_canary(
        _pair_runner(True, True),
        baseline_commit="a" * 40,
        candidate_commit="a" * 40,
    )
    assert report.eligible is False
    assert report.ineligible_reason is not None
    assert "identical" in report.ineligible_reason


def test_canary_marks_model_mismatch_ineligible() -> None:
    report = run_canary(
        _pair_runner(True, True, candidate_model="model-v2"),
        baseline_commit="a" * 40,
        candidate_commit="b" * 40,
    )
    assert report.eligible is False
    assert report.identity_locked is False
    assert any("model" in issue for issue in report.identity_issues)


def test_canary_report_is_json_serializable() -> None:
    report = run_canary(
        _pair_runner(True, False),
        baseline_commit="a" * 40,
        candidate_commit="b" * 40,
        output_dir=None,
    )
    encoded = json.dumps(report.to_dict(), sort_keys=True)
    assert CANARY_REPORT_VERSION in encoded


# ───────────────────────── trajectory_diff ────────────────────────────────


def _trajectory(*tool_names: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for index, name in enumerate(tool_names):
        events.append(
            {
                "seq": index,
                "ts": f"2026-01-01T00:00:{index:02d}+00:00",
                "event_type": "tool.proposed",
                "payload": {"tool_call_id": f"t{index}", "tool_name": name},
            }
        )
    return events


def test_tool_sequence_diff_first_divergence_and_added_removed() -> None:
    baseline = _trajectory("read", "read", "patch", "run_tests")
    candidate = _trajectory("read", "grep", "read", "patch", "run_tests", "run_tests")

    diff = diff_tool_sequences(baseline, candidate)
    assert diff.first_divergence == 1
    assert "grep" in diff.added
    assert diff.added.count("run_tests") == 1


def test_tool_sequence_diff_identical() -> None:
    trajectory = _trajectory("read", "patch", "run_tests")
    diff = diff_tool_sequences(trajectory, trajectory)
    assert diff.added == ()
    assert diff.removed == ()
    assert diff.first_divergence == 3


def test_manifest_diff_token_deltas_and_fragment_kinds() -> None:
    baseline = [
        {"selected_tokens": 1000, "fragment_kinds": ["system", "task", "repo_map"]},
        {"selected_tokens": 1500, "fragment_kinds": ["system", "task", "history"]},
    ]
    candidate = [
        {"selected_tokens": 900, "fragment_kinds": ["system", "task"]},
        {"selected_tokens": 1500, "fragment_kinds": ["system", "task", "history"]},
    ]
    diff = diff_context_manifests(baseline, candidate)
    assert diff.selected_token_deltas == (-100, 0)
    assert diff.fragment_kinds_removed[0] == ("repo_map",)
    assert diff.fragment_kinds_added[0] == ()
    assert diff.baseline_selected_tokens == 2500
    assert diff.candidate_selected_tokens == 2400


def test_trajectory_diff_over_record_dicts() -> None:
    baseline = _record(
        "t",
        1,
        "baseline",
        passed=True,
        trajectory=_trajectory("read", "patch"),
        manifests=[{"selected_tokens": 1000, "fragment_kinds": ["system"]}],
    )
    candidate = _record(
        "t",
        1,
        "candidate",
        passed=True,
        trajectory=_trajectory("grep", "read", "patch"),
        manifests=[{"selected_tokens": 1100, "fragment_kinds": ["system", "repo_map"]}],
    )
    diff = diff_trajectories(baseline.to_dict(), candidate.to_dict())
    lines = diff.summary_lines()
    assert any("first divergence at call 0" in line for line in lines)
    assert any("repo_map" in line for line in lines)
    assert diff.event_types_equal is False
