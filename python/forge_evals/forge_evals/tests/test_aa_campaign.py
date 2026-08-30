from __future__ import annotations

import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from forge_evals.aa_campaign import (
    AaCampaignAttempt,
    AaCampaignPlan,
    build_aa_campaign_plan,
    discover_task_ids,
    execute_aa_campaign_plan,
)
from forge_evals.aa_coding_index import AaCodingIndexContract
from forge_evals.cli import _verify_exact_harness_checkout, main
from forge_evals.evidence import EvidenceClass
from forge_evals.run_record import CostBreakdown, GraderResult, Outcome, RunRecord, utc_now
from forge_evals.runners.benchmark_adapters import load_benchmark_manifest
from forge_evals.runners.harness_runner import RunRequest

REPO_ROOT = Path(__file__).resolve().parents[4]
CAMPAIGN = REPO_ROOT / "evals" / "campaigns" / "artificial-analysis-coding-agent-index-v1.4.yaml"
SUITES = REPO_ROOT / "evals" / "suites"


def test_exact_harness_checkout_rejects_dirty_source(tmp_path: Path) -> None:
    repository = tmp_path / "harness"
    repository.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.name", "Terminus Test"], cwd=repository, check=True)
    subprocess.run(
        ["git", "config", "user.email", "terminus@example.invalid"],
        cwd=repository,
        check=True,
    )
    source = repository / "runner.py"
    source.write_text("VERSION = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "runner.py"], cwd=repository, check=True)
    subprocess.run(["git", "commit", "-qm", "freeze harness"], cwd=repository, check=True)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    _verify_exact_harness_checkout(repository, head)
    source.write_text("VERSION = 2\n", encoding="utf-8")

    with pytest.raises(ValueError, match="clean harness checkout"):
        _verify_exact_harness_checkout(repository, head)


def _fake_source(tmp_path: Path, suite: str, task_count: int, task_path: str) -> Path:
    source = tmp_path / suite
    for index in range(task_count):
        task = source / task_path / f"task-{index:03d}"
        task.mkdir(parents=True)
        (task / "task.toml").write_text("schema_version = '1.0'\n", encoding="utf-8")
    return source


def test_discover_task_ids_rejects_task_count_drift(tmp_path: Path) -> None:
    manifest = replace(
        load_benchmark_manifest(SUITES / "deepswe.yaml"),
        task_count=2,
    )
    source = _fake_source(tmp_path, "deepswe", 1, "tasks")
    with pytest.raises(ValueError, match=r"discovered 1.*expected 2"):
        discover_task_ids(manifest, source)


def test_full_plan_has_978_cells_and_resumes_exact_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contract = AaCodingIndexContract.load(CAMPAIGN)
    sources = {
        "deepswe": _fake_source(tmp_path, "deepswe", 113, "tasks"),
        "terminal-bench": _fake_source(tmp_path, "terminal-bench", 89, "tasks"),
        "swe-atlas-qna": _fake_source(tmp_path, "swe-atlas-qna", 124, "data/qa"),
    }
    monkeypatch.setattr(
        "forge_evals.aa_campaign.materialize_task_source",
        lambda manifest, _sources_dir: sources[manifest.suite_id],
    )
    completed = RunRecord.new(
        suite="deepswe",
        task="task-000",
        harness="terminus-aa-v1.4",
        harness_commit="c" * 40,
        environment_digest="sha256:" + "d" * 64,
        random_seed=0,
        model_capability_snapshot={},
        budgets={},
    )

    plan = build_aa_campaign_plan(
        contract,
        manifest_paths={
            component.suite: SUITES / f"{component.suite}.yaml" for component in contract.components
        },
        sources_dir=tmp_path / "sources",
        existing_records=[completed],
        harness="terminus-aa-v1.4",
    )

    assert len(plan.attempts) == 978
    assert len(plan.pending) == 977
    assert plan.attempts[0].key == ("deepswe", "task-000", 0)
    assert plan.attempts[-1].key == ("swe-atlas-qna", "task-123", 2)


def test_execution_keeps_failures_resumable_and_rejects_wrong_identity(
    tmp_path: Path,
) -> None:
    cells = tuple(
        AaCampaignAttempt(
            suite="deepswe",
            task=f"task-{index}",
            seed=0,
            manifest_path=tmp_path / "suite.yaml",
            task_dir=tmp_path / f"task-{index}",
        )
        for index in range(3)
    )
    plan = AaCampaignPlan(attempts=cells, pending=cells, completed_keys=frozenset())

    def run(attempt: AaCampaignAttempt) -> RunRecord:
        if attempt.task == "task-1":
            raise RuntimeError("runner unavailable")
        record = RunRecord.new(
            suite=attempt.suite,
            task=attempt.task,
            harness="terminus-aa-v1.4",
            harness_commit="c" * 40,
            environment_digest="sha256:" + "d" * 64,
            random_seed=attempt.seed,
            model_capability_snapshot={},
            budgets={},
        )
        if attempt.task == "task-2":
            record.task = "wrong-task"
        return record

    execution = execute_aa_campaign_plan(plan, run, concurrency=2)

    assert [record.task for record in execution.records] == ["task-0"]
    assert [failure.error_type for failure in execution.failures] == [
        "RuntimeError",
        "RunIdentityMismatch",
    ]


def test_plan_does_not_resume_duplicate_or_inadmissible_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contract = AaCodingIndexContract.load(CAMPAIGN)
    sources = {
        component.suite: _fake_source(
            tmp_path,
            component.suite,
            component.task_count,
            "data/qa" if component.suite == "swe-atlas-qna" else "tasks",
        )
        for component in contract.components
    }
    monkeypatch.setattr(
        "forge_evals.aa_campaign.materialize_task_source",
        lambda manifest, _sources_dir: sources[manifest.suite_id],
    )
    record = RunRecord.new(
        suite="deepswe",
        task="task-000",
        harness="terminus-aa-v1.4",
        harness_commit="c" * 40,
        environment_digest="sha256:" + "d" * 64,
        random_seed=0,
    )

    duplicate_plan = build_aa_campaign_plan(
        contract,
        manifest_paths={
            component.suite: SUITES / f"{component.suite}.yaml" for component in contract.components
        },
        sources_dir=tmp_path / "sources",
        existing_records=[record, record],
        harness="terminus-aa-v1.4",
    )
    inadmissible_plan = build_aa_campaign_plan(
        contract,
        manifest_paths={
            component.suite: SUITES / f"{component.suite}.yaml" for component in contract.components
        },
        sources_dir=tmp_path / "sources",
        existing_records=[record],
        harness="terminus-aa-v1.4",
        admissible_record=lambda _record: False,
    )

    assert (record.suite, record.task, record.random_seed) not in duplicate_plan.completed_keys
    assert duplicate_plan.attempts[0].key in {attempt.key for attempt in duplicate_plan.pending}
    assert inadmissible_plan.attempts[0].key in {
        attempt.key for attempt in inadmissible_plan.pending
    }


def test_aa_run_streams_an_admissible_partial_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    task_dir = tmp_path / "task"
    task_dir.mkdir()
    attempt = AaCampaignAttempt(
        suite="deepswe",
        task="task-000",
        seed=0,
        manifest_path=SUITES / "deepswe.yaml",
        task_dir=task_dir,
    )
    plan = AaCampaignPlan(
        attempts=(attempt,),
        pending=(attempt,),
        completed_keys=frozenset(),
    )
    monkeypatch.setattr(
        "forge_evals.aa_campaign.build_aa_campaign_plan",
        lambda *_args, **_kwargs: plan,
    )
    monkeypatch.setattr(
        "forge_evals.cli._verify_exact_harness_checkout",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setenv("TERMINUS_CONTROL_URL", "http://127.0.0.1:3050")

    def fake_run(**kwargs: object) -> RunRecord:
        request = kwargs["request"]
        assert isinstance(request, RunRequest)
        assert request.reasoning_effort == "xhigh"
        start = utc_now()
        return RunRecord(
            run_id="accepted-attempt",
            suite="deepswe",
            task="task-000",
            harness="terminus-live",
            harness_commit="a" * 40,
            model_capability_snapshot={
                "provider": "openai",
                "model": "gpt-5.6-luna",
                "reasoning_effort": "xhigh",
                "runner_source": (
                    "git+https://github.com/datacurve-ai/pier.git@"
                    "df89f994623a0a6a57229103b6fe910766693c30"
                ),
            },
            environment_digest="sha256:" + "c" * 64,
            random_seed=0,
            budgets={},
            start=start,
            end=start,
            outcome=Outcome.COMPLETED,
            grader_results=[
                GraderResult(
                    grader_id="pier:official",
                    grader_version="1",
                    passed=False,
                    score=0.0,
                )
            ],
            cost=CostBreakdown(
                provider_reported_usd=0.01,
                computed_usd=0.01,
                input_tokens=10,
                output_tokens=2,
            ),
            artifacts=[
                {
                    "kind": "resolved_image_digest",
                    "status": "resolved",
                    "digest": "sha256:" + "d" * 64,
                }
            ],
            tokens_input_fresh=10,
            tokens_output=2,
            wall_clock_ms=1_000,
            evidence_class=EvidenceClass.EXTERNAL_LIVE,
            independently_verified=True,
            provider_receipts=[{"request": "receipt"}],
        )

    monkeypatch.setattr(
        "forge_evals.runners.harbor_runner.run_harbor_tasks",
        fake_run,
    )
    runs_dir = tmp_path / "runs"
    exit_code = main(
        [
            "aa-run",
            "--campaign",
            str(CAMPAIGN),
            "--runs-dir",
            str(runs_dir),
            "--harness-commit",
            "a" * 40,
            "--provider-account",
            "openai-primary",
            "--max-attempts",
            "1",
        ]
    )

    assert exit_code == 2
    records = RunRecord.from_jsonl(runs_dir / "runs.jsonl")
    assert [record.run_id for record in records] == ["accepted-attempt"]
    assert (runs_dir / "status.json").exists()
