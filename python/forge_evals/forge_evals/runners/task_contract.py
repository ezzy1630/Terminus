"""Fail-closed decoding of task-package admission contracts.

Task packages are intentionally data, not trusted Python.  This module keeps
the small amount of policy needed before admission in typed values: risk,
resource caps, opaque secret capability identifiers, and verification nodes.
The decoder accepts the historical nested ``task:`` layout as well as the
flat layout used by some evaluation fixtures.  A policy file can only make a
contract stricter; it cannot grant a larger budget or lower its risk.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

__all__ = [
    "ContractDecodeError",
    "TaskBudgets",
    "TaskContract",
    "decode_task_contract",
    "load_task_contract",
]


class ContractDecodeError(ValueError):
    """The task package does not contain an admissible contract."""


_RISK_RANK = {"normal": 0, "high": 1, "critical": 2}
_RISK_ALIASES = {
    "normal": "normal",
    "low": "normal",  # historical task-package spelling
    "elevated": "high",  # documented compatibility alias
    "high": "high",
    "critical": "critical",
}
_VERIFICATION_NODES = frozenset(
    {
        "parse",
        "diagnostics",
        "narrow_tests",
        "security_tests",
        "detached_review",
        "acceptance",
        "human_approval",
        "package_tests",
        "full_suite",
        "review",
        "ui_e2e",
    }
)
_BUDGET_FIELDS = (
    "model_micros",
    "compute_seconds",
    "wall_clock_seconds",
    "human_approvals",
)
_SECRET_URI = re.compile(r"secret://[A-Za-z0-9][A-Za-z0-9._/-]*\Z")
_SENSITIVE_WORDS = frozenset({"security", "secure", "auth", "authentication", "secret"})


@dataclass(frozen=True)
class TaskBudgets:
    """Optional package-level resource ceilings.

    ``None`` means the package did not declare a ceiling.  Keeping omission
    distinct from zero prevents a malformed/empty declaration from becoming a
    permissive default.
    """

    model_micros: int | None = None
    compute_seconds: int | None = None
    wall_clock_seconds: int | None = None
    human_approvals: int | None = None

    def to_dict(self) -> dict[str, int]:
        return {
            name: value
            for name in _BUDGET_FIELDS
            if (value := getattr(self, name)) is not None
        }


@dataclass(frozen=True)
class TaskContract:
    """The typed, policy-composed portion of a task package contract."""

    task_id: str
    risk_class: str
    budgets: TaskBudgets
    secret_capability_uris: tuple[str, ...]
    required_verification_nodes: tuple[str, ...]


def _mapping(value: Any, *, name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractDecodeError(f"{name} must be a mapping")
    return dict(value)


def _block(raw: Mapping[str, Any], key: str) -> dict[str, Any]:
    nested = raw.get(key)
    if nested is None:
        return dict(raw)
    if not isinstance(nested, Mapping):
        raise ContractDecodeError(f"{key} must be a mapping")
    merged = {name: value for name, value in raw.items() if name != key}
    merged.update(nested)
    return merged


def _risk(value: Any, *, source: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractDecodeError(f"{source} risk_class must be a non-empty string")
    canonical = _RISK_ALIASES.get(value.strip().lower())
    if canonical is None:
        raise ContractDecodeError(f"{source} has unknown risk_class: {value!r}")
    return canonical


def _budgets(raw: Mapping[str, Any], *, source: str) -> TaskBudgets:
    value = raw.get("budget", raw.get("budgets"))
    if value is None:
        return TaskBudgets()
    values = _mapping(value, name=f"{source} budget")
    unknown = sorted(set(values) - set(_BUDGET_FIELDS))
    if unknown:
        raise ContractDecodeError(f"{source} budget has unknown fields: {', '.join(unknown)}")
    parsed: dict[str, int] = {}
    for name in _BUDGET_FIELDS:
        if name not in values:
            continue
        number = values[name]
        # bool is an int subclass, but is never a valid resource cap.
        minimum = 0 if name == "human_approvals" else 1
        if isinstance(number, bool) or not isinstance(number, int) or number < minimum:
            qualifier = "non-negative" if name == "human_approvals" else "positive"
            raise ContractDecodeError(f"{source} budget.{name} must be a {qualifier} integer")
        parsed[name] = number
    return TaskBudgets(**parsed)


def _budget_overrides(raw: Mapping[str, Any]) -> TaskBudgets:
    candidates = [raw.get("budget_overrides"), raw.get("budget"), raw.get("budgets")]
    present = [candidate for candidate in candidates if candidate is not None]
    if not present:
        return TaskBudgets()
    first = _mapping(present[0], name="policy budget")
    for candidate in present[1:]:
        other = _mapping(candidate, name="policy budget")
        if other != first:
            raise ContractDecodeError("policy declares conflicting budget mappings")
    return _budgets({"budget": first}, source="policy")


def _strings(value: Any, *, name: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise ContractDecodeError(f"{name} must be a list of strings")
    output: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ContractDecodeError(f"{name} must contain only non-empty strings")
        item = item.strip()
        if item not in seen:
            seen.add(item)
            output.append(item)
    return tuple(output)


def _secret_uris(
    raw: Mapping[str, Any], *, source: str, include_legacy_secrets: bool = True
) -> tuple[str, ...]:
    values: list[str] = []
    keys: tuple[str, ...] = ("secret_capabilities", "secret_capability_uris")
    if include_legacy_secrets:
        keys = ("secrets", *keys)
    for key in keys:
        if key in raw:
            values.extend(_strings(raw[key], name=f"{source} {key}"))
    result = tuple(dict.fromkeys(values))
    for uri in result:
        if not _SECRET_URI.fullmatch(uri):
            raise ContractDecodeError(
                f"{source} secret capability must be a secret:// identifier, got {uri!r}"
            )
    return result


def _nodes(raw: Mapping[str, Any], *, source: str) -> tuple[str, ...]:
    value = raw.get("required_verification_nodes", raw.get("verification_nodes"))
    nodes = _strings(value, name=f"{source} required_verification_nodes")
    unknown = sorted(set(nodes) - _VERIFICATION_NODES)
    if unknown:
        raise ContractDecodeError(f"{source} has unknown verification nodes: {', '.join(unknown)}")
    return nodes


def _sensitive(raw: Mapping[str, Any], *, risk: str, uris: tuple[str, ...]) -> bool:
    if risk in {"high", "critical"} or uris:
        return True
    for key in ("security", "authentication", "requires_secret"):
        if raw.get(key) is True:
            return True
    for key in ("id", "suite", "category", "kind", "type", "tags", "labels"):
        value = raw.get(key)
        values = value if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) else [value]
        for item in values:
            if isinstance(item, str):
                words = set(re.findall(r"[a-z]+", item.lower()))
                if words & _SENSITIVE_WORDS:
                    return True
    return False


def _compose_budgets(task: TaskBudgets, policy: TaskBudgets) -> TaskBudgets:
    values: dict[str, int] = {}
    for name in _BUDGET_FIELDS:
        task_value = getattr(task, name)
        policy_value = getattr(policy, name)
        if task_value is not None and policy_value is not None and policy_value > task_value:
            raise ContractDecodeError(
                f"policy budget.{name} widens the task budget ({policy_value} > {task_value})"
            )
        if policy_value is not None:
            values[name] = policy_value
        elif task_value is not None:
            values[name] = task_value
    return TaskBudgets(**values)


def decode_task_contract(
    task_yaml: Mapping[str, Any], policy_yaml: Mapping[str, Any] | None = None
) -> TaskContract:
    """Decode and policy-compose YAML mappings without exposing secret values."""
    task = _block(_mapping(task_yaml, name="task.yaml"), "task")
    policy = _block(_mapping(policy_yaml, name="policy.yaml"), "policy") if policy_yaml else {}
    task_id = task.get("id")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ContractDecodeError("task.yaml id must be a non-empty string")
    task_risk = _risk(task.get("risk_class", "normal"), source="task")
    task_budgets = _budgets(task, source="task")
    task_secrets = _secret_uris(task, source="task")
    task_nodes = _nodes(task, source="task")
    if policy:
        policy_risk = _risk(policy.get("risk_class", task_risk), source="policy")
        if _RISK_RANK[policy_risk] < _RISK_RANK[task_risk]:
            raise ContractDecodeError("policy risk_class lowers the task risk")
        risk = policy_risk
        budgets = _compose_budgets(task_budgets, _budget_overrides(policy))
        # A policy's ``secrets`` field normally points at the
        # ``policies/secrets/default`` file, not a capability list.
        # Only explicit capability keys are meaningful in policy.yaml.
        policy_secrets = _secret_uris(policy, source="policy", include_legacy_secrets=False)
        secrets = tuple(dict.fromkeys((*task_secrets, *policy_secrets)))
        nodes = tuple(dict.fromkeys((*task_nodes, *_nodes(policy, source="policy"))))
    else:
        risk, budgets, secrets, nodes = task_risk, task_budgets, task_secrets, task_nodes
    if risk in {"high", "critical"} and budgets.human_approvals == 0:
        raise ContractDecodeError("high-risk task budget.human_approvals must be positive")
    if _sensitive(task, risk=risk, uris=secrets):
        missing = {"security_tests", "detached_review", "human_approval"} - set(nodes)
        if missing:
            raise ContractDecodeError(
                "sensitive task requires verification nodes: " + ", ".join(sorted(missing))
            )
    return TaskContract(
        task_id=task_id.strip(),
        risk_class=risk,
        budgets=budgets,
        secret_capability_uris=secrets,
        required_verification_nodes=nodes,
    )


def _read_yaml(path: Path, *, name: str) -> dict[str, Any]:
    if not path.is_file():
        raise ContractDecodeError(f"{name} is missing: {path}")
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ContractDecodeError(f"unable to read {name}: {exc}") from exc
    return _mapping(loaded, name=name)


def load_task_contract(task_dir: Path | str) -> TaskContract:
    """Load ``task.yaml`` and an optional sibling ``policy.yaml``."""
    directory = Path(task_dir)
    task = _read_yaml(directory / "task.yaml", name="task.yaml")
    policy_path = directory / "policy.yaml"
    policy = _read_yaml(policy_path, name="policy.yaml") if policy_path.exists() else None
    return decode_task_contract(task, policy)
