"""Hidden checks for diag-001: the diagnosis must name the seeded root cause.

Never projected to model context. Staged back into the workspace only at
grade time by the runner's grader-asset isolation.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REQUIRED_SPANS = [
    "src/ledger.py",
    "process_records",
    "records[1:]",
]


def _changed_files(workdir: Path) -> set[str]:
    completed = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return {
        line[3:].strip()
        for line in completed.stdout.splitlines()
        if len(line) >= 3 and not line[3:].strip().startswith("hidden/")
    }


def test_diagnosis_file_exists(workdir: Path) -> None:
    assert (workdir / "DIAGNOSIS.md").is_file()


def test_diagnosis_names_module_function_and_defect(workdir: Path) -> None:
    text = (workdir / "DIAGNOSIS.md").read_text(encoding="utf-8").lower()
    for span in REQUIRED_SPANS:
        assert span.lower() in text, f"diagnosis must name {span!r}"


def test_workspace_stayed_read_only(workdir: Path) -> None:
    changed = _changed_files(workdir)
    assert changed <= {"DIAGNOSIS.md"}, f"tracked files changed: {sorted(changed)}"
