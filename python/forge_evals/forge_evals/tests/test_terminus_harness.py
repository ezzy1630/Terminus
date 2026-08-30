"""Tests for the live Terminus harness adapter (deep-audit PR8)."""

from __future__ import annotations

import json
import threading
from collections.abc import Generator, Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, ClassVar

import pytest

from forge_evals.evidence import has_complete_provider_receipt
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
    provider_receipts_from_route,
)
from forge_evals.runners.trajectory_recorder import TrajectoryRecorder


class _StubControlPlane(BaseHTTPRequestHandler):
    """Minimal stand-in for terminus-control covering the adapter's calls."""

    attempt_rows: ClassVar[list[Any] | None] = None
    repair_attempts: ClassVar[list[Any]] = []
    repair_turn_attempts: ClassVar[dict[str, list[Any] | None]] = {}

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
        if self.path == "/v1/workspaces/open":
            body = self._read_body()
            assert body["root_uri"].startswith("file:")
            self._json(201, {"id": "ws-1", "kind": body.get("kind", "local_directory")})
        elif self.path == "/v1/sessions":
            self._json(201, {"id": "sess-1", "active_thread_id": "thread-1"})
        elif self.path == "/v1/tasks":
            assert self.headers.get("authorization") == "Bearer test-token"
            body = self._read_body()
            assert isinstance(body.get("session_id"), str)
            assert isinstance(body.get("thread_id"), str)
            assert isinstance(body.get("objective"), str) and body["objective"]
            self._json(201, {"id": "task-1", "status": "DRAFT"})
        elif self.path == "/v1/tasks/task-1/start":
            self._json(200, {"id": "task-1", "status": "ACTIVE"})
        elif self.path == "/v1/turns":
            body = self._read_body()
            assert body["thread_id"] == "thread-1"
            assert body["task_id"] == "task-1"
            assert isinstance(body["user_input"], str) and body["user_input"]
            self._json(201, {"id": "turn-1", "state": "PROVIDER_RUNNING"})
        else:
            self._json(404, {"error": "not found"})

    def do_PATCH(self) -> None:
        if self.path == "/v1/sessions/sess-1":
            body = self._read_body()
            self._json(200, {"id": "sess-1", **body})
        else:
            self._json(404, {"error": "not found"})

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        decoded: Any = json.loads(self.rfile.read(length).decode())
        assert isinstance(decoded, dict)
        return decoded

    def do_GET(self) -> None:
        if self.path == "/v1/turns/turn-1" or (
            self.path.startswith("/v1/turns/")
            and not self.path.endswith("/attempts")
            and self.path.split("/")[3] in self.repair_turn_attempts
        ):
            self._json(200, {"state": "COMPLETED"})
        elif self.path.startswith("/v1/turns/") and self.path.endswith("/attempts"):
            turn_id = self.path.split("/")[3]
            rows = (
                self.attempt_rows if turn_id == "turn-1" else self.repair_turn_attempts.get(turn_id)
            )
            if rows is None:
                self._json(404, {"error": "not found"})
            else:
                payload = json.dumps(rows).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        elif self.path == "/v1/tasks/task-1":
            self._json(200, {"repair_attempts": self.repair_attempts})
        elif self.path.startswith("/v1/tasks/task-1/artifacts"):
            assert self.path.endswith("limit=100")
            self._json(
                200,
                {
                    "artifacts": [
                        {"purpose": "context-epoch-baseline", "hash": "sha256:" + "a" * 64},
                        {"purpose": "verification-repair-directive", "hash": "sha256:" + "b" * 64},
                    ]
                },
            )
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


def test_wait_follows_repair_continuation_instead_of_dead_parent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = TerminusHarness(
        TerminusHarnessConfig(base_url="http://unused", token=None, poll_interval_seconds=0.0)
    )
    task_reads: Iterator[dict[str, Any]] = iter(
        [
            {
                "status": "ACTIVE",
                "active_turn": {"id": "repair-1"},
                "repair_attempts": [{"repair_turn_id": "repair-1"}],
            },
            {
                "status": "ACTIVE",
                "active_turn": None,
                "repair_attempts": [{"repair_turn_id": "repair-1"}],
            },
        ]
    )
    repair_reads = iter([{"state": "PROVIDER_RUNNING"}, {"state": "COMPLETED"}])

    def fake_request(method: str, path: str, body: object = None) -> dict[str, Any]:
        del body
        assert method == "GET"
        if path == "/v1/tasks/task-1":
            return next(task_reads)
        if path == "/v1/turns/repair-1":
            return next(repair_reads)
        raise AssertionError(f"wait polled stale or unexpected route: {path}")

    monkeypatch.setattr(harness, "_request", fake_request)
    assert harness._await_terminal("proposal-1", task_id="task-1") == "COMPLETED"


