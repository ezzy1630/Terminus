"""SPEC §46.6 / §41.11 conformance graders.

Conformance graders verify that a harness implements the protocol contracts
correctly: response schemas, event ordering, error codes, idempotency,
manifest durability, etc. These are the *external-harness conformance tests*
of SPEC §46.6 layer 10.

A conformance grader is *not* a security grader — it checks protocol
correctness, not policy enforcement. Conformance failures produce
``retain_experimental`` decisions, not hard blocks.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..run_record import GraderResult
from .end_state import EndStateGrader, EndStateGraderInput

__all__ = [
    "ConformanceCheck",
    "ConformanceGrader",
    "ContextManifestDurabilityCheck",
    "EventOrderingCheck",
    "IdempotencyCheck",
    "ProviderResponseSchemaCheck",
    "ToolResultEnvelopeCheck",
]


@dataclass
class ConformanceCheck:
    """A single conformance check (id + predicate)."""

    check_id: str
    description: str
    predicate: Callable[[EndStateGraderInput], ConformanceCheckResult]

    def run(self, inp: EndStateGraderInput) -> ConformanceCheckResult:
        """Run the predicate and return its result."""
        return self.predicate(inp)


@dataclass(frozen=True)
class ConformanceCheckResult:
    """The result of a single conformance check."""

    check_id: str
    description: str
    passed: bool
    evidence: list[str] = field(default_factory=list)


class ConformanceGrader(EndStateGrader):
    """Run a list of conformance checks and aggregate the results."""

    grader_id = "conformance.base"
    grader_version = "0.1.0"

    def __init__(self, checks: list[ConformanceCheck]) -> None:
        self.checks: list[ConformanceCheck] = list(checks)

    def grade(self, inp: EndStateGraderInput) -> GraderResult:
        results: list[ConformanceCheckResult] = [c.run(inp) for c in self.checks]
        passed = all(r.passed for r in results) if results else False
        score = sum(1 for r in results if r.passed) / max(1, len(results))
        evidence: list[str] = []
        for r in results:
            mark = "PASS" if r.passed else "FAIL"
            evidence.append(f"[{mark}] {r.check_id}: {r.description}")
            for e in r.evidence:
                evidence.append(f"    - {e}")
        return GraderResult(
            grader_id=self.grader_id,
            grader_version=self.grader_version,
            passed=passed,
            score=score,
            evidence=evidence,
            metadata={
                "check_results": [
                    {
                        "check_id": r.check_id,
                        "description": r.description,
                        "passed": r.passed,
                    }
                    for r in results
                ]
            },
        )


# ──────────────────────────── built-in checks ────────────────────────────


def _trajectory(inp: EndStateGraderInput) -> list[dict[str, Any]]:
    """Return the trajectory list from input metadata (or empty)."""
    traj = inp.metadata.get("trajectory") or []
    return traj if isinstance(traj, list) else []


def ProviderResponseSchemaCheck() -> ConformanceCheck:
    """Verify every provider response chunk has a known ``kind``."""

    allowed_kinds = {"text", "tool_call", "error", "done", "malformed"}

    def _pred(inp: EndStateGraderInput) -> ConformanceCheckResult:
        bad: list[str] = []
        for ev in _trajectory(inp):
            if ev.get("event_type") != "provider.chunk":
                continue
            kind = ev.get("payload", {}).get("chunk_kind")
            if kind not in allowed_kinds:
                bad.append(f"unknown chunk_kind={kind!r}")
        if bad:
            return ConformanceCheckResult(
                check_id="provider_response_schema",
                description="Every provider chunk has a known kind",
                passed=False,
                evidence=bad[:5],
            )
        return ConformanceCheckResult(
            check_id="provider_response_schema",
            description="Every provider chunk has a known kind",
            passed=True,
        )

    return ConformanceCheck(
        check_id="provider_response_schema",
        description="Every provider chunk has a known kind",
        predicate=_pred,
    )


def EventOrderingCheck() -> ConformanceCheck:
    """Verify ``run.started`` is the first event and ``run.ended`` is last."""

    def _pred(inp: EndStateGraderInput) -> ConformanceCheckResult:
        events = _trajectory(inp)
        if not events:
            return ConformanceCheckResult(
                check_id="event_ordering",
                description="run.started first, run.ended last",
                passed=False,
                evidence=["no events in trajectory"],
            )
        first = events[0].get("event_type")
        last = events[-1].get("event_type")
        issues: list[str] = []
        if first != "run.started":
            issues.append(f"first event is {first!r}, expected run.started")
        if last != "run.ended":
            issues.append(f"last event is {last!r}, expected run.ended")
        return ConformanceCheckResult(
            check_id="event_ordering",
            description="run.started first, run.ended last",
            passed=not issues,
            evidence=issues,
        )

    return ConformanceCheck(
        check_id="event_ordering",
        description="run.started first, run.ended last",
        predicate=_pred,
    )


def ToolResultEnvelopeCheck() -> ConformanceCheck:
    """Verify every ``tool.settled`` event has a result envelope (hash or error)."""

    def _pred(inp: EndStateGraderInput) -> ConformanceCheckResult:
        missing: list[str] = []
        for ev in _trajectory(inp):
            if ev.get("event_type") != "tool.settled":
                continue
            payload = ev.get("payload", {})
            has_hash = bool(payload.get("result_artifact_hash"))
            has_error = bool(payload.get("error"))
            if not has_hash and not has_error:
                missing.append(f"tool_call_id={payload.get('tool_call_id')!r}")
        if missing:
            return ConformanceCheckResult(
                check_id="tool_result_envelope",
                description="Every tool.settled has a result hash or error",
                passed=False,
                evidence=missing[:5],
            )
        return ConformanceCheckResult(
            check_id="tool_result_envelope",
            description="Every tool.settled has a result hash or error",
            passed=True,
        )

    return ConformanceCheck(
        check_id="tool_result_envelope",
        description="Every tool.settled has a result hash or error",
        predicate=_pred,
    )


def ContextManifestDurabilityCheck() -> ConformanceCheck:
    """Verify every provider request was preceded by a manifest persistence."""

    def _pred(inp: EndStateGraderInput) -> ConformanceCheckResult:
        events = _trajectory(inp)
        last_manifest_seq: int | None = None
        issues: list[str] = []
        for ev in events:
            et = ev.get("event_type")
            seq = ev.get("seq")
            if et == "context.manifest_persisted":
                last_manifest_seq = seq if isinstance(seq, int) else last_manifest_seq
            elif et == "provider.request_sent" and last_manifest_seq is None:
                issues.append(f"provider.request_sent (seq={seq}) before any manifest")
        if issues:
            return ConformanceCheckResult(
                check_id="context_manifest_durability",
                description="Every provider request has a durable manifest before send",
                passed=False,
                evidence=issues[:5],
            )
        return ConformanceCheckResult(
            check_id="context_manifest_durability",
            description="Every provider request has a durable manifest before send",
            passed=True,
        )

    return ConformanceCheck(
        check_id="context_manifest_durability",
        description="Every provider request has a durable manifest before send",
        predicate=_pred,
    )


def IdempotencyCheck() -> ConformanceCheck:
    """Verify idempotent operations return equivalent results.

    Looks for ``tool.settled`` events with the same ``idempotency_key`` —
    they must have the same ``result_artifact_hash``.
    """

    def _pred(inp: EndStateGraderInput) -> ConformanceCheckResult:
        by_key: dict[str, set[str]] = {}
        for ev in _trajectory(inp):
            if ev.get("event_type") != "tool.settled":
                continue
            payload = ev.get("payload", {})
            key = payload.get("idempotency_key")
            if not key:
                continue
            h = str(payload.get("result_artifact_hash", ""))
            by_key.setdefault(str(key), set()).add(h)
        conflicts = [k for k, hashes in by_key.items() if len(hashes) > 1]
        if conflicts:
            return ConformanceCheckResult(
                check_id="idempotency",
                description="Idempotent operations return equivalent results",
                passed=False,
                evidence=[f"conflicting keys: {conflicts[:5]}"],
            )
        return ConformanceCheckResult(
            check_id="idempotency",
            description="Idempotent operations return equivalent results",
            passed=True,
        )

    return ConformanceCheck(
        check_id="idempotency",
        description="Idempotent operations return equivalent results",
        predicate=_pred,
    )


def default_conformance_checks() -> list[ConformanceCheck]:
    """The default set of conformance checks for a Terminus harness run."""
    return [
        ProviderResponseSchemaCheck(),
        EventOrderingCheck(),
        ToolResultEnvelopeCheck(),
        ContextManifestDurabilityCheck(),
        IdempotencyCheck(),
    ]


def default_conformance_grader() -> ConformanceGrader:
    """Build the default :class:`ConformanceGrader`."""
    return ConformanceGrader(checks=default_conformance_checks())


def trajectory_to_jsonable(traj: list[dict[str, Any]]) -> str:
    """Serialize a trajectory to a JSON string."""
    return json.dumps(traj, sort_keys=True, default=str)
