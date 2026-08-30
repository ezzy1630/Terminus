"""Live Terminus harness adapter (deep-audit Rank 5 / PR8, Phase 0 item 11).

The audit's finding: "suite exists and adapter unit test passes" must never
appear as benchmark support, because no adapter executed a live Terminus
coding harness. This module is that adapter: it drives the real Terminus
control-plane HTTP API (task → turn → terminal state) against a prepared task
workspace and records everything the promotion gate needs — the steering it
applied, the context manifests, the verification evidence, the reconciled
per-run metrics, and the final workspace diff identity.

It owns **no grading logic**. Grading stays with the task package's declared
grader (:mod:`forge_evals.runners.task_graders`) so evaluator and harness
ownership remain separated (anti-gaming rule). The control plane's own
verification conclusion is collected too, but only as
``harness_verdict`` — a claim to compare against the grader, never the
run's success value.

Steering actually applied (control plane contract, verbatim field names):

* ``POST /v1/turns`` accepts ``model``, ``reasoning_effort``
  (``low|medium|high|max``) and ``provider_account_id``. All three are sent.
* ``PATCH /v1/sessions/:id`` accepts ``default_model``,
  ``default_reasoning_effort`` and ``default_provider_account_id``. The
  session defaults are set as well so a repair turn the control plane
  schedules on its own inherits the same model and effort.
* ``POST /v1/turns`` accepts and **enforces** ``budget: {max_steps,
  max_tokens, max_cost_micros}`` and echoes it in the 201 body, so
  :class:`Budgets` is sent and ``budgets_enforced`` records whether the server
  echoed it back. The route also 400s on an unknown top-level key, so this
  module sends exactly the seven fields it accepts. A budget is a request, not
  an entitlement: the server takes the lower of it and the task contract's.

Configuration (all required unless a fake server supplies them in tests):

- ``TERMINUS_CONTROL_URL``   base URL of a running terminus-control instance
- ``TERMINUS_CONTROL_TOKEN`` bearer token for that instance

"""

from __future__ import annotations

import contextlib
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import yaml

from ..evidence import EvidenceClass
from ..run_record import CostBreakdown, Outcome
from .control_plane_metrics import TurnMetrics, reconcile_metrics
from .environment_digest import LiveEnvironmentDigest
from .harness_runner import Budgets, HarnessResult, RunRequest
from .model_pricing import ModelPrices, compute_cost, resolve_model_prices
from .task_contract import ContractDecodeError, TaskContract, load_task_contract
from .task_graders import acceptance_criteria_for_task
from .trajectory_recorder import TrajectoryRecorder

__all__ = [
    "REASONING_EFFORTS",
    "TERMINAL_TURN_STATES",
    "TerminusControlError",
    "TerminusHarness",
    "TerminusHarnessConfig",
    "provider_receipts_from_route",
]

TERMINAL_TURN_STATES = {
    "COMPLETED",
    "FAILED",
    "POLICY_DENIED",
    "BUDGET_EXHAUSTED",
    "INTERRUPTED",
    "ABORTED",
}
_TERMINAL_TASK_STATES = {"COMPLETED", "FAILED_VERIFICATION", "BLOCKED", "CANCELLED"}
_TASK_PENDING_STATE = "TASK_PENDING"

# `parseReasoningEffort` accepts exactly these (packages/provider-core).
REASONING_EFFORTS = ("low", "medium", "high", "max")

# Model ids that mean "no live model was requested". Sending one of these as a
# turn's `model` would earn a 409 MODEL_NOT_ADMITTED from a real control plane.
_FIXTURE_MODEL_IDS = frozenset({"", "fake", "fake-1", "unknown"})

_TRANSCRIPT_PAGE_LIMIT = 1_000
_TRANSCRIPT_MAX_EVENTS = 20_000


_MUTATING_METHODS: frozenset[str] = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class TerminusControlError(RuntimeError):
    """The Terminus control plane rejected or could not serve a request."""


