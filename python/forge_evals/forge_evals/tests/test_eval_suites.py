"""Validation tests for evaluation suite YAML manifests (SPEC §41.3, §41.4)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from forge_evals.runners import (
    SWE_BENCH_HARNESS_COMMIT,
    SWE_BENCH_VERIFIED_REVISION,
    TERMINAL_BENCH_HARBOR_COMMIT,
    TERMINAL_BENCH_TASK_COMMIT,
    load_benchmark_manifest,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
SUITES_DIR = REPO_ROOT / "evals" / "suites"


def _find_suite_files() -> list[Path]:
    """Find all suite YAML manifests."""
    if not SUITES_DIR.exists():
        pytest.skip(f"suites directory not found at {SUITES_DIR}")
    return sorted(SUITES_DIR.glob("*.yaml"))


def test_suite_files_exist() -> None:
    """At least swe-bench-verified.yaml, terminal-bench.yaml, and forge-internal.yaml must exist."""
    files = _find_suite_files()
    assert len(files) >= 3
    file_names = {f.name for f in files}
    assert "swe-bench-verified.yaml" in file_names
    assert "terminal-bench.yaml" in file_names
    assert "forge-internal.yaml" in file_names


@pytest.mark.parametrize("suite_file", _find_suite_files(), ids=lambda p: p.name)
def test_suite_manifest_schema(suite_file: Path) -> None:
    """Each suite manifest must be valid YAML with required suite fields."""
    content = suite_file.read_text(encoding="utf-8")
    data: Any = yaml.safe_load(content)
    assert isinstance(data, dict), f"{suite_file.name} root must be a mapping"
    assert "suite" in data, f"{suite_file.name} must have a top-level 'suite' key"

    suite = data["suite"]
    assert isinstance(suite, dict), f"{suite_file.name} suite must be a mapping"
    assert isinstance(suite.get("id"), str) and len(suite["id"]) > 0
    assert isinstance(suite.get("version"), int) and suite["version"] >= 1
    assert isinstance(suite.get("description"), str) and len(suite["description"].strip()) > 0
    assert isinstance(suite.get("task_count"), int) and suite["task_count"] > 0
    assert (
        isinstance(suite.get("default_timeout_seconds"), int)
        and suite["default_timeout_seconds"] > 0
    )

    budget = suite.get("default_budget")
    assert isinstance(budget, dict), f"{suite_file.name} default_budget must be a mapping"
    assert isinstance(budget.get("model_micros"), int) and budget["model_micros"] > 0
    assert isinstance(budget.get("compute_seconds"), int) and budget["compute_seconds"] > 0
    assert isinstance(budget.get("wall_clock_seconds"), int) and budget["wall_clock_seconds"] > 0

    assert isinstance(suite.get("grader_version"), str) and len(suite["grader_version"]) > 0
    assert isinstance(suite.get("metrics"), dict), f"{suite_file.name} metrics must be a mapping"
    assert isinstance(suite.get("cohorts"), list) and len(suite["cohorts"]) > 0


def test_external_manifests_pin_exact_sources_and_scopes() -> None:
    """External suites must use exact upstream pins and honest image policies."""
    terminal = load_benchmark_manifest(SUITES_DIR / "terminal-bench.yaml")
    assert terminal.adapter_kind == "harbor"
    assert terminal.dataset == "terminal-bench"
    assert terminal.dataset_version == "2.0"
    assert terminal.task_count == 89
    assert terminal.registry_commit == TERMINAL_BENCH_HARBOR_COMMIT
    assert terminal.task_commit == TERMINAL_BENCH_TASK_COMMIT
    assert terminal.image_digest_policy == "per_task_required"

    swe = load_benchmark_manifest(SUITES_DIR / "swe-bench-verified.yaml")
    assert swe.adapter_kind == "swebench"
    assert swe.dataset == "SWE-bench/SWE-bench_Verified"
    assert swe.dataset_revision == SWE_BENCH_VERIFIED_REVISION
    assert swe.harness_commit == SWE_BENCH_HARNESS_COMMIT
    assert swe.split == "test"
    assert swe.language == "python"
    assert swe.task_count == 500
    assert swe.cohorts == ("python-repos",)
    assert swe.image_digest_policy == "per_instance_required"


def test_swe_bench_verified_manifest_has_no_suite_wide_image_pin() -> None:
    """SWE-bench's per-instance images cannot be represented by one digest."""
    path = SUITES_DIR / "swe-bench-verified.yaml"
    content = path.read_text(encoding="utf-8")
    data = yaml.safe_load(content)
    suite = data["suite"]

    assert suite["id"] == "swe-bench-verified"
    assert suite["task_count"] == 500
    assert "pinned_image_digest" not in suite
    assert suite["adapter"]["image_digest_policy"] == "per_instance_required"
    assert suite["adapter"]["language"] == "python"
