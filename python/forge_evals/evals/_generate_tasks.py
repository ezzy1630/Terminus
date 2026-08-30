"""Validate the committed held-out task cohort.

The first version of this module generated placeholder directories and could
silently overwrite a real fixture. The benchmark cohort is now authored as
reviewable task packages. This command intentionally performs no writes: it
validates the four canonical packages and fails if one is missing or has
regressed to a sentinel-only fixture.
"""

from __future__ import annotations

from pathlib import Path

REQUIRED_FILES = (
    "task.yaml",
    "prompt.md",
    "environment.lock",
    "setup.sh",
    "grader/run.py",
    "hidden/test_hidden.py",
    "expected-properties.yaml",
    "policy.yaml",
    "README.md",
)

CANONICAL_TASKS = (
    ("build-failure", "build-001"),
    ("cross-file-feature", "cff-001"),
    ("test-generation", "testgen-001"),
    ("malicious-repository-instructions", "mri-001"),
)


def validate_task_package(task_dir: Path) -> list[str]:
    """Return actionable validation errors for one committed task package."""
    errors: list[str] = []
    for relative in REQUIRED_FILES:
        if not (task_dir / relative).is_file():
            errors.append(f"missing {relative}")
    if errors:
        return errors
    setup = (task_dir / "setup.sh").read_text(encoding="utf-8")
    grader = (task_dir / "grader/run.py").read_text(encoding="utf-8")
    task_yaml = (task_dir / "task.yaml").read_text(encoding="utf-8")
    if setup.count("\n") < 12 or "task setup complete" in setup:
        errors.append("setup.sh is still a placeholder; it must create a real repository")
    if "check_substring" in grader or "Synthetic grader" in grader:
        errors.append("grader must execute behavior, not search for acceptance sentinels")
    if "0000000000000000000000000000000000000000" in task_yaml:
        errors.append("task metadata contains an unpinned all-zero source revision")
    if "sha256:0000000000000000000000000000000000000000000000000000000000000000" in task_yaml:
        errors.append("task metadata contains a fake all-zero image digest")
    return errors


def generate_all(base_dir: Path) -> list[Path]:
    """Validate and return the canonical packages without changing the tree."""
    directories = [base_dir / suite / task for suite, task in CANONICAL_TASKS]
    problems: dict[str, list[str]] = {}
    for directory in directories:
        errors = validate_task_package(directory)
        if errors:
            problems[str(directory)] = errors
    if problems:
        details = "; ".join(f"{path}: {', '.join(errors)}" for path, errors in problems.items())
        raise ValueError(f"held-out task cohort is invalid: {details}")
    return directories


if __name__ == "__main__":
    root = Path(__file__).resolve().parent / "tasks"
    validated = generate_all(root)
    print(f"validated {len(validated)} held-out task packages under {root}")
    for directory in validated:
        print(f"  {directory.relative_to(root.parent)}")
