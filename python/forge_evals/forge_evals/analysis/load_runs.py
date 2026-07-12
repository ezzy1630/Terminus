"""SPEC §41.5 run record loaders.

Loads :class:`RunRecord` instances from JSON, JSONL, or Parquet into Polars
DataFrames for batch analysis.

Three loading modes:

- :func:`load_runs_from_jsonl` — one record per line, fastest for streaming.
- :func:`load_runs_from_json_dir` — one JSON file per record.
- :func:`load_runs_from_parquet` — columnar, fastest for batch analytics.

All loaders return a :class:`RunCatalog` that holds both the raw records
and a flattened Polars DataFrame for analysis.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import polars as pl

from ..run_record import CostBreakdown, GraderResult, Outcome, RunRecord

__all__ = [
    "RunCatalog",
    "load_runs_from_json_dir",
    "load_runs_from_jsonl",
    "load_runs_from_parquet",
    "load_runs_from_records",
    "records_to_dataframe",
]


@dataclass
class RunCatalog:
    """A catalog of loaded run records.

    ``records`` is the list of :class:`RunRecord` instances. ``df`` is a
    flattened Polars DataFrame with one row per record (heavy nested fields
    are kept as JSON strings).
    """

    records: list[RunRecord] = field(default_factory=list)
    df: pl.DataFrame = field(default_factory=lambda: pl.DataFrame())

    @property
    def n(self) -> int:
        """Number of records."""
        return len(self.records)

    def by_harness(self) -> dict[str, list[RunRecord]]:
        """Group records by harness id."""
        out: dict[str, list[RunRecord]] = {}
        for r in self.records:
            out.setdefault(r.harness, []).append(r)
        return out

    def by_cohort(self) -> dict[str, list[RunRecord]]:
        """Group records by suite (cohort)."""
        out: dict[str, list[RunRecord]] = {}
        for r in self.records:
            out.setdefault(r.suite, []).append(r)
        return out

    def by_task(self) -> dict[str, list[RunRecord]]:
        """Group records by task id."""
        out: dict[str, list[RunRecord]] = {}
        for r in self.records:
            out.setdefault(r.task, []).append(r)
        return out

    def filter(self, predicate) -> RunCatalog:
        """Return a sub-catalog of records matching ``predicate(record)``."""
        return RunCatalog(records=[r for r in self.records if predicate(r)])


# ──────────────────────────── loaders ─────────────────────────────────────


def load_runs_from_jsonl(path: Path | str) -> RunCatalog:
    """Load a JSONL file of run records."""
    records = RunRecord.from_jsonl(path)
    return RunCatalog(records=records, df=records_to_dataframe(records))


def load_runs_from_json_dir(dir_path: Path | str, pattern: str = "*.json") -> RunCatalog:
    """Load every JSON file in a directory as a run record."""
    d = Path(dir_path)
    if not d.exists():
        return RunCatalog()
    records: list[RunRecord] = []
    for p in sorted(d.glob(pattern)):
        try:
            records.append(RunRecord.from_json(p))
        except (KeyError, ValueError):
            # Skip files that aren't valid run records.
            continue
    return RunCatalog(records=records, df=records_to_dataframe(records))


def load_runs_from_parquet(path: Path | str) -> RunCatalog:
    """Load a Parquet file of run records.

    Each row becomes a :class:`RunRecord`; nested JSON-string columns are
    decoded.
    """
    df = pl.read_parquet(Path(path))
    records: list[RunRecord] = []
    for row in df.to_dicts():
        records.append(_row_to_record(row))
    return RunCatalog(records=records, df=df)


def load_runs_from_records(records: Iterable[RunRecord]) -> RunCatalog:
    """Build a catalog from an iterable of in-memory records."""
    rec_list = list(records)
    return RunCatalog(records=rec_list, df=records_to_dataframe(rec_list))


# ──────────────────────────── flattening ─────────────────────────────────


def records_to_dataframe(records: list[RunRecord]) -> pl.DataFrame:
    """Flatten a list of records into a Polars DataFrame.

    The DataFrame has one row per record. Scalar fields are top-level
    columns; complex fields (graders, cost, trajectory) are JSON strings.
    A few convenience columns are added:

    - ``passed`` (bool) — outcome COMPLETED and all graders passed.
    - ``primary_score`` (float) — mean grader score.
    - ``duration_seconds`` (float).
    - ``input_tokens``, ``output_tokens``, ``cached_tokens`` (int).
    - ``provider_reported_usd``, ``computed_usd`` (float).
    - ``cost_reconciliation_flagged`` (bool).
    """
    rows: list[dict[str, object]] = []
    for r in records:
        d = r.to_dict()
        row: dict[str, object] = {
            "run_id": r.run_id,
            "suite": r.suite,
            "task": r.task,
            "harness": r.harness,
            "harness_commit": r.harness_commit,
            "environment_digest": r.environment_digest,
            "random_seed": r.random_seed,
            "start": r.start,
            "end": r.end,
            "outcome": r.outcome.value,
            "passed": r.passed,
            "primary_score": r.primary_score,
            "duration_seconds": r.duration_seconds,
            "experiment_assignments": d["experiment_assignments"],
            "model_capability_snapshot": d["model_capability_snapshot"],
            "budgets": d["budgets"],
            "grader_results": d["grader_results"],
            "artifacts": d["artifacts"],
            "context_manifests": d["context_manifests"],
            "trajectory": d["trajectory"],
            "notes": r.notes,
        }
        if r.cost is not None:
            row["provider_reported_usd"] = r.cost.provider_reported_usd
            row["computed_usd"] = r.cost.computed_usd
            row["input_tokens"] = r.cost.input_tokens
            row["output_tokens"] = r.cost.output_tokens
            row["cached_tokens"] = r.cost.cached_tokens
            row["reasoning_tokens"] = r.cost.reasoning_tokens
            row["cache_write_tokens"] = r.cost.cache_write_tokens
            row["cache_read_tokens"] = r.cost.cache_read_tokens
            row["cost_reconciliation_flagged"] = r.cost.reconciliation_flagged
        else:
            row["provider_reported_usd"] = None
            row["computed_usd"] = None
            row["input_tokens"] = 0
            row["output_tokens"] = 0
            row["cached_tokens"] = 0
            row["reasoning_tokens"] = 0
            row["cache_write_tokens"] = 0
            row["cache_read_tokens"] = 0
            row["cost_reconciliation_flagged"] = False
        rows.append(row)
    if not rows:
        return _empty_schema()
    # Convert nested dicts to JSON strings for Parquet compatibility.
    for row in rows:
        for k in (
            "experiment_assignments",
            "model_capability_snapshot",
            "budgets",
            "grader_results",
            "artifacts",
            "context_manifests",
            "trajectory",
        ):
            row[k] = json.dumps(row[k], sort_keys=True, default=str)
    return pl.DataFrame(rows)


def _empty_schema() -> pl.DataFrame:
    """Return an empty DataFrame with the canonical schema."""
    return pl.DataFrame(
        schema={
            "run_id": pl.Utf8,
            "suite": pl.Utf8,
            "task": pl.Utf8,
            "harness": pl.Utf8,
            "harness_commit": pl.Utf8,
            "environment_digest": pl.Utf8,
            "random_seed": pl.Int64,
            "start": pl.Datetime("us"),
            "end": pl.Datetime("us"),
            "outcome": pl.Utf8,
            "passed": pl.Boolean,
            "primary_score": pl.Float64,
            "duration_seconds": pl.Float64,
            "experiment_assignments": pl.Utf8,
            "model_capability_snapshot": pl.Utf8,
            "budgets": pl.Utf8,
            "grader_results": pl.Utf8,
            "artifacts": pl.Utf8,
            "context_manifests": pl.Utf8,
            "trajectory": pl.Utf8,
            "notes": pl.Utf8,
            "provider_reported_usd": pl.Float64,
            "computed_usd": pl.Float64,
            "input_tokens": pl.Int64,
            "output_tokens": pl.Int64,
            "cached_tokens": pl.Int64,
            "reasoning_tokens": pl.Int64,
            "cache_write_tokens": pl.Int64,
            "cache_read_tokens": pl.Int64,
            "cost_reconciliation_flagged": pl.Boolean,
        }
    )


def _row_to_record(row: dict[str, object]) -> RunRecord:
    """Reconstruct a :class:`RunRecord` from a flattened row dict."""
    # Parse nested JSON string columns.
    graders_raw: list[dict[str, object]] = []
    graders_str = row.get("grader_results")
    if isinstance(graders_str, str):
        graders_raw = json.loads(graders_str)
    cost: CostBreakdown | None = None
    if row.get("provider_reported_usd") is not None:
        cost = CostBreakdown(
            provider_reported_usd=float(row["provider_reported_usd"]),  # type: ignore[arg-type]
            computed_usd=float(row["computed_usd"]),  # type: ignore[arg-type]
            input_tokens=int(row.get("input_tokens") or 0),  # type: ignore[arg-type]
            output_tokens=int(row.get("output_tokens") or 0),  # type: ignore[arg-type]
            cached_tokens=int(row.get("cached_tokens") or 0),  # type: ignore[arg-type]
            reasoning_tokens=int(row.get("reasoning_tokens") or 0),  # type: ignore[arg-type]
            cache_write_tokens=int(row.get("cache_write_tokens") or 0),  # type: ignore[arg-type]
            cache_read_tokens=int(row.get("cache_read_tokens") or 0),  # type: ignore[arg-type]
            reconciliation_delta_usd=float(row.get("provider_reported_usd") or 0)  # type: ignore[arg-type]
            - float(row.get("computed_usd") or 0),
            reconciliation_flagged=bool(row.get("cost_reconciliation_flagged", False)),
        )
    graders = [GraderResult(**g) for g in graders_raw]
    end = row.get("end")
    return RunRecord(
        run_id=str(row["run_id"]),
        suite=str(row["suite"]),
        task=str(row["task"]),
        harness=str(row["harness"]),
        harness_commit=str(row["harness_commit"]),
        model_capability_snapshot=_loads_or_default(row.get("model_capability_snapshot"), {}),
        environment_digest=str(row["environment_digest"]),
        random_seed=int(row.get("random_seed") or 0),
        budgets=_loads_or_default(row.get("budgets"), {}),
        experiment_assignments=_loads_or_default(row.get("experiment_assignments"), []),
        start=row["start"],  # type: ignore[arg-type]
        end=end if end is not None else None,
        outcome=Outcome(str(row.get("outcome", "missing"))),
        grader_results=graders,
        cost=cost,
        artifacts=_loads_or_default(row.get("artifacts"), []),
        context_manifests=_loads_or_default(row.get("context_manifests"), []),
        trajectory=_loads_or_default(row.get("trajectory"), []),
        notes=str(row.get("notes", "")),
    )


def _loads_or_default(v: object, default: object) -> object:
    """JSON-decode ``v`` if it's a string, else return as-is or default."""
    if v is None:
        return default
    if isinstance(v, str):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return default
    return v
