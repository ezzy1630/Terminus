"""SPEC §41.5 trajectory recorder.

Persists full trajectories to Parquet via Polars. A trajectory is the ordered
sequence of events emitted by a single harness run:

- every tool call (proposed, authorized, settled, result),
- every provider attempt (request manifest, response chunks, usage),
- every context manifest (fragments, token budget, cache epoch),
- every policy decision (allow/deny, rule list),
- every lifecycle event (turn started, finalized, etc.).

The recorder is append-only and deterministic. Each event carries a
monotonic sequence number, a high-resolution timestamp, and a stable event
type from a fixed vocabulary.

Trajectories are *immutable evidence* — they are never edited after the run
ends. Re-analysis reads them back from Parquet/JSONL.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import polars as pl

__all__ = [
    "TrajectoryEvent",
    "TrajectoryEventType",
    "TrajectoryRecorder",
    "decode_trajectory_payloads",
    "load_trajectory_jsonl",
    "load_trajectory_parquet",
    "trajectory_to_dicts",
]


class TrajectoryEventType(str):
    """Stable vocabulary for trajectory event types.

    Values mirror the runtime-protocol semantic event types where applicable
    (see ``@terminus/runtime-protocol``). New types are appended; existing types
    are never renamed.
    """


# A closed set of event types. Stored as plain strings in Parquet for
# forward compatibility (unknown future types remain loadable).
EVENT_TYPES: tuple[str, ...] = (
    "run.started",
    "run.ended",
    "task.activated",
    "turn.started",
    "turn.context_compiling",
    "context.manifest_persisted",
    "turn.provider_running",
    "provider.request_sent",
    "provider.chunk",
    "provider.response_validated",
    "provider.error",
    "tool.proposed",
    "tool.authorized",
    "tool.denied",
    "tool.settled",
    "policy.decision",
    "approval.requested",
    "approval.granted",
    "approval.denied",
    "side_effect.started",
    "side_effect.settled",
    "side_effect.failed",
    "verification.node_passed",
    "verification.node_failed",
    "verification.plan_completed",
    "memory.claim_written",
    "memory.claim_invalidated",
    "context.compaction_started",
    "context.compaction_completed",
    "checkpoint.written",
    "job.state_changed",
    "agent.delegated",
    "agent.reviewed",
    "turn.finalizing",
    "turn.completed",
    # Adapter-local lifecycle events are recorded by the offline runner while
    # it drives the live control plane. They are evidence, not failures.
    "harness.contract_admitted",
    "harness.session_created",
    "harness.session_defaults_applied",
    "harness.task_created",
    "harness.task_started",
    "harness.turn_created",
    "harness.metrics_reconciled",
    "turn.response_validating",
    "turn.provider_text_delta",
    "turn.failed",
    "tool.failed",
    "task.repair_scheduled",
    "turn.repair_pending",
    "turn.repairing",
    "verification.admitted",
    "verification.no_runnable_checks",
    "task.verification_not_runnable",
    "turn.verification_not_applicable",
    "error.uncaught",
    # Unknown future event names are wrapped here with their original name in
    # the payload. This keeps the vocabulary queryable without misclassifying
    # forward-compatible evidence as an uncaught exception.
    "event.unknown",
)


@dataclass(frozen=True)
class TrajectoryEvent:
    """A single trajectory event.

    ``seq`` is monotonic per run; ``ts`` is timezone-aware UTC. ``payload``
    is an arbitrary JSON-safe dict; the schema is intentionally permissive
    because trajectory events come from many subsystems.
    """

    seq: int
    ts: datetime
    event_type: str
    payload: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.seq < 0:
            raise ValueError("seq must be non-negative")
        if not self.event_type:
            raise ValueError("event_type is required")

    def to_dict(self) -> dict[str, Any]:
        """Convert to a JSON-safe dict.

        The ``payload`` is kept as a plain ``dict`` (not JSON-encoded) so
        that graders consuming trajectory events can do
        ``isinstance(payload, dict)`` checks directly. The on-disk JSONL
        writer (:meth:`TrajectoryRecorder.to_jsonl`) serializes the whole
        dict (including the nested payload) to a single JSON line; the
        loader (:func:`load_trajectory_jsonl`) yields events whose
        ``payload`` is again a dict. Parquet storage keeps ``payload`` as
        a JSON string column for type-stability, and
        :func:`load_trajectory_parquet` decodes it back to a dict.
        """
        return {
            "seq": self.seq,
            "ts": self.ts.isoformat(),
            "event_type": self.event_type,
            "payload": dict(self.payload),
        }


class TrajectoryRecorder:
    """Append-only recorder for trajectory events.

    Events are buffered in memory and flushed to disk with :meth:`flush` or
    :meth:`finalize`. The recorder is single-threaded; one recorder per run.
    """

    def __init__(self, run_id: str) -> None:
        self.run_id: str = run_id
        self._events: list[TrajectoryEvent] = []
        self._seq: int = 0
        self._closed: bool = False

    @property
    def event_count(self) -> int:
        """Number of events buffered."""
        return len(self._events)

    @property
    def closed(self) -> bool:
        """True iff :meth:`finalize` was called."""
        return self._closed

    # ──────────────────────────── recording ───────────────────────────────

    def record(self, event_type: str, payload: dict[str, Any] | None = None) -> TrajectoryEvent:
        """Append an event with the next seq number and a fresh UTC timestamp."""
        if self._closed:
            raise RuntimeError("recorder is finalized")
        if event_type not in EVENT_TYPES:
            # Keep the on-disk vocabulary closed while making the original
            # event name explicit. An unknown event is not evidence of an
            # uncaught exception; callers can inspect and update the vocabulary
            # independently of the run's failure state.
            payload = dict(payload or {})
            payload["unknown_event_type"] = event_type
            event_type = "event.unknown"
        self._seq += 1
        ev = TrajectoryEvent(
            seq=self._seq,
            ts=datetime.now(UTC),
            event_type=event_type,
            payload=payload or {},
        )
        self._events.append(ev)
        return ev

    # ──────────────────────────── convenience ─────────────────────────────

    def record_run_started(
        self, *, suite: str, task: str, harness: str, seed: int
    ) -> TrajectoryEvent:
        """Record the ``run.started`` event."""
        return self.record(
            "run.started",
            {"run_id": self.run_id, "suite": suite, "task": task, "harness": harness, "seed": seed},
        )

    def record_run_ended(self, *, outcome: str, duration_seconds: float) -> TrajectoryEvent:
        """Record the ``run.ended`` event."""
        return self.record(
            "run.ended",
            {"run_id": self.run_id, "outcome": outcome, "duration_seconds": duration_seconds},
        )

    def record_tool_proposed(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> TrajectoryEvent:
        """Record the ``tool.proposed`` event."""
        return self.record(
            "tool.proposed",
            {
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "arguments": json.dumps(arguments, sort_keys=True, default=str),
            },
        )

    def record_tool_authorized(
        self, *, tool_call_id: str, decision: str, rules: list[str]
    ) -> TrajectoryEvent:
        """Record the ``tool.authorized`` event."""
        return self.record(
            "tool.authorized",
            {
                "tool_call_id": tool_call_id,
                "decision": decision,
                "rules": json.dumps(rules, sort_keys=True),
            },
        )

    def record_tool_settled(
        self, *, tool_call_id: str, success: bool, result_artifact_hash: str | None
    ) -> TrajectoryEvent:
        """Record the ``tool.settled`` event."""
        return self.record(
            "tool.settled",
            {
                "tool_call_id": tool_call_id,
                "success": success,
                "result_artifact_hash": result_artifact_hash,
            },
        )

    def record_provider_chunk(
        self, *, attempt_id: str, chunk_kind: str, text: str | None = None
    ) -> TrajectoryEvent:
        """Record a ``provider.chunk`` event."""
        return self.record(
            "provider.chunk",
            {"attempt_id": attempt_id, "chunk_kind": chunk_kind, "text": text},
        )

    def record_manifest_persisted(
        self,
        *,
        manifest_id: str,
        token_budget: int,
        fragment_count: int,
    ) -> TrajectoryEvent:
        """Record the ``context.manifest_persisted`` event."""
        return self.record(
            "context.manifest_persisted",
            {
                "manifest_id": manifest_id,
                "token_budget": token_budget,
                "fragment_count": fragment_count,
            },
        )

    # ──────────────────────────── iteration ───────────────────────────────

    def __iter__(self) -> Iterator[TrajectoryEvent]:
        """Iterate over buffered events in seq order."""
        return iter(self._events)

    def to_dicts(self) -> list[dict[str, Any]]:
        """Return all buffered events as plain dicts."""
        return [e.to_dict() for e in self._events]

    # ──────────────────────────── persistence ─────────────────────────────

    def to_dataframe(self) -> pl.DataFrame:
        """Build a Polars DataFrame from the buffered events.

        Schema:

        - ``run_id`` (str)
        - ``seq`` (int)
        - ``ts`` (datetime)
        - ``event_type`` (str)
        - ``payload`` (str — JSON-encoded)
        """
        rows = [
            {
                "run_id": self.run_id,
                "seq": e.seq,
                "ts": e.ts,
                "event_type": e.event_type,
                "payload": json.dumps(e.payload, sort_keys=True, default=str),
            }
            for e in self._events
        ]
        if not rows:
            return pl.DataFrame(
                schema={
                    "run_id": pl.Utf8,
                    "seq": pl.Int64,
                    "ts": pl.Datetime("us"),
                    "event_type": pl.Utf8,
                    "payload": pl.Utf8,
                }
            )
        return pl.DataFrame(rows)

    def to_parquet(self, path: Path | str) -> Path:
        """Write the trajectory as a Parquet file."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        self.to_dataframe().write_parquet(p)
        return p

    def to_jsonl(self, path: Path | str) -> Path:
        """Append the trajectory as JSONL (one event per line)."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as fh:
            for e in self._events:
                fh.write(json.dumps(e.to_dict(), sort_keys=True, default=str) + "\n")
        return p

    def finalize(self) -> list[TrajectoryEvent]:
        """Mark the recorder as closed and return the buffered events."""
        self._closed = True
        return list(self._events)


# ──────────────────────────── loading ─────────────────────────────────────


def load_trajectory_parquet(path: Path | str) -> pl.DataFrame:
    """Load a trajectory Parquet file written by :meth:`TrajectoryRecorder.to_parquet`.

    The ``payload`` column is stored as a JSON string for type-stability
    across Polars/Arrow versions; callers that need a dict can use
    :func:`decode_trajectory_payloads`.
    """
    return pl.read_parquet(Path(path))


def decode_trajectory_payloads(df: pl.DataFrame) -> list[dict[str, Any]]:
    """Decode a Parquet-loaded trajectory DataFrame into a list of dicts.

    Each dict has ``seq``, ``ts``, ``event_type``, and ``payload`` (decoded
    back to a ``dict`` from the JSON string column).
    """
    out: list[dict[str, Any]] = []
    if df.height == 0:
        return out
    for row in df.to_dicts():
        payload = row.get("payload")
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                payload = {}
        if not isinstance(payload, dict):
            payload = {}
        out.append(
            {
                "seq": int(row.get("seq", 0)),
                "ts": row.get("ts"),
                "event_type": str(row.get("event_type", "")),
                "payload": payload,
            }
        )
    return out


def load_trajectory_jsonl(path: Path | str) -> list[TrajectoryEvent]:
    """Load a JSONL trajectory file into a list of :class:`TrajectoryEvent`.

    The ``payload`` field is always returned as a ``dict``. If the stored
    payload is a JSON string (legacy records), it is decoded back to a dict.
    """
    p = Path(path)
    events: list[TrajectoryEvent] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        ts = datetime.fromisoformat(d["ts"])
        payload = d.get("payload")
        if isinstance(payload, str):
            # Legacy records stored payload as a JSON-encoded string.
            try:
                payload = json.loads(payload)
            except (json.JSONDecodeError, TypeError):
                payload = {}
        if not isinstance(payload, dict):
            payload = {}
        events.append(
            TrajectoryEvent(
                seq=int(d["seq"]),
                ts=ts,
                event_type=d["event_type"],
                payload=payload,
            )
        )
    return events


def trajectory_to_dicts(events: list[TrajectoryEvent]) -> list[dict[str, Any]]:
    """Convert a list of events to plain dicts (for run record trajectory field).

    ``payload`` is preserved as a plain ``dict`` so graders can use
    ``isinstance(payload, dict)`` checks directly.
    """
    out: list[dict[str, Any]] = []
    for e in events:
        out.append(
            {
                "seq": e.seq,
                "ts": e.ts.isoformat(),
                "event_type": e.event_type,
                "payload": dict(e.payload),
            }
        )
    return out
