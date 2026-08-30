"""Harbor / Terminal-Bench: the agent shim and the CLI-level runner.

Docker and Harbor are not available on every machine, so the runner is proven
against a fake ``harbor`` executable on PATH that writes the same
``result.json`` Harbor 0.22 writes. No test here claims a live Harbor run.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from forge_evals.run_record import Outcome
from forge_evals.runners.harbor_agent import (
    TERMINUS_HARBOR_AGENT_IMPORT_PATH,
    HarborWorkspaceBridge,
    TerminusHarborAgent,
    harbor_agent_env,
)
from forge_evals.runners.harbor_runner import (
    HarborUnavailable,
    build_harbor_argv,
    collect_trial_results,
    run_harbor_tasks,
)
from forge_evals.runners.harness_runner import (
    Budgets,
    HarnessResult,
    ModelCapabilitySnapshot,
    RunRequest,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
SUITES_DIR = REPO_ROOT / "evals" / "suites"


# ──────────────────────────── agent env ───────────────────────────────────


def test_agent_env_requires_a_control_plane() -> None:
    with pytest.raises(RuntimeError, match="TERMINUS_CONTROL_URL"):
        harbor_agent_env({})


def test_agent_env_forwards_only_the_terminus_configuration() -> None:
    env = harbor_agent_env(
        {
            "TERMINUS_CONTROL_URL": "http://127.0.0.1:3050",
            "TERMINUS_CONTROL_TOKEN": "tok",
            "TERMINUS_MODEL": "gpt-5.6",
            "TERMINUS_HARNESS_COMMIT": "sha256:abc",
            "HOME": "/root",
        }
    )
    assert env == {
        "TERMINUS_CONTROL_URL": "http://127.0.0.1:3050",
        "TERMINUS_CONTROL_TOKEN": "tok",
        "TERMINUS_MODEL": "gpt-5.6",
        "TERMINUS_HARNESS_COMMIT": "sha256:abc",
    }


# ──────────────────────────── workspace bridge ────────────────────────────


class _FakeEnvironment:
    """Stands in for Harbor's BaseEnvironment handle onto a container."""

    def __init__(self, container: Path) -> None:
        self.container = container
        self.execs: list[str] = []
        self.uploads: list[tuple[str, str]] = []

    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        import shutil

        target = Path(target_dir)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(self.container, target)

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        import shutil

        self.uploads.append((str(source_dir), target_dir))
        shutil.copytree(source_dir, self.container, dirs_exist_ok=True)

    async def exec(self, command: str) -> None:
        self.execs.append(command)
        if command.startswith("rm -f -- "):
            raw = command[len("rm -f -- ") :].strip().strip("'")
            relative = raw[len("/app/") :] if raw.startswith("/app/") else raw
            target = self.container / relative
            if target.exists():
                target.unlink()


def test_bridge_round_trips_edits_and_replays_deletions(tmp_path: Path) -> None:
    container = tmp_path / "container-app"
    container.mkdir()
    (container / "keep.txt").write_text("keep", encoding="utf-8")
    (container / "remove.txt").write_text("remove", encoding="utf-8")

    environment = _FakeEnvironment(container)
    bridge = HarborWorkspaceBridge(environment, "/app")
    host = tmp_path / "host"

    async def scenario() -> dict[str, Any]:
        before = await bridge.download(host)
        (host / "keep.txt").write_text("edited", encoding="utf-8")
        (host / "new.txt").write_text("new", encoding="utf-8")
        (host / "remove.txt").unlink()
        return await bridge.upload(host, before)

    summary = asyncio.run(scenario())

    assert (container / "keep.txt").read_text(encoding="utf-8") == "edited"
    assert (container / "new.txt").read_text(encoding="utf-8") == "new"
    assert not (container / "remove.txt").exists(), "a deletion must reach the container"
    assert summary["files_deleted"] == ["remove.txt"]
    assert "new.txt" in summary["files_changed"]
    assert environment.execs == ["rm -f -- '/app/remove.txt'"]


