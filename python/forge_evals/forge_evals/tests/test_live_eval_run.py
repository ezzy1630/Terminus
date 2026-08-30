"""End-to-end shape of one live eval run against a fake control plane.

Covers the four things the audit found missing from a live record: a verdict,
a cost, honoured steering, and a real environment digest.
"""

from __future__ import annotations

import json
import subprocess
import threading
from collections.abc import Generator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
import yaml

from forge_evals.cli import build_live_run_record, main
from forge_evals.run_record import GraderResult, Outcome, RunRecord
from forge_evals.runners.harness_runner import Budgets, ModelCapabilitySnapshot, RunRequest
from forge_evals.runners.live_runner import (
    LiveRunError,
    materialize_task_workspace,
    workspace_diff,
)
from forge_evals.runners.terminus_harness import (
    TerminusHarness,
    TerminusHarnessConfig,
)
from forge_evals.runners.trajectory_recorder import TrajectoryRecorder

RECEIVED: dict[str, Any] = {}


def _transcript_events() -> list[dict[str, Any]]:
    def event(name: str, data: dict[str, Any], at: str) -> dict[str, Any]:
        return {"id": f"ev-{name}", "event": name, "data": json.dumps(data), "occurred_at": at}

    usage_1 = {
        "inputTokens": "1000",
        "cachedInputTokens": "0",
        "cacheWriteTokens": "0",
        "outputTokens": "200",
        "reasoningTokens": "50",
        "toolSchemaTokens": "40",
        "latencyMs": 1200,
        "timeToFirstTokenMs": 640,
    }
    usage_2 = {
        **usage_1,
        "inputTokens": "4000",
        "cachedInputTokens": "3000",
        "outputTokens": "300",
        "timeToFirstTokenMs": 410,
    }
    return [
        event(
            "turn.started", {"thread_id": "thread-1", "sequence": 1}, "2026-08-29T12:00:00+00:00"
        ),
        event("turn.provider_running", {"provider_attempt_id": "a-1"}, "2026-08-29T12:00:01+00:00"),
        event("turn.provider_text_delta", {"text": "Reading"}, "2026-08-29T12:00:01.640000+00:00"),
        event(
            "turn.response_validating",
            {"provider_attempt_id": "a-1", "finish_reason": "tool_use", "usage": usage_1},
            "2026-08-29T12:00:03+00:00",
        ),
        event(
            "tool.proposed", {"tool_call_id": "c-1", "tool_id": "edit"}, "2026-08-29T12:00:04+00:00"
        ),
        event(
            "tool.settled",
            {"tool_call_id": "c-1", "status": "success"},
            "2026-08-29T12:00:05+00:00",
        ),
        event(
            "tool.proposed",
            {"tool_call_id": "c-2", "tool_id": "shell"},
            "2026-08-29T12:00:06+00:00",
        ),
        event(
            "tool.failed", {"tool_call_id": "c-2", "status": "error"}, "2026-08-29T12:00:07+00:00"
        ),
        event("turn.provider_running", {"provider_attempt_id": "a-2"}, "2026-08-29T12:00:08+00:00"),
        event(
            "turn.response_validating",
            {"provider_attempt_id": "a-2", "finish_reason": "stop", "usage": usage_2},
            "2026-08-29T12:00:10+00:00",
        ),
        event(
            "verification.node_passed",
            {"node_id": "n-parse", "criterion_id": "typo-fixed", "status": "pass"},
            "2026-08-29T12:00:11+00:00",
        ),
        event("verification.plan_completed", {"status": "all_passed"}, "2026-08-29T12:00:12+00:00"),
        event(
            "verification.admitted",
            {"plan_id": "plan-1", "phase": "VERIFIED"},
            "2026-08-29T12:00:13+00:00",
        ),
        event(
            "turn.completed", {"state": "COMPLETED", "summary": "done"}, "2026-08-29T12:00:14+00:00"
        ),
    ]


def _route_attempts() -> list[dict[str, Any]]:
    """`GET /v1/turns/:id/attempts` — BigInt token counts as decimal strings."""

    def attempt(n: int, usage: dict[str, Any], finish: str) -> dict[str, Any]:
        return {
            "provider_attempt_id": f"a-{n}",
            "attempt_number": n,
            "model": "gpt-5.6",
            "provider_id": "acct-chatgpt",
            "status": "SUCCEEDED",
            "usage": usage,
            "finish_reason": finish,
            "provider_request_id": f"req-{n}",
            "provider_reported_cost_micros": None,
            "computed_cost_micros": str(4_500 * n),
            "cost_source": "computed",
            "started_at": "2026-08-29T12:00:01+00:00",
            "completed_at": "2026-08-29T12:00:03+00:00",
        }

    return [
        attempt(
            1,
            {
                "input_tokens": "1000",
                "cached_input_tokens": "0",
                "cache_write_tokens": "0",
                "output_tokens": "200",
                "reasoning_tokens": "50",
                "tool_schema_tokens": "40",
                "latency_ms": 1200,
                "time_to_first_token_ms": 640,
            },
            "tool_use",
        ),
        attempt(
            2,
            {
                "input_tokens": "4000",
                "cached_input_tokens": "3000",
                "cache_write_tokens": "0",
                "output_tokens": "300",
                "reasoning_tokens": "50",
                "tool_schema_tokens": "40",
                "latency_ms": 1200,
                "time_to_first_token_ms": 410,
            },
            "stop",
        ),
    ]


