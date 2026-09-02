"""Deterministic baseline/candidate trajectory, manifest, and tool-sequence diffs.

The causal evaluation system (see docs/architecture/evaluation-lab.md) needs
automatic, model-free comparisons between a baseline run and a candidate run
of the same (task, seed). This module produces exactly those, from the
immutable evidence already on the :class:`~forge_evals.run_record.RunRecord`:

- **tool sequences** — the ordered tool names each run invoked, aligned to a
  first divergence and an edit-distance summary;
- **context manifests** — per-turn selected-token totals and fragment-kind
  sets, compared turn by turn;
- **event-type sequences** — the full trajectory event vocabulary, aligned
  like the tool sequence for a coarse behavioral diff.

Every function here is pure and deterministic: the same records always
produce the same diff. No model call, no score, no verdict — these diffs are
diagnostics that explain *why* a paired delta moved, not evidence by
themselves.
"""

from __future__ import annotations

import difflib
import json
from dataclasses import dataclass, field
from itertools import zip_longest
from typing import Any

__all__ = [
    "ContextManifestDiff",
    "ManifestSummary",
    "ToolSequenceDiff",
    "TrajectoryDiff",
    "diff_context_manifests",
    "diff_tool_sequences",
    "diff_trajectories",
    "summarize_context_manifests",
    "tool_sequence",
]

_TOOL_EVENT = "tool.proposed"
_TOOL_NAME_KEY = "tool_name"


def _payload_json(payload: dict[str, Any], key: str) -> Any:
    """Read a payload value that the recorder JSON-encoded."""
    raw = payload.get(key)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return raw
    return raw


def tool_sequence(record_trajectory: list[dict[str, Any]]) -> list[str]:
    """Extract the ordered tool names from a run record's trajectory."""
    names: list[str] = []
    for event in record_trajectory:
        if event.get("event_type") != _TOOL_EVENT:
            continue
        payload = event.get("payload") or {}
        name = payload.get(_TOOL_NAME_KEY)
        if name is None:
            name = _payload_json(payload, _TOOL_NAME_KEY)
        if name is not None:
            names.append(str(name))
    return names


@dataclass(frozen=True)
class ToolSequenceDiff:
    """Alignment of two tool-call sequences."""

    baseline_tools: tuple[str, ...]
    candidate_tools: tuple[str, ...]
    # First index where the sequences diverge (length of the common prefix).
    first_divergence: int
    # Tool invocations present only in the baseline, in order.
    removed: tuple[str, ...]
    # Tool invocations present only in the candidate, in order.
    added: tuple[str, ...]
    # Difflib opcodes over the sequences (equal/replace/delete/insert).
    opcodes: tuple[tuple[str, int, int, int, int], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "baseline_tools": list(self.baseline_tools),
            "candidate_tools": list(self.candidate_tools),
            "first_divergence": self.first_divergence,
            "removed": list(self.removed),
            "added": list(self.added),
            "opcodes": [list(opcode) for opcode in self.opcodes],
        }

    def summary_lines(self) -> list[str]:
        lines = [
            f"tools: baseline={len(self.baseline_tools)} candidate={len(self.candidate_tools)}",
        ]
        if self.first_divergence < max(len(self.baseline_tools), len(self.candidate_tools)):
            lines.append(
                f"first divergence at call {self.first_divergence}: "
                f"baseline={self.baseline_tools[self.first_divergence : self.first_divergence + 3]}"
                f" candidate={self.candidate_tools[self.first_divergence : self.first_divergence + 3]}"
            )
        if self.added:
            lines.append(f"candidate added: {', '.join(self.added)}")
        if self.removed:
            lines.append(f"candidate dropped: {', '.join(self.removed)}")
        if not self.added and not self.removed:
            lines.append("tool sequences identical")
        return lines


def diff_tool_sequences(
    baseline_trajectory: list[dict[str, Any]],
    candidate_trajectory: list[dict[str, Any]],
) -> ToolSequenceDiff:
    """Diff the ordered tool names of two run records' trajectories."""
    baseline = tuple(tool_sequence(baseline_trajectory))
    candidate = tuple(tool_sequence(candidate_trajectory))
    matcher = difflib.SequenceMatcher(a=baseline, b=candidate, autojunk=False)
    opcodes = tuple((tag, i1, i2, j1, j2) for tag, i1, i2, j1, j2 in matcher.get_opcodes())
    first_divergence = len(baseline)
    for tag, i1, _i2, _j1, _j2 in opcodes:
        if tag != "equal":
            first_divergence = i1
            break
    removed_chunks: list[list[str]] = []
    added_chunks: list[list[str]] = []
    for tag, i1, i2, j1, j2 in opcodes:
        if tag in {"delete", "replace"}:
            removed_chunks.append(list(baseline[i1:i2]))
        if tag in {"insert", "replace"}:
            added_chunks.append(list(candidate[j1:j2]))
    return ToolSequenceDiff(
        baseline_tools=baseline,
        candidate_tools=candidate,
        first_divergence=first_divergence,
        removed=tuple(name for chunk in removed_chunks for name in chunk),
        added=tuple(name for chunk in added_chunks for name in chunk),
        opcodes=opcodes,
    )


