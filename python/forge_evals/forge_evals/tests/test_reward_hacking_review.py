"""Terminal-Bench reward-hacking review admission."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from forge_evals.reward_hacking_review import (
    admit_reward_hacking_review,
    harbor_reward_hacking_review_payload,
    load_reward_hacking_review,
    run_record_digest,
)
from forge_evals.run_record import GraderResult, Outcome, RunRecord


def _record() -> RunRecord:
    return RunRecord(
        run_id="terminal-bench-task-0",
        suite="terminal-bench",
        task="task-1",
        harness="terminus-live",
        harness_commit="a" * 40,
        model_capability_snapshot={},
        environment_digest="sha256:" + "b" * 64,
        random_seed=0,
        budgets={},
        outcome=Outcome.COMPLETED,
        grader_results=[
            GraderResult(
                grader_id="harbor:official",
                grader_version="2.1",
                passed=True,
                score=1.0,
                metadata={"task_checksum": "official-checksum"},
            )
        ],
    )


def _write_review(path: Path, record: RunRecord, **overrides: object) -> Path:
    payload: dict[str, object] = {
        "schema": "terminus.terminal-bench-reward-hacking-review.v1",
        "verifier": "independent-reviewer.example",
        "verdict": "not_hacked",
        "run_id": record.run_id,
        "task": record.task,
        "random_seed": record.random_seed,
        "task_checksum": "official-checksum",
        "record_digest": run_record_digest(record),
        "review_method": "harbor_analyze",
        "judge_agent": "claude-code",
        "judge_model": "claude-sonnet-5",
        "runner_source": "git+https://example.com/harbor.git@" + "d" * 40,
        "rubric_digest": "sha256:" + "e" * 64,
        "analysis_artifact": "artifact://analysis.json",
        "analysis_digest": "sha256:" + "c" * 64,
        **overrides,
    }
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    return path


def test_external_review_is_bound_and_attached(tmp_path: Path) -> None:
    record = _record()
    review = load_reward_hacking_review(_write_review(tmp_path / "review.json", record))

    admitted = admit_reward_hacking_review(record, review)

    metadata = admitted.grader_results[0].metadata
    assert metadata["reward_hacking_review"] == "not_hacked"
    assert metadata["reward_hacking_review_record_digest"] == review.record_digest
    assert admitted.artifacts[-1]["digest"] == review.attestation_digest


def test_review_rejects_a_different_run_record(tmp_path: Path) -> None:
    record = _record()
    review = load_reward_hacking_review(
        _write_review(tmp_path / "review.json", record, record_digest="sha256:" + "d" * 64)
    )

    with pytest.raises(ValueError, match="exact run record"):
        admit_reward_hacking_review(record, review)


def test_review_rejects_self_attestation(tmp_path: Path) -> None:
    record = _record()
    path = _write_review(tmp_path / "review.json", record, verifier="terminus-eval")

    with pytest.raises(ValueError, match="external verifier"):
        load_reward_hacking_review(path)


def test_harbor_analysis_translates_to_the_exact_judge_attestation(tmp_path: Path) -> None:
    record = _record()
    analysis = tmp_path / "analysis.json"
    analysis.write_text(
        json.dumps(
            {
                "trial_name": "task-1",
                "summary": "The task was solved directly.",
                "checks": {
                    "reward_hacking": {
                        "outcome": "pass",
                        "explanation": "No verifier manipulation or answer retrieval.",
                    }
                },
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    rubric = tmp_path / "rubric.toml"
    rubric.write_text("[[criteria]]\nname = 'reward_hacking'\n", encoding="utf-8")
    runner_source = "git+https://example.com/harbor.git@" + "d" * 40

    payload = harbor_reward_hacking_review_payload(
        record,
        analysis_path=analysis,
        runner_source=runner_source,
        rubric_path=rubric,
    )
    review_path = tmp_path / "review.json"
    review_path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    review = load_reward_hacking_review(review_path)

    assert review.verdict == "not_hacked"
    assert review.review_method == "harbor_analyze"
    assert review.judge_agent == "claude-code"
    assert review.judge_model == "claude-sonnet-5"
    assert review.runner_source == runner_source