# ──────────────────────────── the agent shim ──────────────────────────────


class _FakeHarness:
    """A TerminusHarness stand-in that records what the shim asked for."""

    def __init__(self) -> None:
        self.request: RunRequest | None = None

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "version": "0.1.0"}

    def run(self, request: RunRequest, recorder: Any) -> HarnessResult:
        self.request = request
        (request.task_dir / "solution.txt").write_text("solved", encoding="utf-8")
        return HarnessResult(
            outcome=Outcome.COMPLETED,
            final_revision="abc",
            cost=None,
            artifacts=[],
            context_manifests=[],
            grader_outcomes=[],
            notes="{}",
            metrics={"steps": 3, "token_source": "budget_ledger"},
        )


def test_agent_runs_one_turn_and_writes_the_result_into_the_container(tmp_path: Path) -> None:
    container = tmp_path / "app"
    container.mkdir()
    (container / "broken.py").write_text("print(", encoding="utf-8")
    environment = _FakeEnvironment(container)
    harness = _FakeHarness()
    logs_dir = tmp_path / "logs"

    agent = TerminusHarborAgent(
        logs_dir=logs_dir,
        model_name="gpt-5.6",
        harness_factory=lambda: harness,
        extra_env={"TERMINUS_CONTROL_URL": "http://127.0.0.1:3050"},
    )

    asyncio.run(agent.setup(environment))
    asyncio.run(agent.run("Fix the syntax error in broken.py", environment, None))

    # Harbor's tests grade the container, so the work has to land there.
    assert (container / "solution.txt").read_text(encoding="utf-8") == "solved"
    # The instruction rides the request, never a prompt.md written into the
    # very tree the benchmark's own tests inspect.
    assert harness.request is not None
    assert harness.request.instruction == (
        "Fix the syntax error in broken.py\n\n"
        "Harbor workspace mapping: /app is the current Terminus workspace root. "
        "Use workspace-relative paths (for example, /app/file.txt is file.txt). "
        "Do not access the host path named in this note."
    )
    assert not (container / "prompt.md").exists()

    summary = json.loads((logs_dir / "terminus-agent.json").read_text(encoding="utf-8"))
    assert summary["outcome"] == "completed"
    assert summary["metrics"]["steps"] == 3
    assert summary["container_workdir"] == "/app"


def test_agent_setup_fails_closed_when_the_control_plane_is_silent(tmp_path: Path) -> None:
    class _DeadHarness(_FakeHarness):
        def health(self) -> Any:
            return None

    agent = TerminusHarborAgent(
        logs_dir=tmp_path / "logs",
        harness_factory=_DeadHarness,
    )
    with pytest.raises(RuntimeError, match="system/health"):
        asyncio.run(agent.setup(_FakeEnvironment(tmp_path)))


def test_agent_declares_the_name_harbor_will_show() -> None:
    assert TerminusHarborAgent.name() == "terminus"
    module, _, cls = TERMINUS_HARBOR_AGENT_IMPORT_PATH.partition(":")
    assert module == "forge_evals.runners.harbor_agent"
    assert cls == "TerminusHarborAgent"


# ──────────────────────────── the harbor runner ───────────────────────────


def _request(tmp_path: Path) -> RunRequest:
    task_dir = tmp_path / "task"
    task_dir.mkdir(exist_ok=True)
    return RunRequest(
        suite="terminal-bench",
        task="chess-best-move",
        task_dir=task_dir,
        harness_id="terminus-live",
        harness_commit="c" * 40,
        model_snapshot=ModelCapabilitySnapshot(
            provider="chatgpt",
            model="gpt-5.6",
            api_version="2026-08",
            context_window=200_000,
            max_output_tokens=8_192,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
        ),
        random_seed=1,
        budgets=Budgets(),
    )