def test_wait_does_not_complete_active_task_after_proposal_turn_settles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = TerminusHarness(
        TerminusHarnessConfig(base_url="http://unused", token=None, poll_interval_seconds=0.0)
    )
    task_reads: Iterator[dict[str, Any]] = iter(
        [
            {"status": "ACTIVE", "active_turn": {"id": "proposal-1"}},
            {"status": "ACTIVE", "active_turn": None},
        ]
    )
    turn_reads = iter([{"state": "COMPLETED"}, {"state": "COMPLETED"}])

    def fake_request(method: str, path: str, body: object = None) -> dict[str, Any]:
        del body
        assert method == "GET"
        if path == "/v1/tasks/task-1":
            return next(task_reads)
        if path == "/v1/turns/proposal-1":
            return next(turn_reads)
        raise AssertionError(f"wait polled stale or unexpected route: {path}")

    monkeypatch.setattr(harness, "_request", fake_request)
    state = harness._await_terminal("proposal-1", task_id="task-1")

    assert state == "TASK_PENDING"
    assert TerminusHarness._map_outcome(state) is Outcome.ERROR


def test_wait_preserves_cancellation_for_active_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = TerminusHarness(
        TerminusHarnessConfig(base_url="http://unused", token=None, poll_interval_seconds=0.0)
    )

    def fake_request(method: str, path: str, body: object = None) -> dict[str, Any]:
        del body
        assert method == "GET"
        if path == "/v1/tasks/task-1":
            return {"status": "ACTIVE", "active_turn": None}
        if path == "/v1/turns/proposal-1":
            return {"state": "ABORTED"}
        raise AssertionError(f"wait polled stale or unexpected route: {path}")

    monkeypatch.setattr(harness, "_request", fake_request)

    assert harness._await_terminal("proposal-1", task_id="task-1") == "ABORTED"


def test_wait_preserves_terminal_completed_task_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = TerminusHarness(
        TerminusHarnessConfig(base_url="http://unused", token=None, poll_interval_seconds=0.0)
    )

    def fake_request(method: str, path: str, body: object = None) -> dict[str, Any]:
        del body
        assert method == "GET"
        if path == "/v1/tasks/task-1":
            return {"status": "COMPLETED", "active_turn": None}
        raise AssertionError(f"terminal task should not poll turn route: {path}")

    monkeypatch.setattr(harness, "_request", fake_request)

    assert harness._await_terminal("proposal-1", task_id="task-1") == "COMPLETED"


def test_versioned_contract_admission_tightens_supported_limits_and_scope(
    tmp_path: Path,
) -> None:
    (tmp_path / "task.yaml").write_text(
        """id: focused/contract
risk_class: normal
budget:
  model_micros: 125000
  wall_clock_seconds: 9
allowed_scope:
  read_paths: [src/**]
  write_paths: [src/**]
  external_systems: [api.example.test]
non_goals: [Do not touch docs]
acceptance_criteria:
  - id: checked
    statement: The focused change is present.
    required: true
""",
        encoding="utf-8",
    )
    harness = TerminusHarness(TerminusHarnessConfig(base_url="http://unused", token=None))

    admission = harness._admit_contract(_run_request(tmp_path))
    assert admission.contract is not None
    assert admission.contract.risk_class == "normal"
    assert admission.contract.budgets.to_dict() == {
        "model_micros": 125000,
        "wall_clock_seconds": 9,
    }
    assert admission.allowed_scope == {
        "read_paths": ["src/**"],
        "write_paths": ["src/**"],
        "external_systems": ["api.example.test"],
    }
    assert admission.non_goals == ["Do not touch docs"]
    assert [criterion["id"] for criterion in admission.acceptance_criteria] == ["checked"]

    narrowed = harness._apply_contract_budgets(_run_request(tmp_path), admission.contract)
    assert narrowed.budgets.max_cost_usd == 0.125
    assert narrowed.budgets.max_wall_seconds == 9


