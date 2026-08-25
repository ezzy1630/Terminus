"""Live Terminus harness adapter (deep-audit Rank 5 / PR8).

The audit's finding: "suite exists and adapter unit test passes" must never
appear as benchmark support, because no adapter executed a live Terminus
coding harness. This module is the missing adapter: it drives the real
Terminus control-plane HTTP API (task → turn → terminal state) against a
prepared task workspace and records everything the promotion gate needs —
context manifests, verification results, provider usage receipts, and the
final workspace diff identity.

It is deliberately transport-only: it owns NO grading logic. Grading stays
with the runner's graders so evaluator and harness ownership remain
separated (anti-gaming rule).

Configuration (all required unless a fake server supplies them in tests):

- ``TERMINUS_CONTROL_URL``   base URL of a running terminus-control instance
- ``TERMINUS_CONTROL_TOKEN`` bearer token for that instance

"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..run_record import Outcome
from .harness_runner import HarnessResult, RunRequest
from .trajectory_recorder import TrajectoryRecorder

__all__ = [
    "TERMINAL_TURN_STATES",
    "TerminusControlError",
    "TerminusHarness",
    "TerminusHarnessConfig",
]

TERMINAL_TURN_STATES = {"COMPLETED", "FAILED", "POLICY_DENIED", "BUDGET_EXHAUSTED", "INTERRUPTED"}
_TERMINAL_TASK_STATES = {"COMPLETED", "FAILED_VERIFICATION", "BLOCKED", "CANCELLED"}


class TerminusControlError(RuntimeError):
    """The Terminus control plane rejected or could not serve a request."""


@dataclass(frozen=True)
class TerminusHarnessConfig:
    """Connection settings for one Terminus harness."""

    base_url: str
    token: str | None
    poll_interval_seconds: float = 1.0
    timeout_seconds: float = 1_800.0


class TerminusHarness:
    """Drive one benchmark task through the live Terminus coding loop.

    The harness pins run identity from the :class:`RunRequest` (suite, task,
    seed, budgets, model snapshot) and returns a fully populated
    :class:`HarnessResult` whose artifacts include the per-turn context
    manifests and verification evidence emitted by the control plane.
    """

    def __init__(self, config: TerminusHarnessConfig) -> None:
        self._config = config

    @classmethod
    def from_env(cls) -> TerminusHarness:
        base_url = os.environ.get("TERMINUS_CONTROL_URL")
        if not base_url:
            raise TerminusControlError(
                "TERMINUS_CONTROL_URL is not set; refusing to fabricate a harness result"
            )
        return cls(
            TerminusHarnessConfig(
                base_url=base_url.rstrip("/"),
                token=os.environ.get("TERMINUS_CONTROL_TOKEN"),
            )
        )

    # -- Harness protocol -------------------------------------------------

    @property
    def harness_id(self) -> str:
        return "terminus-live"

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        started = time.monotonic()
        workspace_id = self._prepare_workspace(request)
        task_id = self._create_task(request, workspace_id, recorder)
        turn_id = self._create_turn(request, task_id, workspace_id, recorder)
        state = self._await_terminal(turn_id)

        usage, context_manifests, verification = self._collect_evidence(task_id, turn_id)
        elapsed = time.monotonic() - started
        outcome = self._map_outcome(state)

        return HarnessResult(
            outcome=outcome,
            final_revision=self._final_revision(workspace_id),
            cost=None,
            artifacts=[
                *verification,
                {"kind": "turn_state", "turn_id": turn_id, "state": state},
            ],
            context_manifests=context_manifests,
            grader_outcomes=[],
            notes=json.dumps(
                {
                    "harness": self.harness_id,
                    "workspace_id": workspace_id,
                    "task_id": task_id,
                    "turn_id": turn_id,
                    "wall_seconds": round(elapsed, 3),
                    "provider_usage": usage,
                },
                sort_keys=True,
            ),
        )

    # -- Control-plane steps ----------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self._config.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("content-type", "application/json")
        if self._config.token:
            req.add_header("authorization", f"Bearer {self._config.token}")
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                payload = response.read()
        except urllib.error.HTTPError as error:  # pragma: no cover - network path
            detail = error.read().decode(errors="replace")[:500]
            raise TerminusControlError(f"{method} {path} failed: {error.code} {detail}") from error
        except urllib.error.URLError as error:  # pragma: no cover - network path
            raise TerminusControlError(f"{method} {path} unreachable: {error.reason}") from error
        if not payload:
            return {}
        decoded: Any = json.loads(payload.decode())
        if not isinstance(decoded, dict):
            raise TerminusControlError(f"{method} {path} returned a non-object body")
        return decoded

    def _prepare_workspace(self, request: RunRequest) -> str:
        created = self._request(
            "POST",
            "/v1/workspaces",
            {
                "root_uri": request.task_dir.resolve().as_uri(),
                "trust": (request.suite.startswith("malicious") and "untrusted") or "trusted",
            },
        )
        workspace_id = created.get("id")
        if not isinstance(workspace_id, str):
            raise TerminusControlError("workspace creation returned no id")
        return workspace_id

    def _create_task(
        self,
        request: RunRequest,
        workspace_id: str,
        recorder: TrajectoryRecorder,
    ) -> str:
        statement_path = request.task_dir / "task.md"
        statement = (
            statement_path.read_text(encoding="utf-8") if statement_path.exists() else request.task
        )
        created = self._request(
            "POST",
            "/v1/tasks",
            {
                "session_id": None,
                "workspace_id": workspace_id,
                "statement": statement,
                "acceptance_criteria": _criteria_from_task_dir(request.task_dir),
                "allowed_scope": {"read_paths": ["**"], "write_paths": ["**"]},
            },
        )
        task_id = created.get("id")
        if not isinstance(task_id, str):
            raise TerminusControlError("task creation returned no id")
        recorder.record(
            "harness.task_created",
            {"task_id": task_id, "suite": request.suite, "task": request.task},
        )
        return task_id

    def _create_turn(
        self,
        request: RunRequest,
        task_id: str,
        workspace_id: str,
        recorder: TrajectoryRecorder,
    ) -> str:
        del workspace_id
        prompt = request.task_dir / "prompt.txt"
        user_message = prompt.read_text(encoding="utf-8") if prompt.exists() else request.task
        created = self._request(
            "POST",
            "/v1/turns",
            {
                "task_id": task_id,
                "user_message": user_message,
                "budgets": request.budgets.to_dict(),
                "model_snapshot": request.model_snapshot.to_dict(),
                "seed": request.random_seed,
                "experiment_assignments": request.experiment_assignments,
            },
        )
        turn_id = created.get("id")
        if not isinstance(turn_id, str):
            raise TerminusControlError("turn creation returned no id")
        recorder.record("harness.turn_created", {"turn_id": turn_id})
        return turn_id

    def _await_terminal(self, turn_id: str) -> str:
        deadline = time.monotonic() + self._config.timeout_seconds
        while time.monotonic() < deadline:
            turn = self._request("GET", f"/v1/turns/{turn_id}")
            state = turn.get("state")
            if isinstance(state, str) and state in TERMINAL_TURN_STATES:
                return state
            time.sleep(self._config.poll_interval_seconds)
        return "TIMEOUT"

    def _collect_evidence(
        self,
        task_id: str,
        turn_id: str,
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]], list[dict[str, Any]]]:
        usage: dict[str, Any] | None = None
        manifests: list[dict[str, Any]] = []
        verification: list[dict[str, Any]] = []
        try:
            attempts = self._request("GET", f"/v1/tasks/{task_id}/verification/results")
            if isinstance(attempts.get("results"), list):
                verification.extend(attempts["results"])
        except TerminusControlError:
            pass
        try:
            manifest_list = self._request("GET", f"/v1/turns/{turn_id}/context-manifests")
            if isinstance(manifest_list.get("manifests"), list):
                manifests.extend(manifest_list["manifests"])
        except TerminusControlError:
            pass
        try:
            attempt_rows = self._request("GET", f"/v1/turns/{turn_id}/provider-attempts")
            if isinstance(attempt_rows.get("attempts"), list):
                usage = {"attempts": attempt_rows["attempts"]}
        except TerminusControlError:
            pass
        return usage, manifests, verification

    def _final_revision(self, workspace_id: str) -> str:
        try:
            status = self._request("GET", f"/v1/workspaces/{workspace_id}/revision")
            revision = status.get("revision")
            return revision if isinstance(revision, str) else "unknown"
        except TerminusControlError:
            return "unknown"

    @staticmethod
    def _map_outcome(state: str) -> Outcome:
        return {
            "COMPLETED": Outcome.COMPLETED,
            "FAILED": Outcome.FAILED,
            "FAILED_VERIFICATION": Outcome.FAILED,
            "POLICY_DENIED": Outcome.POLICY_DENIED,
            "BUDGET_EXHAUSTED": Outcome.BUDGET_EXHAUSTED,
            "INTERRUPTED": Outcome.CANCELLED,
            "BLOCKED": Outcome.ABORTED,
            "CANCELLED": Outcome.CANCELLED,
        }.get(state, Outcome.ERROR)


def _criteria_from_task_dir(task_dir: Path) -> list[dict[str, Any]]:
    criteria_path = task_dir / "acceptance.yaml"
    if not criteria_path.exists():
        return []
    loaded = yaml_safe_load(criteria_path)
    if isinstance(loaded, list):
        return [
            item for item in loaded if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]
    return []


def yaml_safe_load(path: Path) -> Any:
    import yaml  # local import keeps the module importable without yaml at runtime paths that never load tasks

    return yaml.safe_load(path.read_text(encoding="utf-8"))
