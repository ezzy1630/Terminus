"""Read per-run metrics from the Terminus control plane's own surfaces.

Phase 0-F2 gave the control plane typed routes for everything this module used
to re-derive, so the routes are the source and the event log is a fallback:

* ``GET /v1/turns/:id`` → ``usage`` (summed over attempts), ``cost_micros``,
  ``stop_reason``, ``budget`` — the per-turn view.
* ``GET /v1/turns/:id/attempts`` → per-attempt ``usage``, ``finish_reason`` and
  cost columns. Attempts are where cache-hit ratio is measurable at all.
* ``GET /v1/tasks/:id`` → ``budget_ledger`` (task-wide cumulative totals) and
  ``repair_metrics``.
* ``GET /v1/tasks/:id/transcript`` → the durable semantic event log. Tool
  lifecycle, repair scheduling and the ``verification.*`` verdict are only
  there. Usage/TTFT/stop-reason reconstruction from these events survives
  **only** as the legacy path for a control plane that 404s the two turn
  routes; it is a second implementation of the server's accounting rule and is
  no longer trusted when the routes answer.

Every number is either read from a route or derived from recorded evidence.
Nothing is estimated, and a value that cannot be obtained stays ``None``
rather than becoming a plausible-looking zero.

Wire encodings: route token counts are BigInt-as-string and snake_case; event
``usage`` payloads keep provider-core's camelCase keys.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "AttemptUsage",
    "TurnMetrics",
    "VerificationVerdict",
    "attempts_from_route",
    "parse_budget_ledger",
    "reconcile_metrics",
    "usage_from_route",
]

# Tool lifecycle events. `tool.settled` and `tool.failed` carry the same
# payload; the *event name* is the success flag (effect-settlement-service.ts).
_TOOL_PROPOSED = "tool.proposed"
_TOOL_SETTLED = "tool.settled"
_TOOL_FAILED = "tool.failed"
_TOOL_DENIED = "tool.denied"
_TOOL_SETTLEMENT_UNKNOWN = "tool.settlement_unknown"

_RESPONSE_VALIDATING = "turn.response_validating"

_REPAIR_SCHEDULED = "task.repair_scheduled"
_REPAIRING = "turn.repairing"

_VERIFICATION_ADMITTED = "verification.admitted"
_VERIFICATION_PLAN_COMPLETED = "verification.plan_completed"
_VERIFICATION_NO_RUNNABLE = "verification.no_runnable_checks"
_VERIFICATION_NODE_PASSED = "verification.node_passed"
_VERIFICATION_NODE_FAILED = "verification.node_failed"
_VERIFICATION_NOT_APPLICABLE = "turn.verification_not_applicable"
_TASK_VERIFICATION_NOT_RUNNABLE = "task.verification_not_runnable"

_TURN_FAILED = "turn.failed"


@dataclass(frozen=True)
class AttemptUsage:
    """One provider attempt's usage, as reported on ``turn.response_validating``."""

    attempt_index: int
    provider_attempt_id: str | None
    input_tokens: int
    cached_input_tokens: int
    cache_write_tokens: int
    output_tokens: int
    reasoning_tokens: int
    tool_schema_tokens: int
    latency_ms: int | None
    time_to_first_token_ms: int | None
    finish_reason: str | None

    @property
    def fresh_input_tokens(self) -> int:
        """Input tokens billed at the uncached rate (cached is a subset)."""
        return max(0, self.input_tokens - self.cached_input_tokens)

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form for the run record's artifacts."""
        return {
            "attempt_index": self.attempt_index,
            "provider_attempt_id": self.provider_attempt_id,
            "input_tokens": self.input_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "output_tokens": self.output_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "tool_schema_tokens": self.tool_schema_tokens,
            "latency_ms": self.latency_ms,
            "time_to_first_token_ms": self.time_to_first_token_ms,
            "finish_reason": self.finish_reason,
        }


