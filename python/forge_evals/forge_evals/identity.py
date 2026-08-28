"""Locked identity for reproducible, model-fixed evaluation comparisons.

The identity is part of the evidence key, not presentation metadata. A pair
is eligible for statistical promotion only when every model/environment/task
field matches; harness identity remains recorded per side of the pair.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

__all__ = ["EvaluationIdentity", "LockedEvaluationIdentity"]


@dataclass(frozen=True)
class EvaluationIdentity:
    """Immutable identity required for a model-fixed evaluation run."""

    task_id: str
    task_version: str
    repository_digest: str
    environment_digest: str
    harness_id: str
    harness_commit: str
    harness_config_hash: str
    provider: str
    model: str
    model_version: str
    model_capability_snapshot_hash: str
    random_seed: int
    sampling_config_hash: str
    sandbox_policy_hash: str
    network_policy: str
    budget_hash: str
    tool_schema_hash: str
    instruction_hash: str

    def __post_init__(self) -> None:
        for name, value in self.to_dict().items():
            if name == "random_seed":
                continue
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a non-empty string")
        if not isinstance(self.random_seed, int) or isinstance(self.random_seed, bool):
            raise ValueError("random_seed must be an integer")
        if self.random_seed < 0:
            raise ValueError("random_seed must be non-negative")

    @property
    def capability_snapshot_hash(self) -> str:
        """Short alias for callers that use the SPEC's capability wording."""
        return self.model_capability_snapshot_hash

    def to_dict(self) -> dict[str, str | int]:
        """Return the exact result-key fields as JSON-safe values."""
        return {
            "task_id": self.task_id,
            "task_version": self.task_version,
            "repository_digest": self.repository_digest,
            "environment_digest": self.environment_digest,
            "harness_id": self.harness_id,
            "harness_commit": self.harness_commit,
            "harness_config_hash": self.harness_config_hash,
            "provider": self.provider,
            "model": self.model,
            "model_version": self.model_version,
            "model_capability_snapshot_hash": self.model_capability_snapshot_hash,
            "random_seed": self.random_seed,
            "sampling_config_hash": self.sampling_config_hash,
            "sandbox_policy_hash": self.sandbox_policy_hash,
            "network_policy": self.network_policy,
            "budget_hash": self.budget_hash,
            "tool_schema_hash": self.tool_schema_hash,
            "instruction_hash": self.instruction_hash,
        }

    @property
    def result_key(self) -> str:
        """Stable digest for this exact task/harness/model attempt."""
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))
        return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    @property
    def model_fixed_key(self) -> str:
        """Stable digest of fields that must match across harnesses."""
        values = self.to_dict()
        for key in ("harness_id", "harness_commit", "harness_config_hash"):
            values.pop(key)
        encoded = json.dumps(values, sort_keys=True, separators=(",", ":"))
        return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def compatible_model_fixed(self, other: EvaluationIdentity) -> bool:
        """Whether two runs are eligible for a model-fixed pair."""
        return self.model_fixed_key == other.model_fixed_key

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EvaluationIdentity:
        """Decode a serialized identity and reject missing fields."""
        def text(name: str) -> str:
            value = data[name]
            if not isinstance(value, str):
                raise ValueError(f"{name} must be a string")
            return value

        seed = data["random_seed"]
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise ValueError("random_seed must be an integer")
        return cls(
            task_id=text("task_id"),
            task_version=text("task_version"),
            repository_digest=text("repository_digest"),
            environment_digest=text("environment_digest"),
            harness_id=text("harness_id"),
            harness_commit=text("harness_commit"),
            harness_config_hash=text("harness_config_hash"),
            provider=text("provider"),
            model=text("model"),
            model_version=text("model_version"),
            model_capability_snapshot_hash=text("model_capability_snapshot_hash"),
            random_seed=seed,
            sampling_config_hash=text("sampling_config_hash"),
            sandbox_policy_hash=text("sandbox_policy_hash"),
            network_policy=text("network_policy"),
            budget_hash=text("budget_hash"),
            tool_schema_hash=text("tool_schema_hash"),
            instruction_hash=text("instruction_hash"),
        )


# Name used by the evaluation/promotion API when the evidence is immutable.
LockedEvaluationIdentity = EvaluationIdentity
