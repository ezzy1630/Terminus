from pathlib import Path

import pytest
import yaml

from forge_evals.feature_registry import FeatureRegistryError, load_feature_registry

REPO_ROOT = Path(__file__).resolve().parents[4]
REGISTRY = REPO_ROOT / "evals" / "feature-experiments.yaml"


def test_repository_feature_registry_is_complete_and_preregistered() -> None:
    registry = load_feature_registry(REGISTRY)

    assert registry.control_profile["id"] == "terminus-minimal"
    assert len(registry.features) == 7
    assert len(registry.paired_experiments) == 17
    assert all(feature["current_decision"] != "promoted" for feature in registry.features)


def test_registry_rejects_multivariate_pair(tmp_path: Path) -> None:
    raw = yaml.safe_load(REGISTRY.read_text(encoding="utf-8"))
    raw["paired_experiments"][0]["candidate"]["memory"] = True
    path = tmp_path / "invalid.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")

    with pytest.raises(FeatureRegistryError, match="exactly one assignment"):
        load_feature_registry(path)