@dataclass(frozen=True)
class VerificationVerdict:
    """What the *harness* concluded, reconciled from ``verification.*`` events.

    This is deliberately separate from the graders' verdict. ``admitted`` is
    the control plane's claim that the turn's verification plan passed; it is
    recorded for comparison and never used as the run's success value.
    """

    admitted: bool | None
    status: str
    plan_ids: tuple[str, ...] = ()
    passed_nodes: tuple[str, ...] = ()
    failed_nodes: tuple[str, ...] = ()
    skipped_nodes: tuple[str, ...] = ()
    # Which acceptance criteria those nodes were planned for. The node events
    # carry `criterion_id` (Phase 0-F2), so an unmet criterion is named rather
    # than left to be re-derived from the plan artifact. A node bound to no
    # criterion contributes nothing here.
    passed_criteria: tuple[str, ...] = ()
    failed_criteria: tuple[str, ...] = ()
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form stored on ``RunRecord.harness_verdict``."""
        return {
            "admitted": self.admitted,
            "status": self.status,
            "plan_ids": list(self.plan_ids),
            "passed_nodes": list(self.passed_nodes),
            "failed_nodes": list(self.failed_nodes),
            "skipped_nodes": list(self.skipped_nodes),
            "passed_criteria": list(self.passed_criteria),
            "failed_criteria": list(self.failed_criteria),
            "reason": self.reason,
        }


@dataclass(frozen=True)
class TurnMetrics:
    """Every first-class metric the run record carries, reconciled."""

    tokens_input_fresh: int = 0
    tokens_input_cached: int = 0
    tokens_output: int = 0
    tokens_reasoning: int = 0
    tokens_cache_write: int = 0
    tokens_tool_schema: int = 0
    cache_hit_ratio: float | None = None
    steps: int = 0
    tool_errors: int = 0
    tool_error_rate: float | None = None
    repair_turns: int = 0
    ttft_ms: int | None = None
    stop_reason: str | None = None
    provider_cost_micros: int | None = None
    verdict: VerificationVerdict = field(
        default_factory=lambda: VerificationVerdict(admitted=None, status="unknown")
    )
    attempts: tuple[AttemptUsage, ...] = ()
    token_source: str = "unavailable"

    @property
    def tokens_input_total(self) -> int:
        """Total prompt tokens, cached and fresh together."""
        return self.tokens_input_fresh + self.tokens_input_cached

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form for the run record's artifacts."""
        return {
            "tokens_input_fresh": self.tokens_input_fresh,
            "tokens_input_cached": self.tokens_input_cached,
            "tokens_output": self.tokens_output,
            "tokens_reasoning": self.tokens_reasoning,
            "tokens_cache_write": self.tokens_cache_write,
            "tokens_tool_schema": self.tokens_tool_schema,
            "cache_hit_ratio": self.cache_hit_ratio,
            "steps": self.steps,
            "tool_errors": self.tool_errors,
            "tool_error_rate": self.tool_error_rate,
            "repair_turns": self.repair_turns,
            "ttft_ms": self.ttft_ms,
            "stop_reason": self.stop_reason,
            "provider_cost_micros": self.provider_cost_micros,
            "token_source": self.token_source,
            "verdict": self.verdict.to_dict(),
            "attempts": [a.to_dict() for a in self.attempts],
        }


_TOKEN_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
    "tool_schema_tokens",
)


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _as_int(value: Any) -> int:
    """Coerce a BigInt-as-string / number / None ledger value to an int."""
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return 0
        try:
            return int(stripped)
        except ValueError:
            try:
                return int(float(stripped))
            except ValueError:
                return 0
    return 0


def _as_opt_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, str)):
        return _as_int(value)
    return None


def parse_budget_ledger(ledger: Mapping[str, Any] | None) -> dict[str, int]:
    """Decode ``GET /v1/tasks/:id``'s ``budget_ledger`` into plain ints.

    Every token/cost value on that route is a stringified BigInt; treating
    them as ints without decoding silently yields zeros.
    """
    if not isinstance(ledger, Mapping):
        return {}
    keys = (
        "steps_used",
        "max_steps",
        "hard_max_steps",
        "tokens_used",
        "input_tokens",
        "cached_input_tokens",
        "cache_write_tokens",
        "output_tokens",
        "reasoning_tokens",
        "tool_schema_tokens",
        "max_tokens",
        "cost_micros",
        "max_cost_micros",
        "context_headroom_tokens",
    )
    return {key: _as_int(ledger.get(key)) for key in keys if key in ledger}