@dataclass(frozen=True)
class _ContractAdmission:
    """Validated package contract plus the fields the current API can carry."""

    contract: TaskContract | None
    allowed_scope: dict[str, list[str]]
    non_goals: list[str]
    acceptance_criteria: list[dict[str, Any]]
    timeout_seconds: float | None

    @property
    def admitted(self) -> bool:
        return self.contract is not None


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
    seed, budgets, model snapshot), applies every steering knob the control
    plane actually accepts, and returns a fully populated
    :class:`HarnessResult` whose artifacts include the per-turn context
    manifests, the verification evidence, and the reconciled run metrics.
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
        admission = self._admit_contract(request)
        admitted_request = self._apply_contract_budgets(request, admission.contract)
        if admission.admitted:
            recorder.record(
                "harness.contract_admitted",
                self._contract_event(admission),
            )
        # Live API contract: open workspace → create session (yields the root
        # thread) → create DRAFT task → start it → admit a turn.
        workspace_id = self._prepare_workspace(admitted_request)

        # The fixture tree is hashed *before* the agent touches it: an
        # environment digest taken after the run would describe the result,
        # not the environment.
        health = self._optional("GET", "/v1/system/health")
        catalog = self._optional("GET", "/v1/provider-models")
        session_id, thread_id = self._create_session(admitted_request, workspace_id, recorder)
        steering = self._apply_steering(admitted_request, session_id, catalog, recorder)

        task_id = self._create_task(admitted_request, session_id, thread_id, recorder, admission)
        self._start_task(task_id, recorder)
        sandbox_report = self._optional("GET", f"/v1/sandbox/report?task_id={task_id}")
        digest = LiveEnvironmentDigest.build(
            workspace_root=request.task_dir,
            task_dir=request.task_package_dir or request.task_dir,
            health=health,
            sandbox_report=sandbox_report,
        )

        user_message = self._user_message(request)
        turn_id = self._create_turn(
            admitted_request, thread_id, task_id, user_message, steering, recorder
        )
        state = self._await_terminal(
            turn_id, task_id=task_id, timeout_seconds=admission.timeout_seconds
        )

        context_manifests, verification = self._collect_artifacts(task_id)
        events = self._collect_events(task_id)
        task_detail = self._optional("GET", f"/v1/tasks/{task_id}") or {}
        # The typed turn routes are the source for usage, cost and stop reason.
        # Both are optional: a control plane older than Phase 0-F2 404s them and
        # `reconcile_metrics` falls back to the event log.
        turn_detail = self._optional("GET", f"/v1/turns/{turn_id}")
        turn_attempts = self._optional_list("GET", f"/v1/turns/{turn_id}/attempts")
        provider_receipts, receipt_projection_status, receipt_turn_ids = (
            self._collect_provider_receipts(
                original_turn_id=turn_id,
                original_turn_attempts=turn_attempts,
                task_detail=task_detail,
            )
        )
        metrics = reconcile_metrics(
            events=events,
            turn=turn_detail,
            turn_attempts=turn_attempts,
            budget_ledger=task_detail.get("budget_ledger"),
            repair_metrics=task_detail.get("repair_metrics"),
        )
        # The criteria the run was actually graded against, read back from the
        # contract rather than re-read from the fixture on disk: the two can
        # disagree, and only the contract's copy is what verification used.
        contract = task_detail.get("contract")
        admitted_criteria = (
            contract.get("acceptance_criteria") if isinstance(contract, Mapping) else None
        )
        recorder.record(
            "harness.metrics_reconciled",
            {
                "turn_id": turn_id,
                "token_source": metrics.token_source,
                "steps": metrics.steps,
                "provider_receipts": len(provider_receipts),
                "provider_receipts_status": receipt_projection_status,
            },
        )

        elapsed = time.monotonic() - started
        wall_clock_ms = int(elapsed * 1000)
        selected_model = steering["model"] or request.model_snapshot.model
        prices = resolve_model_prices(selected_model, catalog=catalog)
        cost = _cost_breakdown(
            metrics,
            prices,
            provider_prices_the_turn=provider_prices_the_turn(catalog, selected_model),
        )
        outcome = self._map_outcome(state)

        metrics_payload = {
            **metrics.to_dict(),
            "model_snapshot": live_model_snapshot(
                admitted_request, steering=steering, catalog=catalog, prices=prices
            ),
            "acceptance_criteria": (
                list(admitted_criteria) if isinstance(admitted_criteria, list) else []
            ),
            "wall_clock_ms": wall_clock_ms,
            "steering": steering,
            "pricing": prices.to_dict() if prices is not None else None,
            "environment_digest": digest.to_dict(),
            # A missing or malformed attempts projection stays explicitly
            # ineligible for release pairing.  The promotion gate also
            # checks the first-class `provider_receipts` column, but keeping
            # this status beside the other reconciled metrics makes a live
            # run's evidence boundary inspectable without parsing notes.
            "provider_receipts_complete": receipt_projection_status == "complete",
            "provider_receipts_status": receipt_projection_status,
        }
        return HarnessResult(
            outcome=outcome,
            final_revision=self._final_revision(workspace_id),
            cost=cost,
            artifacts=[
                *verification,
                {"kind": "turn_state", "turn_id": turn_id, "state": state},
                {
                    "kind": "task_contract",
                    "task_id": task_id,
                    "version": contract.get("version") if isinstance(contract, Mapping) else None,
                    "content_hash": (
                        contract.get("content_hash") if isinstance(contract, Mapping) else None
                    ),
                    "acceptance_criteria": (
                        list(admitted_criteria) if isinstance(admitted_criteria, list) else []
                    ),
                    "admission": self._contract_event(admission),
                },
                digest.to_dict(),
                {
                    "kind": "provider_attempts",
                    "attempts": [a.to_dict() for a in metrics.attempts],
                    "token_source": metrics.token_source,
                },
                {
                    "kind": "provider_receipts",
                    "turn_id": turn_id,
                    "turn_ids": receipt_turn_ids,
                    "status": receipt_projection_status,
                    "receipts": provider_receipts,
                },
                {"kind": "turn_steering", **steering},
            ],
            context_manifests=context_manifests,
            grader_outcomes=[],
            environment_digest=digest.to_digest(),
            evidence_class=(
                EvidenceClass.EXTERNAL_LIVE
                if steering["model"] is not None
                else EvidenceClass.FIXTURE_ONLY
            ),
            metrics=metrics_payload,
            provider_receipts=provider_receipts,
            notes=json.dumps(
                {
                    "harness": self.harness_id,
                    "workspace_id": workspace_id,
                    "session_id": session_id,
                    "task_id": task_id,
                    "turn_id": turn_id,
                    "receipt_turn_ids": receipt_turn_ids,
                    "wall_seconds": round(elapsed, 3),
                    "event_count": len(events),
                    "provider_receipts": len(provider_receipts),
                    "provider_receipts_status": receipt_projection_status,
                },
                sort_keys=True,
            ),
        )

    # -- Control-plane steps ----------------------------------------------

    def _raw(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
    ) -> bytes:
        """Perform one HTTP call and return the undecoded body."""
        url = f"{self._config.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("content-type", "application/json")
        if method.upper() in _MUTATING_METHODS:
            # The control plane rejects every mutating request that does not
            # carry an Idempotency-Key (IDEMPOTENCY_KEY_REQUIRED). One fresh key
            # per call: the harness never retries a call it already issued.
            req.add_header("Idempotency-Key", f"forge-evals-{uuid.uuid4()}")
        if self._config.token:
            req.add_header("authorization", f"Bearer {self._config.token}")
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                payload: bytes = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")[:500]
            raise TerminusControlError(f"{method} {path} failed: {error.code} {detail}") from error
        except urllib.error.URLError as error:  # pragma: no cover - network path
            raise TerminusControlError(f"{method} {path} unreachable: {error.reason}") from error
        return payload

    def _request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = self._raw(method, path, body)
        if not payload:
            return {}
        decoded: Any = json.loads(payload.decode())
        if not isinstance(decoded, dict):
            raise TerminusControlError(f"{method} {path} returned a non-object body")
        return decoded

    def _optional(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Call a route whose absence must not fail the run."""
        try:
            return self._request(method, path, body)
        except (TerminusControlError, ValueError):
            return None

    def _optional_list(self, method: str, path: str) -> list[Any] | None:
        """Call a route that answers with a JSON array, tolerating its absence.

        ``_request`` rejects a non-object body, which is right for every route
        that returns a resource and wrong for ``/v1/turns/:id/attempts``.
        """
        try:
            raw = self._raw(method, path)
        except (TerminusControlError, ValueError):
            return None
        if not raw:
            return None
        try:
            decoded: Any = json.loads(raw.decode())
        except ValueError:
            return None
        return decoded if isinstance(decoded, list) else None

    def _collect_provider_receipts(
        self,
        *,
        original_turn_id: str,
        original_turn_attempts: list[Any] | None,
        task_detail: Mapping[str, Any],
    ) -> tuple[list[dict[str, Any]], str, list[str]]:
        """Collect receipts for the proposal turn and every repair continuation.

        The task route is the durable source for the repair chain. A partial
        chain or one unreadable attempts route makes the whole projection
        ineligible. Keeping the original turn's receipts alone would conceal
        provider work performed by automatic repair turns.
        """
        if "repair_attempts" not in task_detail:
            return [], "unavailable", [original_turn_id]

        repair_turn_ids = _repair_turn_ids(
            original_turn_id,
            task_detail.get("repair_attempts"),
        )
        if repair_turn_ids is None:
            return [], "malformed", [original_turn_id]

        turn_rows: list[tuple[str, list[Any] | None]] = [(original_turn_id, original_turn_attempts)]
        turn_rows.extend(
            (repair_turn_id, self._optional_list("GET", f"/v1/turns/{repair_turn_id}/attempts"))
            for repair_turn_id in repair_turn_ids
        )
        turn_ids = [turn_id for turn_id, _rows in turn_rows]

        receipts: list[dict[str, Any]] = []
        for turn_id, rows in turn_rows:
            projected = provider_receipts_from_route(rows)
            status = _receipt_projection_status(rows, projected)
            if status != "complete":
                return [], status, turn_ids
            receipts.extend({**receipt, "turn_id": turn_id} for receipt in projected)
        return receipts, "complete", turn_ids

    def _prepare_workspace(self, request: RunRequest) -> str:
        created = self._request(
            "POST",
            "/v1/workspaces/open",
            {
                "root_uri": request.task_dir.resolve().as_uri(),
                "kind": "local_git" if (request.task_dir / ".git").exists() else "local_directory",
                "trust": (request.suite.startswith("malicious") and "untrusted") or "trusted",
            },
        )
        workspace_id = created.get("id")
        if not isinstance(workspace_id, str):
            raise TerminusControlError("workspace creation returned no id")
        return workspace_id

    def _create_session(
        self,
        request: RunRequest,
        workspace_id: str,
        recorder: TrajectoryRecorder,
    ) -> tuple[str, str]:
        created = self._request(
            "POST",
            "/v1/sessions",
            {"workspace_id": workspace_id, "title": f"eval:{request.suite}/{request.task}"},
        )
        session_id = created.get("id")
        thread_id = created.get("active_thread_id")
        if not isinstance(session_id, str) or not isinstance(thread_id, str):
            raise TerminusControlError("session creation returned no id/active_thread_id")
        recorder.record("harness.session_created", {"session_id": session_id})
        return session_id, thread_id

    # -- Steering ----------------------------------------------------------

    def _requested_model(self, request: RunRequest) -> str | None:
        """The model to steer with, or ``None`` for a fixture placeholder."""
        model = (request.model_snapshot.model or "").strip()
        return None if model.lower() in _FIXTURE_MODEL_IDS else model

    def _requested_effort(self, request: RunRequest) -> str | None:
        effort = (request.reasoning_effort or "").strip().lower()
        if not effort:
            return None
        if effort not in REASONING_EFFORTS:
            raise TerminusControlError(
                f"reasoning effort {effort!r} is not one of {', '.join(REASONING_EFFORTS)}"
            )
        return effort

    def _resolve_provider_account(
        self,
        model: str | None,
        catalog: Mapping[str, Any] | None,
        explicit: str | None,
    ) -> str | None:
        """Pick the provider account that serves ``model``.

        ``GET /v1/provider-models`` reports each model's owning account in its
        ``provider`` field on the multi-account path. An explicit request wins;
        otherwise the account that actually lists the model is chosen so the
        run cannot silently land on a different subscription. When the catalog
        is the legacy gateway shape, ``None`` is returned and the control
        plane's own default chain applies.
        """
        if explicit:
            return explicit
        if model is None or not isinstance(catalog, Mapping):
            return None
        accounts = self._optional("GET", "/v1/provider-accounts") or {}
        known = {
            str(a.get("id"))
            for a in (accounts.get("accounts") or [])
            if isinstance(a, Mapping) and a.get("status") == "connected"
        }
        models = catalog.get("models")
        if not isinstance(models, list):
            return None
        wanted = model.strip().lower()
        for entry in models:
            if not isinstance(entry, Mapping):
                continue
            ids = {str(entry.get(key) or "").strip().lower() for key in ("id", "slug", "label")}
            if wanted not in ids:
                continue
            provider = entry.get("provider")
            if isinstance(provider, str) and provider in known:
                return provider
        return None

    def _apply_steering(
        self,
        request: RunRequest,
        session_id: str,
        catalog: Mapping[str, Any] | None,
        recorder: TrajectoryRecorder,
    ) -> dict[str, Any]:
        """Apply --model/--effort to the session and describe what was applied.

        Session defaults matter beyond the first turn: the control plane
        schedules repair turns itself, and those inherit the session's
        ``default_model`` / ``default_reasoning_effort``.
        """
        model = self._requested_model(request)
        effort = self._requested_effort(request)
        account_id = self._resolve_provider_account(model, catalog, request.provider_account_id)

        patch: dict[str, Any] = {}
        if model is not None:
            patch["default_model"] = model
        if effort is not None:
            patch["default_reasoning_effort"] = effort
        if account_id is not None:
            patch["default_provider_account_id"] = account_id
        session_defaults_applied = False
        if patch:
            # Repair turns are created by the control plane and inherit only
            # session defaults. A failed or lossy patch would silently run a
            # repair under a different model/account/effort than the initial
            # turn, invalidating both user intent and paired evidence.
            applied = self._request("PATCH", f"/v1/sessions/{session_id}", patch)
            mismatches = {
                key: {"requested": value, "applied": applied.get(key)}
                for key, value in patch.items()
                if applied.get(key) != value
            }
            if mismatches:
                raise TerminusControlError(
                    "session defaults read-back did not match requested steering: "
                    f"{json.dumps(mismatches, sort_keys=True)}"
                )
            session_defaults_applied = True
            recorder.record(
                "harness.session_defaults_applied",
                {"session_id": session_id, "applied": session_defaults_applied, **patch},
            )

        steering: dict[str, Any] = {
            "model": model,
            "reasoning_effort": effort,
            "provider_account_id": account_id,
            "session_defaults_applied": session_defaults_applied,
            "requested_budgets": request.budgets.to_dict(),
            "turn_budget": _turn_budget(request.budgets),
            # Set from the 201 echo by `_create_turn`. False here means the
            # answer is not in yet, never "the server refused".
            "budgets_enforced": False,
            "enforced_budget": None,
        }
        return steering

    # -- Task + turn -------------------------------------------------------

    def health(self) -> dict[str, Any] | None:
        """Return ``GET /v1/system/health``, or ``None`` when unreachable."""
        return self._optional("GET", "/v1/system/health")

    def _objective(self, request: RunRequest) -> str:
        # An explicit instruction wins: external harnesses hand the task over
        # as a string and have no prompt.md to read.
        if request.instruction and request.instruction.strip():
            return request.instruction
        # Task packages ship prompt.md; older fixtures may use task.md. The
        # prompt lives in the package, which is not always the workspace.
        for root in (request.task_package_dir or request.task_dir, request.task_dir):
            for name in ("prompt.md", "task.md"):
                candidate = root / name
                if candidate.exists():
                    return candidate.read_text(encoding="utf-8")
        return request.task

    def _user_message(self, request: RunRequest) -> str:
        if request.instruction and request.instruction.strip():
            return request.instruction
        root = request.task_package_dir or request.task_dir
        prompt = root / "prompt.md"
        if not prompt.exists():
            prompt = root / "prompt.txt"
        return prompt.read_text(encoding="utf-8") if prompt.exists() else self._objective(request)

    def _admit_contract(self, request: RunRequest) -> _ContractAdmission:
        """Decode the package contract before opening any remote resources.

        Older synthetic fixtures predate the versioned contract and identify a
        task with ``task:`` rather than ``id:``. They retain the historical
        unconstrained harness behavior. A package that opts into the contract
        shape is decoded strictly; fields the current control-plane task API
        cannot carry are rejected instead of being silently ignored.
        """
        package = request.task_package_dir or request.task_dir
        task_path = package / "task.yaml"
        if not task_path.is_file():
            return _ContractAdmission(None, _default_scope(), [], [], None)
        raw = _read_yaml_mapping(task_path, name="task.yaml")
        task = _task_mapping(raw)
        # The pre-contract fixtures use ``task: build-001``. Only a declared
        # contract identity opts into strict admission.
        if "id" not in task:
            return _ContractAdmission(None, _default_scope(), [], [], None)
        try:
            contract = load_task_contract(package)
        except ContractDecodeError as exc:
            raise TerminusControlError(f"CONTRACT_ADMISSION_INVALID: {exc}") from exc

        criteria = acceptance_criteria_for_task(package)
        declared_criteria = task.get("acceptance_criteria")
        if declared_criteria is not None and (
            not isinstance(declared_criteria, list) or len(criteria) != len(declared_criteria)
        ):
            raise TerminusControlError(
                "CONTRACT_ADMISSION_INVALID: task acceptance_criteria contains malformed or duplicate entries"
            )
        scope = _declared_scope(task)
        non_goals = _declared_strings(task.get("non_goals"), name="task non_goals")
        policy = _read_optional_yaml_mapping(package / "policy.yaml")
        policy_block = _task_mapping(policy) if policy is not None else {}
        if "allowed_scope" in policy_block or "scope" in policy_block:
            raise TerminusControlError(
                "CONTRACT_ADMISSION_UNSUPPORTED: policy scope cannot be safely composed by the current task API"
            )
        unsupported: list[str] = []
        if contract.secret_capability_uris:
            unsupported.append("secret capability admission")
        if contract.budgets.compute_seconds is not None:
            unsupported.append("compute_seconds budget")
        if contract.budgets.human_approvals:
            unsupported.append("human_approvals budget")
        if contract.risk_class in {"high", "critical"}:
            unsupported.append(
                "required verification nodes (security_tests, detached_review, human_approval)"
            )
        if unsupported:
            raise TerminusControlError(
                "CONTRACT_ADMISSION_UNSUPPORTED: current task/turn API cannot admit "
                + ", ".join(unsupported)
            )
        timeout = (
            float(contract.budgets.wall_clock_seconds)
            if contract.budgets.wall_clock_seconds is not None
            else None
        )
        return _ContractAdmission(contract, scope, non_goals, criteria, timeout)

    @staticmethod
    def _apply_contract_budgets(request: RunRequest, contract: TaskContract | None) -> RunRequest:
        """Intersect supported package ceilings with caller-requested limits."""
        if contract is None:
            return request
        budget = request.budgets
        if contract.budgets.model_micros is not None:
            budget = replace(
                budget,
                max_cost_usd=min(budget.max_cost_usd, contract.budgets.model_micros / 1_000_000),
            )
        if contract.budgets.wall_clock_seconds is not None:
            budget = replace(
                budget,
                max_wall_seconds=min(budget.max_wall_seconds, contract.budgets.wall_clock_seconds),
            )
        return replace(request, budgets=budget)

    @staticmethod
    def _contract_event(admission: _ContractAdmission) -> dict[str, Any]:
        contract = admission.contract
        if contract is None:
            return {"status": "legacy_unversioned"}
        # Secret capability values are intentionally represented only by a
        # count. The URI is an opaque authority, but does not belong in eval
        # trajectories unless the server has admitted it.
        return {
            "status": "admitted",
            "task_id": contract.task_id,
            "risk_class": contract.risk_class,
            "budgets": contract.budgets.to_dict(),
            "secret_capability_count": len(contract.secret_capability_uris),
            "required_verification_nodes": list(contract.required_verification_nodes),
            "allowed_scope": admission.allowed_scope,
            "non_goals": admission.non_goals,
            "acceptance_criteria": [criterion["id"] for criterion in admission.acceptance_criteria],
        }

    def _create_task(
        self,
        request: RunRequest,
        session_id: str,
        thread_id: str,
        recorder: TrajectoryRecorder,
        admission: _ContractAdmission | None = None,
    ) -> str:
        resolved = admission or self._admit_contract(request)
        criteria = resolved.acceptance_criteria or acceptance_criteria_for_task(
            request.task_package_dir or request.task_dir
        )
        body: dict[str, Any] = {
            "session_id": session_id,
            "thread_id": thread_id,
            "objective": self._objective(request),
            "acceptance_criteria": criteria,
            "allowed_scope": resolved.allowed_scope,
            "non_goals": resolved.non_goals,
        }
        if resolved.contract is not None:
            # This is the only contract risk field POST /v1/tasks currently
            # admits. Required nodes and secret capabilities were rejected
            # above rather than pretending this field covers them.
            body["risk_class"] = resolved.contract.risk_class
        created = self._request(
            "POST",
            "/v1/tasks",
            body,
        )
        task_id = created.get("id")
        if not isinstance(task_id, str):
            raise TerminusControlError("task creation returned no id")
        recorder.record(
            "harness.task_created",
            {
                "task_id": task_id,
                "suite": request.suite,
                "task": request.task,
                "acceptance_criteria": [c["id"] for c in criteria],
                "contract_admission": self._contract_event(resolved),
            },
        )
        return task_id

    def _start_task(self, task_id: str, recorder: TrajectoryRecorder) -> None:
        """A DRAFT task cannot admit turns; start it first."""
        started = self._request("POST", f"/v1/tasks/{task_id}/start")
        if started.get("status") is None and started.get("state") is None:
            raise TerminusControlError(f"task {task_id} start returned no status")
        recorder.record("harness.task_started", {"task_id": task_id})

    def _create_turn(
        self,
        request: RunRequest,
        thread_id: str,
        task_id: str,
        user_message: str,
        steering: dict[str, Any],
        recorder: TrajectoryRecorder,
    ) -> str:
        body: dict[str, Any] = {
            "thread_id": thread_id,
            "task_id": task_id,
            "user_input": user_message,
        }
        # Exactly the fields POST /v1/turns accepts. Anything else is a 400
        # (TURN_INPUT_UNKNOWN_FIELDS) rather than a silent drop, so a typo here
        # fails the run instead of producing an uncapped one.
        if steering.get("model"):
            body["model"] = steering["model"]
        if steering.get("reasoning_effort"):
            body["reasoning_effort"] = steering["reasoning_effort"]
        if steering.get("provider_account_id"):
            body["provider_account_id"] = steering["provider_account_id"]
        if steering.get("turn_budget"):
            body["budget"] = steering["turn_budget"]
        created = self._request("POST", "/v1/turns", body)
        turn_id = created.get("id")
        if not isinstance(turn_id, str):
            raise TerminusControlError("turn creation returned no id")
        # The 201 echoes the accepted budget. An older control plane drops the
        # key and echoes nothing, which is exactly the state to record.
        echoed = created.get("budget")
        steering["enforced_budget"] = dict(echoed) if isinstance(echoed, Mapping) else None
        steering["budgets_enforced"] = steering["enforced_budget"] is not None
        recorder.record(
            "harness.turn_created",
            {
                "turn_id": turn_id,
                "requested_model": steering.get("model"),
                "admitted_model": created.get("model"),
                "reasoning_effort": created.get("reasoning_effort"),
                "selected_provider_account_id": created.get("selected_provider_account_id"),
                "budgets_enforced": steering["budgets_enforced"],
                "seed": request.random_seed,
            },
        )
        return turn_id

    def _await_terminal(
        self,
        turn_id: str,
        task_id: str | None = None,
        timeout_seconds: float | None = None,
    ) -> str:
        deadline = time.monotonic() + min(
            self._config.timeout_seconds,
            timeout_seconds if timeout_seconds is not None else self._config.timeout_seconds,
        )
        current_turn_id = turn_id
        while time.monotonic() < deadline:
            # Task-level terminal states dominate: verification may fail the
            # task after the proposal settles. Automatic verification repair
            # supersedes that proposal with a distinct child turn, so follow
            # the task's durable continuation instead of returning ABORTED or
            # polling the dead parent forever.
            task: Mapping[str, Any] | None = None
            if task_id is not None:
                try:
                    task = self._request("GET", f"/v1/tasks/{task_id}")
                    task_status = task.get("status")
                    if isinstance(task_status, str) and task_status in _TERMINAL_TASK_STATES:
                        return task_status
                except TerminusControlError:
                    task = None

            repair_ids: list[str] = []
            if task is not None:
                active_turn = task.get("active_turn")
                if isinstance(active_turn, Mapping) and isinstance(active_turn.get("id"), str):
                    current_turn_id = str(active_turn["id"])
                else:
                    repair_attempts = task.get("repair_attempts")
                    if isinstance(repair_attempts, list):
                        for row in repair_attempts:
                            if not isinstance(row, Mapping):
                                continue
                            repair_turn_id = row.get("repair_turn_id")
                            if isinstance(repair_turn_id, str):
                                repair_ids.append(repair_turn_id)
                        if repair_ids:
                            current_turn_id = str(repair_ids[-1])

            turn = self._request("GET", f"/v1/turns/{current_turn_id}")
            state = turn.get("state")
            if isinstance(state, str) and state in TERMINAL_TURN_STATES:
                active_turn = task.get("active_turn") if task is not None else None
                if not isinstance(active_turn, Mapping):
                    # A proposal turn can settle while its task remains
                    # ACTIVE, notably while verification or a continuation
                    # has not been admitted yet. Do not turn that transient
                    # gap into a successful evaluation. A known repair turn
                    # keeps the existing continuation behavior.
                    task_status = task.get("status") if task is not None else None
                    if (
                        state == "COMPLETED"
                        and current_turn_id not in repair_ids
                        and isinstance(task_status, str)
                        and task_status not in _TERMINAL_TASK_STATES
                    ):
                        return _TASK_PENDING_STATE
                    return state
            time.sleep(self._config.poll_interval_seconds)
        # Timeout must not leave the remote turn running: interrupt, then
        # wait (bounded) for the terminal transition before returning so the
        # workspace stops mutating under the diff/grade steps.
        with contextlib.suppress(TerminusControlError):
            self._request(
                "POST", f"/v1/turns/{current_turn_id}/interrupt", {"reason": "harness-timeout"}
            )
        deadline = time.monotonic() + 60.0
        while time.monotonic() < deadline:
            try:
                turn = self._request("GET", f"/v1/turns/{current_turn_id}")
                state = turn.get("state")
                if isinstance(state, str) and state in TERMINAL_TURN_STATES:
                    return state
            except TerminusControlError:
                break
            time.sleep(self._config.poll_interval_seconds)
        return "TIMEOUT"

    # -- Evidence ----------------------------------------------------------

    def _collect_artifacts(self, task_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Split the task's artifact inventory into manifests and verification."""
        manifests: list[dict[str, Any]] = []
        verification: list[dict[str, Any]] = []
        try:
            page = self._request("GET", f"/v1/tasks/{task_id}/artifacts?limit=100")
        except TerminusControlError:
            return manifests, verification
        raw_items = page.get("artifacts")
        items = [a for a in raw_items if isinstance(a, dict)] if isinstance(raw_items, list) else []
        for artifact in items:
            # The inventory exposes ingest `purpose`, not a kind field.
            purpose = str(artifact.get("purpose") or "")
            if "verification" in purpose:
                verification.append(artifact)
            elif "context" in purpose or "manifest" in purpose:
                manifests.append(artifact)
        return manifests, verification

    def _collect_events(self, task_id: str) -> list[dict[str, Any]]:
        """Read the task's durable event log oldest-first.

        ``GET /v1/tasks/:id/transcript`` returns the newest page first and
        pages backwards through ``earlier_cursor``. There is no per-task event
        list route, so the transcript is the only replayable surface; the SSE
        stream would require having subscribed before the turn started.
        """
        collected: list[dict[str, Any]] = []
        cursor: str | None = None
        while len(collected) < _TRANSCRIPT_MAX_EVENTS:
            path = f"/v1/tasks/{task_id}/transcript?limit={_TRANSCRIPT_PAGE_LIMIT}"
            if cursor:
                path += f"&before={urllib.parse.quote(cursor)}"
            page = self._optional("GET", path)
            if page is None:
                break
            raw = page.get("events")
            events = [e for e in raw if isinstance(e, dict)] if isinstance(raw, list) else []
            if not events:
                break
            collected = events + collected
            cursor = page.get("earlier_cursor")
            if not isinstance(cursor, str) or not cursor:
                break
        return collected

    def _final_revision(self, workspace_id: str) -> str:
        try:
            status = self._request("GET", f"/v1/workspaces/{workspace_id}/revision")
            revision = status.get("revision")
            return revision if isinstance(revision, str) else "unknown"
        except TerminusControlError:
            return "unknown"

    def fetch_patch(self, task_id: str) -> dict[str, Any]:
        """Fetch the task workspace diff (R8 patch extraction).

        Returns the control plane's diff payload: unified diff against HEAD,
        untracked file list, and truncation flags. Raises
        :class:`TerminusControlError` when the workspace has no usable diff.
        """
        payload = self._request("GET", f"/v1/tasks/{task_id}/diff")
        if not isinstance(payload, Mapping):
            raise TerminusControlError("task diff endpoint returned a non-object payload")
        return {
            "diff": str(payload.get("diff") or ""),
            "untracked_files": list(payload.get("untracked_files") or []),
            "truncated": bool(payload.get("diff_truncated")),
            "git_available": bool(payload.get("git_available")),
        }

    @staticmethod
    def _map_outcome(state: str) -> Outcome:
        return {
            "COMPLETED": Outcome.COMPLETED,
            "FAILED": Outcome.FAILED,
            "FAILED_VERIFICATION": Outcome.FAILED,
            "POLICY_DENIED": Outcome.POLICY_DENIED,
            "BUDGET_EXHAUSTED": Outcome.BUDGET_EXHAUSTED,
            "INTERRUPTED": Outcome.CANCELLED,
            "ABORTED": Outcome.CANCELLED,
            "BLOCKED": Outcome.ABORTED,
            "CANCELLED": Outcome.CANCELLED,
            "TIMEOUT": Outcome.TIMEOUT,
            _TASK_PENDING_STATE: Outcome.ERROR,
        }.get(state, Outcome.ERROR)


_RECEIPT_USAGE_TOKEN_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
    "tool_schema_tokens",
)
_RECEIPT_USAGE_DURATION_FIELDS = ("latency_ms", "time_to_first_token_ms")
_RECEIPT_API_FIELDS = (
    "provider_attempt_id",
    "attempt_number",
    "model",
    "provider_id",
    "status",
    "usage",
    "finish_reason",
    "provider_request_id",
    "provider_reported_cost_micros",
    "computed_cost_micros",
    "cost_source",
    "started_at",
    "completed_at",
)


