"""Tests for the live Terminus harness adapter (deep-audit PR8)."""

from __future__ import annotations

import json
import threading
from collections.abc import Generator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from forge_evals.run_record import Outcome
from forge_evals.runners.harness_runner import (
    Budgets,
    ModelCapabilitySnapshot,
    RunRequest,
)
from forge_evals.runners.terminus_harness import (
    TerminusControlError,
    TerminusHarness,
    TerminusHarnessConfig,
)
from forge_evals.runners.trajectory_recorder import TrajectoryRecorder


class _StubControlPlane(BaseHTTPRequestHandler):
    """Minimal stand-in for terminus-control covering the adapter's calls."""

    def log_message(self, *args: object) -> None:  # silence test output
        return

    def _json(self, code: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        if self.path == "/v1/workspaces":
            self._json(201, {"id": "ws-1"})
        elif self.path == "/v1/tasks":
            assert self.headers.get("authorization") == "Bearer test-token"
            self._json(201, {"id": "task-1"})
        elif self.path == "/v1/turns":
            self._json(201, {"id": "turn-1"})
        else:
            self._json(404, {"error": "not found"})

    def do_GET(self) -> None:
        if self.path == "/v1/turns/turn-1":
            self._json(200, {"state": "COMPLETED"})
        elif self.path == "/v1/turns/turn-1/context-manifests":
            self._json(200, {"manifests": [{"id": "m-1", "fragments": 7}]})
        elif self.path == "/v1/tasks/task-1/verification/results":
            self._json(200, {"results": [{"node_id": "n1", "status": "pass"}]})
        elif self.path == "/v1/workspaces/ws-1/revision":
            self._json(200, {"revision": "abc123"})
        else:
            self._json(404, {"error": "not found"})


@pytest.fixture()
def control_url(tmp_path: Path) -> Generator[str, None, None]:
    server = HTTPServer(("127.0.0.1", 0), _StubControlPlane)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    thread.join()


def _run_request(task_dir: Path) -> RunRequest:
    return RunRequest(
        suite="focused_hidden_repair",
        task="repair_login_bug",
        task_dir=task_dir,
        harness_id="terminus-live",
        harness_commit="b6d5b22",
        model_snapshot=ModelCapabilitySnapshot(
            provider="openai",
            model="gpt-4o",
            api_version="2024-10-21",
            context_window=128_000,
            max_output_tokens=16_384,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
        ),
        random_seed=42,
        budgets=Budgets(),
    )


def _harness(url: str) -> TerminusHarness:
    return TerminusHarness(
        TerminusHarnessConfig(base_url=url, token="test-token", poll_interval_seconds=0.01)
    )


def test_live_run_completes_with_evidence(control_url: Path, tmp_path: Path) -> None:
    (tmp_path / "task.md").write_text("Fix the login bug.", encoding="utf-8")
    request = _run_request(tmp_path)
    recorder = TrajectoryRecorder(run_id="run-1")
    result = _harness(str(control_url)).run(request, recorder)
    assert result.outcome is Outcome.COMPLETED
    assert result.final_revision == "abc123"
    assert result.context_manifests == [{"id": "m-1", "fragments": 7}]
    assert any(a.get("node_id") == "n1" for a in result.artifacts)
    notes = json.loads(result.notes)
    assert notes["harness"] == "terminus-live"
    assert notes["turn_id"] == "turn-1"


def test_missing_control_url_fails_closed() -> None:
    import os

    saved = os.environ.pop("TERMINUS_CONTROL_URL", None)
    try:
        with pytest.raises(TerminusControlError):
            TerminusHarness.from_env()
    finally:
        if saved is not None:
            os.environ["TERMINUS_CONTROL_URL"] = saved