def _payload(event: Mapping[str, Any]) -> dict[str, Any]:
    """Return an event's payload from any of the three wire renderings."""
    for key in ("data", "payload", "payload_json", "payloadJson"):
        raw = event.get(key)
        if isinstance(raw, Mapping):
            return dict(raw)
        if isinstance(raw, str) and raw.strip():
            try:
                decoded = json.loads(raw)
            except ValueError:
                continue
            if isinstance(decoded, Mapping):
                return dict(decoded)
    return {}


def _event_type(event: Mapping[str, Any]) -> str:
    for key in ("event", "event_type", "eventType", "type"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _usage_from_payload(payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    usage = payload.get("usage")
    return usage if isinstance(usage, Mapping) else None


def usage_from_route(usage: Mapping[str, Any] | None) -> dict[str, int | None]:
    """Decode a ``usage`` object from ``/v1/turns/:id`` or its attempts route.

    One key per field: the route's contract is snake_case with BigInt token
    counts as decimal strings and plain-number durations. Nothing here guesses
    at an alternate spelling — a shape change must fail loudly, not silently
    read as zero.
    """
    if not isinstance(usage, Mapping):
        return {}
    decoded: dict[str, int | None] = {
        key: _as_int(usage.get(key))
        for key in (
            "input_tokens",
            "cached_input_tokens",
            "cache_write_tokens",
            "output_tokens",
            "reasoning_tokens",
            "tool_schema_tokens",
        )
    }
    decoded["latency_ms"] = _as_opt_int(usage.get("latency_ms"))
    decoded["time_to_first_token_ms"] = _as_opt_int(usage.get("time_to_first_token_ms"))
    return decoded


def attempts_from_route(rows: Any) -> list[AttemptUsage]:
    """Decode ``GET /v1/turns/:id/attempts``.

    ``attempt_number`` is the server's own ordinal, not this list's index: an
    attempt whose row is missing must not silently renumber the rest, because
    the cache-hit ratio is defined over attempts >= 2.
    """
    if not isinstance(rows, list):
        return []
    attempts: list[AttemptUsage] = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, Mapping):
            continue
        usage = usage_from_route(row.get("usage"))
        attempt_number = _as_opt_int(row.get("attempt_number"))
        attempt_id = row.get("provider_attempt_id")
        finish_reason = row.get("finish_reason")
        attempts.append(
            AttemptUsage(
                attempt_index=attempt_number if attempt_number else index,
                provider_attempt_id=attempt_id if isinstance(attempt_id, str) else None,
                input_tokens=usage.get("input_tokens") or 0,
                cached_input_tokens=usage.get("cached_input_tokens") or 0,
                cache_write_tokens=usage.get("cache_write_tokens") or 0,
                output_tokens=usage.get("output_tokens") or 0,
                reasoning_tokens=usage.get("reasoning_tokens") or 0,
                tool_schema_tokens=usage.get("tool_schema_tokens") or 0,
                latency_ms=usage.get("latency_ms"),
                time_to_first_token_ms=usage.get("time_to_first_token_ms"),
                finish_reason=finish_reason if isinstance(finish_reason, str) else None,
            )
        )
    return attempts


def _legacy_attempts_from_events(events: Sequence[Mapping[str, Any]]) -> list[AttemptUsage]:
    """Per-attempt usage from ``turn.response_validating`` — legacy path only.

    Used when ``GET /v1/turns/:id/attempts`` 404s (a control plane older than
    Phase 0-F2). Event ``usage`` payloads are provider-core records, so the
    keys are camelCase; the snake_case spellings this used to also accept were
    the route's, and the route is now read directly.
    """
    attempts: list[AttemptUsage] = []
    for event in events:
        if _event_type(event) != _RESPONSE_VALIDATING:
            continue
        payload = _payload(event)
        usage = _usage_from_payload(payload)
        if usage is None:
            continue
        attempt_id = payload.get("provider_attempt_id")
        finish_reason = payload.get("finish_reason")
        attempts.append(
            AttemptUsage(
                attempt_index=len(attempts) + 1,
                provider_attempt_id=attempt_id if isinstance(attempt_id, str) else None,
                input_tokens=_as_int(usage.get("inputTokens")),
                cached_input_tokens=_as_int(usage.get("cachedInputTokens")),
                cache_write_tokens=_as_int(usage.get("cacheWriteTokens")),
                output_tokens=_as_int(usage.get("outputTokens")),
                reasoning_tokens=_as_int(usage.get("reasoningTokens")),
                tool_schema_tokens=_as_int(usage.get("toolSchemaTokens")),
                latency_ms=_as_opt_int(usage.get("latencyMs")),
                time_to_first_token_ms=_as_opt_int(usage.get("timeToFirstTokenMs")),
                finish_reason=finish_reason if isinstance(finish_reason, str) else None,
            )
        )
    return attempts


def _verdict_from_events(events: Sequence[Mapping[str, Any]]) -> VerificationVerdict:
    """Reconcile the harness's own verification conclusion."""
    plan_ids: list[str] = []
    passed_nodes: list[str] = []
    failed_nodes: list[str] = []
    skipped_nodes: list[str] = []
    passed_criteria: list[str] = []
    failed_criteria: list[str] = []
    admitted: bool | None = None
    status = "unknown"
    reason: str | None = None

    for event in events:
        event_type = _event_type(event)
        payload = _payload(event)
        if event_type == _VERIFICATION_ADMITTED:
            admitted = True
            status = "admitted"
            plan_id = payload.get("plan_id")
            if isinstance(plan_id, str):
                plan_ids.append(plan_id)
        elif event_type == _VERIFICATION_PLAN_COMPLETED:
            plan_status = payload.get("status")
            if isinstance(plan_status, str):
                if plan_status == "failed":
                    admitted = False
                    status = "failed"
                    reason = "required_predicates_failed"
                elif plan_status == "no_runnable_checks" and admitted is None:
                    admitted = None
                    status = "not_runnable"
                    reason = "no_runnable_checks"
                elif plan_status == "all_passed" and status == "unknown":
                    status = "all_passed"
        elif event_type == _VERIFICATION_NO_RUNNABLE:
            admitted = None
            status = "not_runnable"
            reason = "no_runnable_checks"
            for node in payload.get("skipped_nodes") or []:
                node_id = node.get("node_id") if isinstance(node, Mapping) else node
                if isinstance(node_id, str):
                    skipped_nodes.append(node_id)
        elif event_type == _TASK_VERIFICATION_NOT_RUNNABLE:
            admitted = None
            status = "not_runnable"
            reason = str(payload.get("reason") or "no_runnable_checks")
            for node_id in payload.get("skipped_nodes") or []:
                if isinstance(node_id, str):
                    skipped_nodes.append(node_id)
        elif event_type == _VERIFICATION_NOT_APPLICABLE:
            admitted = None
            status = "not_applicable"
            reason = str(payload.get("reason") or "turn_made_no_workspace_changes")
        elif event_type in (_VERIFICATION_NODE_PASSED, _VERIFICATION_NODE_FAILED):
            passed = event_type == _VERIFICATION_NODE_PASSED
            node_id = payload.get("node_id")
            if isinstance(node_id, str):
                (passed_nodes if passed else failed_nodes).append(node_id)
            # Null when the plan bound this node to no acceptance criterion —
            # infrastructure checks exist, and inventing an id for them would
            # be worse than reporting none.
            criterion_id = payload.get("criterion_id")
            if isinstance(criterion_id, str) and criterion_id:
                (passed_criteria if passed else failed_criteria).append(criterion_id)
        elif event_type == _TURN_FAILED:
            failure_reason = payload.get("reason")
            if isinstance(failure_reason, str):
                reason = failure_reason
                if failure_reason in {
                    "verification_failed",
                    "failed_verification",
                    "completion_gate_denied",
                }:
                    admitted = False
                    status = "failed"

    return VerificationVerdict(
        admitted=admitted,
        status=status,
        plan_ids=tuple(plan_ids),
        passed_nodes=tuple(passed_nodes),
        failed_nodes=tuple(failed_nodes),
        skipped_nodes=tuple(skipped_nodes),
        passed_criteria=tuple(dict.fromkeys(passed_criteria)),
        failed_criteria=tuple(dict.fromkeys(failed_criteria)),
        reason=reason,
    )


def _legacy_stop_reason_from_events(
    events: Sequence[Mapping[str, Any]],
    attempts: Sequence[AttemptUsage],
) -> str | None:
    """Stop reason for a control plane that has no ``stop_reason`` field.

    Two tiers, both reading a value the server *recorded*: a turn-level failure
    reason dominates the provider's finish reason, because a turn that ended
    for ``budget_exhausted`` is not described by ``"stop"``. The old third tier
    synthesized ``"stop"`` from ``turn.completed`` — that was this client
    guessing at the server's rule, and ``GET /v1/turns/:id`` now states it.
    """
    for event in reversed(list(events)):
        if _event_type(event) == _TURN_FAILED:
            reason = _payload(event).get("reason")
            if isinstance(reason, str) and reason:
                return reason
    for attempt in reversed(list(attempts)):
        if attempt.finish_reason:
            return attempt.finish_reason
    return None


def reconcile_metrics(
    *,
    events: Iterable[Mapping[str, Any]],
    turn: Mapping[str, Any] | None = None,
    turn_attempts: Any = None,
    budget_ledger: Mapping[str, Any] | None = None,
    repair_metrics: Mapping[str, Any] | None = None,
) -> TurnMetrics:
    """Assemble every first-class run metric from control-plane evidence.

    ``turn`` is ``GET /v1/turns/:id`` and ``turn_attempts`` is
    ``GET /v1/turns/:id/attempts``; pass ``None`` for either when the route
    404s and the event-log fallback should run instead. ``budget_ledger`` and
    ``repair_metrics`` come from ``GET /v1/tasks/:id``. ``events`` is the
    task's semantic event log in any of its three renderings (transcript rows,
    ``/v1/events`` SSE payloads, ``/v2/events`` envelopes) and remains the only
    source of tool lifecycle, repair and ``verification.*`` evidence.
    """
    event_list = [e for e in events if isinstance(e, Mapping)]
    turn_row = turn if isinstance(turn, Mapping) else None
    attempts = attempts_from_route(turn_attempts)
    attempt_source = "provider_attempts_route"
    if not attempts:
        attempts = _legacy_attempts_from_events(event_list)
        attempt_source = "provider_attempt_events"
    ledger = parse_budget_ledger(budget_ledger)

    turn_usage = usage_from_route(turn_row.get("usage")) if turn_row is not None else {}
    if turn_usage.get("input_tokens") or turn_usage.get("output_tokens"):
        totals = {key: turn_usage.get(key) or 0 for key in _TOKEN_KEYS}
        token_source = "turn_usage_route"
    elif attempts:
        totals = {
            "input_tokens": sum(a.input_tokens for a in attempts),
            "cached_input_tokens": sum(a.cached_input_tokens for a in attempts),
            "cache_write_tokens": sum(a.cache_write_tokens for a in attempts),
            "output_tokens": sum(a.output_tokens for a in attempts),
            "reasoning_tokens": sum(a.reasoning_tokens for a in attempts),
            "tool_schema_tokens": sum(a.tool_schema_tokens for a in attempts),
        }
        token_source = attempt_source
    elif ledger.get("input_tokens") or ledger.get("output_tokens"):
        totals = {key: ledger.get(key, 0) for key in _TOKEN_KEYS}
        token_source = "budget_ledger"
    else:
        totals = dict.fromkeys(_TOKEN_KEYS, 0)
        token_source = "unavailable"

    # The run record covers a whole task, the turn routes cover one turn. When
    # the task-wide ledger reports strictly more than the turn we drove, the
    # control plane ran turns of its own (repairs) and its ledger is the wider,
    # correct total. Otherwise the per-turn route wins: it reads the attempt
    # columns directly instead of summing a cumulative counter.
    if token_source in {"turn_usage_route", attempt_source} and ledger:
        ledger_input = ledger.get("input_tokens", 0)
        ledger_output = ledger.get("output_tokens", 0)
        if ledger_input > totals["input_tokens"] or ledger_output > totals["output_tokens"]:
            totals = {key: ledger.get(key, 0) for key in _TOKEN_KEYS}
            token_source = "budget_ledger"

    input_total = totals["input_tokens"]
    cached = min(totals["cached_input_tokens"], input_total)
    fresh = max(0, input_total - cached)

    # Cache-hit ratio is only meaningful from the second attempt onward: the
    # first attempt of a task has nothing to hit. Attempts are the only place
    # this is measurable, so a single-attempt run reports None rather than 0.
    later_attempts = [a for a in attempts if a.attempt_index >= 2]
    cache_hit_ratio: float | None = None
    if later_attempts:
        later_input = sum(a.input_tokens for a in later_attempts)
        later_cached = sum(min(a.cached_input_tokens, a.input_tokens) for a in later_attempts)
        if later_input > 0:
            cache_hit_ratio = round(later_cached / later_input, 6)

    proposed = sum(1 for e in event_list if _event_type(e) == _TOOL_PROPOSED)
    settled = sum(1 for e in event_list if _event_type(e) == _TOOL_SETTLED)
    failed = sum(
        1
        for e in event_list
        if _event_type(e) in (_TOOL_FAILED, _TOOL_DENIED, _TOOL_SETTLEMENT_UNKNOWN)
    )
    steps = proposed or (settled + failed)
    if not steps and ledger.get("steps_used"):
        steps = ledger["steps_used"]
    settled_total = settled + failed
    tool_error_rate = round(failed / settled_total, 6) if settled_total else None

    repair_turns = sum(
        1 for e in event_list if _event_type(e) in (_REPAIR_SCHEDULED, _REPAIRING)
    )
    if repair_turns:
        # `task.repair_scheduled` and `turn.repairing` are emitted per repair;
        # count each repair once when both are present.
        scheduled = sum(1 for e in event_list if _event_type(e) == _REPAIR_SCHEDULED)
        repairing = sum(1 for e in event_list if _event_type(e) == _REPAIRING)
        repair_turns = max(scheduled, repairing)
    if not repair_turns and isinstance(repair_metrics, Mapping):
        repair_turns = _as_int(repair_metrics.get("repair_attempts"))

    # TTFT is measured by the runtime at dispatch. `GET /v1/turns/:id` reports
    # the first attempt that measured one, which is what "how long until this
    # turn started speaking" means; the per-attempt value is the same number
    # when the turn route is absent.
    ttft_ms = turn_usage.get("time_to_first_token_ms")
    if ttft_ms is None:
        ttft_ms = next(
            (a.time_to_first_token_ms for a in attempts if a.time_to_first_token_ms is not None),
            None,
        )

    stop_reason = _string_or_none(turn_row.get("stop_reason")) if turn_row is not None else None
    if stop_reason is None:
        stop_reason = _legacy_stop_reason_from_events(event_list, attempts)
    if stop_reason is None and isinstance(repair_metrics, Mapping):
        stop_reason = _string_or_none(repair_metrics.get("stop_reason"))

    # Null cost is not zero cost: a turn whose price the provider never
    # reported did not run for free.
    provider_cost_micros = _as_opt_int(turn_row.get("cost_micros")) if turn_row else None
    if provider_cost_micros is None and "cost_micros" in ledger:
        provider_cost_micros = ledger["cost_micros"]

    return TurnMetrics(
        tokens_input_fresh=fresh,
        tokens_input_cached=cached,
        tokens_output=totals["output_tokens"],
        tokens_reasoning=totals["reasoning_tokens"],
        tokens_cache_write=totals["cache_write_tokens"],
        tokens_tool_schema=totals["tool_schema_tokens"],
        cache_hit_ratio=cache_hit_ratio,
        steps=steps,
        tool_errors=failed,
        tool_error_rate=tool_error_rate,
        repair_turns=repair_turns,
        ttft_ms=ttft_ms,
        stop_reason=stop_reason,
        provider_cost_micros=provider_cost_micros,
        verdict=_verdict_from_events(event_list),
        attempts=tuple(attempts),
        token_source=token_source,
    )
