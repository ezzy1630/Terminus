from pathlib import Path

import pytest
import yaml

from forge_evals.runners.task_contract import (
    ContractDecodeError,
    decode_task_contract,
    load_task_contract,
)


def test_decodes_nested_task_and_policy_composes_stricter_values(tmp_path: Path) -> None:
    task = {
        "task": {
            "id": "security/rotate-token",
            "risk_class": "elevated",
            "budget": {"model_micros": 100, "compute_seconds": 20},
            "secrets": ["secret://test/token"],
            "required_verification_nodes": ["parse", "acceptance"],
        }
    }
    policy = {
        "policy": {
            "risk_class": "critical",
            "budget_overrides": {"model_micros": 90, "compute_seconds": 10},
            "required_verification_nodes": [
                "security_tests",
                "detached_review",
                "human_approval",
            ],
        }
    }

    contract = decode_task_contract(task, policy)

    assert contract.task_id == "security/rotate-token"
    assert contract.risk_class == "critical"
    assert contract.budgets.to_dict() == {"model_micros": 90, "compute_seconds": 10}
    assert contract.secret_capability_uris == ("secret://test/token",)
    assert contract.required_verification_nodes == (
        "parse",
        "acceptance",
        "security_tests",
        "detached_review",
        "human_approval",
    )


def test_loads_flat_task_and_optional_policy(tmp_path: Path) -> None:
    (tmp_path / "task.yaml").write_text(
        yaml.safe_dump(
            {
                "id": "tiny/fix",
                "risk_class": "low",
                "budget": {"wall_clock_seconds": 30},
                "required_verification_nodes": ["parse"],
            }
        ),
        encoding="utf-8",
    )

    contract = load_task_contract(tmp_path)

    assert contract.risk_class == "normal"
    assert contract.budgets.wall_clock_seconds == 30
    assert contract.required_verification_nodes == ("parse",)


@pytest.mark.parametrize(
    ("task", "policy", "message"),
    [
        ({"id": "x", "risk_class": "unknown"}, None, "unknown risk_class"),
        ({"id": "x", "secrets": ["https://bad"]}, None, "secret:// identifier"),
        ({"id": "x", "secrets": ["secret://"]}, None, "secret:// identifier"),
        ({"id": "x", "required_verification_nodes": ["invented"]}, None, "unknown verification"),
        (
            {"id": "x", "budget": {"model_micros": 10}},
            {"budget_overrides": {"model_micros": 11}},
            "widens",
        ),
        (
            {"id": "x", "risk_class": "normal"},
            {"risk_class": "critical"},
            "requires verification nodes",
        ),
        (
            {"id": "security/x", "risk_class": "normal"},
            None,
            "requires verification nodes",
        ),
        (
            {"id": "security/x", "risk_class": "high", "budget": {"human_approvals": 0}},
            {
                "required_verification_nodes": [
                    "security_tests",
                    "detached_review",
                    "human_approval",
                ]
            },
            "human_approvals must be positive",
        ),
    ],
)
def test_rejects_malformed_or_unsafe_contract(
    task: dict[str, object], policy: dict[str, object] | None, message: str
) -> None:
    with pytest.raises(ContractDecodeError, match=message):
        decode_task_contract(task, policy)


def test_policy_nodes_union_without_duplicates() -> None:
    contract = decode_task_contract(
        {
            "id": "x",
            "required_verification_nodes": ["parse", "acceptance"],
        },
        {"required_verification_nodes": ["parse", "diagnostics"]},
    )

    assert contract.required_verification_nodes == ("parse", "acceptance", "diagnostics")


def test_sensitive_task_requires_all_security_nodes_even_when_secret_is_opaque() -> None:
    with pytest.raises(ContractDecodeError, match="human_approval"):
        decode_task_contract(
            {
                "id": "normal-task",
                "secrets": ["secret://broker/token"],
                "required_verification_nodes": ["security_tests", "detached_review"],
            }
        )
