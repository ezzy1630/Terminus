"""SPEC §41.5 run record schema.

A ``RunRecord`` is the immutable unit of evaluation evidence. Every Terminus
evaluation run — whether harness-controlled, product-comparison, or component
ablation — emits exactly one ``RunRecord`` per (task, harness, seed) triple.

The schema matches SPEC §41.5 exactly. Records serialize to JSON (single files
or JSONL streams) and to Parquet (columnar, for batch analysis).

This module is provider- and harness-agnostic. ``RunRecord`` does not import
runner code so that records remain loadable without the runner graph present.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

from .evidence import EvidenceClass
from .identity import EvaluationIdentity

__all__ = [
    "CostBreakdown",
    "EvaluationIdentity",
    "EvidenceClass",
    "GraderResult",
    "Outcome",
    "RunRecord",
    "RunRecordError",
    "utc_now",
]


def utc_now() -> datetime:
    """Return a timezone-aware UTC ``datetime``."""
    return datetime.now(UTC)


class Outcome(StrEnum):
    """Terminal task outcomes (SPEC §41.5, §15.x)."""

    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"
    TIMEOUT = "timeout"
    BUDGET_EXHAUSTED = "budget_exhausted"
    POLICY_DENIED = "policy_denied"
    ERROR = "error"
    CANCELLED = "cancelled"
    MISSING = "missing"  # for absent/lost runs — never silently dropped (SPEC §41.6)


class RunRecordError(ValueError):
    """Raised when a run record is invalid or fails to serialize."""


@dataclass(frozen=True)
class GraderResult:
    """A single grader's verdict on a finished run.

    Grader code is **never** projected into model context (SPEC §41.5):
    grader identity here is a stable string id, not a code pointer.
    """

    grader_id: str
    grader_version: str
    passed: bool
    score: float  # in [0.0, 1.0]
    evidence: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not 0.0 <= self.score <= 1.0:
            raise RunRecordError(f"score must be in [0,1], got {self.score}")
        if not self.grader_id:
            raise RunRecordError("grader_id is required")


@dataclass(frozen=True)
class CostBreakdown:
    """Reconciliation of provider-reported cost vs computed cost (SPEC §41.5)."""

    # Null, not zero. A subscription plan (the ChatGPT/Codex path) has no
    # per-token price to report, and recording 0.0 there made every such run
    # look like a 100% accounting anomaly against its own estimate.
    provider_reported_usd: float | None
    computed_usd: float
    input_tokens: int
    output_tokens: int
    cached_tokens: int = 0
    reasoning_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    # If the two disagree beyond this tolerance we flag an accounting anomaly.
    # Both stay null when there is nothing to reconcile against.
    reconciliation_delta_usd: float | None = 0.0
    reconciliation_flagged: bool = False
    # Where `computed_usd` came from: `provider_reported` when the provider
    # priced the turn itself, otherwise the price table that was used.
    source: str = "provider_reported"


@dataclass
class RunRecord:
    """SPEC §41.5 run record.

    Fields mirror the YAML schema in SPEC §41.5 exactly. ``trajectory`` and
    ``context_manifests`` can grow large; prefer ``to_parquet`` for full
    fidelity and ``to_json`` for compact interchange.
    """

    run_id: str
    suite: str
    task: str
    harness: str
    harness_commit: str
    model_capability_snapshot: dict[str, Any]
    environment_digest: str
    random_seed: int
    budgets: dict[str, Any]
    experiment_assignments: list[dict[str, Any]] = field(default_factory=list)
    start: datetime = field(default_factory=utc_now)
    end: datetime | None = None
    outcome: Outcome = Outcome.MISSING
    grader_results: list[GraderResult] = field(default_factory=list)
    cost: CostBreakdown | None = None
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    context_manifests: list[dict[str, Any]] = field(default_factory=list)
    trajectory: list[dict[str, Any]] = field(default_factory=list)
    notes: str = ""
    # ── first-class run metrics (Phase 0 item 11) ─────────────────────────
    # Reconciled from provider usage and the control plane's event log. They
    # are columns, not prose: `notes` is never the storage site for a number
    # the promotion gate has to read.
    tokens_input_fresh: int = 0
    tokens_input_cached: int = 0
    tokens_output: int = 0
    tokens_reasoning: int = 0
    cache_hit_ratio: float | None = None
    steps: int = 0
    tool_error_rate: float | None = None
    repair_turns: int = 0
    ttft_ms: int | None = None
    wall_clock_ms: int | None = None
    stop_reason: str | None = None
    # What the harness itself believed about the run (verification admitted /
    # failed / not_runnable). Recorded so "harness thinks it passed" can be
    # compared against "grader says it passed" — it never sets `success`.
    harness_verdict: dict[str, Any] = field(default_factory=dict)
    # Per-attempt provider accounting (`GET /v1/turns/:id/attempts`). Kept as
    # a first-class column so cache behaviour across a turn's attempts is
    # inspectable offline without replaying the event log.
    attempts: list[dict[str, Any]] = field(default_factory=list)
    # The commit the workspace started from. Every diff in this record is
    # taken against it, and a run whose fixture was never committed cannot be
    # verified by a control plane that reads `git rev-parse HEAD`.
    workspace_base_commit: str | None = None
    # Required for model-fixed promotion; legacy/fixture records remain
    # readable but are ineligible until this is supplied.
    evaluation_identity: EvaluationIdentity | None = None
    # Provenance is explicit.  Existing records default to fixture-only and
    # therefore cannot satisfy a live release gate by accident.
    evidence_class: EvidenceClass = EvidenceClass.FIXTURE_ONLY
    holdout_partition: str | None = None
    independently_verified: bool = False
    provider_receipts: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.run_id:
            raise RunRecordError("run_id is required")
        if self.random_seed < 0:
            raise RunRecordError("random_seed must be non-negative")
        if self.end is not None and self.end < self.start:
            raise RunRecordError("end is before start")

    # ──────────────────────── convenience ──────────────────────────────────

    @property
    def duration_seconds(self) -> float:
        """Wall-clock duration in seconds (``end - start``)."""
        end = self.end or utc_now()
        return (end - self.start).total_seconds()

    @property
    def passed(self) -> bool:
        """True iff outcome is ``COMPLETED`` and all graders passed."""
        return self.outcome is Outcome.COMPLETED and all(g.passed for g in self.grader_results)

    @property
    def success(self) -> bool:
        """The graders' verdict, independent of what the harness claimed.

        A run with no grader result is **not** a success: absence of a verdict
        is not evidence of one (anti-gaming rule). The harness's own opinion
        lives in :attr:`harness_verdict` and is deliberately not consulted.
        """
        return bool(self.grader_results) and all(g.passed for g in self.grader_results)

    @property
    def harness_grader_disagreement(self) -> bool:
        """Whether the harness and the graders reached different conclusions.

        The rule is a plain XOR: ``grader passed`` against ``the harness
        reached an admitted completion``. Anything other than ``admitted:
        true`` — failed, not runnable, or the ``unknown`` a crashed loop
        leaves behind — is *not* an admitted completion, so a passing grader
        over a turn that died in ``agent_loop_error`` is surfaced instead of
        being read as agreement. ``harness_verdict.status`` keeps the detail.

        A run with no grader verdict has nothing to disagree with.
        """
        if not self.grader_results:
            return False
        return self.success != (self.harness_verdict.get("admitted") is True)

    @property
    def primary_score(self) -> float:
        """Mean grader score (0.0 if no graders ran)."""
        if not self.grader_results:
            return 0.0
        return sum(g.score for g in self.grader_results) / len(self.grader_results)

    # ──────────────────────── serialization ────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        """Convert to a plain dict suitable for JSON / Parquet / DataFrame."""
        d: dict[str, Any] = asdict(self)
        # Replace non-JSON-native types.
        d["outcome"] = self.outcome.value
        d["start"] = self.start.isoformat()
        d["end"] = self.end.isoformat() if self.end else None
        d["cost"] = asdict(self.cost) if self.cost else None
        d["grader_results"] = [asdict(g) for g in self.grader_results]
        d["evaluation_identity"] = self.evaluation_identity.to_dict() if self.evaluation_identity else None
        d["evidence_class"] = self.evidence_class.value
        # Derived verdict fields are serialized so a reader of the record file
        # never has to re-implement the "graders decide, not the harness" rule.
        d["success"] = self.success
        d["primary_score"] = self.primary_score
        d["harness_grader_disagreement"] = self.harness_grader_disagreement
        return d

    def to_json(self, path: Path | str) -> Path:
        """Write this record as pretty JSON to ``path``."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True), encoding="utf-8")
        return p

    def to_jsonl_line(self) -> str:
        """Serialize as a single JSONL line (no trailing newline)."""
        return json.dumps(self.to_dict(), sort_keys=True)

    def to_parquet(self, path: Path | str) -> Path:
        """Write this record as a single-row Parquet file.

        Heavy nested fields (``trajectory``, ``context_manifests``) are stored
        as JSON strings in Parquet columns so that the table remains queryable
        by Polars/DuckDB.
        """
        import polars as pl

        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        d = self.to_dict()
        # Polars can't store arbitrary nested dicts in Parquet cleanly; serialize
        # the complex columns as JSON strings.
        for col in (
            "model_capability_snapshot",
            "budgets",
            "experiment_assignments",
            "grader_results",
            "artifacts",
            "context_manifests",
            "trajectory",
            "evaluation_identity",
            "provider_receipts",
            "harness_verdict",
            "attempts",
        ):
            d[col] = json.dumps(d.get(col) or [], sort_keys=True)
        if d.get("cost") is not None:
            d["cost"] = json.dumps(d["cost"], sort_keys=True)
        df = pl.DataFrame([d])
        df.write_parquet(p)
        return p

    # ──────────────────────── constructors ─────────────────────────────────

    @classmethod
    def new(
        cls,
        *,
        suite: str,
        task: str,
        harness: str,
        harness_commit: str,
        environment_digest: str,
        random_seed: int,
        model_capability_snapshot: dict[str, Any] | None = None,
        budgets: dict[str, Any] | None = None,
        evaluation_identity: EvaluationIdentity | None = None,
        evidence_class: EvidenceClass = EvidenceClass.FIXTURE_ONLY,
        holdout_partition: str | None = None,
        independently_verified: bool = False,
        provider_receipts: list[dict[str, Any]] | None = None,
    ) -> RunRecord:
        """Create a fresh record with a generated ``run_id`` and ``start`` timestamp."""
        return cls(
            run_id=_new_run_id(),
            suite=suite,
            task=task,
            harness=harness,
            harness_commit=harness_commit,
            model_capability_snapshot=model_capability_snapshot or {},
            environment_digest=environment_digest,
            random_seed=random_seed,
            budgets=budgets or {},
            evaluation_identity=evaluation_identity,
            evidence_class=evidence_class,
            holdout_partition=holdout_partition,
            independently_verified=independently_verified,
            provider_receipts=list(provider_receipts or []),
        )

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RunRecord:
        """Reconstruct from a dict produced by :meth:`to_dict`."""
        graders = [GraderResult(**g) for g in d.get("grader_results", [])]
        cost_raw = d.get("cost")
        cost = CostBreakdown(**cost_raw) if cost_raw else None
        end_raw = d.get("end")
        end = datetime.fromisoformat(end_raw) if end_raw else None
        return cls(
            run_id=d["run_id"],
            suite=d["suite"],
            task=d["task"],
            harness=d["harness"],
            harness_commit=d["harness_commit"],
            model_capability_snapshot=d.get("model_capability_snapshot", {}) or {},
            environment_digest=d["environment_digest"],
            random_seed=int(d["random_seed"]),
            budgets=d.get("budgets", {}) or {},
            experiment_assignments=d.get("experiment_assignments", []) or [],
            start=datetime.fromisoformat(d["start"]),
            end=end,
            outcome=Outcome(d.get("outcome", Outcome.MISSING.value)),
            grader_results=graders,
            cost=cost,
            artifacts=d.get("artifacts", []) or [],
            context_manifests=d.get("context_manifests", []) or [],
            trajectory=d.get("trajectory", []) or [],
            notes=d.get("notes", ""),
            tokens_input_fresh=int(d.get("tokens_input_fresh", 0) or 0),
            tokens_input_cached=int(d.get("tokens_input_cached", 0) or 0),
            tokens_output=int(d.get("tokens_output", 0) or 0),
            tokens_reasoning=int(d.get("tokens_reasoning", 0) or 0),
            cache_hit_ratio=(
                float(d["cache_hit_ratio"]) if d.get("cache_hit_ratio") is not None else None
            ),
            steps=int(d.get("steps", 0) or 0),
            tool_error_rate=(
                float(d["tool_error_rate"]) if d.get("tool_error_rate") is not None else None
            ),
            repair_turns=int(d.get("repair_turns", 0) or 0),
            ttft_ms=int(d["ttft_ms"]) if d.get("ttft_ms") is not None else None,
            wall_clock_ms=int(d["wall_clock_ms"]) if d.get("wall_clock_ms") is not None else None,
            stop_reason=d.get("stop_reason"),
            harness_verdict=d.get("harness_verdict", {}) or {},
            attempts=d.get("attempts", []) or [],
            workspace_base_commit=d.get("workspace_base_commit"),
            evaluation_identity=(
                EvaluationIdentity.from_dict(d["evaluation_identity"])
                if d.get("evaluation_identity") is not None
                else None
            ),
            evidence_class=EvidenceClass(d.get("evidence_class", EvidenceClass.FIXTURE_ONLY.value)),
            holdout_partition=d.get("holdout_partition"),
            independently_verified=bool(d.get("independently_verified", False)),
            provider_receipts=d.get("provider_receipts", []) or [],
        )

    @classmethod
    def from_json(cls, path: Path | str) -> RunRecord:
        """Read a single JSON record."""
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    @classmethod
    def from_jsonl(cls, path: Path | str) -> list[RunRecord]:
        """Read a JSONL file containing one record per line."""
        text = Path(path).read_text(encoding="utf-8")
        return [cls.from_dict(json.loads(line)) for line in text.splitlines() if line.strip()]


def _new_run_id() -> str:
    """Generate a deterministic-ish run id (UUID4 hex)."""
    return uuid.uuid4().hex


def write_jsonl(records: Iterable[RunRecord], path: Path | str) -> Path:
    """Append a sequence of records as JSONL."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as fh:
        for r in records:
            fh.write(r.to_jsonl_line() + "\n")
    return p