class _ControlPlane(BaseHTTPRequestHandler):
    """A stand-in for terminus-control covering every route the harness calls."""

    # A control plane older than Phase 0-F2 has no per-turn usage routes and
    # drops an unknown `budget` key instead of enforcing it.
    serve_turn_routes: bool = True

    def log_message(self, *args: object) -> None:
        return

    def _json(self, code: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        decoded: Any = json.loads(self.rfile.read(length).decode()) if length else {}
        assert isinstance(decoded, dict)
        return decoded

    def _require_idempotency_key(self) -> bool:
        """Mirror the real control plane: every mutating request needs the header."""
        key = self.headers.get("Idempotency-Key", "")
        if not key or len(key) > 255:
            self._json(
                400,
                {
                    "error": {
                        "code": "IDEMPOTENCY_KEY_REQUIRED",
                        "message": "mutating requests require a non-empty Idempotency-Key",
                    }
                },
            )
            return False
        return True

    def do_POST(self) -> None:
        if not self._require_idempotency_key():
            return
        if self.path == "/v1/workspaces/open":
            body = self._read_body()
            assert body["root_uri"].startswith("file:")
            self._json(201, {"id": "ws-1", "kind": body.get("kind", "local_directory")})
        elif self.path == "/v1/sessions":
            self._json(201, {"id": "sess-1", "active_thread_id": "thread-1"})
        elif self.path == "/v1/tasks":
            RECEIVED["task_body"] = self._read_body()
            self._json(201, {"id": "task-1", "status": "DRAFT"})
        elif self.path == "/v1/tasks/task-1/start":
            self._json(200, {"task_id": "task-1", "status": "ACTIVE", "event_cursor": "ev-0"})
        elif self.path == "/v1/turns":
            RECEIVED["turn_body"] = body = self._read_body()
            unknown = sorted(
                set(body)
                - {
                    "thread_id",
                    "task_id",
                    "user_input",
                    "model",
                    "reasoning_effort",
                    "provider_account_id",
                    "budget",
                }
            )
            if unknown:
                return self._json(400, {"code": "TURN_INPUT_UNKNOWN_FIELDS", "unknown": unknown})
            self._json(
                201,
                {
                    "id": "turn-1",
                    "state": "PROVIDER_RUNNING",
                    "model": body.get("model"),
                    "reasoning_effort": body.get("reasoning_effort"),
                    "selected_provider_account_id": body.get("provider_account_id"),
                    **(
                        {"budget": body.get("budget")}
                        if self.serve_turn_routes and body.get("budget")
                        else {}
                    ),
                },
            )
        else:
            self._json(404, {"error": "not found"})

    def do_PATCH(self) -> None:
        if not self._require_idempotency_key():
            return
        if self.path == "/v1/sessions/sess-1":
            RECEIVED["session_patch"] = body = self._read_body()
            self._json(200, {"id": "sess-1", **body})
        else:
            self._json(404, {"error": "not found"})

    def do_GET(self) -> None:
        if self.path == "/v1/system/health":
            self._json(
                200,
                {
                    "status": "ok",
                    "version": "0.1.0",
                    "build_commit": "c2cd9d5",
                    "instance_id": "nonce-per-restart",
                    "kernel": {
                        "state": "READY",
                        "degradations": [],
                        "version": "0.4.2",
                        "build_digest": "sha256:" + "k" * 64,
                    },
                },
            )
        elif self.path == "/v1/provider-models":
            self._json(
                200,
                {
                    "providers": [
                        {
                            "id": "acct-chatgpt",
                            "label": "ChatGPT Codex",
                            "source": "chatgpt_oauth",
                            "billing": "subscription",
                            "available": True,
                        }
                    ],
                    "models": [
                        {
                            "id": "gpt-5.6",
                            "provider": "acct-chatgpt",
                            "billing": "subscription",
                            # Subscription billing has no per-token rate, and
                            # says so rather than omitting the fields.
                            "pricing": None,
                            "pricing_source": "subscription",
                        }
                    ],
                    "rejected": [],
                    "observed_at": "2026-08-29T11:00:00Z",
                    "error": None,
                },
            )
        elif self.path == "/v1/provider-accounts":
            self._json(
                200,
                {
                    "accounts": [
                        {
                            "id": "acct-chatgpt",
                            "status": "connected",
                            "billing": "subscription",
                            "is_default": True,
                        }
                    ],
                    "discovery": {"last_run_at": None, "installed_tools": [], "warnings": []},
                },
            )
        elif self.path.startswith("/v1/sandbox/report"):
            self._json(
                200,
                {
                    "backend_id": "seatbelt",
                    "status": "enforced",
                    "profile_id": "secure-local-default",
                },
            )
        elif self.path == "/v1/turns/turn-1":
            if not self.serve_turn_routes:
                return self._json(200, {"id": "turn-1", "state": "COMPLETED"})
            self._json(
                200,
                {
                    "id": "turn-1",
                    "state": "COMPLETED",
                    "budget": RECEIVED.get("turn_body", {}).get("budget"),
                    "usage": {
                        "input_tokens": "5000",
                        "cached_input_tokens": "3000",
                        "cache_write_tokens": "0",
                        "output_tokens": "500",
                        "reasoning_tokens": "100",
                        "tool_schema_tokens": "80",
                        "latency_ms": 2400,
                        "time_to_first_token_ms": 640,
                    },
                    "cost_micros": "9000",
                    "stop_reason": "stop",
                    "terminal_error": None,
                },
            )
        elif self.path == "/v1/turns/turn-1/attempts":
            if not self.serve_turn_routes:
                return self._json(404, {"error": "not found"})
            payload = json.dumps(_route_attempts()).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/v1/tasks/task-1":
            self._json(
                200,
                {
                    "id": "task-1",
                    "status": "COMPLETED",
                    "budget_ledger": {
                        "steps_used": "2",
                        "max_steps": "24",
                        "input_tokens": "5000",
                        "cached_input_tokens": "3000",
                        "cache_write_tokens": "0",
                        "output_tokens": "500",
                        "reasoning_tokens": "100",
                        "tool_schema_tokens": "80",
                        "cost_micros": "9000",
                    },
                    "repair_metrics": {"repair_attempts": 0, "stop_reason": None},
                    "contract": {
                        "version": 1,
                        "content_hash": "sha256:" + "c" * 64,
                        "objective": "Fix the typo in src/lib.py.",
                        "non_goals": [],
                        "acceptance_criteria": [
                            {
                                "id": "typo-fixed",
                                "statement": "recieve becomes receive",
                                "verification_hint": None,
                                "required": True,
                                "status": "SATISFIED",
                            }
                        ],
                        "allowed_scope": {
                            "read_paths": ["**"],
                            "write_paths": ["**"],
                            "external_systems": [],
                        },
                    },
                },
            )
        elif self.path.startswith("/v1/tasks/task-1/transcript"):
            if "before=" in self.path:
                self._json(200, {"task_id": "task-1", "events": [], "earlier_cursor": None})
            else:
                self._json(
                    200,
                    {
                        "task_id": "task-1",
                        "events": _transcript_events(),
                        "total": 14,
                        "next_cursor": None,
                        "earlier_cursor": None,
                    },
                )
        elif self.path.startswith("/v1/tasks/task-1/artifacts"):
            self._json(
                200,
                {
                    "artifacts": [
                        {"purpose": "context-epoch-baseline", "hash": "sha256:" + "a" * 64},
                        {"purpose": "verification_evidence", "hash": "sha256:" + "b" * 64},
                    ]
                },
            )
        elif self.path == "/v1/tasks/task-1/diff":
            self._json(
                200,
                {
                    "task_id": "task-1",
                    "git_available": True,
                    "diff": "diff --git a/src/lib.py b/src/lib.py\n",
                    "diff_truncated": False,
                    "untracked_files": [],
                },
            )
        elif self.path == "/v1/workspaces/ws-1/revision":
            self._json(200, {"workspace_id": "ws-1", "revision": "a" * 40, "git_available": True})
        else:
            self._json(404, {"error": "not found"})


class _MeteredControlPlane(_ControlPlane):
    """An account billed per token, so the provider prices the turn itself."""

    def do_GET(self) -> None:
        if self.path == "/v1/provider-models":
            return self._json(
                200,
                {
                    "providers": [
                        {"id": "acct-metered", "label": "OpenCode Zen", "billing": "metered"}
                    ],
                    "models": [
                        {
                            "id": "gpt-5.6",
                            "provider": "acct-metered",
                            "billing": "metered",
                            "context_tokens": 400_000,
                            "output_tokens": 128_000,
                            "pricing": {
                                "input_micros_per_million": 1_250_000,
                                "cached_input_micros_per_million": 125_000,
                                "output_micros_per_million": 10_000_000,
                            },
                            "pricing_source": "catalog",
                        }
                    ],
                    "rejected": [],
                    "observed_at": "2026-08-29T11:00:00Z",
                    "error": None,
                },
            )
        if self.path == "/v1/provider-accounts":
            return self._json(
                200,
                {
                    "accounts": [
                        {"id": "acct-metered", "status": "connected", "billing": "metered"}
                    ],
                    "discovery": {"last_run_at": None, "installed_tools": [], "warnings": []},
                },
            )
        super().do_GET()


class _LegacyControlPlane(_ControlPlane):
    """A control plane from before Phase 0-F2: no turn usage routes."""

    serve_turn_routes = False


def _serve(handler: type[BaseHTTPRequestHandler]) -> Generator[str, None, None]:
    RECEIVED.clear()
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    thread.join()


@pytest.fixture()
def control_url() -> Generator[str, None, None]:
    yield from _serve(_ControlPlane)


@pytest.fixture()
def legacy_control_url() -> Generator[str, None, None]:
    yield from _serve(_LegacyControlPlane)


@pytest.fixture()
def metered_control_url() -> Generator[str, None, None]:
    yield from _serve(_MeteredControlPlane)


def _task_package(tmp_path: Path, *, grader_passes: bool) -> Path:
    task_dir = tmp_path / "01-fix-typo"
    task_dir.mkdir(parents=True)
    (task_dir / "task.yaml").write_text(
        yaml.safe_dump(
            {
                "task": {
                    "id": "tiny-bugfix/01-fix-typo",
                    "grader_version": "terminus-internal-1.0",
                    "acceptance_criteria": [
                        {
                            "id": "typo-fixed",
                            "statement": "recieve becomes receive",
                            "required": True,
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )
    (task_dir / "prompt.md").write_text("Fix the typo in src/lib.py.", encoding="utf-8")
    (task_dir / "grader").mkdir()
    (task_dir / "grader" / "run.py").write_text(
        f"import sys\nsys.exit({0 if grader_passes else 1})\n", encoding="utf-8"
    )
    return task_dir


def _request(task_dir: Path, **overrides: Any) -> RunRequest:
    defaults: dict[str, Any] = {
        "suite": "terminus-internal",
        "task": "tiny-bugfix/01-fix-typo",
        "task_dir": task_dir,
        "harness_id": "terminus-live",
        "harness_commit": "c" * 40,
        "model_snapshot": ModelCapabilitySnapshot(
            provider="chatgpt",
            model="gpt-5.6",
            api_version="2026-08",
            context_window=200_000,
            max_output_tokens=8_192,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
        ),
        "random_seed": 42,
        "budgets": Budgets(max_tool_calls=25, max_total_tokens=500_000),
        "reasoning_effort": "high",
    }
    defaults.update(overrides)
    return RunRequest(**defaults)


def _harness(url: str) -> TerminusHarness:
    return TerminusHarness(
        TerminusHarnessConfig(base_url=url, token="test-token", poll_interval_seconds=0.01)
    )


# ──────────────────────────── steering ────────────────────────────────────


def test_model_and_effort_actually_steer_the_turn(control_url: str, tmp_path: Path) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    assert RECEIVED["turn_body"]["model"] == "gpt-5.6"
    assert RECEIVED["turn_body"]["reasoning_effort"] == "high"
    # The account that lists the model is chosen, not a blind default.
    assert RECEIVED["turn_body"]["provider_account_id"] == "acct-chatgpt"
    # Session defaults are set so control-plane-scheduled repair turns inherit them.
    assert RECEIVED["session_patch"]["default_model"] == "gpt-5.6"
    assert RECEIVED["session_patch"]["default_reasoning_effort"] == "high"
    assert result.metrics["steering"]["session_defaults_applied"] is True


def test_turn_budgets_are_sent_and_recorded_as_enforced(control_url: str, tmp_path: Path) -> None:
    """`--max-steps`/`--max-tokens` reach the turn and the 201 echo proves it."""
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    assert RECEIVED["turn_body"]["budget"] == {
        "max_steps": 25,
        "max_tokens": "500000",
        "max_cost_micros": "5000000",
    }
    steering = result.metrics["steering"]
    assert steering["budgets_enforced"] is True
    assert steering["enforced_budget"]["max_steps"] == 25
    assert steering["requested_budgets"]["max_tool_calls"] == 25
    # Only the seven keys the route accepts; anything else is a 400 now.
    assert set(RECEIVED["turn_body"]) <= {
        "thread_id",
        "task_id",
        "user_input",
        "model",
        "reasoning_effort",
        "provider_account_id",
        "budget",
    }


def test_a_control_plane_that_ignores_the_budget_is_not_reported_as_enforcing_it(
    legacy_control_url: str, tmp_path: Path
) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(legacy_control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    steering = result.metrics["steering"]
    assert steering["turn_budget"]["max_steps"] == 25, "the budget is still sent"
    assert steering["budgets_enforced"] is False
    assert steering["enforced_budget"] is None


def test_fixture_model_placeholder_does_not_steer(control_url: str, tmp_path: Path) -> None:
    """`--model fake-1` would earn a 409 MODEL_NOT_ADMITTED from a real plane."""
    task_dir = _task_package(tmp_path, grader_passes=True)
    snapshot = ModelCapabilitySnapshot(
        provider="fake",
        model="fake-1",
        api_version="v1",
        context_window=1,
        max_output_tokens=1,
        supports_tool_calls=False,
        supports_streaming=False,
        supports_cache=False,
    )
    _harness(control_url).run(
        _request(task_dir, model_snapshot=snapshot, reasoning_effort=None),
        TrajectoryRecorder(run_id="r-1"),
    )
    assert "model" not in RECEIVED["turn_body"]


def test_task_contract_carries_the_packages_acceptance_criteria(
    control_url: str, tmp_path: Path
) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    body = RECEIVED["task_body"]
    assert body["allowed_scope"] == {"read_paths": ["**"], "write_paths": ["**"]}
    assert body["acceptance_criteria"] == [
        {"id": "typo-fixed", "statement": "recieve becomes receive", "required": True}
    ]


# ──────────────────────────── metrics + cost ──────────────────────────────


def test_harness_result_carries_reconciled_metrics_and_cost(
    control_url: str, tmp_path: Path
) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    metrics = result.metrics
    assert metrics["token_source"] == "turn_usage_route"
    assert metrics["tokens_input_fresh"] == 2_000  # 5000 total - 3000 cached
    assert metrics["tokens_input_cached"] == 3_000
    assert metrics["tokens_output"] == 500
    assert metrics["tokens_reasoning"] == 100
    assert metrics["cache_hit_ratio"] == 0.75  # attempt 2: 3000/4000
    assert metrics["steps"] == 2
    assert metrics["tool_error_rate"] == 0.5
    assert metrics["repair_turns"] == 0
    assert metrics["ttft_ms"] == 640
    assert metrics["stop_reason"] == "stop"
    assert metrics["wall_clock_ms"] >= 0
    assert metrics["verdict"]["admitted"] is True

    assert result.cost is not None
    expected = 2_000 / 1e6 * 2.0 + 3_000 / 1e6 * 0.2 + 500 / 1e6 * 12.0
    assert result.cost.computed_usd == round(expected, 6)
    # The fake account is subscription-billed, so the control plane has no
    # per-token price and its `cost_micros: 0` is the absence of one.
    assert result.cost.provider_reported_usd is None
    assert result.cost.reconciliation_flagged is False
    assert result.cost.source == "registry_estimate"
    assert result.cost.cached_tokens == 3_000


def test_environment_digest_is_content_addressed_not_a_workspace_label(
    control_url: str, tmp_path: Path
) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    assert result.environment_digest is not None
    assert result.environment_digest.startswith("sha256:")
    assert not result.environment_digest.startswith("remote:")
    component = next(a for a in result.artifacts if a.get("kind") == "environment_digest")
    assert component["runtime_identity"].startswith("control_version=0.1.0")
    assert "nonce-per-restart" not in component["runtime_identity"]


# ──────────────────────────── the run record ──────────────────────────────


def _record(control_url: str, task_dir: Path, **overrides: Any) -> RunRecord:
    from forge_evals.runners.live_runner import run_live_task

    recorder = TrajectoryRecorder(run_id="r-1")
    request = _request(task_dir, **overrides)
    result, patch_payload = run_live_task(_harness(control_url), request, recorder)
    return build_live_run_record(
        harness_result=result,
        request=request,
        patch_payload=patch_payload,
        seed=42,
        trajectory=recorder.to_dicts(),
    )


def test_run_record_success_is_the_graders_verdict(control_url: str, tmp_path: Path) -> None:
    record = _record(control_url, _task_package(tmp_path, grader_passes=True))

    assert record.grader_results, "a live record must carry a grader verdict"
    assert record.grader_results[0].grader_id == "task:tiny-bugfix/01-fix-typo"
    assert record.success is True
    assert record.harness_verdict["admitted"] is True
    assert record.harness_grader_disagreement is False


def test_false_positive_completion_is_visible(control_url: str, tmp_path: Path) -> None:
    """The harness admitted the turn; the grader disagrees. Success follows the grader."""
    record = _record(control_url, _task_package(tmp_path, grader_passes=False))

    assert record.outcome is Outcome.COMPLETED  # what the harness said
    assert record.success is False  # what the grader said
    assert record.harness_verdict["admitted"] is True
    assert record.harness_grader_disagreement is True


def test_run_record_metrics_are_first_class_columns_not_notes(
    control_url: str, tmp_path: Path
) -> None:
    record = _record(control_url, _task_package(tmp_path, grader_passes=True))

    assert record.tokens_input_fresh == 2_000
    assert record.tokens_input_cached == 3_000
    assert record.tokens_output == 500
    assert record.tokens_reasoning == 100
    assert record.cache_hit_ratio == 0.75
    assert record.steps == 2
    assert record.tool_error_rate == 0.5
    assert record.repair_turns == 0
    assert record.ttft_ms == 640
    assert record.wall_clock_ms is not None
    assert record.stop_reason == "stop"
    assert record.cost is not None and record.cost.computed_usd > 0
    assert record.end is not None

    # The numbers must survive a JSON round trip as columns.
    restored = RunRecord.from_dict(json.loads(record.to_jsonl_line()))
    assert restored.tokens_input_cached == 3_000
    assert restored.cache_hit_ratio == 0.75
    assert restored.ttft_ms == 640
    assert restored.harness_verdict["status"] == "admitted"
    assert restored.success is True


def test_run_record_passes_the_local_exit_gate_shape(control_url: str, tmp_path: Path) -> None:
    """The digest, verdict, cost and timestamps the exit gate demands are present."""
    from forge_evals.cli import _local_exit_gate_issues

    record = _record(control_url, _task_package(tmp_path, grader_passes=True))
    issues = [i for i in _local_exit_gate_issues([record]) if "independent seeds" not in i]
    assert issues == []


def test_cli_live_run_writes_a_graded_record(
    control_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    monkeypatch.setenv("TERMINUS_CONTROL_URL", control_url)
    monkeypatch.setenv("TERMINUS_CONTROL_TOKEN", "test-token")
    output_dir = tmp_path / "results"

    exit_code = main(
        [
            "run",
            "--suite",
            "terminus-internal",
            "--task",
            "tiny-bugfix/01-fix-typo",
            "--task-dir",
            str(task_dir),
            "--harness",
            "terminus-live",
            "--harness-commit",
            "c" * 40,
            "--model",
            "gpt-5.6",
            "--effort",
            "high",
            "--seeds",
            "1",
            "--output-dir",
            str(output_dir),
        ]
    )
    assert exit_code == 0
    lines = (output_dir / "runs.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["grader_results"][0]["passed"] is True
    assert payload["cost"]["computed_usd"] > 0
    assert payload["environment_digest"].startswith("sha256:")
    assert payload["harness_verdict"]["admitted"] is True
    assert payload["tokens_input_cached"] == 3_000


def test_cli_routes_swe_bench_pro_to_the_instance_path(
    control_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--suite swe-bench-pro` materialises the instance and writes predictions."""
    import subprocess

    source = tmp_path / "repos" / "acme__widget"
    source.mkdir(parents=True)
    subprocess.run(["git", "-C", str(source), "init", "-q", "-b", "main"], check=True)
    subprocess.run(["git", "-C", str(source), "config", "user.email", "e@x"], check=True)
    subprocess.run(["git", "-C", str(source), "config", "user.name", "e"], check=True)
    (source / "widget.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(source), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-q", "-m", "init"], check=True)
    base = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()

    instances = tmp_path / "instances.jsonl"
    instances.write_text(
        json.dumps(
            {
                "instance_id": "acme__widget-1",
                "repo": "acme__widget",
                "base_commit": base,
                "problem_statement": "add() subtracts.",
                "repo_language": "python",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("TERMINUS_CONTROL_URL", control_url)
    monkeypatch.setenv("TERMINUS_CONTROL_TOKEN", "test-token")
    monkeypatch.setenv(
        "TERMINUS_SWEBENCH_PRO_REPO_URL_TEMPLATE", str(tmp_path / "repos" / "{repo}")
    )
    monkeypatch.delenv("TERMINUS_SWEBENCH_PRO_HARNESS_DIR", raising=False)
    output_dir = tmp_path / "results"

    exit_code = main(
        [
            "run",
            "--suite",
            "swe-bench-pro",
            "--task",
            "acme__widget-1",
            "--task-dir",
            str(tmp_path / "workspace"),
            "--instance-file",
            str(instances),
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

    payload = json.loads((output_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    grader = payload["grader_results"][0]
    # No official harness is configured here: the honest state is "pending",
    # which is recorded as not-passed with the prediction path preserved.
    assert grader["grader_id"] == "swe-bench-pro:swe_bench_pro_eval"
    assert grader["passed"] is False
    assert grader["metadata"]["grader_status"] == "evaluation_pending"

    prediction = next(a for a in payload["artifacts"] if a.get("kind") == "swebench_pro_prediction")
    assert prediction["base_commit"] == base
    written = json.loads(Path(prediction["predictions_path"]).read_text(encoding="utf-8"))
    assert set(written[0]) == {"instance_id", "model_name_or_path", "model_patch"}
    assert written[0]["model_patch"].startswith("diff --git")
    pro_format = json.loads(Path(prediction["patches_path"]).read_text(encoding="utf-8"))
    assert set(pro_format[0]) == {"instance_id", "patch", "prefix"}
    # The instance was materialised at its base commit, not left empty.
    assert (tmp_path / "workspace" / "widget.py").exists()


# ─────────────────── task materialisation (setup.sh) ──────────────────────


def _package_with_setup(tmp_path: Path, *, setup_body: str, grader_body: str) -> Path:
    task_dir = tmp_path / "pkg"
    (task_dir / "grader").mkdir(parents=True)
    (task_dir / "task.yaml").write_text(
        yaml.safe_dump({"task": {"id": "t/1", "grader_version": "v1"}}), encoding="utf-8"
    )
    (task_dir / "setup.sh").write_text(setup_body, encoding="utf-8")
    (task_dir / "grader" / "run.py").write_text(grader_body, encoding="utf-8")
    return task_dir


def test_setup_script_builds_a_scratch_workspace_and_leaves_the_package_clean(
    tmp_path: Path,
) -> None:
    """Fixtures are generated at run time; generating them in-place would
    write into the repository and expose the grader to the agent."""
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\nset -e\nmkdir -p src\necho hi > src/lib.py\n",
        grader_body="import sys\nsys.exit(0)\n",
    )
    materialized = materialize_task_workspace(package, tmp_path / "ws")

    assert materialized.setup_status == "ran"
    assert materialized.is_scratch
    assert (tmp_path / "ws" / "src" / "lib.py").read_text(encoding="utf-8") == "hi\n"
    assert not (package / "src").exists(), "setup.sh must not write into the task package"
    # The grader and the hidden tests never reach the tree the agent edits.
    assert not (tmp_path / "ws" / "grader").exists()


def test_a_failing_setup_script_stops_the_run(tmp_path: Path) -> None:
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\necho broken >&2\nexit 3\n",
        grader_body="import sys\nsys.exit(0)\n",
    )
    with pytest.raises(LiveRunError, match="exited 3"):
        materialize_task_workspace(package, tmp_path / "ws")


def test_materialize_refuses_to_run_setup_over_existing_files(tmp_path: Path) -> None:
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\ntrue\n",
        grader_body="import sys\nsys.exit(0)\n",
    )
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "keep.txt").write_text("x", encoding="utf-8")
    with pytest.raises(LiveRunError, match="not empty"):
        materialize_task_workspace(package, workspace)


def test_package_without_a_setup_script_is_graded_in_place(tmp_path: Path) -> None:
    package = _task_package(tmp_path, grader_passes=True)
    materialized = materialize_task_workspace(package, tmp_path / "ws")
    assert materialized.setup_status == "no_setup_script"
    assert materialized.workspace == package
    assert not materialized.is_scratch


def test_cli_grades_the_materialized_workspace_not_the_package(
    control_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The grader only passes if it ran against the tree setup.sh built."""
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\nset -e\necho fixed > answer.txt\n",
        grader_body=(
            "import pathlib, sys\nsys.exit(0 if pathlib.Path('answer.txt').exists() else 1)\n"
        ),
    )
    monkeypatch.setenv("TERMINUS_CONTROL_URL", control_url)
    monkeypatch.setenv("TERMINUS_CONTROL_TOKEN", "test-token")
    output_dir = tmp_path / "results"

    exit_code = main(
        [
            "run",
            "--suite",
            "terminus-internal",
            "--task",
            "tiny-bugfix/01-fix-typo",
            "--task-dir",
            str(package),
            "--harness",
            "terminus-live",
            "--harness-commit",
            "c" * 40,
            "--model",
            "gpt-5.6",
            "--seeds",
            "1",
            "--output-dir",
            str(output_dir),
        ]
    )
    assert exit_code == 0
    payload = json.loads((output_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    assert payload["grader_results"][0]["passed"] is True
    workspace_artifact = next(a for a in payload["artifacts"] if a.get("kind") == "task_workspace")
    assert workspace_artifact["setup_status"] == "ran"
    assert workspace_artifact["workspace"] != workspace_artifact["package_dir"]
    assert not (package / "answer.txt").exists()


def test_cli_no_setup_grades_the_task_directory_in_place(
    control_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\nset -e\necho fixed > answer.txt\n",
        grader_body=(
            "import pathlib, sys\nsys.exit(0 if pathlib.Path('answer.txt').exists() else 1)\n"
        ),
    )
    monkeypatch.setenv("TERMINUS_CONTROL_URL", control_url)
    monkeypatch.setenv("TERMINUS_CONTROL_TOKEN", "test-token")
    output_dir = tmp_path / "results"

    exit_code = main(
        [
            "run",
            "--suite",
            "terminus-internal",
            "--task",
            "tiny-bugfix/01-fix-typo",
            "--task-dir",
            str(package),
            "--harness",
            "terminus-live",
            "--no-setup",
            "--harness-commit",
            "c" * 40,
            "--model",
            "gpt-5.6",
            "--seeds",
            "1",
            "--output-dir",
            str(output_dir),
        ]
    )
    assert exit_code == 0
    payload = json.loads((output_dir / "runs.jsonl").read_text(encoding="utf-8").strip())
    # No setup ran, so answer.txt never existed: an honest failing verdict.
    assert payload["grader_results"][0]["passed"] is False
    assert payload["success"] is False


def test_the_real_repo_task_materializes_and_its_grader_discriminates(tmp_path: Path) -> None:
    """End-to-end against the committed task package, no control plane."""
    from forge_evals.runners.task_graders import run_task_grader

    package = (
        Path(__file__).resolve().parents[4] / "evals" / "tasks" / "tiny-bugfix" / "01-fix-typo"
    )
    if not (package / "setup.sh").exists():  # pragma: no cover - repo layout guard
        pytest.skip("committed task package is not present")

    materialized = materialize_task_workspace(package, tmp_path / "ws")
    lib = materialized.workspace / "src" / "lib.py"
    assert "recieve" in lib.read_text(encoding="utf-8")
    assert not (materialized.workspace / "hidden").exists()
    assert materialized.grader_assets_dir is not None
    assert (materialized.grader_assets_dir / "hidden" / "test_fix.py").exists()

    before = run_task_grader(
        package,
        materialized.workspace,
        objective="tiny-bugfix/01-fix-typo",
        grader_assets_dir=materialized.grader_assets_dir,
    )
    assert before.passed is False, "the unfixed fixture must not grade as a pass"
    assert not (materialized.workspace / "hidden").exists()

    lib.write_text(lib.read_text(encoding="utf-8").replace("recieve", "receive"), encoding="utf-8")
    after = run_task_grader(
        package,
        materialized.workspace,
        objective="tiny-bugfix/01-fix-typo",
        grader_assets_dir=materialized.grader_assets_dir,
    )
    assert after.passed is True, after.evidence
    assert not (materialized.workspace / "hidden").exists()


# ───────────────── typed control-plane routes (Phase 0-F2) ────────────────


def test_metrics_come_from_the_turn_routes_not_the_event_log(
    control_url: str, tmp_path: Path
) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    metrics = result.metrics
    assert metrics["token_source"] == "turn_usage_route"
    assert metrics["ttft_ms"] == 640
    assert metrics["stop_reason"] == "stop"
    # Attempt 2 read 3000 of its 4000 prompt tokens from cache.
    assert metrics["cache_hit_ratio"] == 0.75
    assert [a["provider_attempt_id"] for a in metrics["attempts"]] == ["a-1", "a-2"]
    assert result.cost is not None
    assert result.cost.provider_reported_usd is None


def test_a_legacy_control_plane_still_produces_a_record(
    legacy_control_url: str, tmp_path: Path
) -> None:
    """404 on both turn routes ⇒ the event-log reconstruction runs instead."""
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(legacy_control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    metrics = result.metrics
    assert metrics["token_source"] == "provider_attempt_events"
    assert metrics["tokens_input_cached"] == 3_000
    assert metrics["ttft_ms"] == 640
    assert metrics["cache_hit_ratio"] == 0.75


def test_acceptance_criteria_are_read_back_from_the_contract(
    control_url: str, tmp_path: Path
) -> None:
    """What the run was graded against, as the contract holds it — not the fixture."""
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    contract = next(a for a in result.artifacts if a.get("kind") == "task_contract")
    assert contract["version"] == 1
    assert [c["id"] for c in contract["acceptance_criteria"]] == ["typo-fixed"]
    assert contract["acceptance_criteria"][0]["status"] == "SATISFIED"


def test_harness_verdict_names_the_criterion_a_node_verified(
    control_url: str, tmp_path: Path
) -> None:
    record = _record(control_url, _task_package(tmp_path, grader_passes=True))
    assert record.harness_verdict["passed_criteria"] == ["typo-fixed"]


def test_environment_digest_folds_in_the_kernel_build_not_the_restart_nonce(
    control_url: str, tmp_path: Path
) -> None:
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))

    digest = next(a for a in result.artifacts if a.get("kind") == "environment_digest")
    identity = digest["runtime_identity"]
    assert "kernel_build_digest=sha256:" + "k" * 64 in identity
    assert "kernel_version=0.4.2" in identity
    # A per-restart nonce in the digest would make every run's environment
    # unique and the comparison worthless.
    assert "nonce-per-restart" not in identity


# ─────────────── Phase 0-F3: what the first live run exposed ──────────────


def test_the_materialized_workspace_is_a_git_repository(tmp_path: Path) -> None:
    """The first live run died in `agent_loop_error`: verification shells out
    to `git rev-parse HEAD`, and the fixture was not a repository."""
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\nset -e\nmkdir -p src\necho hi > src/lib.py\n",
        grader_body="import sys\nsys.exit(0)\n",
    )
    materialized = materialize_task_workspace(package, tmp_path / "ws")

    assert materialized.vcs_status == "git_initialized"
    assert materialized.base_commit is not None
    assert len(materialized.base_commit) == 40
    head = subprocess.run(
        ["git", "-C", str(materialized.workspace), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert head.stdout.strip() == materialized.base_commit
    # The fixture is committed, so the tree is clean and every later diff is
    # exactly the agent's work.
    status = subprocess.run(
        ["git", "-C", str(materialized.workspace), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout == ""


def test_the_fixture_commit_is_attributed_to_the_harness_not_the_operator(
    tmp_path: Path,
) -> None:
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\nset -e\necho x > a.txt\n",
        grader_body="import sys\nsys.exit(0)\n",
    )
    materialized = materialize_task_workspace(package, tmp_path / "ws")
    author = subprocess.run(
        ["git", "-C", str(materialized.workspace), "log", "-1", "--format=%an <%ae>"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert author.stdout.strip() == "forge-evals <forge-evals@localhost>"


def test_a_package_graded_in_place_is_never_committed_to(tmp_path: Path) -> None:
    """A checked-in task package must not gain a repository of its own."""
    package = _task_package(tmp_path, grader_passes=True)
    materialized = materialize_task_workspace(package, tmp_path / "ws")
    assert materialized.vcs_status == "untouched_package"
    assert materialized.base_commit is None
    assert not (package / ".git").exists()


def test_workspace_diff_is_taken_against_the_fixture_commit(tmp_path: Path) -> None:
    package = _package_with_setup(
        tmp_path,
        setup_body="#!/usr/bin/env bash\nset -e\nmkdir -p src\necho 'recieve' > src/lib.py\n",
        grader_body="import sys\nsys.exit(0)\n",
    )
    materialized = materialize_task_workspace(package, tmp_path / "ws")
    assert materialized.base_commit is not None
    assert workspace_diff(materialized.workspace, materialized.base_commit) == ""

    (materialized.workspace / "src" / "lib.py").write_text("receive\n", encoding="utf-8")
    (materialized.workspace / "new_file.py").write_text("x = 1\n", encoding="utf-8")
    diff = workspace_diff(materialized.workspace, materialized.base_commit)
    assert "-recieve" in diff and "+receive" in diff
    # `add -A -N`: work in untracked files is not silently dropped.
    assert "new_file.py" in diff


def test_a_live_record_never_says_the_provider_is_fake(control_url: str, tmp_path: Path) -> None:
    record = _record(control_url, _task_package(tmp_path, grader_passes=True))
    snapshot = record.model_capability_snapshot

    assert snapshot["provider"] == "ChatGPT Codex"
    assert snapshot["provider"] != "fake"
    assert snapshot["provider_account_id"] == "acct-chatgpt"
    assert snapshot["provider_account_label"] == "ChatGPT Codex"
    assert snapshot["billing"] == "subscription"
    assert snapshot["catalog_pricing_source"] == "subscription"
    assert snapshot["capability_source"] == "control_plane:/v1/provider-models"
    assert record.evaluation_identity is not None
    assert record.evaluation_identity.provider == "ChatGPT Codex"
    assert record.evaluation_identity.model == "gpt-5.6"


def test_model_limits_come_from_the_catalog_not_from_constants(
    metered_control_url: str, tmp_path: Path
) -> None:
    """200_000/8_192 were placeholders the caller could not know."""
    record = _record(metered_control_url, _task_package(tmp_path, grader_passes=True))
    snapshot = record.model_capability_snapshot

    assert snapshot["context_window"] == 400_000
    assert snapshot["max_output_tokens"] == 128_000
    assert snapshot["provider"] == "OpenCode Zen"


def test_a_metered_account_still_reconciles_against_the_provider(
    metered_control_url: str, tmp_path: Path
) -> None:
    """Only subscription runs skip reconciliation; a real price is still checked."""
    task_dir = _task_package(tmp_path, grader_passes=True)
    result = _harness(metered_control_url).run(_request(task_dir), TrajectoryRecorder(run_id="r-1"))
    assert result.cost is not None
    assert result.cost.provider_reported_usd == 0.009  # 9000 micros
    assert result.cost.source == "provider_reported"
    assert result.cost.reconciliation_delta_usd is not None


def test_a_passing_grader_over_a_crashed_loop_is_a_disagreement() -> None:
    """The first live run: grader PASS, turn `agent_loop_error`, verdict unknown."""
    passing = GraderResult(grader_id="g", grader_version="1", passed=True, score=1.0)
    crashed = _record_with(graders=[passing], verdict={"admitted": None, "status": "unknown"})
    assert crashed.success is True
    assert crashed.harness_grader_disagreement is True, (
        "an unadmitted completion under a passing grader must be surfaced"
    )
    # `status` keeps the detail the boolean cannot carry.
    assert crashed.harness_verdict["status"] == "unknown"

    agreed = _record_with(graders=[passing], verdict={"admitted": True, "status": "admitted"})
    assert agreed.harness_grader_disagreement is False

    failing = GraderResult(grader_id="g", grader_version="1", passed=False, score=0.0)
    false_positive = _record_with(
        graders=[failing], verdict={"admitted": True, "status": "admitted"}
    )
    assert false_positive.harness_grader_disagreement is True

    # Nothing graded the run, so there is no second opinion to disagree with.
    ungraded = _record_with(graders=[], verdict={"admitted": True, "status": "admitted"})
    assert ungraded.harness_grader_disagreement is False


def test_the_record_carries_the_per_attempt_array(control_url: str, tmp_path: Path) -> None:
    """Per-attempt cache behaviour must be inspectable without the event log."""
    record = _record(control_url, _task_package(tmp_path, grader_passes=True))

    assert [a["attempt_index"] for a in record.attempts] == [1, 2]
    assert [a["cached_input_tokens"] for a in record.attempts] == [0, 3_000]
    assert record.attempts[1]["provider_attempt_id"] == "a-2"
    # It survives the round trip a later analysis reads it from.
    assert RunRecord.from_dict(json.loads(record.to_jsonl_line())).attempts == record.attempts


def _record_with(*, graders: list[GraderResult], verdict: dict[str, Any]) -> RunRecord:
    return RunRecord(
        run_id="r-1",
        suite="terminus-internal",
        task="tiny-bugfix/01-fix-typo",
        harness="terminus-live",
        harness_commit="c" * 40,
        model_capability_snapshot={},
        environment_digest="sha256:" + "0" * 64,
        random_seed=42,
        budgets={},
        outcome=Outcome.FAILED,
        grader_results=graders,
        harness_verdict=verdict,
    )
