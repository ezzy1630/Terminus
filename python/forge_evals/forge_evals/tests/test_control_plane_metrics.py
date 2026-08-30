"""Reconciliation of run metrics, environment digests, and cost from the control plane."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from forge_evals.runners.control_plane_metrics import parse_budget_ledger, reconcile_metrics
from forge_evals.runners.environment_digest import (
    LiveEnvironmentDigest,
    hash_workspace_tree,
    runtime_identity_string,
)
from forge_evals.runners.model_pricing import (
    compute_cost,
    load_registry_pricing,
    prices_from_control_plane_models,
    resolve_model_prices,
)

REPO_ROOT = Path(__file__).resolve().parents[4]


def _event(event: str, data: dict[str, Any], occurred_at: str = "2026-08-29T12:00:00+00:00") -> dict[str, Any]:
    """A `GET /v1/tasks/:id/transcript` entry: {id, event, data, occurred_at}."""
    return {"id": f"ev-{event}", "event": event, "data": json.dumps(data), "occurred_at": occurred_at}


def _usage(
    *,
    input_tokens: int,
    cached: int = 0,
    output: int = 0,
    reasoning: int = 0,
    ttft: int | None = None,
) -> dict[str, Any]:
    return {
        "inputTokens": str(input_tokens),
        "cachedInputTokens": str(cached),
        "cacheWriteTokens": "0",
        "outputTokens": str(output),
        "reasoningTokens": str(reasoning),
        "toolSchemaTokens": "0",
        "latencyMs": 900,
        "timeToFirstTokenMs": ttft,
    }


def _route_usage(
    *,
    input_tokens: int,
    cached: int = 0,
    output: int = 0,
    reasoning: int = 0,
    ttft: int | None = None,
) -> dict[str, Any]:
    """The snake_case, BigInt-as-string shape the turn routes answer with."""
    return {
        "input_tokens": str(input_tokens),
        "cached_input_tokens": str(cached),
        "cache_write_tokens": "0",
        "output_tokens": str(output),
        "reasoning_tokens": str(reasoning),
        "tool_schema_tokens": "0",
        "latency_ms": 900,
        "time_to_first_token_ms": ttft,
    }


def _route_attempt(number: int, usage: dict[str, Any], finish: str = "stop") -> dict[str, Any]:
    return {
        "provider_attempt_id": f"a-{number}",
        "attempt_number": number,
        "model": "gpt-5.6",
        "usage": usage,
        "finish_reason": finish,
        "provider_reported_cost_micros": None,
        "computed_cost_micros": "1000",
        "cost_source": "computed",
    }


# ──────────────────── typed turn routes (Phase 0-F2) ──────────────────────


def test_turn_route_usage_is_preferred_over_the_event_log() -> None:
    """The route reads the attempt columns; the events re-derive them."""
    events = [
        _event(
            "turn.response_validating",
            {"provider_attempt_id": "a-1", "usage": _usage(input_tokens=1, output=1)},
        ),
    ]
    metrics = reconcile_metrics(
        events=events,
        turn={
            "usage": _route_usage(input_tokens=5_000, cached=3_000, output=500, reasoning=100),
            "cost_micros": "9000",
            "stop_reason": "budget_exhausted",
        },
    )
    assert metrics.token_source == "turn_usage_route"
    assert metrics.tokens_input_fresh == 2_000
    assert metrics.tokens_input_cached == 3_000
    assert metrics.tokens_output == 500
    assert metrics.provider_cost_micros == 9_000
    # The route states the rule; the client no longer guesses "stop".
    assert metrics.stop_reason == "budget_exhausted"


def test_attempts_route_uses_the_servers_own_ordinal() -> None:
    """Cache-hit ratio is defined over attempts >= 2, so numbering must not slip."""
    attempts = [
        _route_attempt(2, _route_usage(input_tokens=4_000, cached=3_000, output=300)),
    ]
    metrics = reconcile_metrics(events=[], turn_attempts=attempts)
    assert metrics.token_source == "provider_attempts_route"
    assert [a.attempt_index for a in metrics.attempts] == [2]
    assert metrics.cache_hit_ratio == 0.75


def test_first_attempt_alone_reports_no_cache_hit_ratio() -> None:
    metrics = reconcile_metrics(
        events=[],
        turn_attempts=[_route_attempt(1, _route_usage(input_tokens=1_000, cached=0))],
    )
    assert metrics.cache_hit_ratio is None


def test_a_task_wide_ledger_that_exceeds_the_turn_wins() -> None:
    """A repair turn the control plane scheduled itself is still part of the run."""
    metrics = reconcile_metrics(
        events=[],
        turn={"usage": _route_usage(input_tokens=1_000, output=100)},
        budget_ledger={"input_tokens": "9000", "output_tokens": "900", "cached_input_tokens": "0"},
    )
    assert metrics.token_source == "budget_ledger"
    assert metrics.tokens_input_fresh == 9_000


def test_provider_receipts_sum_original_and_repair_attempts() -> None:
    """Run accounting covers every attempt, including automatic repairs."""
    receipts = [
        {
            "receipt_id": "original-1",
            "turn_id": "turn-original",
            "attempt_number": 1,
            "usage": _route_usage(input_tokens=1_000, cached=0, output=100, reasoning=10),
            "provider_reported_cost_micros": "2_000",
            "finish_reason": "tool_use",
        },
        {
            "receipt_id": "repair-1",
            "turn_id": "turn-repair",
            "attempt_number": 1,
            "usage": _route_usage(input_tokens=2_000, cached=1_500, output=200, reasoning=20),
            "provider_reported_cost_micros": "3_000",
            "finish_reason": "stop",
        },
    ]

    metrics = reconcile_metrics(events=[], provider_receipts=receipts)

    assert metrics.token_source == "provider_receipts"
    assert metrics.tokens_input_fresh == 1_500
    assert metrics.tokens_input_cached == 1_500
    assert metrics.tokens_output == 300
    assert metrics.tokens_reasoning == 30
    assert metrics.provider_cost_micros == 5_000
    assert [attempt.attempt_index for attempt in metrics.attempts] == [1, 2]


def test_missing_provider_receipt_cost_is_not_reported_as_zero() -> None:
    """A receipt set with unknown prices must keep provider cost unknown."""
    receipts = [
        {
            "receipt_id": "original-1",
            "usage": _route_usage(input_tokens=1_000, output=100),
            "provider_reported_cost_micros": None,
            "finish_reason": "stop",
        },
    ]

    metrics = reconcile_metrics(events=[], provider_receipts=receipts)

    assert metrics.provider_cost_micros is None


def test_routes_that_404_fall_back_to_the_event_log() -> None:
    """A control plane older than Phase 0-F2 answers neither turn route."""
    events = [
        _event(
            "turn.response_validating",
            {"provider_attempt_id": "a-1", "usage": _usage(input_tokens=1_000, output=200, ttft=640)},
        ),
        _event("turn.failed", {"reason": "budget_exhausted"}),
    ]
    metrics = reconcile_metrics(events=events, turn=None, turn_attempts=None)
    assert metrics.token_source == "provider_attempt_events"
    assert metrics.tokens_input_fresh == 1_000
    assert metrics.ttft_ms == 640
    assert metrics.stop_reason == "budget_exhausted"


def test_verification_nodes_name_the_criterion_they_check() -> None:
    events = [
        _event(
            "verification.node_failed",
            {"node_id": "n-typo", "criterion_id": "typo-fixed", "status": "fail"},
        ),
        # Infrastructure nodes are bound to no criterion; a null is reported as
        # nothing rather than invented.
        _event(
            "verification.node_passed",
            {"node_id": "n-build", "criterion_id": None, "status": "pass"},
        ),
        _event("verification.plan_completed", {"status": "failed"}),
    ]
    verdict = reconcile_metrics(events=events).verdict
    assert verdict.failed_criteria == ("typo-fixed",)
    assert verdict.passed_criteria == ()
    assert verdict.passed_nodes == ("n-build",)


# ──────────────────────────── budget ledger ───────────────────────────────


def test_budget_ledger_bigints_arrive_as_strings() -> None:
    """Every token/cost value on GET /v1/tasks/:id is a stringified BigInt."""
    ledger = parse_budget_ledger(
        {
            "steps_used": "7",
            "input_tokens": "120000",
            "cached_input_tokens": "90000",
            "output_tokens": "4200",
            "reasoning_tokens": "1500",
            "cost_micros": "31500",
        }
    )
    assert ledger["input_tokens"] == 120_000
    assert ledger["cached_input_tokens"] == 90_000
    assert ledger["steps_used"] == 7
    assert parse_budget_ledger(None) == {}


# ──────────────────────────── metric reconciliation ───────────────────────


def test_tokens_split_fresh_from_cached_using_the_ledger() -> None:
    """`input_tokens` is total input; cached is a subset, never additive."""
    metrics = reconcile_metrics(
        events=[],
        budget_ledger={
            "input_tokens": "100000",
            "cached_input_tokens": "80000",
            "output_tokens": "5000",
            "reasoning_tokens": "1200",
            "cache_write_tokens": "300",
            "cost_micros": "42000",
        },
    )
    assert metrics.tokens_input_fresh == 20_000
    assert metrics.tokens_input_cached == 80_000
    assert metrics.tokens_input_total == 100_000
    assert metrics.tokens_output == 5_000
    assert metrics.tokens_reasoning == 1_200
    assert metrics.token_source == "budget_ledger"
    assert metrics.provider_cost_micros == 42_000


def test_cache_hit_ratio_only_counts_attempts_from_the_second_onward() -> None:
    """The first attempt cannot hit a cache it just created."""
    events = [
        _event("turn.provider_running", {"provider_attempt_id": "a-1", "attempt_number": 1}),
        _event(
            "turn.response_validating",
            {"provider_attempt_id": "a-1", "finish_reason": "tool_use", "usage": _usage(input_tokens=1000, cached=0, output=100)},
        ),
        _event("turn.provider_running", {"provider_attempt_id": "a-2", "attempt_number": 2}),
        _event(
            "turn.response_validating",
            {"provider_attempt_id": "a-2", "finish_reason": "stop", "usage": _usage(input_tokens=2000, cached=1500, output=50)},
        ),
    ]
    metrics = reconcile_metrics(events=events)
    assert len(metrics.attempts) == 2
    assert metrics.cache_hit_ratio == 0.75  # 1500 / 2000, attempt 2 only
    assert metrics.token_source == "provider_attempt_events"


def test_single_attempt_reports_no_cache_ratio_rather_than_zero() -> None:
    events = [
        _event("turn.response_validating", {"provider_attempt_id": "a-1", "usage": _usage(input_tokens=1000)}),
    ]
    assert reconcile_metrics(events=events).cache_hit_ratio is None


def test_steps_and_tool_error_rate_come_from_the_tool_event_names() -> None:
    """`tool.settled` vs `tool.failed` is the success flag; there is no boolean."""
    events = [
        _event("tool.proposed", {"tool_call_id": "c-1", "tool_id": "edit"}),
        _event("tool.settled", {"tool_call_id": "c-1", "status": "success"}),
        _event("tool.proposed", {"tool_call_id": "c-2", "tool_id": "shell"}),
        _event("tool.failed", {"tool_call_id": "c-2", "status": "error"}),
        _event("tool.proposed", {"tool_call_id": "c-3", "tool_id": "shell"}),
        _event("tool.denied", {"tool_call_id": "c-3", "rule_id": "deny-network"}),
        _event("tool.proposed", {"tool_call_id": "c-4", "tool_id": "edit"}),
        _event("tool.settled", {"tool_call_id": "c-4", "status": "partial"}),
    ]
    metrics = reconcile_metrics(events=events)
    assert metrics.steps == 4
    assert metrics.tool_errors == 2
    assert metrics.tool_error_rate == 0.5


def test_repair_turns_are_counted_once_per_repair() -> None:
    events = [
        _event("task.repair_scheduled", {"repair_attempt": 1, "repair_attempt_id": "r-1"}),
        _event("turn.repair_pending", {"repair_attempt": 1}),
        _event("turn.repairing", {"repair_attempt": 1, "repair_attempt_id": "r-1"}),
        _event("task.repair_scheduled", {"repair_attempt": 2, "repair_attempt_id": "r-2"}),
        _event("turn.repairing", {"repair_attempt": 2, "repair_attempt_id": "r-2"}),
    ]
    assert reconcile_metrics(events=events).repair_turns == 2


def test_ttft_comes_from_the_turn_route() -> None:
    turn = {"usage": _route_usage(input_tokens=10, ttft=812), "stop_reason": "stop"}
    assert reconcile_metrics(events=[], turn=turn).ttft_ms == 812


def test_ttft_falls_back_to_the_attempts_own_measurement() -> None:
    """No turn route: the measurement the runtime recorded is still on attempts.

    What is *not* rebuilt any more is a TTFT subtracted from event timestamps;
    that was this client re-deriving a number the runtime measures at dispatch,
    and it silently reported queueing delay as model latency.
    """
    events = [
        _event(
            "turn.response_validating",
            {"provider_attempt_id": "a-1", "usage": _usage(input_tokens=10, ttft=640)},
        ),
    ]
    assert reconcile_metrics(events=events).ttft_ms == 640

    without_measurement = [
        _event("turn.provider_running", {"provider_attempt_id": "a-1"}, "2026-08-29T12:00:00+00:00"),
        _event("turn.provider_text_delta", {"text": "Loo"}, "2026-08-29T12:00:01.250000+00:00"),
        _event(
            "turn.response_validating",
            {"provider_attempt_id": "a-1", "usage": _usage(input_tokens=10)},
        ),
    ]
    assert reconcile_metrics(events=without_measurement).ttft_ms is None


def test_verdict_admitted() -> None:
    events = [
        _event("verification.node_passed", {"node_id": "n-parse", "status": "pass"}),
        _event("verification.plan_completed", {"status": "all_passed"}),
        _event("verification.admitted", {"plan_id": "plan-1", "phase": "VERIFIED"}),
        _event("turn.completed", {"state": "COMPLETED"}),
    ]
    verdict = reconcile_metrics(events=events).verdict
    assert verdict.admitted is True
    assert verdict.status == "admitted"
    assert verdict.plan_ids == ("plan-1",)
    assert verdict.passed_nodes == ("n-parse",)


def test_verdict_failed_and_stop_reason_prefers_the_turn_failure() -> None:
    events = [
        _event("verification.node_failed", {"node_id": "n-tests", "status": "fail"}),
        _event("verification.plan_completed", {"status": "failed"}),
        _event(
            "turn.response_validating",
            {"provider_attempt_id": "a-1", "finish_reason": "stop", "usage": _usage(input_tokens=5)},
        ),
        _event("turn.failed", {"reason": "completion_gate_denied", "code": "VERIFICATION"}),
    ]
    metrics = reconcile_metrics(events=events)
    assert metrics.verdict.admitted is False
    assert metrics.verdict.failed_nodes == ("n-tests",)
    assert metrics.stop_reason == "completion_gate_denied"


def test_verdict_not_runnable_is_not_a_pass_and_not_a_fail() -> None:
    events = [
        _event(
            "verification.no_runnable_checks",
            {"plan_id": "plan-1", "skipped_nodes": [{"node_id": "n-ui", "reason": "UI_E2E"}]},
        ),
        _event("verification.plan_completed", {"status": "no_runnable_checks"}),
    ]
    verdict = reconcile_metrics(events=events).verdict
    assert verdict.admitted is None
    assert verdict.status == "not_runnable"
    assert verdict.skipped_nodes == ("n-ui",)


def test_verdict_not_applicable_for_a_turn_with_no_workspace_changes() -> None:
    events = [
        _event(
            "turn.verification_not_applicable",
            {"reason": "turn_made_no_workspace_changes", "detail": "no mutating tool settled"},
        ),
    ]
    verdict = reconcile_metrics(events=events).verdict
    assert verdict.status == "not_applicable"
    assert verdict.admitted is None


def test_v2_envelope_events_are_accepted_too() -> None:
    """/v2/events frames use camelCase envelopes with an inline payload."""
    events = [
        {
            "eventId": "e1",
            "eventType": "tool.proposed",
            "occurredAt": "2026-08-29T12:00:00+00:00",
            "payload": {"tool_id": "edit"},
        },
        {
            "eventId": "e2",
            "eventType": "tool.settled",
            "occurredAt": "2026-08-29T12:00:01+00:00",
            "payload": {"status": "success"},
        },
    ]
    metrics = reconcile_metrics(events=events)
    assert metrics.steps == 1
    assert metrics.tool_error_rate == 0.0


def test_no_evidence_means_unavailable_not_zero() -> None:
    metrics = reconcile_metrics(events=[])
    assert metrics.token_source == "unavailable"
    assert metrics.cache_hit_ratio is None
    assert metrics.tool_error_rate is None
    assert metrics.ttft_ms is None


# ──────────────────────────── environment digest ──────────────────────────


def test_workspace_tree_hash_is_content_addressed_and_ignores_git(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    (workspace / "src").mkdir(parents=True)
    (workspace / "src" / "lib.py").write_text("def greet(): ...\n", encoding="utf-8")
    first = hash_workspace_tree(workspace)
    assert first.startswith("sha256:")
    assert len(first) == len("sha256:") + 64

    # Repeat runs of an unchanged tree agree.
    assert hash_workspace_tree(workspace) == first

    # VCS metadata is not content the agent sees.
    (workspace / ".git").mkdir()
    (workspace / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    assert hash_workspace_tree(workspace) == first

    # A content change must change the digest.
    (workspace / "src" / "lib.py").write_text("def greet(): return 1\n", encoding="utf-8")
    assert hash_workspace_tree(workspace) != first


def test_runtime_identity_excludes_the_per_process_instance_id() -> None:
    """A restart nonce in the digest would poison every cross-run comparison."""
    health = {
        "version": "0.1.0",
        "build_commit": "c2cd9d5",
        "instance_id": "9f2c1a1e-restart-nonce",
        "kernel": {"state": "READY", "degradations": []},
    }
    identity = runtime_identity_string(health, {"backend_id": "seatbelt", "status": "enforced"})
    assert "9f2c1a1e-restart-nonce" not in identity
    assert "control_build_commit=c2cd9d5" in identity
    assert "sandbox_backend=seatbelt" in identity

    restarted = {**health, "instance_id": "another-nonce"}
    assert runtime_identity_string(restarted, {"backend_id": "seatbelt", "status": "enforced"}) == identity


def test_live_environment_digest_satisfies_the_exit_gate_shape(tmp_path: Path) -> None:
    task_dir = tmp_path / "task"
    task_dir.mkdir()
    (task_dir / "task.yaml").write_text("task: {id: t}\n", encoding="utf-8")
    (task_dir / "setup.sh").write_text("echo hi\n", encoding="utf-8")

    digest = LiveEnvironmentDigest.build(workspace_root=task_dir, task_dir=task_dir)
    value = digest.to_digest()
    assert value.startswith("sha256:") and len(value) == 71
    assert value != "remote:workspace-id"
    assert digest.to_dict()["digest"] == value
    assert digest.to_dict()["workspace_tree_digest"].startswith("sha256:")


# ──────────────────────────── pricing and cost ────────────────────────────


def test_control_plane_catalog_prices_win_when_present() -> None:
    catalog = {
        "models": [
            {
                "id": "gpt-5.6",
                "provider": "acct-1",
                "billing": "metered",
                "pricing": {
                    "input_micros_per_million": 2_000_000,
                    "cached_input_micros_per_million": 200_000,
                    "output_micros_per_million": 12_000_000,
                },
                "pricing_source": "catalog",
            }
        ]
    }
    prices = prices_from_control_plane_models(catalog, "gpt-5.6")
    assert prices is not None
    assert prices.input_usd_per_mtok == 2.0
    assert prices.output_usd_per_mtok == 12.0
    # Read, not assumed equal to fresh input: cache reads are billed at a
    # fraction, and assuming parity overstates a cached turn ~10x.
    assert prices.cached_input_usd_per_mtok == 0.2
    assert prices.source == "control_plane:/v1/provider-models:catalog"


def test_subscription_accounts_state_that_they_have_no_prices() -> None:
    """`pricing: null` + `pricing_source` says *why*, so nothing is inferred."""
    catalog = {
        "models": [
            {
                "id": "gpt-5.6",
                "provider": "acct-chatgpt",
                "billing": "subscription",
                "pricing": None,
                "pricing_source": "subscription",
            }
        ]
    }
    assert prices_from_control_plane_models(catalog, "gpt-5.6") is None

    prices = resolve_model_prices("gpt-5.6", catalog=catalog)
    assert prices is not None
    assert "registry" in prices.source
    assert prices.cached_input_usd_per_mtok == 0.2


def test_registry_pricing_block_is_present_and_typed() -> None:
    table = load_registry_pricing()
    assert "gpt-5.6" in table
    raw = yaml.safe_load((REPO_ROOT / "evals" / "registry.yaml").read_text(encoding="utf-8"))
    assert set(raw["model_pricing"]["gpt-5.6"]) == {
        "input_usd_per_mtok",
        "output_usd_per_mtok",
        "cached_input_usd_per_mtok",
        "reasoning_accounting",
    }


def test_family_fallback_prices_a_codex_deployment_id() -> None:
    prices = resolve_model_prices("gpt-5.6-codex")
    assert prices is not None
    assert prices.input_usd_per_mtok == 2.0


def test_unknown_model_has_no_price_rather_than_a_guess() -> None:
    assert resolve_model_prices("some-model-nobody-priced") is None


def test_cost_formula_matches_the_control_planes_own_accounting() -> None:
    """Cached input is a subset billed at the cached rate; the rest at input."""
    prices = resolve_model_prices("gpt-5.6")
    assert prices is not None
    cost = compute_cost(
        prices,
        tokens_input_fresh=20_000,
        tokens_input_cached=80_000,
        tokens_output=5_000,
        tokens_reasoning=1_200,
    )
    expected = 20_000 / 1e6 * 2.0 + 80_000 / 1e6 * 0.2 + 5_000 / 1e6 * 12.0
    assert cost == round(expected, 8)


def test_reasoning_is_only_billed_when_accounting_says_it_is_separate() -> None:
    from forge_evals.runners.model_pricing import ModelPrices

    separate = ModelPrices(
        model="m",
        input_usd_per_mtok=1.0,
        output_usd_per_mtok=10.0,
        cached_input_usd_per_mtok=0.1,
        source="test",
        reasoning_accounting=True,
    )
    inline = ModelPrices(
        model="m",
        input_usd_per_mtok=1.0,
        output_usd_per_mtok=10.0,
        cached_input_usd_per_mtok=0.1,
        source="test",
        reasoning_accounting=False,
    )
    args = {
        "tokens_input_fresh": 0,
        "tokens_input_cached": 0,
        "tokens_output": 1_000,
        "tokens_reasoning": 1_000,
    }
    assert compute_cost(separate, **args) == round(2_000 / 1e6 * 10.0, 8)
    assert compute_cost(inline, **args) == round(1_000 / 1e6 * 10.0, 8)
