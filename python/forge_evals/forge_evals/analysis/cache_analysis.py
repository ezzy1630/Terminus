"""SPEC §3.3 / §18.4 cache analysis.

Cache behavior is a systems concern (SPEC §3.3). The eval lab records
``cached_tokens``, ``cache_write_tokens``, and ``cache_read_tokens`` on
every run. This module computes:

- hit rate = cached_tokens / input_tokens;
- read rate = cache_read_tokens / input_tokens;
- write rate = cache_write_tokens / input_tokens;
- invalidation causes (parsed from trajectory events).

These metrics feed into SPEC §18.4's "cache hit/write rate" context-specific
evaluation.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import polars as pl

from ..run_record import RunRecord
from .load_runs import RunCatalog

__all__ = [
    "CacheInvalidationCause",
    "CacheStats",
    "cache_invalidation_causes",
    "cache_stats_by_harness_cohort",
    "compute_cache_stats",
]


@dataclass(frozen=True)
class CacheStats:
    """Per-run cache statistics."""

    run_id: str
    harness: str
    suite: str
    task: str
    input_tokens: int
    cached_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    hit_rate: float
    read_rate: float
    write_rate: float

    def to_dict(self) -> dict[str, object]:
        """Plain dict form."""
        return {
            "run_id": self.run_id,
            "harness": self.harness,
            "suite": self.suite,
            "task": self.task,
            "input_tokens": self.input_tokens,
            "cached_tokens": self.cached_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "hit_rate": self.hit_rate,
            "read_rate": self.read_rate,
            "write_rate": self.write_rate,
        }


@dataclass(frozen=True)
class CacheInvalidationCause:
    """A cache invalidation cause parsed from a run's trajectory."""

    run_id: str
    cause: str
    fragment_id: str
    evidence: str = ""


def compute_cache_stats(records: Iterable[RunRecord] | RunCatalog) -> list[CacheStats]:
    """Compute per-run cache statistics."""
    recs = _coerce(records)
    out: list[CacheStats] = []
    for r in recs:
        if r.cost is None:
            continue
        cost = r.cost
        input_tokens = cost.input_tokens or 0
        cached = cost.cached_tokens or 0
        write = cost.cache_write_tokens or 0
        read = cost.cache_read_tokens or 0
        hit_rate = cached / input_tokens if input_tokens > 0 else 0.0
        read_rate = read / input_tokens if input_tokens > 0 else 0.0
        write_rate = write / input_tokens if input_tokens > 0 else 0.0
        out.append(
            CacheStats(
                run_id=r.run_id,
                harness=r.harness,
                suite=r.suite,
                task=r.task,
                input_tokens=input_tokens,
                cached_tokens=cached,
                cache_write_tokens=write,
                cache_read_tokens=read,
                hit_rate=hit_rate,
                read_rate=read_rate,
                write_rate=write_rate,
            )
        )
    return out


def cache_stats_by_harness_cohort(
    records: Iterable[RunRecord] | RunCatalog,
) -> pl.DataFrame:
    """One row per (harness, cohort) with mean cache rates."""
    per_run = compute_cache_stats(records)
    if not per_run:
        return pl.DataFrame()
    df = pl.DataFrame([s.to_dict() for s in per_run])
    return df.group_by("harness", "suite").agg(
        pl.col("hit_rate").mean().alias("mean_hit_rate"),
        pl.col("read_rate").mean().alias("mean_read_rate"),
        pl.col("write_rate").mean().alias("mean_write_rate"),
        pl.col("input_tokens").sum().alias("total_input_tokens"),
        pl.col("cached_tokens").sum().alias("total_cached_tokens"),
        pl.col("cache_write_tokens").sum().alias("total_cache_write_tokens"),
        pl.col("cache_read_tokens").sum().alias("total_cache_read_tokens"),
        pl.len().alias("n"),
    )


def cache_invalidation_causes(
    records: Iterable[RunRecord] | RunCatalog,
) -> list[CacheInvalidationCause]:
    """Parse cache invalidation causes from trajectory events.

    Looks for ``memory.claim_invalidated`` and ``context.compaction_started``
    events whose payloads include an ``invalidation_cause`` field.
    """
    recs = _coerce(records)
    out: list[CacheInvalidationCause] = []
    for r in recs:
        for ev in r.trajectory:
            if not isinstance(ev, dict):
                continue
            et = ev.get("event_type")
            if et not in ("memory.claim_invalidated", "context.compaction_started"):
                continue
            payload = ev.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            cause = str(payload.get("invalidation_cause", "unknown"))
            fragment_id = str(payload.get("fragment_id", payload.get("claim_id", "")))
            evidence = str(payload.get("reason", ""))
            out.append(
                CacheInvalidationCause(
                    run_id=r.run_id,
                    cause=cause,
                    fragment_id=fragment_id,
                    evidence=evidence,
                )
            )
    return out


def _coerce(records: Iterable[RunRecord] | RunCatalog) -> list[RunRecord]:
    """Accept either a catalog or a raw iterable of records."""
    if isinstance(records, RunCatalog):
        return list(records.records)
    return list(records)
