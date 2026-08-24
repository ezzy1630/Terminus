"""Validation tests for evaluation suite YAML manifests (SPEC §41.3, §41.4)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[4]
SUITES_DIR = REPO_ROOT / "evals" / "suites"
SHA256_DIGEST_REGEX = re.compile(r"^sha256:[0-9a-f]{64}$")
ALL_ZERO_DIGEST = "sha256:" + "0" * 64


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
    assert isinstance(suite.get("default_timeout_seconds"), int) and suite["default_timeout_seconds"] > 0

    budget = suite.get("default_budget")
    assert isinstance(budget, dict), f"{suite_file.name} default_budget must be a mapping"
    assert isinstance(budget.get("model_micros"), int) and budget["model_micros"] > 0
    assert isinstance(budget.get("compute_seconds"), int) and budget["compute_seconds"] > 0
    assert isinstance(budget.get("wall_clock_seconds"), int) and budget["wall_clock_seconds"] > 0

    assert isinstance(suite.get("grader_version"), str) and len(suite["grader_version"]) > 0
    assert isinstance(suite.get("metrics"), dict), f"{suite_file.name} metrics must be a mapping"
    assert isinstance(suite.get("cohorts"), list) and len(suite["cohorts"]) > 0


def test_swe_bench_verified_manifest_pin_and_scope() -> None:
    """SWE-bench Verified must have pinned non-zero image digest and strictly Python cohorts."""
    path = SUITES_DIR / "swe-bench-verified.yaml"
    content = path.read_text(encoding="utf-8")
    data = yaml.safe_load(content)
    suite = data["suite"]

    assert suite["id"] == "swe-bench-verified"
    assert suite["task_count"] == 500

    # Pinned image digest must be a valid non-zero SHA-256
    digest = suite.get("pinned_image_digest")
    assert digest is not None, "swe-bench-verified must specify pinned_image_digest"
    assert SHA256_DIGEST_REGEX.match(digest), f"invalid digest format: {digest}"
    assert digest != ALL_ZERO_DIGEST, "pinned_image_digest must not be all-zeros placeholder"

    # Cohorts must only be Python
    cohorts = suite.get("cohorts", [])
    assert cohorts == ["python-repos"], f"SWE-bench Verified cohorts must be ['python-repos'], got {cohorts}"
    assert "js-ts-repos" not in cohorts
    assert "go-repos" not in cohorts
