"""Validated preregistration for Terminus feature ablations.

The registry records hypotheses and paired cells; it does not declare a win.
Promotion still requires immutable paired run evidence and the promotion gate.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

REQUIRED_FEATURES = frozenset({
    "semantic_retrieval",
    "model_routing",
    "subagents",
    "memory",
    "evidence_graph",
    "adaptive_tool_disclosure",
    "compaction",
})
ALLOWED_DECISIONS = frozenset({
    "default_off_pending_evidence",
    "protected_core_requires_simplification_evidence",
    "promoted",
    "demoted",
    "deleted",
})


class FeatureRegistryError(ValueError):
    """Raised when a feature experiment registry is not preregistered safely."""


@dataclass(frozen=True)
class FeatureExperimentRegistry:
    schema_version: int
    control_profile: Mapping[str, Any]
    features: tuple[Mapping[str, Any], ...]
    paired_experiments: tuple[Mapping[str, Any], ...]


def _non_empty_text(row: Mapping[str, Any], key: str, *, owner: str) -> None:
    if not isinstance(row.get(key), str) or not str(row[key]).strip():
        raise FeatureRegistryError(f"{owner}.{key} must be non-empty text")


def _unique_ids(rows: list[Any], *, owner: str) -> set[str]:
    ids: list[str] = []
    for row in rows:
        if not isinstance(row, Mapping):
            raise FeatureRegistryError(f"{owner} entries must be mappings")
        _non_empty_text(row, "id", owner=owner)
        ids.append(str(row["id"]))
    if len(ids) != len(set(ids)):
        raise FeatureRegistryError(f"{owner} ids must be unique")
    return set(ids)


def load_feature_registry(path: Path | str) -> FeatureExperimentRegistry:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping) or raw.get("schema_version") != 1:
        raise FeatureRegistryError("schema_version must be 1")
    control = raw.get("control_profile")
    features = raw.get("features")
    experiments = raw.get("paired_experiments")
    if not isinstance(control, Mapping):
        raise FeatureRegistryError("control_profile must be a mapping")
    if control.get("id") != "terminus-minimal" or str(control.get("version")) != "1":
        raise FeatureRegistryError("control_profile must bind terminus-minimal version 1")
    if control.get("status") != "executable_default":
        raise FeatureRegistryError("control_profile must explicitly remain the executable default")
    if not isinstance(features, list) or not isinstance(experiments, list):
        raise FeatureRegistryError("features and paired_experiments must be lists")

    feature_ids = _unique_ids(features, owner="features")
    if feature_ids != REQUIRED_FEATURES:
        missing = sorted(REQUIRED_FEATURES - feature_ids)
        extra = sorted(feature_ids - REQUIRED_FEATURES)
        raise FeatureRegistryError(f"feature inventory mismatch: missing={missing}, extra={extra}")
    for feature in features:
        assert isinstance(feature, Mapping)
        feature_id = str(feature["id"])
        for key in (
            "hypothesis",
            "expected_measurable_benefit",
            "deletion_or_demotion_condition",
        ):
            _non_empty_text(feature, key, owner=feature_id)
        archetypes = feature.get("target_task_archetypes")
        if not isinstance(archetypes, list) or not archetypes:
            raise FeatureRegistryError(f"{feature_id}.target_task_archetypes must be non-empty")
        for key in ("cost_budget", "reliability_budget"):
            budget = feature.get(key)
            if not isinstance(budget, Mapping) or not budget:
                raise FeatureRegistryError(f"{feature_id}.{key} must be a non-empty mapping")
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in budget.values()):
                raise FeatureRegistryError(f"{feature_id}.{key} values must be numeric")
        if feature.get("current_decision") not in ALLOWED_DECISIONS:
            raise FeatureRegistryError(f"{feature_id}.current_decision is not recognized")

    experiment_ids = _unique_ids(experiments, owner="paired_experiments")
    if not experiment_ids:
        raise FeatureRegistryError("at least one paired experiment is required")
    covered: set[str] = set()
    for experiment in experiments:
        assert isinstance(experiment, Mapping)
        experiment_id = str(experiment["id"])
        feature_id = experiment.get("feature_id")
        if feature_id not in feature_ids:
            raise FeatureRegistryError(f"{experiment_id} names unknown feature {feature_id!r}")
        covered.add(str(feature_id))
        baseline = experiment.get("baseline")
        candidate = experiment.get("candidate")
        if not isinstance(baseline, Mapping) or not isinstance(candidate, Mapping):
            raise FeatureRegistryError(f"{experiment_id} arms must be mappings")
        keys = set(baseline) | set(candidate)
        changed = [key for key in keys if baseline.get(key) != candidate.get(key)]
        if len(changed) != 1:
            raise FeatureRegistryError(
                f"{experiment_id} must change exactly one assignment; changed={sorted(changed)}"
            )
        archetypes = experiment.get("task_archetypes")
        if not isinstance(archetypes, list) or not archetypes:
            raise FeatureRegistryError(f"{experiment_id}.task_archetypes must be non-empty")
    if covered != REQUIRED_FEATURES:
        raise FeatureRegistryError(f"paired experiments do not cover {sorted(REQUIRED_FEATURES - covered)}")

    return FeatureExperimentRegistry(
        schema_version=1,
        control_profile=control,
        features=tuple(features),
        paired_experiments=tuple(experiments),
    )
