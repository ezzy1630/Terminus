"""Focused tests for the installed CLI benchmark adapters.

The executables here are tiny local fixtures. No provider is contacted.
"""

from __future__ import annotations

import json
import stat
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest

from forge_evals.evidence import EvidenceClass, has_complete_provider_receipt
from forge_evals.run_record import Outcome
from forge_evals.runners import (
    Budgets,
    CliHarnessError,
    ModelCapabilitySnapshot,
    OpenCodeCliAdapter,
    PiCliAdapter,
    RunRequest,
    TrajectoryRecorder,
)


def _request(
    tmp_path: Path, *, harness_id: str = "fixture-cli", instruction: str = "fix it"
) -> RunRequest:
    return RunRequest(
        suite="internal",
        task="cli-task",
        task_dir=tmp_path / "workspace",
        harness_id=harness_id,
        harness_commit="fixture",
        model_snapshot=ModelCapabilitySnapshot(
            provider="opencode-zen",
            model="mimo-v2.5-free",
            api_version="catalog-1",
            context_window=128_000,
            max_output_tokens=16_384,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
        ),
        random_seed=4,
        budgets=Budgets(max_wall_seconds=5),
        reasoning_effort="high",
        instruction=instruction,
    )


def _fixture_executable(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "fake-agent"
    path.write_text(f"#!{sys.executable}\n{body}\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_opencode_runs_non_interactively_and_records_usage(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    executable = _fixture_executable(
        tmp_path,
        """
import json, os, sys
assert sys.stdin.isatty() is False
Path = __import__('pathlib').Path
(Path(os.environ['FORGE_EVAL_WORKSPACE']) / 'changed.txt').write_text('ok')
print(json.dumps({'type': 'step_start'}))
print(json.dumps({'type': 'step_finish', 'part': {'tokens': {'input': 100, 'output': 40, 'reasoning': 7, 'cache': {'read': 25, 'write': 3}}}}))
print(json.dumps({'type': 'text', 'text': 'done'}))
""",
    )
    request = _request(tmp_path, harness_id="upstream_opencode")
    recorder = TrajectoryRecorder("run-opencode")

    result = OpenCodeCliAdapter(
        executable=str(executable),
        artifact_root=tmp_path / "artifacts",
        evidence_class=EvidenceClass.FIXTURE_ONLY,
    ).run(request, recorder)

    assert result.outcome is Outcome.COMPLETED
    assert (workspace / "changed.txt").read_text() == "ok"
    invocation = result.artifacts[0]
    assert invocation["cwd"] == str(workspace.resolve())
    assert invocation["argv"][1:7] == [
        "run",
        "--pure",
        "--format",
        "json",
        "--model",
        "opencode-zen/mimo-v2.5-free",
    ]
    assert "--variant" in invocation["argv"]
    assert result.metrics["tokens_input_fresh"] == 75
    assert result.metrics["tokens_input_cached"] == 25
    assert result.metrics["tokens_output"] == 40
    assert result.metrics["tokens_reasoning"] == 7
    assert result.evidence_class is EvidenceClass.FIXTURE_ONLY
    assert len(result.provider_receipts) == 1
    assert has_complete_provider_receipt(result.provider_receipts[0])
    stdout_artifact = result.artifacts[1]
    assert Path(stdout_artifact["path"]).read_text().endswith('"done"}\n')
    assert stdout_artifact["truncated"] is False


def test_pi_selects_provider_and_disables_sessions(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    executable = _fixture_executable(
        tmp_path,
        """
import json, os, sys
__import__('pathlib').Path(os.environ['FORGE_EVAL_WORKSPACE'], 'argv.json').write_text(json.dumps(sys.argv[1:]))
print(json.dumps({'type': 'message_end', 'message': {'usage': {'input': 12, 'output': 5}}}))
""",
    )
    result = PiCliAdapter(
        executable=str(executable),
        artifact_root=tmp_path / "artifacts",
        evidence_class=EvidenceClass.FIXTURE_ONLY,
    ).run(_request(tmp_path, harness_id="pi"), TrajectoryRecorder("run-pi"))

    assert result.outcome is Outcome.COMPLETED
    args = json.loads((workspace / "argv.json").read_text())
    assert args[:8] == [
        "--print",
        "--no-session",
        "--mode",
        "json",
        "--provider",
        "opencode-zen",
        "--model",
        "mimo-v2.5-free",
    ]
    assert "--no-extensions" in args
    assert args[-2:] == ["--", "fix it"]
    assert result.cost is not None
    assert result.cost.input_tokens == 12
    assert result.cost.output_tokens == 5


def test_cli_output_is_bounded_in_record_and_keeps_immutable_artifact(tmp_path: Path) -> None:
    (tmp_path / "workspace").mkdir()
    executable = _fixture_executable(tmp_path, "print('x' * 200)")
    result = PiCliAdapter(
        executable=str(executable),
        output_tail_bytes=32,
        artifact_root=tmp_path / "artifacts",
        evidence_class=EvidenceClass.FIXTURE_ONLY,
    ).run(_request(tmp_path, harness_id="pi"), TrajectoryRecorder("run-large"))
    output = result.artifacts[1]

    assert output["bytes_seen"] > 32
    assert output["truncated"] is True
    assert len(output["tail"].encode()) <= 32
    artifact = Path(output["path"])
    assert artifact.exists()
    assert artifact.stat().st_size > 32
    assert output["artifact_ref"].startswith("artifact://sha256/")


def test_timeout_kills_cli_process_group_and_reports_timeout(tmp_path: Path) -> None:
    (tmp_path / "workspace").mkdir()
    executable = _fixture_executable(
        tmp_path, "import time; print('started', flush=True); time.sleep(10)"
    )
    started = time.monotonic()
    result = PiCliAdapter(
        executable=str(executable),
        timeout_seconds=0.1,
        artifact_root=tmp_path / "artifacts",
        evidence_class=EvidenceClass.FIXTURE_ONLY,
    ).run(_request(tmp_path, harness_id="pi"), TrajectoryRecorder("run-timeout"))

    assert result.outcome is Outcome.TIMEOUT
    assert time.monotonic() - started < 3
    assert result.provider_receipts[0]["verified"] is False


def test_invalid_model_identity_fails_before_start(tmp_path: Path) -> None:
    (tmp_path / "workspace").mkdir()
    request = _request(tmp_path)
    bad = ModelCapabilitySnapshot(
        provider="opencode-zen",
        model="other-provider/model",
        api_version="v1",
        context_window=1,
        max_output_tokens=1,
        supports_tool_calls=False,
        supports_streaming=False,
        supports_cache=False,
    )
    request = replace(request, model_snapshot=bad)
    with pytest.raises(CliHarnessError, match="provider mismatch"):
        PiCliAdapter(executable="does-not-exist").run(request, TrajectoryRecorder("run-bad"))
