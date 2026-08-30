"""SPEC §41.5 harness runner.

Drives a single harness (Terminus minimal, Terminus full, or external baseline)
through a benchmark task and produces a :class:`RunRecord`.

The runner is *harness-agnostic*: it talks to a :class:`Harness` interface
that knows how to start a fresh workspace, run the agent loop, and return
the final revision. The runner itself records the metadata that every run
needs (commit, model snapshot, environment digest, seed, budgets,
experiment assignments, timestamps, outcome, grader results, cost,
artifacts, manifests, trajectory).

The runner does **not** live in the production critical path (SPEC §43.3).
It runs in the offline eval plane only — typically driven by
:mod:`forge_evals.cli` or by the cross-harness comparator
(:mod:`forge_evals.runners.cross_harness`).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from ..evidence import EvidenceClass
from ..graders.end_state import EndStateGrader, EndStateGraderInput, WorkspaceSnapshot
from ..identity import EvaluationIdentity
from ..run_record import CostBreakdown, GraderResult, Outcome, RunRecord, utc_now
from .trajectory_recorder import TrajectoryRecorder

__all__ = [
    "Budgets",
    "EnvironmentDigest",
    "GraderOutcome",
    "Harness",
    "HarnessResult",
    "HarnessRunner",
    "ModelCapabilitySnapshot",
    "RunRequest",
    "apply_metrics_to_record",
    "build_evaluation_identity",
]


@dataclass(frozen=True)
class ModelCapabilitySnapshot:
    """SPEC §41.5 ``model_capability_snapshot`` — pinned model/provider info."""

    provider: str
    model: str
    api_version: str
    context_window: int
    max_output_tokens: int
    supports_tool_calls: bool
    supports_streaming: bool
    supports_cache: bool
    pricing: dict[str, float] = field(default_factory=dict)  # per-1M-token rates in USD

    def to_dict(self) -> dict[str, Any]:
        """Plain dict form for run record storage."""
        return {
            "provider": self.provider,
            "model": self.model,
            "api_version": self.api_version,
            "context_window": self.context_window,
            "max_output_tokens": self.max_output_tokens,
            "supports_tool_calls": self.supports_tool_calls,
            "supports_streaming": self.supports_streaming,
            "supports_cache": self.supports_cache,
            "pricing": dict(self.pricing),
        }


@dataclass(frozen=True)
class EnvironmentDigest:
    """SPEC §41.5 ``environment_digest`` — content hash of the run environment."""

    source_commit: str
    image_digest: str
    setup_script_hash: str
    environment_lock_hash: str

    def to_digest(self) -> str:
        """A single SHA-256 digest over all four inputs."""
        h = hashlib.sha256()
        for part in (
            self.source_commit,
            self.image_digest,
            self.setup_script_hash,
            self.environment_lock_hash,
        ):
            h.update(part.encode("utf-8"))
            h.update(b"\x00")
        return "sha256:" + h.hexdigest()

    @classmethod
    def from_task_dir(cls, task_dir: Path | str) -> EnvironmentDigest:
        """Build an EnvironmentDigest by hashing the files in a task package."""
        d = Path(task_dir)
        source_commit = _read_or(d / "task.yaml", default_field="source_commit")
        image_digest = _read_or(d / "task.yaml", default_field="image_digest")
        setup_hash = _hash_file(d / "setup.sh")
        lock_hash = _hash_file(d / "environment.lock")
        return cls(
            source_commit=source_commit,
            image_digest=image_digest,
            setup_script_hash=setup_hash,
            environment_lock_hash=lock_hash,
        )


def _hash_file(p: Path) -> str:
    if not p.exists():
        return "sha256:"
    return "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()


def _read_or(p: Path, default_field: str) -> str:
    """Read a field from a YAML file; return a placeholder if missing."""
    if not p.exists():
        return f"{default_field}=missing"
    try:
        import yaml

        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        val = data.get(default_field)
        return str(val) if val is not None else f"{default_field}=unset"
    except Exception:  # pragma: no cover — defensive
        return f"{default_field}=unreadable"


@dataclass(frozen=True)
class Budgets:
    """SPEC §41.5 ``budgets`` — token, cost, time, and tool limits."""

    max_input_tokens: int = 1_000_000
    max_output_tokens: int = 100_000
    max_total_tokens: int = 2_000_000
    max_cost_usd: float = 5.0
    max_wall_seconds: int = 1800
    max_tool_calls: int = 200
    max_turns: int = 30

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_input_tokens": self.max_input_tokens,
            "max_output_tokens": self.max_output_tokens,
            "max_total_tokens": self.max_total_tokens,
            "max_cost_usd": self.max_cost_usd,
            "max_wall_seconds": self.max_wall_seconds,
            "max_tool_calls": self.max_tool_calls,
            "max_turns": self.max_turns,
        }


@dataclass(frozen=True)
class RunRequest:
    """A single run request — one (task, harness, seed) triple."""

    suite: str
    task: str
    task_dir: Path
    harness_id: str
    harness_commit: str
    model_snapshot: ModelCapabilitySnapshot
    random_seed: int
    budgets: Budgets = field(default_factory=Budgets)
    experiment_assignments: list[dict[str, Any]] = field(default_factory=list)
    # Live steering. `reasoning_effort` is one of low|medium|high|max and maps
    # to the control plane's `reasoning_effort` / `default_reasoning_effort`;
    # `provider_account_id` pins which discovered account serves the model.
    # Both are None for fixture harnesses, which have nothing to steer.
    reasoning_effort: str | None = None
    provider_account_id: str | None = None
    # An instruction supplied by the caller rather than by a `prompt.md` in the
    # task package. External harnesses (Harbor) hand the instruction over as a
    # string, and writing it into the workspace would pollute the very tree the
    # benchmark's own tests inspect.
    instruction: str | None = None
    # The task package directory, when it differs from the workspace. Internal
    # fixtures are built by `setup.sh` into a scratch workspace, so the prompt,
    # acceptance criteria, grader and `task.yaml` identity all live here while
    # `task_dir` is what the agent may edit.
    task_package_dir: Path | None = None
    # Optional identity inputs. Missing policy/config inputs are recorded as
    # explicit markers and make paired promotion ineligible.
    task_version: str | None = None
    repository_digest: str | None = None
    model_version: str | None = None
    sampling_config_hash: str | None = None
    sandbox_policy_hash: str | None = None
    network_policy: str | None = None
    tool_schema_hash: str | None = None
    instruction_hash: str | None = None
    harness_config_hash: str | None = None
    # Release comparisons must identify the partition explicitly.  Leaving it
    # unset is safe for local fixtures and ineligible for release promotion.
    holdout_partition: str | None = None


def build_evaluation_identity(
    request: RunRequest,
    *,
    environment_digest: str,
    model_snapshot: Mapping[str, Any] | None = None,
) -> EvaluationIdentity:
    """Derive the locked identity used by the runner's actual run path.

    Explicit request fields win. The runner derives stable hashes for model,
    budgets, and experiment assignments. Policy and task fields that are not
    supplied are marked as missing instead of being replaced with guessed
    values, so the resulting record cannot qualify for promotion by accident.
    """
    package_dir = request.task_package_dir or request.task_dir
    resolved_model_snapshot = (
        dict(model_snapshot)
        if model_snapshot is not None
        else request.model_snapshot.to_dict()
    )
    source_commit = _read_or(package_dir / "task.yaml", "source_commit")
    if source_commit.startswith("source_commit="):
        source_commit = "missing:task_source_commit"
    task_version = request.task_version or source_commit
    repository_digest = request.repository_digest or source_commit
    return EvaluationIdentity(
        task_id=request.task,
        task_version=task_version,
        repository_digest=repository_digest,
        environment_digest=environment_digest,
        harness_id=request.harness_id,
        harness_commit=request.harness_commit,
        harness_config_hash=request.harness_config_hash
        or _stable_hash(
            {"harness_id": request.harness_id, "assignments": request.experiment_assignments}
        ),
        provider=str(resolved_model_snapshot.get("provider") or request.model_snapshot.provider),
        model=str(resolved_model_snapshot.get("model") or request.model_snapshot.model),
        model_version=request.model_version
        or str(resolved_model_snapshot.get("api_version") or request.model_snapshot.api_version),
        model_capability_snapshot_hash=_stable_hash(resolved_model_snapshot),
        random_seed=request.random_seed,
        sampling_config_hash=request.sampling_config_hash
        or _stable_hash(request.experiment_assignments),
        sandbox_policy_hash=request.sandbox_policy_hash or "missing:sandbox_policy_hash",
        network_policy=request.network_policy or "missing:network_policy",
        budget_hash=_stable_hash(request.budgets.to_dict()),
        tool_schema_hash=request.tool_schema_hash or "missing:tool_schema_hash",
        instruction_hash=request.instruction_hash or "missing:instruction_hash",
    )


def _stable_hash(value: object) -> str:
    """Hash JSON-compatible identity inputs with one canonical encoding."""
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class GraderOutcome:
    """A grader's verdict on a finished run."""

    grader_id: str
    grader_version: str
    passed: bool
    score: float
    evidence: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HarnessResult:
    """The outcome of running a harness on a task.

    The harness is responsible for filling in everything except the fields
    the runner itself owns (timestamps, run id, environment digest).
    """

    outcome: Outcome
    final_revision: str  # git commit hash of the agent's final state
    cost: CostBreakdown | None
    artifacts: list[dict[str, Any]]
    context_manifests: list[dict[str, Any]]
    grader_outcomes: list[GraderOutcome]
    notes: str = ""
    # Reconciled first-class metrics (tokens, steps, tool errors, repairs,
    # TTFT, stop reason, verification verdict). The runner lifts these onto
    # the run record's own columns; they are never left to `notes`.
    metrics: dict[str, Any] = field(default_factory=dict)
    # External harnesses may replace the task-package fallback with a digest
    # resolved from the actual image/environment they executed.
    environment_digest: str | None = None
    evidence_class: EvidenceClass = EvidenceClass.FIXTURE_ONLY
    independently_verified: bool = False
    provider_receipts: list[dict[str, Any]] = field(default_factory=list)