def test_high_risk_contract_fails_closed_before_task_creation(tmp_path: Path) -> None:
    (tmp_path / "task.yaml").write_text(
        """id: security/rotate
risk_class: high
budget:
  model_micros: 100000
  human_approvals: 1
required_verification_nodes: [security_tests, detached_review, human_approval]
""",
        encoding="utf-8",
    )
    harness = TerminusHarness(TerminusHarnessConfig(base_url="http://unused", token=None))

    with pytest.raises(TerminusControlError, match="CONTRACT_ADMISSION_UNSUPPORTED"):
        harness._admit_contract(_run_request(tmp_path))


def test_contract_secret_capability_fails_closed_when_api_cannot_admit_it(tmp_path: Path) -> None:
    (tmp_path / "task.yaml").write_text(
        """id: focused/secret
risk_class: normal
secrets: [secret://broker/token]
required_verification_nodes: [security_tests, detached_review, human_approval]
""",
        encoding="utf-8",
    )
    harness = TerminusHarness(TerminusHarnessConfig(base_url="http://unused", token=None))

    with pytest.raises(TerminusControlError, match="secret capability admission"):
        harness._admit_contract(_run_request(tmp_path))


def test_aborted_turn_maps_to_cancelled() -> None:
    assert TerminusHarness._map_outcome("ABORTED") is Outcome.CANCELLED


