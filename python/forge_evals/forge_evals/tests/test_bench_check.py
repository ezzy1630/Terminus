"""Tests for the ``terminus-eval bench-check`` command.

The audit P0-5 gate: external benchmark manifests must be provably
translatable through their adapters at HEAD — offline, without credentials.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import yaml

from forge_evals.cli import main

if TYPE_CHECKING:
    import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
SUITES_DIR = REPO_ROOT / "evals" / "suites"


def test_bench_check_validates_all_declared_external_suites(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["bench-check", "--suites-dir", str(SUITES_DIR)])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert "swe-bench-verified.yaml" in captured.out
    assert "swe-bench-pro.yaml" in captured.out
    assert "terminal-bench.yaml" in captured.out
    assert "3 validated, 1 skipped, 0 failed" in captured.out


def test_bench_check_skips_internal_fixture_suite() -> None:
    exit_code = main(["bench-check", "--suites-dir", str(SUITES_DIR), "--suite", "forge-internal.yaml"])
    assert exit_code == 0


def test_bench_check_fails_on_corrupted_manifest(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    broken = tmp_path / "broken.yaml"
    raw: dict[str, object] = {
        "suite": {
            "id": "broken",
            "version": 1,
            "description": "corrupt",
            "source": "https://example.com/broken",
            "license": "MIT",
            "task_count": 10,
            "cohorts": ["x"],
            "adapter": {
                "kind": "harbor",
                "dataset": "broken",
                # task_count mismatch against adapter.task_count (missing)
                "harness": {
                    "repository": "https://github.com/harbor-framework/harbor.git",
                    "commit": "72f7dd0134162c5b7229f6a31286e05a49c0f8a4",
                },
            },
        }
    }
    broken.write_text(yaml.safe_dump(raw), encoding="utf-8")
    exit_code = main(["bench-check", "--suites-dir", str(tmp_path), "--suite", "broken.yaml"])
    captured = capsys.readouterr()
    assert exit_code == 1
    assert "FAIL" in captured.err