def _repair_turn_ids(original_turn_id: str, rows: Any) -> list[str] | None:
    """Validate and return the task route's ordered repair continuation chain."""
    if not isinstance(rows, list):
        return None

    turn_ids: list[str] = []
    previous_turn_id = original_turn_id
    for expected_attempt_number, row in enumerate(rows, start=1):
        if not isinstance(row, Mapping):
            return None
        attempt_number = row.get("attempt_number")
        parent_turn_id = row.get("parent_turn_id")
        repair_turn_id = row.get("repair_turn_id")
        if (
            isinstance(attempt_number, bool)
            or not isinstance(attempt_number, int)
            or attempt_number != expected_attempt_number
            or parent_turn_id != previous_turn_id
            or not isinstance(repair_turn_id, str)
            or not repair_turn_id.strip()
            or repair_turn_id == original_turn_id
            or repair_turn_id in turn_ids
        ):
            return None
        turn_ids.append(repair_turn_id)
        previous_turn_id = repair_turn_id
    return turn_ids


def provider_receipts_from_route(rows: Any) -> list[dict[str, Any]]:
    """Project the attempts route into opaque, immutable provider receipts.

    ``GET /v1/turns/:id/attempts`` is the control plane's typed accounting
    boundary.  The route's attempt id is Terminus' durable receipt identity;
    ``response_artifact``/``artifact_ref`` (when a newer server exposes one),
    then the provider request id, are preferred as the opaque artifact
    reference.  Older servers do not expose an artifact URI and failed
    provider calls may not have a provider request id, so the durable attempt
    id is the last-resort reference.  It is still an immutable server-side
    identity, and the original request id remains present in the receipt when
    available.

    This function is deliberately all-or-nothing.  A partial list can make a
    run appear to have complete accounting while silently dropping an attempt;
    returning no receipts instead leaves the release gate ineligible.  The
    route is allowed to add fields, but every currently documented field is
    copied without normalization so the run record remains an exact snapshot
    of the API response.
    """
    if not isinstance(rows, list) or not rows:
        return []

    receipts: list[dict[str, Any]] = []
    seen_attempt_ids: set[str] = set()
    seen_attempt_numbers: set[int] = set()
    previous_attempt_number = 0

    for row in rows:
        if not isinstance(row, Mapping):
            return []
        if not _valid_provider_attempt_row(row):
            return []

        attempt_id = row["provider_attempt_id"]
        attempt_number = row["attempt_number"]
        # The validation above establishes these concrete types without a
        # cast, keeping malformed JSON outside the receipt projection.
        if not isinstance(attempt_id, str) or not isinstance(attempt_number, int):
            return []
        if attempt_id in seen_attempt_ids or attempt_number in seen_attempt_numbers:
            return []
        if attempt_number <= previous_attempt_number:
            return []
        seen_attempt_ids.add(attempt_id)
        seen_attempt_numbers.add(attempt_number)
        previous_attempt_number = attempt_number

        artifact_ref = _first_nonempty_text(
            row.get("response_artifact"),
            row.get("artifact_ref"),
            row.get("provider_request_id"),
            attempt_id,
        )
        if artifact_ref is None:
            return []

        receipt: dict[str, Any] = {
            "receipt_id": attempt_id,
            "provider": row["provider_id"],
            "model": row["model"],
            "artifact_ref": artifact_ref,
            # `verified` means this adapter validated the authenticated,
            # immutable route shape.  Independent task grading remains a
            # separate HarnessResult field and is never inferred here.
            "verified": True,
        }
        for key in _RECEIPT_API_FIELDS:
            if key in row:
                value = row[key]
                receipt[key] = (
                    dict(value) if key == "usage" and isinstance(value, Mapping) else value
                )
        # A future control plane can expose the response artifact directly;
        # retain it rather than hiding a stronger immutable reference behind
        # the generic `artifact_ref` field.
        for key in ("response_artifact", "artifact_ref"):
            if key in row:
                receipt[key] = row[key]
        receipts.append(receipt)

    return receipts


