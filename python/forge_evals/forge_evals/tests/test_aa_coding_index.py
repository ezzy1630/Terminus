"""Artificial Analysis v1.4 campaign scoring and evidence gates."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import yaml

from forge_evals.aa_coding_index import (
    AaCodingIndexContract,
    evaluate_aa_coding_index,
)
from forge_evals.cli import main
from forge_evals.evidence import EvidenceClass
from forge_evals.reward_hacking_review import run_record_digest
from forge_evals.run_record import CostBreakdown, GraderResult, Outcome, RunRecord, utc_now

REPO_ROOT = Path(__file__).resolve().parents[4]
RUNNER_SOURCES = {
    "deepswe": "git+https://example.com/deepswe-runner.git@" + "1" * 40,
    "terminal-bench": "git+https://example.com/terminal-runner.git@" + "2" * 40,
    "swe-atlas-qna": "git+https://example.com/atlas-runner.git@" + "3" * 40,
}


def _contract(tmp_path: Path) -> AaCodingIndexContract:
    path = tmp_path / "campaign.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "schema": "terminus.aa-coding-index-campaign.v1",
                "methodology": {
                    "name": "Artificial Analysis Coding Agent Index",
                    "version": "1.4",
                    "attempts_per_task": 3,
                    "task_weighting": "equal_within_component",
                    "component_weighting": "equal",
                },
                "model": {
                    "provider": "openai",
                    "id": "gpt-5.6-luna",
                    "reasoning_effort": "xhigh",
                },
                "components": [
                    {
                        "id": "deepswe",
                        "suite": "deepswe",
                        "task_count": 2,
                        "score_must_exceed": 57.0,
                    },
                    {
                        "id": "terminal-bench-2.1",
                        "suite": "terminal-bench",
                        "task_count": 1,
                        "score_must_exceed": 71.0,
                    },
                    {
                        "id": "swe-atlas-qna",
                        "suite": "swe-atlas-qna",
                        "task_count": 1,
                        "score_must_exceed": 31.0,
                    },
                ],
                "index_must_exceed": 53.0,
                "efficiency": {
                    "cost_usd_per_task_must_be_below": 0.24,
                    "wall_minutes_per_task_must_be_below": 6.9,
                    "tokens_per_task_must_be_below": 12_800_000,
                },
                "integrity": {
                    "require_external_live": True,
                    "require_independent_verification": True,
                    "require_provider_receipts": True,
                    "require_exact_harness_revision": True,
                    "require_pinned_runner_source": True,
                    "runner_sources": RUNNER_SOURCES,
                    "require_resolved_image_digest": True,
                    "terminal_bench_reward_hacking_review": True,
                },
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return AaCodingIndexContract.load(path)


def _record(*, suite: str, task: str, seed: int, passed: bool = True) -> RunRecord:
    start = utc_now()
    review_digest = "sha256:" + "e" * 64
    record_digest = "sha256:" + "f" * 64
    rubric_digest = "sha256:" + "7" * 64
    analysis_digest = "sha256:" + "9" * 64
    grader_metadata = (
        {
            "task_checksum": "official-terminal-checksum",
            "reward_hacking_review": "not_hacked",
            "reward_hacking_review_verifier": "independent-reviewer.example",
            "reward_hacking_review_method": "harbor_analyze",
            "reward_hacking_review_judge_agent": "claude-code",
            "reward_hacking_review_judge_model": "claude-sonnet-5",
            "reward_hacking_review_runner_source": RUNNER_SOURCES[suite],
            "reward_hacking_review_rubric_digest": rubric_digest,
            "reward_hacking_review_attestation_digest": review_digest,
            "reward_hacking_review_analysis_artifact": "artifact://analysis.json",
            "reward_hacking_review_analysis_digest": analysis_digest,
            "reward_hacking_review_record_digest": record_digest,
        }
        if suite == "terminal-bench" and passed
        else {}
    )
    return RunRecord(
        run_id=f"{suite}-{task}-{seed}",
        suite=suite,
        task=task,
        harness="terminus-live",
        harness_commit="a" * 40,
        model_capability_snapshot={
            "provider": "openai",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "xhigh",
            "runner_source": RUNNER_SOURCES[suite],
        },
        environment_digest="sha256:" + "b" * 64,
        random_seed=seed,
        budgets={},
        start=start,
        end=start + timedelta(seconds=60),
        outcome=Outcome.COMPLETED,
        grader_results=[
            GraderResult(
                grader_id="official",
                grader_version="1",
                passed=passed,
                score=1.0 if passed else 0.0,
                metadata=grader_metadata,
            )
        ],
        cost=CostBreakdown(
            provider_reported_usd=None,
            computed_usd=0.10,
            input_tokens=1000,
            output_tokens=200,
            cached_tokens=800,
            source="test-price-table",
        ),
        tokens_input_fresh=200,
        tokens_input_cached=800,
        tokens_output=200,
        wall_clock_ms=60_000,
        evidence_class=EvidenceClass.EXTERNAL_LIVE,
        independently_verified=True,
        provider_receipts=[{"receipt_id": f"receipt-{suite}-{task}-{seed}"}],
        artifacts=[
            {
                "kind": "resolved_image_digest",
                "status": "resolved",
                "digest": "sha256:" + "c" * 64,
            },
            *(
                [
                    {
                        "kind": "terminus_trajectory",
                        "status": "resolved",
                        "complete": True,
                        "digest": "sha256:" + "8" * 64,
                    }
                ]
                if suite == "terminal-bench" and passed
                else []
            ),
            *(
                [
                    {
                        "kind": "reward_hacking_review_attestation",
                        "status": "not_hacked",
                        "verifier": "independent-reviewer.example",
                        "digest": review_digest,
                        "record_digest": record_digest,
                        "review_method": "harbor_analyze",
                        "judge_agent": "claude-code",
                        "judge_model": "claude-sonnet-5",
                        "runner_source": RUNNER_SOURCES[suite],
                        "rubric_digest": rubric_digest,
                        "analysis_artifact": "artifact://analysis.json",
                        "analysis_digest": analysis_digest,
                    }
                ]
                if suite == "terminal-bench" and passed
                else []
            ),
        ],
    )


def _complete_records() -> list[RunRecord]:
    return [
        _record(suite=suite, task=task, seed=seed)
        for suite, tasks in (
            ("deepswe", ("deep-1", "deep-2")),
            ("terminal-bench", ("terminal-1",)),
            ("swe-atlas-qna", ("qna-1",)),
        )
        for task in tasks
        for seed in (1, 2, 3)
    ]


def test_complete_campaign_scores_tasks_then_components_and_passes(tmp_path: Path) -> None:
    result = evaluate_aa_coding_index(_complete_records(), _contract(tmp_path), "terminus-live")

    assert result.eligible
    assert result.passed
    assert result.index_score == 100.0
    assert result.component_scores == {
        "deepswe": 100.0,
        "terminal-bench-2.1": 100.0,
        "swe-atlas-qna": 100.0,
    }
    assert result.cost_usd_per_task == 0.10
    assert result.wall_minutes_per_task == 1.0
    assert result.tokens_per_task == 1200.0
    assert result.issues == ()


def test_incomplete_or_duplicate_attempts_fail_closed(tmp_path: Path) -> None:
    records = _complete_records()
    records.pop()
    records.append(records[0])

    result = evaluate_aa_coding_index(records, _contract(tmp_path), "terminus-live")

    assert not result.eligible
    assert not result.passed
    assert any(issue.key == "duplicate_attempt" for issue in result.issues)
    assert any(issue.key == "attempt_count" for issue in result.issues)


def test_missing_telemetry_or_integrity_review_cannot_win(tmp_path: Path) -> None:
    records = _complete_records()
    records[0].cost = None
    records[1].wall_clock_ms = None
    records[2].provider_receipts = []
    records[3].artifacts = []
    terminal = next(record for record in records if record.suite == "terminal-bench")
    terminal.grader_results[0].metadata.clear()

    result = evaluate_aa_coding_index(records, _contract(tmp_path), "terminus-live")

    assert not result.eligible
    assert not result.passed
    assert result.cost_usd_per_task is None
    assert result.wall_minutes_per_task is None
    assert {issue.key for issue in result.issues} >= {
        "cost_telemetry",
        "wall_time_telemetry",
        "provider_receipt",
        "resolved_image_digest",
        "reward_hacking_review",
    }


def test_wrong_model_or_reasoning_effort_is_not_comparable(tmp_path: Path) -> None:
    records = _complete_records()
    records[0].model_capability_snapshot["reasoning_effort"] = "high"

    result = evaluate_aa_coding_index(records, _contract(tmp_path), "terminus-live")

    assert not result.eligible
    assert any(issue.key == "model_identity" for issue in result.issues)


def test_different_exact_runner_commit_is_not_comparable(tmp_path: Path) -> None:
    records = _complete_records()
    records[0].model_capability_snapshot["runner_source"] = (
        "git+https://example.com/deepswe-runner.git@" + "f" * 40
    )

    result = evaluate_aa_coding_index(records, _contract(tmp_path), "terminus-live")

    assert not result.eligible
    assert any(issue.key == "runner_source" for issue in result.issues)


def test_repository_campaign_freezes_the_requested_comparison() -> None:
    contract = AaCodingIndexContract.load(
        REPO_ROOT / "evals/campaigns/artificial-analysis-coding-agent-index-v1.4.yaml"
    )

    assert contract.methodology_version == "1.4"
    assert contract.model == "gpt-5.6-luna"
    assert contract.reasoning_effort == "xhigh"
    assert contract.expected_attempt_count == 978
    assert contract.index_must_exceed == 53.0
    assert contract.cost_usd_per_task_must_be_below == 0.24
    assert contract.wall_minutes_per_task_must_be_below == 6.9
    assert contract.tokens_per_task_must_be_below == 12_800_000
    assert contract.runner_sources["terminal-bench"].endswith(
        "@4407eb5227a2ff4f0d3f16b2eb48849382fdf276"
    )


def test_cli_writes_machine_readable_gate_result(tmp_path: Path) -> None:
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    (runs_dir / "runs.jsonl").write_text(
        "\n".join(record.to_jsonl_line() for record in _complete_records()) + "\n",
        encoding="utf-8",
    )
    output = tmp_path / "result.json"

    exit_code = main(
        [
            "aa-coding-index",
            "--campaign",
            str(_write_contract(tmp_path)),
            "--runs-dir",
            str(runs_dir),
            "--harness",
            "terminus-live",
            "--output",
            str(output),
        ]
    )

    assert exit_code == 0
    assert output.exists()
    assert '"passed": true' in output.read_text(encoding="utf-8")


def test_cli_admits_an_exact_external_reward_review(tmp_path: Path) -> None:
    record = _record(suite="terminal-bench", task="terminal-1", seed=1)
    record.grader_results[0].metadata.clear()
    record.grader_results[0].metadata["task_checksum"] = "official-terminal-checksum"
    record.artifacts = [
        artifact
        for artifact in record.artifacts
        if artifact.get("kind") != "reward_hacking_review_attestation"
    ]
    pending = tmp_path / "pending.json"
    record.to_json(pending)
    review = tmp_path / "review.json"
    review.write_text(
        __import__("json").dumps(
            {
                "schema": "terminus.terminal-bench-reward-hacking-review.v1",
                "verifier": "independent-reviewer.example",
                "verdict": "not_hacked",
                "run_id": record.run_id,
                "task": record.task,
                "random_seed": record.random_seed,
                "task_checksum": "official-terminal-checksum",
                "record_digest": run_record_digest(record),
                "review_method": "harbor_analyze",
                "judge_agent": "claude-code",
                "judge_model": "claude-sonnet-5",
                "runner_source": RUNNER_SOURCES["terminal-bench"],
                "rubric_digest": "sha256:" + "7" * 64,
                "analysis_artifact": "artifact://analysis.json",
                "analysis_digest": "sha256:" + "9" * 64,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    runs_dir = tmp_path / "runs"

    exit_code = main(
        [
            "aa-admit-review",
            "--campaign",
            str(_write_contract(tmp_path)),
            "--record",
            str(pending),
            "--review",
            str(review),
            "--runs-dir",
            str(runs_dir),
        ]
    )

    assert exit_code == 0
    admitted = RunRecord.from_jsonl(runs_dir / "runs.jsonl")
    assert admitted[0].grader_results[0].metadata["reward_hacking_review"] == "not_hacked"


def _write_contract(tmp_path: Path) -> Path:
    """Persist the fixture contract for the CLI path."""
    path = tmp_path / "cli-campaign.yaml"
    source = tmp_path / "source-campaign.yaml"
    contract = _contract(tmp_path)
    del contract
    source = tmp_path / "campaign.yaml"
    path.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    return path