@dataclass(frozen=True)
class ManifestSummary:
    """One turn's context manifest, reduced to comparable facts."""

    index: int
    selected_tokens: int | None
    fragment_kinds: tuple[str, ...]
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "selected_tokens": self.selected_tokens,
            "fragment_kinds": list(self.fragment_kinds),
        }


_TOKEN_KEYS = (
    "selected_tokens",
    "total_selected_tokens",
    "tokens_selected",
    "selected_token_count",
)
_KIND_KEYS = ("fragment_kinds", "kinds", "fragments")


# skipcq: PY-R1000
def summarize_context_manifests(context_manifests: list[dict[str, Any]]) -> list[ManifestSummary]:
    """Reduce a run record's context manifests to per-turn comparable facts.

    Manifest payloads vary by producer version; the summarizer reads the
    known token-count and fragment-kind fields and leaves the raw manifest
    attached for readers that need more.
    """
    summaries: list[ManifestSummary] = []
    for index, manifest in enumerate(context_manifests):
        selected_tokens: int | None = None
        for key in _TOKEN_KEYS:
            value = manifest.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                selected_tokens = int(value)
                break
        if selected_tokens is None:
            estimated = manifest.get("estimated_tokens")
            if isinstance(estimated, dict):
                value = estimated.get("predictedInput")
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    selected_tokens = int(value)
        fragment_kinds: tuple[str, ...] = ()
        for key in _KIND_KEYS:
            value = manifest.get(key)
            if isinstance(value, list):
                if key == "fragments" and all(isinstance(item, dict) for item in value):
                    selected = [item for item in value if item.get("selected") is not False]
                    fragment_kinds = tuple(
                        str(item["kind"])
                        for item in sorted(
                            selected,
                            key=lambda item: (
                                item.get("rendered_position")
                                if isinstance(item.get("rendered_position"), int)
                                else 2**31
                            ),
                        )
                        if isinstance(item.get("kind"), str)
                    )
                else:
                    fragment_kinds = tuple(str(item) for item in value)
                break
        summaries.append(
            ManifestSummary(
                index=index,
                selected_tokens=selected_tokens,
                fragment_kinds=fragment_kinds,
                raw=manifest,
            )
        )
    return summaries


@dataclass(frozen=True)
class ContextManifestDiff:
    """Per-turn comparison of two runs' context manifests."""

    baseline_turns: int
    candidate_turns: int
    # selected-token deltas per aligned turn (None where unknown).
    selected_token_deltas: tuple[int | None, ...]
    # Fragment kinds present only in the baseline, per aligned turn.
    fragment_kinds_removed: tuple[tuple[str, ...], ...]
    # Fragment kinds present only in the candidate, per aligned turn.
    fragment_kinds_added: tuple[tuple[str, ...], ...]
    # Total selected tokens where both sides reported them; else None.
    baseline_selected_tokens: int | None
    candidate_selected_tokens: int | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "baseline_turns": self.baseline_turns,
            "candidate_turns": self.candidate_turns,
            "selected_token_deltas": list(self.selected_token_deltas),
            "fragment_kinds_removed": [list(kinds) for kinds in self.fragment_kinds_removed],
            "fragment_kinds_added": [list(kinds) for kinds in self.fragment_kinds_added],
            "baseline_selected_tokens": self.baseline_selected_tokens,
            "candidate_selected_tokens": self.candidate_selected_tokens,
        }

    def summary_lines(self) -> list[str]:
        lines = [f"manifests: baseline={self.baseline_turns} candidate={self.candidate_turns}"]
        if self.baseline_selected_tokens is not None and self.candidate_selected_tokens is not None:
            delta = self.candidate_selected_tokens - self.baseline_selected_tokens
            lines.append(
                f"selected tokens: baseline={self.baseline_selected_tokens} "
                f"candidate={self.candidate_selected_tokens} delta={delta:+d}"
            )
        changed = [
            index
            for index, (removed, added) in enumerate(
                zip(self.fragment_kinds_removed, self.fragment_kinds_added, strict=False)
            )
            if removed or added
        ]
        if changed:
            detail = "; ".join(
                f"turn {index}: "
                + (
                    f"-{', '.join(self.fragment_kinds_removed[index])} "
                    if self.fragment_kinds_removed[index]
                    else ""
                )
                + (
                    f"+{', '.join(self.fragment_kinds_added[index])}"
                    if self.fragment_kinds_added[index]
                    else ""
                )
                for index in changed[:10]
            )
            lines.append(f"fragment kinds changed ({detail})")
        elif self.baseline_turns > 0 and self.baseline_turns == self.candidate_turns:
            lines.append("fragment kinds identical on all turns")
        return lines