def _receipt_projection_status(
    rows: Any,
    receipts: list[dict[str, Any]],
) -> str:
    """Name the receipt evidence boundary for run observability."""
    if rows is None:
        return "unavailable"
    if not isinstance(rows, list):
        return "malformed"
    if not rows:
        return "missing"
    return "complete" if len(receipts) == len(rows) else "malformed"


def _valid_provider_attempt_row(row: Mapping[str, Any]) -> bool:
    """Validate documented attempts-route fields before preserving them."""
    # The route writes nullable values explicitly.  A missing key is therefore
    # a schema regression, not the same thing as a legitimate null provider
    # request/cost/finish field.
    if any(key not in row for key in _RECEIPT_API_FIELDS):
        return False
    for key in ("provider_attempt_id", "model", "provider_id", "status", "started_at"):
        if not _nonempty_text(row.get(key)):
            return False
    attempt_number = row.get("attempt_number")
    if (
        not isinstance(attempt_number, int)
        or isinstance(attempt_number, bool)
        or attempt_number <= 0
    ):
        return False

    if not _valid_usage(row.get("usage")):
        return False
    for key in ("finish_reason", "provider_request_id", "cost_source", "completed_at"):
        if not _optional_text(row.get(key)):
            return False
    for key in ("provider_reported_cost_micros", "computed_cost_micros"):
        if not _optional_decimal(row.get(key)):
            return False
    for key in ("response_artifact", "artifact_ref"):
        if key in row and not _optional_text(row.get(key)):
            return False
    return True


