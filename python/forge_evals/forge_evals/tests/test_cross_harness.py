"""Paired campaigns isolate workspaces and grade outside every harness."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pytest

from forge_evals.evidence import EvidenceClass
from forge_evals.run_record import Outcome, RunRecord
from forge_evals.runners.cross_harness import (
    CrossHarnessPlan,
    CrossHarnessRunner,
    HarnessSpec,
    TaskSpec,
)
from forge_evals.runners.harness_runner import HarnessResult, ModelCapabilitySnapshot, RunRequest
from forge_evals.runners.trajectory_recorder import TrajectoryRecorder


@dataclass
class _RecordingHarness:
    seen_workspaces: list[Path] = field(default_factory=list)

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        self.seen_workspaces.append(request.task_dir)
        assert request.task_package_dir is not None
        assert request.task_dir != request.task_package_dir
        assert not (request.task_dir / "hidden").exists()
        (request.task_dir / "answer.txt").write_text("fixed\n", encoding="utf-8")
        return HarnessResult(
            outcome=Outcome.COMPLETED,
            final_revision="git:result",
            cost=None,
            artifacts=[],
            context_manifests=[],
            grader_outcomes=[],
            evidence_class=EvidenceClass.FIXTURE_ONLY,
        )


def _task_package(tmp_path: Path) -> Path:
    package = tmp_path / "package"
    (package / "grader").mkdir(parents=True)
    (package / "task.yaml").write_text(
        "task: paired-task\n"
        "source_commit: 1111111111111111111111111111111111111111\n"
        "grader_version: 1.0.0\n"
        "allowed_network: []\n",
        encoding="utf-8",
    )
    (package / "prompt.md").write_text("Create answer.txt containing fixed.\n", encoding="utf-8")
    (package / "policy.yaml").write_text("network: deny\n", encoding="utf-8")
    setup = package / "setup.sh"
    setup.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "echo original > input.txt\n"
        "mkdir hidden\n"
        "echo expected > hidden/expected.txt\n",
        encoding="utf-8",
    )
    setup.chmod(0o755)
    (package / "grader" / "run.py").write_text(
        "import pathlib, sys\n"
        "ok = pathlib.Path('answer.txt').read_text().strip() == 'fixed'\n"
        "ok = ok and pathlib.Path('hidden/expected.txt').read_text().strip() == 'expected'\n"
        "sys.exit(0 if ok else 1)\n",
        encoding="utf-8",
    )
    return package


def _plan(tmp_path: Path, package: Path, harnesses: list[HarnessSpec]) -> CrossHarnessPlan:
    return CrossHarnessPlan(
        tasks=[TaskSpec(suite="paired", task="paired-task", task_dir=package)],
        harnesses=harnesses,
        model_snapshot=ModelCapabilitySnapshot(
            provider="opencode",
            model="hy3-free",
            api_version="catalog-1",
            context_window=128_000,
            max_output_tokens=16_384,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
        ),
        seeds=[7],
        randomize_harness_order=False,
        output_dir=tmp_path / "campaign",
    )


def test_campaign_materializes_distinct_workspaces_and_independently_grades(
    tmp_path: Path,
) -> None:
    package = _task_package(tmp_path)
    first = _RecordingHarness()
    second = _RecordingHarness()
    plan = _plan(
        tmp_path,
        package,
        [
            HarnessSpec("first", "a" * 40, first),
            HarnessSpec("second", "b" * 40, second),
        ],
    )

    result = CrossHarnessRunner().run(plan)

    assert plan.output_dir is not None
    assert len(result.records) == 2
    assert first.seen_workspaces[0] != second.seen_workspaces[0]
    assert not (package / "answer.txt").exists()
    assert not (first.seen_workspaces[0] / "hidden").exists()
    assert not (second.seen_workspaces[0] / "hidden").exists()
    assert {record.environment_digest for record in result.records} == {
        result.records[0].environment_digest
    }
    assert all(record.passed for record in result.records)
    assert all(record.independently_verified for record in result.records)
    persisted = RunRecord.from_jsonl(plan.output_dir / "runs.jsonl")
    assert [record.harness for record in persisted] == ["first", "second"]


def test_campaign_refuses_to_overwrite_existing_records(tmp_path: Path) -> None:
    package = _task_package(tmp_path)
    harness = _RecordingHarness()
    plan = _plan(
        tmp_path,
        package,
        [
            HarnessSpec("first", "a" * 40, harness),
            HarnessSpec("second", "b" * 40, harness),
        ],
    )
    assert plan.output_dir is not None
    plan.output_dir.mkdir(parents=True)
    (plan.output_dir / "runs.jsonl").write_text("occupied\n", encoding="utf-8")

    with pytest.raises(ValueError, match="output already exists"):
        CrossHarnessRunner().run(plan)


def test_release_campaign_rejects_unverified_or_inexact_harness_pins(tmp_path: Path) -> None:
    package = _task_package(tmp_path)
    harness = _RecordingHarness()
    plan = _plan(
        tmp_path,
        package,
        [
            HarnessSpec("first", "latest", harness),
            HarnessSpec("second", "b" * 40, harness),
        ],
    )
    strict = CrossHarnessPlan(
        **{**plan.__dict__, "require_exact_pins": True},
    )

    with pytest.raises(ValueError, match="verified exact pin"):
        CrossHarnessRunner().run(strict)