def diff_context_manifests(
    baseline_manifests: list[dict[str, Any]],
    candidate_manifests: list[dict[str, Any]],
) -> ContextManifestDiff:
    """Diff two runs' per-turn context manifests turn by turn."""
    baseline = summarize_context_manifests(baseline_manifests)
    candidate = summarize_context_manifests(candidate_manifests)
    token_deltas: list[int | None] = []
    kinds_removed: list[tuple[str, ...]] = []
    kinds_added: list[tuple[str, ...]] = []
    for b, c in zip_longest(baseline, candidate, fillvalue=None):
        if b is not None and c is not None:
            if b.selected_tokens is not None and c.selected_tokens is not None:
                token_deltas.append(c.selected_tokens - b.selected_tokens)
            else:
                token_deltas.append(None)
            b_kinds = set(b.fragment_kinds)
            c_kinds = set(c.fragment_kinds)
            kinds_removed.append(tuple(sorted(b_kinds - c_kinds)))
            kinds_added.append(tuple(sorted(c_kinds - b_kinds)))
        elif b is not None:
            token_deltas.append(None if b.selected_tokens is None else -b.selected_tokens)
            kinds_removed.append(tuple(sorted(set(b.fragment_kinds))))
            kinds_added.append(())
        elif c is not None:
            token_deltas.append(c.selected_tokens)
            kinds_removed.append(())
            kinds_added.append(tuple(sorted(set(c.fragment_kinds))))
    b_total = sum(s.selected_tokens for s in baseline if s.selected_tokens is not None)
    c_total = sum(s.selected_tokens for s in candidate if s.selected_tokens is not None)
    return ContextManifestDiff(
        baseline_turns=len(baseline),
        candidate_turns=len(candidate),
        selected_token_deltas=tuple(token_deltas),
        fragment_kinds_removed=tuple(kinds_removed),
        fragment_kinds_added=tuple(kinds_added),
        baseline_selected_tokens=b_total
        if any(s.selected_tokens is not None for s in baseline)
        else None,
        candidate_selected_tokens=c_total
        if any(s.selected_tokens is not None for s in candidate)
        else None,
    )


@dataclass(frozen=True)
class TrajectoryDiff:
    """The full automatic comparison between two paired runs."""

    event_types_equal: bool
    baseline_event_types: tuple[str, ...]
    candidate_event_types: tuple[str, ...]
    tool_diff: ToolSequenceDiff
    manifest_diff: ContextManifestDiff

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_types_equal": self.event_types_equal,
            "baseline_event_types": list(self.baseline_event_types),
            "candidate_event_types": list(self.candidate_event_types),
            "tool_diff": self.tool_diff.to_dict(),
            "manifest_diff": self.manifest_diff.to_dict(),
        }

    def summary_lines(self) -> list[str]:
        lines = ["trajectory diff:"]
        lines.extend(f"  {line}" for line in self.tool_diff.summary_lines())
        lines.extend(f"  {line}" for line in self.manifest_diff.summary_lines())
        if self.event_types_equal:
            lines.append("  event-type sequences identical")
        else:
            lines.append(
                f"  event types differ: baseline={len(self.baseline_event_types)} "
                f"candidate={len(self.candidate_event_types)}"
            )
        return lines


def diff_trajectories(
    baseline_record: dict[str, Any],
    candidate_record: dict[str, Any],
) -> TrajectoryDiff:
    """Diff every comparable surface of two run-record dicts.

    Inputs are ``RunRecord.to_dict()`` payloads (or loaded JSONL rows), so
    callers can diff records read straight off disk.
    """
    baseline_traj = list(baseline_record.get("trajectory") or [])
    candidate_traj = list(candidate_record.get("trajectory") or [])
    tool_diff = diff_tool_sequences(baseline_traj, candidate_traj)
    manifest_diff = diff_context_manifests(
        list(baseline_record.get("context_manifests") or []),
        list(candidate_record.get("context_manifests") or []),
    )
    baseline_types = tuple(
        str(event.get("event_type"))
        for event in baseline_traj
        if event.get("event_type") is not None
    )
    candidate_types = tuple(
        str(event.get("event_type"))
        for event in candidate_traj
        if event.get("event_type") is not None
    )
    return TrajectoryDiff(
        event_types_equal=baseline_types == candidate_types,
        baseline_event_types=baseline_types,
        candidate_event_types=candidate_types,
        tool_diff=tool_diff,
        manifest_diff=manifest_diff,
    )