def _valid_usage(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    if any(not _decimal(value.get(key)) for key in _RECEIPT_USAGE_TOKEN_FIELDS):
        return False
    for key in _RECEIPT_USAGE_DURATION_FIELDS:
        duration = value.get(key)
        if duration is None:
            continue
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            return False
        try:
            if not math.isfinite(duration) or duration < 0:
                return False
        except (OverflowError, ValueError):
            return False
    return True


def _decimal(value: Any) -> bool:
    return isinstance(value, str) and value.isascii() and value.isdecimal()


def _optional_decimal(value: Any) -> bool:
    return value is None or _decimal(value)


def _nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _optional_text(value: Any) -> bool:
    return value is None or _nonempty_text(value)


def _first_nonempty_text(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value
    return None


def _turn_budget(budgets: Budgets) -> dict[str, Any] | None:
    """Map :class:`Budgets` onto the turn budget ``POST /v1/turns`` accepts.

    Only positive limits are sent: the route rejects a non-positive value, and
    an all-null budget, so a caller that disabled a limit must omit the field
    rather than send a zero the server would refuse. Token counts cross as
    decimal strings, matching the rest of this API's BigInt encoding.
    """
    budget: dict[str, Any] = {}
    if budgets.max_tool_calls > 0:
        budget["max_steps"] = int(budgets.max_tool_calls)
    if budgets.max_total_tokens > 0:
        budget["max_tokens"] = str(int(budgets.max_total_tokens))
    cost_micros = round(budgets.max_cost_usd * 1_000_000)
    if cost_micros > 0:
        budget["max_cost_micros"] = str(cost_micros)
    return budget or None


def _read_yaml_mapping(path: Path, *, name: str) -> dict[str, Any]:
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise TerminusControlError(f"CONTRACT_ADMISSION_INVALID: unable to read {name}: {exc}") from exc
    if not isinstance(loaded, Mapping):
        raise TerminusControlError(f"CONTRACT_ADMISSION_INVALID: {name} must be a mapping")
    return dict(loaded)


def _read_optional_yaml_mapping(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    return _read_yaml_mapping(path, name="policy.yaml")


def _task_mapping(raw: Mapping[str, Any]) -> dict[str, Any]:
    nested = raw.get("task")
    if not isinstance(nested, Mapping):
        return dict(raw)
    merged = {key: value for key, value in raw.items() if key != "task"}
    merged.update(nested)
    return merged


def _declared_strings(value: Any, *, name: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (str, bytes)) or not isinstance(value, list):
        raise TerminusControlError(f"CONTRACT_ADMISSION_INVALID: {name} must be a list of strings")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise TerminusControlError(
            f"CONTRACT_ADMISSION_INVALID: {name} must contain non-empty strings"
        )
    return [item.strip() for item in value]


def _declared_scope(task: Mapping[str, Any]) -> dict[str, list[str]]:
    value = task.get("allowed_scope")
    if value is None:
        # The versioned schema calls this external systems list out separately;
        # accepting the older network spelling keeps packages source-compatible
        # while still putting it on the server's typed scope field.
        external = _declared_strings(task.get("allowed_network"), name="task allowed_network")
        scope = {"read_paths": ["**"], "write_paths": ["**"]}
        if external:
            scope["external_systems"] = external
        return scope
    if not isinstance(value, Mapping):
        raise TerminusControlError("CONTRACT_ADMISSION_INVALID: task allowed_scope must be a mapping")
    unknown = sorted(set(value) - {"read_paths", "write_paths", "external_systems"})
    if unknown:
        raise TerminusControlError(
            "CONTRACT_ADMISSION_INVALID: task allowed_scope has unknown fields: "
            + ", ".join(unknown)
        )
    scope = {
        "read_paths": _declared_strings(value.get("read_paths"), name="task read_paths"),
        "write_paths": _declared_strings(value.get("write_paths"), name="task write_paths"),
    }
    external = _declared_strings(value.get("external_systems"), name="task external_systems")
    if external:
        scope["external_systems"] = external
    return scope


def _default_scope() -> dict[str, list[str]]:
    return {"read_paths": ["**"], "write_paths": ["**"]}


def _cost_breakdown(
    metrics: TurnMetrics,
    prices: ModelPrices | None,
    *,
    provider_prices_the_turn: bool,
) -> CostBreakdown | None:
    """Turn reconciled usage plus a price table into a cost record.

    Returns ``None`` when no usage was recorded at all — a zero-dollar cost on
    a run whose token accounting is unavailable would read as "free", not as
    "unknown".

    ``provider_prices_the_turn`` is false for a subscription account: the plan
    has no per-token rate, so the control plane reports ``0`` and the only
    number available is this side's estimate from a price table. Reconciling an
    estimate against a zero the provider never claimed flagged **every**
    subscription run as an accounting anomaly, which is why an unreported cost
    is now null and unflagged, with ``source`` naming the table instead.
    """
    if metrics.token_source == "unavailable":
        return None
    computed = (
        compute_cost(
            prices,
            tokens_input_fresh=metrics.tokens_input_fresh,
            tokens_input_cached=metrics.tokens_input_cached,
            tokens_output=metrics.tokens_output,
            tokens_reasoning=metrics.tokens_reasoning,
        )
        if prices is not None
        else 0.0
    )
    reported_micros = metrics.provider_cost_micros
    if not provider_prices_the_turn or reported_micros is None:
        return CostBreakdown(
            provider_reported_usd=None,
            computed_usd=round(computed, 6),
            input_tokens=metrics.tokens_input_total,
            output_tokens=metrics.tokens_output,
            cached_tokens=metrics.tokens_input_cached,
            reasoning_tokens=metrics.tokens_reasoning,
            cache_write_tokens=metrics.tokens_cache_write,
            cache_read_tokens=metrics.tokens_input_cached,
            reconciliation_delta_usd=None,
            reconciliation_flagged=False,
            source=_estimate_source(prices),
        )
    provider_reported = reported_micros / 1_000_000.0
    delta = provider_reported - computed
    flagged = abs(delta) > 0.001 and abs(delta) > 0.01 * max(computed, 1e-9)
    return CostBreakdown(
        provider_reported_usd=round(provider_reported, 6),
        computed_usd=round(computed, 6),
        input_tokens=metrics.tokens_input_total,
        output_tokens=metrics.tokens_output,
        cached_tokens=metrics.tokens_input_cached,
        reasoning_tokens=metrics.tokens_reasoning,
        cache_write_tokens=metrics.tokens_cache_write,
        cache_read_tokens=metrics.tokens_input_cached,
        reconciliation_delta_usd=round(delta, 6),
        reconciliation_flagged=flagged,
        source="provider_reported",
    )


def catalog_model_entry(catalog: Mapping[str, Any] | None, model: str | None) -> dict[str, Any]:
    """The `/v1/provider-models` row for ``model``, or ``{}``."""
    if not model or not isinstance(catalog, Mapping):
        return {}
    models = catalog.get("models")
    if not isinstance(models, list):
        return {}
    wanted = model.strip().lower()
    for entry in models:
        if not isinstance(entry, Mapping):
            continue
        if wanted in {str(entry.get(key) or "").strip().lower() for key in ("id", "slug", "label")}:
            return dict(entry)
    return {}


def catalog_account_entry(
    catalog: Mapping[str, Any] | None, account_id: str | None
) -> dict[str, Any]:
    """The `/v1/provider-models` ``providers`` row for ``account_id``, or ``{}``."""
    if not account_id or not isinstance(catalog, Mapping):
        return {}
    providers = catalog.get("providers")
    if not isinstance(providers, list):
        return {}
    for entry in providers:
        if isinstance(entry, Mapping) and str(entry.get("id") or "") == account_id:
            return dict(entry)
    return {}


def live_model_snapshot(
    request: RunRequest,
    *,
    steering: Mapping[str, Any],
    catalog: Mapping[str, Any] | None,
    prices: ModelPrices | None,
) -> dict[str, Any]:
    """The model/provider identity a live run actually executed on.

    The request's own snapshot is a caller-supplied guess: `--provider`
    defaults to a placeholder and the context/output limits are constants. A
    record that says ``provider: "fake"``, ``context_window: 200000`` for a
    real GPT-5.6 turn is not evidence of anything, so every field the control
    plane can answer is taken from the resolved account and its catalogue row.
    """
    model = steering.get("model") or request.model_snapshot.model
    entry = catalog_model_entry(catalog, model)
    account = catalog_account_entry(catalog, steering.get("provider_account_id"))
    base = request.model_snapshot.to_dict()
    # Never a placeholder on a live record: the account's own display name,
    # then its vendor/source, and only then whatever the caller passed.
    provider = (
        str(account.get("label") or "")
        or str(account.get("source") or "")
        or str(entry.get("provider") or "")
    )
    context_tokens = _positive_int(entry.get("context_tokens"))
    output_tokens = _positive_int(entry.get("output_tokens"))
    snapshot: dict[str, Any] = {
        **base,
        "model": model,
        "provider": provider or base["provider"],
        "provider_account_id": steering.get("provider_account_id"),
        "provider_account_label": account.get("label"),
        "provider_account_source": account.get("source"),
        "billing": entry.get("billing") or account.get("billing"),
        "context_window": context_tokens if context_tokens is not None else base["context_window"],
        "max_output_tokens": (
            output_tokens if output_tokens is not None else base["max_output_tokens"]
        ),
        "reasoning_efforts": list(entry.get("reasoning_efforts") or []),
        "default_reasoning_effort": entry.get("default_reasoning_effort"),
        "selected_reasoning_effort": steering.get("reasoning_effort"),
        "pricing": prices.to_dict() if prices is not None else {},
        "pricing_source": prices.source if prices is not None else "unavailable",
        "catalog_pricing_source": entry.get("pricing_source"),
        "supports_tool_calls": bool(entry.get("tool_calling", base["supports_tool_calls"])),
        "capability_source": "control_plane:/v1/provider-models" if entry else "request",
    }
    return snapshot


def provider_prices_the_turn(catalog: Mapping[str, Any] | None, model: str | None) -> bool:
    """Whether the provider bills this model per token and reports the cost.

    A subscription account answers ``pricing: null`` /
    ``pricing_source: "subscription"``, meaning the plan has no per-token rate
    at all — the ``0`` it reports for a turn is the absence of a price, not a
    free turn.
    """
    entry = catalog_model_entry(catalog, model)
    if not entry:
        return False
    if str(entry.get("pricing_source") or "") == "subscription":
        return False
    return isinstance(entry.get("pricing"), Mapping)


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _estimate_source(prices: ModelPrices | None) -> str:
    """Name the price table an estimate came from, or say there was none."""
    if prices is None:
        return "unpriced"
    source = prices.source
    if source.startswith("registry"):
        return "registry_estimate"
    if source.startswith("control_plane"):
        return "catalog_estimate"
    if source.startswith("snapshot") or "models_dev" in source:
        return "snapshot_estimate"
    return f"estimate:{source}"