class Harness(Protocol):
    """Interface that any harness — Terminus or external — must implement.

    The harness is given a :class:`RunRequest` and a
    :class:`TrajectoryRecorder` (already initialized with the run id). It
    runs the agent loop and returns a :class:`HarnessResult`.

    Concrete harnesses live in adapters (SPEC §41.2). The Python eval lab
    ships a :class:`FakeScriptHarness` for tests and the
    :class:`cross_harness` comparator; production harness adapters wrap the
    real Terminus control plane.
    """

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        """Run the harness on ``request`` and return the result."""
        ...


# ──────────────────────────── the runner ──────────────────────────────────


class HarnessRunner:
    """Drives a single harness through one task.

    Usage::

        runner = HarnessRunner(harness=MyHarness())
        record = runner.run(request)
        record.to_json("out/run-<id>.json")

    The runner optionally accepts a list of end-state graders. When the
    harness finishes, the runner builds an :class:`EndStateGraderInput`
    from the trajectory (final workspace state, commands executed, files
    changed) and calls each grader's ``.grade()`` method, collecting
    results into ``record.grader_results``. This closes the security
    gap noted in audit A3 — without this wiring, graders were never
    invoked on real runs.

    Grader outcomes returned by the harness (``HarnessResult.grader_outcomes``)
    are *also* collected, so harnesses that already invoke graders
    internally continue to work. Outcomes from both paths are merged
    (harness outcomes first, then runner-invoke outcomes).
    """

    def __init__(
        self,
        harness: Harness,
        graders: list[EndStateGrader] | None = None,
        *,
        workspace_root: Path | None = None,
        objective: str = "",
        acceptance_criteria: list[str] | None = None,
        risk_class: str = "normal",
    ) -> None:
        """Initialize the runner.

        Args:
            harness: The harness to drive.
            graders: Optional list of :class:`EndStateGrader` instances to
                invoke after the run completes. Security graders from
                :mod:`forge_evals.graders.security_graders` are typical
                here. If ``None``, only the harness's own grader outcomes
                are recorded.
            workspace_root: The workspace root for graders that need it
                (e.g. :class:`WorkspaceEscapeGrader`). Defaults to the
                task directory.
            objective: The task objective, passed to graders.
            acceptance_criteria: The task acceptance criteria, passed to graders.
            risk_class: The task risk class, passed to graders.
        """
        self.harness: Harness = harness
        self.graders: list[EndStateGrader] = list(graders or [])
        self.workspace_root: Path | None = workspace_root
        self.objective: str = objective
        self.acceptance_criteria: list[str] = list(acceptance_criteria or [])
        self.risk_class: str = risk_class

    def run(self, request: RunRequest) -> RunRecord:
        """Run the harness and produce a fully populated :class:`RunRecord`."""
        env_digest = EnvironmentDigest.from_task_dir(request.task_dir)
        # Build the initial run record (no end timestamp yet).
        record = RunRecord.new(
            suite=request.suite,
            task=request.task,
            harness=request.harness_id,
            harness_commit=request.harness_commit,
            environment_digest=env_digest.to_digest(),
            random_seed=request.random_seed,
            model_capability_snapshot=request.model_snapshot.to_dict(),
            budgets=request.budgets.to_dict(),
            evaluation_identity=build_evaluation_identity(
                request,
                environment_digest=env_digest.to_digest(),
            ),
            holdout_partition=request.holdout_partition,
        )
        record.experiment_assignments = list(request.experiment_assignments)

        recorder = TrajectoryRecorder(run_id=record.run_id)
        recorder.record_run_started(
            suite=request.suite,
            task=request.task,
            harness=request.harness_id,
            seed=request.random_seed,
        )

        # Drive the harness.
        try:
            result = self.harness.run(request, recorder)
            outcome = result.outcome
        except TimeoutError:
            outcome = Outcome.TIMEOUT
            result = HarnessResult(
                outcome=outcome,
                final_revision="",
                cost=None,
                artifacts=[],
                context_manifests=[],
                grader_outcomes=[],
                notes="harness raised TimeoutError",
            )
        except Exception as exc:  # pragma: no cover — defensive
            outcome = Outcome.ERROR
            result = HarnessResult(
                outcome=outcome,
                final_revision="",
                cost=None,
                artifacts=[],
                context_manifests=[],
                grader_outcomes=[],
                notes=f"harness raised {type(exc).__name__}: {exc}",
            )

        # Populate the record with the harness result.
        record.outcome = outcome
        if result.environment_digest is not None:
            record.environment_digest = result.environment_digest
            if record.evaluation_identity is not None:
                record.evaluation_identity = replace(
                    record.evaluation_identity,
                    environment_digest=record.environment_digest,
                )
        record.end = utc_now()
        record.cost = result.cost
        record.artifacts = list(result.artifacts)
        record.context_manifests = list(result.context_manifests)
        record.grader_results = [
            GraderResult(
                grader_id=g.grader_id,
                grader_version=g.grader_version,
                passed=g.passed,
                score=g.score,
                evidence=list(g.evidence),
                metadata=dict(g.metadata),
            )
            for g in result.grader_outcomes
        ]
        record.notes = result.notes
        apply_metrics_to_record(record, result.metrics)
        record.evidence_class = result.evidence_class
        record.independently_verified = result.independently_verified
        record.provider_receipts = list(result.provider_receipts)

        recorder.record_run_ended(
            outcome=outcome.value,
            duration_seconds=record.duration_seconds,
        )
        record.trajectory = recorder.to_dicts()

        # ── wire graders ──────────────────────────────────────────────────
        # If the runner was configured with graders, build an EndStateGraderInput
        # from the trajectory + workspace and invoke each grader. This closes
        # the audit A3 gap where security graders were written but never
        # invoked on real runs.
        if self.graders:
            grader_input = self._build_grader_input(request, result, record.trajectory)
            for grader in self.graders:
                try:
                    grader_result = grader.grade(grader_input)
                except Exception as exc:  # pragma: no cover — defensive
                    # A grader failure must never mask the run result.
                    grader_result = GraderResult(
                        grader_id=getattr(grader, "grader_id", "unknown"),
                        grader_version=getattr(grader, "grader_version", "0.0.0"),
                        passed=False,
                        score=0.0,
                        evidence=[f"grader raised {type(exc).__name__}: {exc}"],
                        metadata={"grader_error": str(exc)},
                    )
                record.grader_results.append(grader_result)

        return record

    def _build_grader_input(
        self,
        request: RunRequest,
        result: HarnessResult,
        trajectory: list[dict[str, Any]],
    ) -> EndStateGraderInput:
        """Build an :class:`EndStateGraderInput` from the trajectory and run state.

        The graders see:
        - ``snapshot.workdir`` — the task directory (or the configured workspace root).
        - ``snapshot.final_revision`` — the agent's final revision (from the harness result).
        - ``snapshot.baseline_revision`` — the source commit from ``task.yaml`` (or empty).
        - ``metadata['trajectory']`` — the recorded trajectory events, with
          ``payload`` as plain dicts (see :class:`TrajectoryEvent`).
        - ``metadata['commands_executed']`` — list of shell commands from
          ``side_effect.started``/``side_effect.settled`` events.
        - ``metadata['files_changed']`` — list of paths from ``tool.settled`` events.
        """
        workdir = self.workspace_root or request.task_dir
        baseline_revision = ""
        try:
            import yaml

            task_yaml = request.task_dir / "task.yaml"
            if task_yaml.exists():
                data = yaml.safe_load(task_yaml.read_text(encoding="utf-8")) or {}
                baseline_revision = str(data.get("source_commit", "") or "")
        except Exception:  # pragma: no cover — defensive
            pass

        commands: list[str] = []
        files_changed: list[str] = []
        for ev in trajectory:
            et = ev.get("event_type")
            payload = ev.get("payload")
            if not isinstance(payload, dict):
                continue
            if et == "side_effect.started":
                # Only count each command once (started event; settled event
                # also carries the command but we skip it to avoid dupes).
                cmd = payload.get("command") or payload.get("argv")
                if isinstance(cmd, (str, list)):
                    cmd_str = cmd if isinstance(cmd, str) else " ".join(str(x) for x in cmd)
                    if cmd_str not in commands:
                        commands.append(cmd_str)
            if et in ("tool.settled", "tool.proposed"):
                args = payload.get("arguments")
                if isinstance(args, dict):
                    for v in args.values():
                        if (
                            isinstance(v, str)
                            and ("/" in v or v.endswith(".py") or v.endswith(".sh"))
                            and v not in files_changed
                        ):
                            files_changed.append(v)
                path = payload.get("path")
                if isinstance(path, str) and path not in files_changed:
                    files_changed.append(path)

        snapshot = WorkspaceSnapshot(
            workdir=workdir,
            final_revision=result.final_revision,
            baseline_revision=baseline_revision,
        )
        metadata: dict[str, Any] = {
            "trajectory": trajectory,
            "commands_executed": commands,
            "files_changed": files_changed,
            "task_dir": str(request.task_dir),
            "suite": request.suite,
            "task": request.task,
            "harness": request.harness_id,
            "seed": request.random_seed,
        }
        return EndStateGraderInput(
            snapshot=snapshot,
            objective=self.objective or f"Task {request.task} in suite {request.suite}",
            acceptance_criteria=self.acceptance_criteria,
            risk_class=self.risk_class,
            metadata=metadata,
        )




