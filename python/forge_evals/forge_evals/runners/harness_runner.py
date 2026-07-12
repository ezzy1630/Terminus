"""SPEC §41.5 harness runner.

Drives a single harness (Forge minimal, Forge full, or external baseline)
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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

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


class Harness(Protocol):
    """Interface that any harness — Forge or external — must implement.

    The harness is given a :class:`RunRequest` and a
    :class:`TrajectoryRecorder` (already initialized with the run id). It
    runs the agent loop and returns a :class:`HarnessResult`.

    Concrete harnesses live in adapters (SPEC §41.2). The Python eval lab
    ships a :class:`FakeScriptHarness` for tests and the
    :class:`cross_harness` comparator; production harness adapters wrap the
    real Forge control plane.
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
    """

    def __init__(self, harness: Harness) -> None:
        self.harness: Harness = harness

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

        recorder.record_run_ended(
            outcome=outcome.value,
            duration_seconds=record.duration_seconds,
        )
        record.trajectory = recorder.to_dicts()

        return record


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
            {"manifest_id": "m-1", "token_budget": request.budgets.max_input_tokens,
             "fragment_count": 4},
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


def make_default_cost(usage: dict[str, int], pricing: dict[str, float]) -> CostBreakdown:
    """Build a :class:`CostBreakdown` by computing cost from usage and pricing.

    ``pricing`` keys: ``input``, ``output``, ``cached``, ``reasoning``,
    ``cache_write``, ``cache_read`` — each a per-1M-token USD rate.
    """
    input_tokens = usage.get("input_tokens", 0)
    output_tokens = usage.get("output_tokens", 0)
    cached_tokens = usage.get("cached_tokens", 0)
    reasoning_tokens = usage.get("reasoning_tokens", 0)
    cache_write_tokens = usage.get("cache_write_tokens", 0)
    cache_read_tokens = usage.get("cache_read_tokens", 0)

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
    provider_reported = usage.pop("_provider_reported_usd", None)
    if provider_reported is None:
        provider_reported = computed
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
    return datetime.now(timezone.utc)


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
