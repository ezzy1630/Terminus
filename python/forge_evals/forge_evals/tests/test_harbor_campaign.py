"""Focused tests for identity-safe Harbor campaign normalization."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from forge_evals.runners.harbor_campaign import (
    CampaignFailure,
    HarborCampaignError,
    HarborCampaignSpec,
    HarborHarnessCommand,
    HarborHarnessIdentity,
    HarborTaskIdentity,
    normalize_harbor_result,
    run_harbor_campaign,
)


def _spec() -> HarborCampaignSpec:
    return HarborCampaignSpec(
        suite_id="terminal-bench",
        task=HarborTaskIdentity(
            dataset="terminal-bench/terminal-bench-2",
            dataset_version="2.0.0",
            source="https://github.com/harbor-framework/terminal-bench",
            task_name="regex-log",
            task_id="terminal-bench/regex-log",
            task_checksum="sha256:task",
        ),
        provider="opencode",
        model="hy3-free",
        model_version="zen-2026-08",
        model_capability_snapshot_hash="sha256:model",
        random_seed=7,
        repository_digest="sha256:repo",
        environment_digest="sha256:environment",
        sampling_config_hash="sha256:sampling",
        sandbox_policy_hash="sha256:sandbox",
        network_policy="none",
        budget_hash="sha256:budget",
        tool_schema_hash="sha256:tools",
        instruction_hash="sha256:instruction",
    )


def _harness(name: str = "terminus") -> HarborHarnessIdentity:
    return HarborHarnessIdentity(name, "a" * 40, f"sha256:{name}")


def _result(*, reward: float = 1.0, source: str | None = None) -> dict[str, object]:
    task = _spec().task
    return {
        "task_name": task.task_name,
        "task_id": task.task_id,
        "task_checksum": task.task_checksum,
        "source": source or task.source,
        "agent_info": {
            "name": "test-agent",
            "version": "1",
            "model_info": {"name": "hy3-free", "provider": "opencode"},
        },
        "agent_result": {
            "n_input_tokens": 100,
            "n_cache_tokens": 40,
            "n_output_tokens": 12,
            "cost_usd": 0.01,
        },
        "started_at": "2026-08-29T10:00:00+00:00",
        "finished_at": "2026-08-29T10:00:02.500000+00:00",
        "verifier_result": {"rewards": {"reward": reward}},
    }


def test_normalizer_projects_exact_metrics_into_pairable_record(tmp_path: Path) -> None:
    path = tmp_path / "results.json"
    path.write_text(json.dumps(_result()), encoding="utf-8")

    normalized = normalize_harbor_result(path, spec=_spec(), harness=_harness())

    assert not isinstance(normalized, CampaignFailure)
    record = normalized.to_run_record(_spec())
    assert record.success is True
    assert record.steps == 1
    assert record.tokens_input_fresh == 60
    assert record.tokens_input_cached == 40
    assert record.tokens_output == 12
    assert record.cache_hit_ratio == pytest.approx(0.4)
    assert record.wall_clock_ms == 2500
    assert record.evaluation_identity is not None
    assert record.evaluation_identity.model_fixed_key


def test_normalizer_refuses_a_result_for_a_different_task(tmp_path: Path) -> None:
    path = tmp_path / "results.json"
    payload = _result()
    payload["task_name"] = "other-task"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(HarborCampaignError, match="task_name"):
        normalize_harbor_result(path, spec=_spec(), harness=_harness())


def test_normalizer_separates_missing_verifier_as_configuration_failure(tmp_path: Path) -> None:
    path = tmp_path / "results.json"
    payload = _result()
    payload.pop("verifier_result")
    payload["exception_info"] = {
        "exception_type": "AuthError",
        "exception_message": "No API key found for opencode",
    }
    path.write_text(json.dumps(payload), encoding="utf-8")

    normalized = normalize_harbor_result(path, spec=_spec(), harness=_harness("pi"))

    assert isinstance(normalized, CampaignFailure)
    assert normalized.kind == "configuration"
    assert "API key" in normalized.reason


def test_campaign_runs_commands_and_keeps_task_failures_scored(tmp_path: Path) -> None:
    result_path = tmp_path / "result.json"
    result_path.write_text(json.dumps(_result(reward=0.0)), encoding="utf-8")
    script = tmp_path / "ok.py"
    script.write_text("raise SystemExit(0)\n", encoding="utf-8")
    command = HarborHarnessCommand(
        identity=_harness("opencode"),
        argv=(sys.executable, str(script)),
        result_path=result_path,
        timeout_seconds=5,
    )

    campaign = run_harbor_campaign(_spec(), [command])

    assert not campaign.failures
    assert len(campaign.records) == 1
    assert campaign.records[0].success is False
    assert campaign.records[0].primary_score == 0.0


def test_campaign_classifies_command_failure_as_infrastructure(tmp_path: Path) -> None:
    command = HarborHarnessCommand(
        identity=_harness("pi"),
        argv=("definitely-not-a-real-harbor-executable",),
        result_path=tmp_path / "missing.json",
    )

    campaign = run_harbor_campaign(_spec(), [command])

    assert not campaign.records
    assert len(campaign.failures) == 1
    assert campaign.failures[0].kind == "infrastructure"