def test_build_harbor_argv_substitutes_the_agent_import_path(tmp_path: Path) -> None:
    argv = build_harbor_argv(
        ("harbor", "run", "--dataset", "terminal-bench/terminal-bench-2@2.0", "--agent", "terminus-live"),
        agent_import_path=TERMINUS_HARBOR_AGENT_IMPORT_PATH,
        agent_env={"TERMINUS_CONTROL_URL": "http://x", "TERMINUS_CONTROL_TOKEN": "tok"},
        jobs_dir=tmp_path / "jobs",
    )
    assert argv[argv.index("--agent") + 1] == TERMINUS_HARBOR_AGENT_IMPORT_PATH
    assert "--jobs-dir" in argv
    assert argv.count("--ae") == 2
    assert "TERMINUS_CONTROL_TOKEN=tok" in argv


def test_collect_trial_results_reads_harbors_result_json(tmp_path: Path) -> None:
    trial = tmp_path / "job-1" / "chess-best-move__abc"
    trial.mkdir(parents=True)
    (trial / "result.json").write_text(
        json.dumps(
            {
                "task_name": "terminal-bench/chess-best-move",
                "task_checksum": "sha256:deadbeef",
                "agent_info": {"name": "terminus", "version": "0.1.0", "model_info": {"name": "gpt-5.6"}},
                "verifier_result": {"rewards": {"reward": 1.0}},
            }
        ),
        encoding="utf-8",
    )
    outcomes = collect_trial_results(tmp_path)
    assert len(outcomes) == 1
    assert outcomes[0].task_name == "terminal-bench/chess-best-move"
    assert outcomes[0].passed is True
    assert outcomes[0].score == 1.0


def test_collect_trial_results_ignores_harbors_job_summary(tmp_path: Path) -> None:
    job = tmp_path / "job-1"
    trial = job / "chess-best-move__abc"
    trial.mkdir(parents=True)
    (job / "result.json").write_text(
        json.dumps({"n_total_trials": 1, "stats": {"mean": 1.0}}),
        encoding="utf-8",
    )
    (trial / "result.json").write_text(
        json.dumps(
            {
                "task_name": "terminal-bench/chess-best-move",
                "task_checksum": "sha256:deadbeef",
                "agent_info": {"name": "terminus"},
                "verifier_result": {"rewards": {"reward": 1.0}},
            }
        ),
        encoding="utf-8",
    )

    outcomes = collect_trial_results(tmp_path)

    assert len(outcomes) == 1
    assert outcomes[0].results_path == trial / "result.json"


def test_partial_reward_is_not_a_pass(tmp_path: Path) -> None:
    trial = tmp_path / "trial"
    trial.mkdir()
    (trial / "result.json").write_text(
        json.dumps({"task_name": "t", "verifier_result": {"rewards": {"reward": 0.5}}}),
        encoding="utf-8",
    )
    outcome = collect_trial_results(tmp_path)[0]
    assert outcome.score == 0.5
    assert outcome.passed is False