def apply_metrics_to_record(record: RunRecord, metrics: Mapping[str, Any] | None) -> None:
    """Lift a harness's reconciled metrics onto the run record's own columns.

    Values the harness could not measure stay absent so that "not measured"
    and "measured as zero" remain distinguishable.
    """
    if not isinstance(metrics, Mapping) or not metrics:
        return
    for field_name in (
        "tokens_input_fresh",
        "tokens_input_cached",
        "tokens_output",
        "tokens_reasoning",
        "steps",
        "repair_turns",
    ):
        value = metrics.get(field_name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            setattr(record, field_name, int(value))
    for field_name in ("cache_hit_ratio", "tool_error_rate"):
        value = metrics.get(field_name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            setattr(record, field_name, float(value))
    for field_name in ("ttft_ms", "wall_clock_ms"):
        value = metrics.get(field_name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            setattr(record, field_name, int(value))
    stop_reason = metrics.get("stop_reason")
    if isinstance(stop_reason, str) and stop_reason:
        record.stop_reason = stop_reason
    verdict = metrics.get("verdict")
    if isinstance(verdict, Mapping):
        record.harness_verdict = dict(verdict)


# ──────────────────────────── fake harness (for tests) ────────────────────


@dataclass
class FakeScriptHarness:
    """A scripted harness used by tests and the cross-harness comparator.

    The harness does not actually run an agent — it returns a pre-baked
    :class:`HarnessResult`. Pair with the fake provider for fully
    deterministic runs.
    """

    result: HarnessResult
    sleep_seconds: float = 0.0

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        """Record a few lifecycle events and return the scripted result."""
        import time

        recorder.record("task.activated", {"task": request.task})
        recorder.record("turn.started", {"turn": 1})
        recorder.record("turn.context_compiling", {"turn": 1})
        recorder.record(
            "context.manifest_persisted",
            {
                "manifest_id": "m-1",
                "token_budget": request.budgets.max_input_tokens,
                "fragment_count": 4,
            },
        )
        recorder.record("turn.provider_running", {"turn": 1})
        recorder.record_provider_chunk(attempt_id="a-1", chunk_kind="text", text="hello")
        recorder.record("turn.response_validating", {"turn": 1})
        recorder.record_tool_proposed(
            tool_call_id="c-1", tool_name="edit", arguments={"path": "a.py"}
        )
        recorder.record_tool_authorized(
            tool_call_id="c-1", decision="allow", rules=["allow-local-tests"]
        )
        recorder.record_tool_settled(
            tool_call_id="c-1", success=True, result_artifact_hash="sha256:abc"
        )
        recorder.record("turn.finalizing", {"turn": 1})
        recorder.record("turn.completed", {"turn": 1})
        if self.sleep_seconds:
            time.sleep(self.sleep_seconds)
        return self.result


def make_default_cost(
    usage: Mapping[str, int | float], pricing: Mapping[str, float]
) -> CostBreakdown:
    """Build a :class:`CostBreakdown` by computing cost from usage and pricing.

    ``pricing`` keys: ``input``, ``output``, ``cached``, ``reasoning``,
    ``cache_write``, ``cache_read`` — each a per-1M-token USD rate.
    """
    input_tokens = int(usage.get("input_tokens", 0))
    output_tokens = int(usage.get("output_tokens", 0))
    cached_tokens = int(usage.get("cached_tokens", 0))
    reasoning_tokens = int(usage.get("reasoning_tokens", 0))
    cache_write_tokens = int(usage.get("cache_write_tokens", 0))
    cache_read_tokens = int(usage.get("cache_read_tokens", 0))

    def _cost(key: str, tokens: int) -> float:
        rate = pricing.get(key, 0.0)
        return tokens / 1_000_000 * rate

    computed = (
        _cost("input", input_tokens)
        + _cost("output", output_tokens)
        + _cost("cached", cached_tokens)
        + _cost("reasoning", reasoning_tokens)
        + _cost("cache_write", cache_write_tokens)
        + _cost("cache_read", cache_read_tokens)
    )
    provider_reported_raw = usage.get("_provider_reported_usd")
    provider_reported = (
        float(provider_reported_raw) if provider_reported_raw is not None else computed
    )
    delta = provider_reported - computed
    flagged = abs(delta) > 0.001 and abs(delta) > 0.01 * max(computed, 1e-9)
    return CostBreakdown(
        provider_reported_usd=round(provider_reported, 6),
        computed_usd=round(computed, 6),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_tokens=cached_tokens,
        reasoning_tokens=reasoning_tokens,
        cache_write_tokens=cache_write_tokens,
        cache_read_tokens=cache_read_tokens,
        reconciliation_delta_usd=round(delta, 6),
        reconciliation_flagged=flagged,
    )


def now_utc() -> datetime:
    """Timezone-aware UTC now (re-exported for harness adapters)."""
    return datetime.now(UTC)


def to_jsonable(obj: Any) -> Any:
    """Best-effort conversion to JSON-safe values (re-exported for adapters)."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    return obj


def dumps(obj: Any) -> str:
    """JSON-dump with sorted keys (re-exported for adapters)."""
    return json.dumps(to_jsonable(obj), sort_keys=True)