def test_session_steering_fails_closed_when_defaults_are_not_applied(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    harness = TerminusHarness(TerminusHarnessConfig(base_url="http://unused", token=None))

    def reject_patch(method: str, path: str, body: object = None) -> dict[str, Any]:
        del path, body
        if method == "PATCH":
            raise TerminusControlError("session patch rejected")
        raise AssertionError(f"unexpected method: {method}")

    monkeypatch.setattr(harness, "_request", reject_patch)

    with pytest.raises(TerminusControlError, match="session patch rejected"):
        harness._apply_steering(
            _run_request(tmp_path),
            "sess-1",
            None,
            TrajectoryRecorder(run_id="steering-rejected"),
        )


def test_session_steering_rejects_lossy_read_back(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    harness = TerminusHarness(TerminusHarnessConfig(base_url="http://unused", token=None))
    monkeypatch.setattr(
        harness,
        "_request",
        lambda method, path, body=None: {"default_model": "different-model"},
    )

    with pytest.raises(TerminusControlError, match="read-back did not match"):
        harness._apply_steering(
            _run_request(tmp_path),
            "sess-1",
            None,
            TrajectoryRecorder(run_id="steering-lossy"),
        )


def test_live_run_completes_with_evidence(control_url: Path, tmp_path: Path) -> None:
    (tmp_path / "task.md").write_text("Fix the login bug.", encoding="utf-8")
    request = _run_request(tmp_path)
    recorder = TrajectoryRecorder(run_id="run-1")
    result = _harness(str(control_url)).run(request, recorder)
    assert result.outcome is Outcome.COMPLETED
    assert result.final_revision == "abc123"
    assert result.context_manifests == [
        {"purpose": "context-epoch-baseline", "hash": "sha256:" + "a" * 64},
    ]
    assert any(a.get("purpose") == "verification-repair-directive" for a in result.artifacts)
    notes = json.loads(result.notes)
    assert notes["harness"] == "terminus-live"
    assert notes["turn_id"] == "turn-1"
    assert result.provider_receipts == []


def _attempt_row(
    number: int = 1,
    *,
    provider_request_id: str | None = "provider-request-1",
) -> dict[str, Any]:
    return {
        "provider_attempt_id": f"attempt-{number}",
        "attempt_number": number,
        "model": "gpt-5.6",
        "provider_id": "acct-chatgpt",
        "status": "completed",
        "usage": {
            "input_tokens": "100",
            "cached_input_tokens": "20",
            "cache_write_tokens": "0",
            "output_tokens": "30",
            "reasoning_tokens": "5",
            "tool_schema_tokens": "10",
            "latency_ms": 120,
            "time_to_first_token_ms": 40,
        },
        "finish_reason": "stop",
        "provider_request_id": provider_request_id,
        "provider_reported_cost_micros": None,
        "computed_cost_micros": "1234",
        "cost_source": "free_model_contract",
        "started_at": "2026-08-29T12:00:00+00:00",
        "completed_at": "2026-08-29T12:00:01+00:00",
    }


def test_provider_receipts_project_every_immutable_attempt_field() -> None:
    rows = [_attempt_row(), _attempt_row(2, provider_request_id=None)]

    receipts = provider_receipts_from_route(rows)

    assert len(receipts) == 2
    first = receipts[0]
    assert has_complete_provider_receipt(first)
    assert first["receipt_id"] == "attempt-1"
    assert first["provider"] == "acct-chatgpt"
    assert first["model"] == "gpt-5.6"
    assert first["artifact_ref"] == "provider-request-1"
    assert first["verified"] is True
    assert first["provider_attempt_id"] == "attempt-1"
    assert first["provider_id"] == "acct-chatgpt"
    assert first["attempt_number"] == 1
    assert first["status"] == "completed"
    assert first["usage"]["cached_input_tokens"] == "20"
    assert first["provider_request_id"] == "provider-request-1"
    assert first["computed_cost_micros"] == "1234"
    assert first["started_at"] == "2026-08-29T12:00:00+00:00"
    # An attempt without a provider request id still has a durable Terminus
    # attempt identity. It is retained as an opaque reference, not dropped.
    assert receipts[1]["artifact_ref"] == "attempt-2"
    assert receipts[1]["provider_request_id"] is None


@pytest.mark.parametrize(
    "mutate",
    [
        lambda row: row.update(provider_attempt_id=""),
        lambda row: row.update(attempt_number="1"),
        lambda row: row.update(usage={}),
        lambda row: row.pop("provider_request_id"),
        lambda row: row.update(provider_request_id=123),
        lambda row: row.update(computed_cost_micros="not-a-decimal"),
        lambda row: row.update(started_at=None),
    ],
)
def test_provider_receipt_projection_fails_closed_on_malformed_rows(
    mutate: Any,
) -> None:
    row = _attempt_row()
    mutate(row)

    assert provider_receipts_from_route([row]) == []


def test_provider_receipt_projection_fails_closed_on_partial_or_reordered_rows() -> None:
    valid = _attempt_row()
    malformed = {"provider_attempt_id": "missing-the-rest"}

    assert provider_receipts_from_route([valid, malformed]) == []
    assert provider_receipts_from_route([_attempt_row(2), _attempt_row(1)]) == []
    assert provider_receipts_from_route(None) == []


class _ReceiptStubControlPlane(_StubControlPlane):
    attempt_rows: ClassVar[list[dict[str, Any]]] = [
        _attempt_row(),
        _attempt_row(2, provider_request_id=None),
    ]


class _RepairReceiptStubControlPlane(_StubControlPlane):
    attempt_rows: ClassVar[list[dict[str, Any]]] = [_attempt_row()]
    repair_attempts: ClassVar[list[dict[str, Any]]] = [
        {
            "id": "repair-1",
            "parent_turn_id": "turn-1",
            "repair_turn_id": "turn-repair-1",
            "attempt_number": 1,
        },
        {
            "id": "repair-2",
            "parent_turn_id": "turn-repair-1",
            "repair_turn_id": "turn-repair-2",
            "attempt_number": 2,
        },
    ]
    repair_turn_attempts: ClassVar[dict[str, list[Any] | None]] = {
        "turn-repair-1": [
            {**_attempt_row(), "provider_attempt_id": "repair-1-attempt-1"},
            {**_attempt_row(2), "provider_attempt_id": "repair-1-attempt-2"},
        ],
        "turn-repair-2": [
            {**_attempt_row(), "provider_attempt_id": "repair-2-attempt-1"},
        ],
    }


@pytest.fixture()
def receipt_control_url() -> Generator[str, None, None]:
    server = HTTPServer(("127.0.0.1", 0), _ReceiptStubControlPlane)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    thread.join()


@pytest.fixture()
def repair_receipt_control_url() -> Generator[str, None, None]:
    server = HTTPServer(("127.0.0.1", 0), _RepairReceiptStubControlPlane)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    thread.join()


def test_live_run_projects_attempts_into_provider_receipts(
    receipt_control_url: str,
    tmp_path: Path,
) -> None:
    (tmp_path / "task.md").write_text("Fix the login bug.", encoding="utf-8")

    result = _harness(receipt_control_url).run(
        _run_request(tmp_path),
        TrajectoryRecorder(run_id="run-receipts"),
    )

    assert len(result.provider_receipts) == 2
    assert all(has_complete_provider_receipt(receipt) for receipt in result.provider_receipts)
    assert result.provider_receipts[0]["receipt_id"] == "attempt-1"
    assert result.provider_receipts[1]["artifact_ref"] == "attempt-2"
    assert result.metrics["provider_receipts_complete"] is True
    receipt_artifact = next(
        artifact for artifact in result.artifacts if artifact.get("kind") == "provider_receipts"
    )
    assert receipt_artifact["status"] == "complete"


def test_live_run_includes_original_and_ordered_repair_turn_receipts(
    repair_receipt_control_url: str,
    tmp_path: Path,
) -> None:
    (tmp_path / "task.md").write_text("Fix the login bug.", encoding="utf-8")

    result = _harness(repair_receipt_control_url).run(
        _run_request(tmp_path),
        TrajectoryRecorder(run_id="run-repair-receipts"),
    )

    assert [receipt["receipt_id"] for receipt in result.provider_receipts] == [
        "attempt-1",
        "repair-1-attempt-1",
        "repair-1-attempt-2",
        "repair-2-attempt-1",
    ]
    assert [receipt["turn_id"] for receipt in result.provider_receipts] == [
        "turn-1",
        "turn-repair-1",
        "turn-repair-1",
        "turn-repair-2",
    ]
    receipt_artifact = next(
        artifact for artifact in result.artifacts if artifact.get("kind") == "provider_receipts"
    )
    assert receipt_artifact["turn_ids"] == [
        "turn-1",
        "turn-repair-1",
        "turn-repair-2",
    ]
    assert receipt_artifact["status"] == "complete"


@pytest.mark.parametrize(
    ("repair_attempts", "repair_rows", "expected_status"),
    [
        (None, {}, "malformed"),
        (
            [{"attempt_number": 1, "parent_turn_id": "turn-1", "repair_turn_id": None}],
            {},
            "malformed",
        ),
        (
            [
                {
                    "attempt_number": 2,
                    "parent_turn_id": "turn-1",
                    "repair_turn_id": "turn-repair-1",
                }
            ],
            {"turn-repair-1": [_attempt_row()]},
            "malformed",
        ),
        (
            [
                {
                    "attempt_number": 1,
                    "parent_turn_id": "turn-1",
                    "repair_turn_id": "turn-repair-1",
                }
            ],
            {},
            "unavailable",
        ),
        (
            [
                {
                    "attempt_number": 1,
                    "parent_turn_id": "turn-1",
                    "repair_turn_id": "turn-repair-1",
                }
            ],
            {"turn-repair-1": []},
            "missing",
        ),
        (
            [
                {
                    "attempt_number": 1,
                    "parent_turn_id": "turn-1",
                    "repair_turn_id": "turn-repair-1",
                }
            ],
            {"turn-repair-1": [{"provider_attempt_id": "incomplete"}]},
            "malformed",
        ),
    ],
)
def test_repair_receipt_collection_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    repair_attempts: Any,
    repair_rows: dict[str, list[Any] | None],
    expected_status: str,
) -> None:
    harness = _harness("http://unused.invalid")
    monkeypatch.setattr(
        harness,
        "_optional_list",
        lambda _method, path: repair_rows.get(path.split("/")[3]),
    )

    receipts, status, _turn_ids = harness._collect_provider_receipts(
        original_turn_id="turn-1",
        original_turn_attempts=[_attempt_row()],
        task_detail={"repair_attempts": repair_attempts},
    )

    assert receipts == []
    assert status == expected_status


def test_repair_receipt_collection_requires_task_repair_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _harness("http://unused.invalid")

    def unexpected_attempt_fetch(_method: str, _path: str) -> None:
        pytest.fail("missing task repair projection must fail before route fetches")

    monkeypatch.setattr(harness, "_optional_list", unexpected_attempt_fetch)

    receipts, status, turn_ids = harness._collect_provider_receipts(
        original_turn_id="turn-1",
        original_turn_attempts=[_attempt_row()],
        task_detail={},
    )

    assert receipts == []
    assert status == "unavailable"
    assert turn_ids == ["turn-1"]


def test_missing_control_url_fails_closed() -> None:
    import os

    saved = os.environ.pop("TERMINUS_CONTROL_URL", None)
    try:
        with pytest.raises(TerminusControlError):
            TerminusHarness.from_env()
    finally:
        if saved is not None:
            os.environ["TERMINUS_CONTROL_URL"] = saved