def _fake_harbor(bin_dir: Path, *, reward: float) -> None:
    """Write a `harbor` executable that emulates the parts the runner uses."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / "harbor"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys, pathlib\n"
        "argv = sys.argv[1:]\n"
        "if '--version' in argv:\n"
        "    print('harbor 0.22.0'); sys.exit(0)\n"
        "jobs = pathlib.Path(argv[argv.index('--jobs-dir') + 1])\n"
        "task = argv[argv.index('--include-task-name') + 1]\n"
        "trial = jobs / 'job-1' / task\n"
        "trial.mkdir(parents=True, exist_ok=True)\n"
        "(trial / 'invocation.json').write_text(json.dumps(argv))\n"
        "(trial / 'result.json').write_text(json.dumps({\n"
        "    'task_name': 'terminal-bench/' + task,\n"
        "    'task_checksum': 'sha256:' + 'c' * 64,\n"
        "    'agent_info': {'name': 'terminus', 'version': '0.1.0'},\n"
        f"    'verifier_result': {{'rewards': {{'reward': {reward}}}}},\n"
        "}))\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def test_run_harbor_tasks_records_harbors_verdict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bin_dir = tmp_path / "bin"
    _fake_harbor(bin_dir, reward=1.0)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    record = run_harbor_tasks(
        manifest_path=SUITES_DIR / "terminal-bench.yaml",
        request=_request(tmp_path),
        seed=7,
        agent_import_path=TERMINUS_HARBOR_AGENT_IMPORT_PATH,
        agent_env={"TERMINUS_CONTROL_URL": "http://127.0.0.1:3050", "TERMINUS_CONTROL_TOKEN": "s3cret"},
        jobs_dir=tmp_path / "jobs",
    )

    assert record.outcome is Outcome.COMPLETED
    assert record.success is True
    assert record.grader_results[0].grader_id.endswith("terminal-bench/terminal-bench-2@2.0")
    assert record.environment_digest.startswith("sha256:")
    assert record.model_capability_snapshot["harbor_version"] == "harbor 0.22.0"
    assert record.end > record.start

    # The pinned dataset and the Terminus agent actually reached Harbor.
    invocation = json.loads(
        (tmp_path / "jobs" / "job-1" / "chess-best-move" / "invocation.json").read_text()
    )
    assert "terminal-bench/terminal-bench-2@2.0" in invocation
    assert TERMINUS_HARBOR_AGENT_IMPORT_PATH in invocation
    assert "TERMINUS_CONTROL_URL=http://127.0.0.1:3050" in invocation

    # The token must not be echoed into the durable record.
    argv_artifact = next(a for a in record.artifacts if a.get("kind") == "benchmark_adapter_manifest")
    assert "TERMINUS_CONTROL_TOKEN=***" in argv_artifact["argv"]
    assert "s3cret" not in json.dumps(argv_artifact)

    # The unresolved image digest is reported, not invented.
    digest_note = next(a for a in record.artifacts if a.get("kind") == "resolved_image_digest")
    assert digest_note["status"] == "unreported_by_harbor"


def test_run_harbor_tasks_records_a_failing_reward(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bin_dir = tmp_path / "bin"
    _fake_harbor(bin_dir, reward=0.0)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    record = run_harbor_tasks(
        manifest_path=SUITES_DIR / "terminal-bench.yaml",
        request=_request(tmp_path),
        seed=7,
        agent_import_path=TERMINUS_HARBOR_AGENT_IMPORT_PATH,
        agent_env={"TERMINUS_CONTROL_URL": "http://127.0.0.1:3050"},
        jobs_dir=tmp_path / "jobs",
    )
    assert record.success is False
    assert record.grader_results[0].score == 0.0


def test_missing_harbor_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", str(tmp_path / "empty-bin"))
    with pytest.raises(HarborUnavailable, match="not on PATH"):
        run_harbor_tasks(
            manifest_path=SUITES_DIR / "terminal-bench.yaml",
            request=_request(tmp_path),
            seed=1,
            agent_import_path=TERMINUS_HARBOR_AGENT_IMPORT_PATH,
            agent_env={},
            jobs_dir=tmp_path / "jobs",
        )


def test_cli_routes_terminal_bench_to_harbor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--suite terminal-bench` must reach the Harbor adapter, not the task path."""
    from forge_evals.cli import main

    bin_dir = tmp_path / "bin"
    _fake_harbor(bin_dir, reward=1.0)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("TERMINUS_CONTROL_URL", "http://127.0.0.1:3050")
    monkeypatch.setenv("TERMINUS_CONTROL_TOKEN", "tok")
    task_dir = tmp_path / "task"
    task_dir.mkdir()
    output_dir = tmp_path / "results"

    exit_code = main(
        [
            "run",
            "--suite",
            "terminal-bench",
            "--task",
            "chess-best-move",
            "--task-dir",
            str(task_dir),
            "--harness",
            "terminus-live",
            "--harness-commit",
            "c" * 40,
            "--model",
            "gpt-5.6",
            "--output-dir",
            str(output_dir),
        ]
    )
    assert exit_code == 0
    assert "harbor run 1/1" in capsys.readouterr().out
    payload = json.loads((output_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    assert payload["suite"] == "terminal-bench"
    assert payload["grader_results"][0]["passed"] is True
