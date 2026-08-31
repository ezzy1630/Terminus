"""SPEC §41.4 eval task package loader.

A *task package* is the on-disk unit of evaluation evidence. It lives at
``evals/tasks/<suite>/<task>/`` and contains:

.. code-block:: text

    evals/tasks/<suite>/<task>/
      task.yaml                  # source_commit, image_digest, timeout, budget,
                                 # allowed_network, secrets, grader_version
      prompt.md                  # the task prompt shown to the agent
      environment.lock           # pinned environment (Python, system deps)
      setup.sh                   # workspace setup script (run before agent)
      grader/                    # Python grader module (run.py + helpers)
        run.py
      hidden/                    # hidden test files (never projected into context)
      expected-properties.yaml   # post-run expected property invariants
      policy.yaml                # policy rule overrides for this task
      README.md                  # human-readable description

This module provides a :class:`TaskPackage` dataclass and a
:func:`load_task_package` function that parses a directory into one.

The loader is intentionally tolerant: missing optional files (e.g.
``expected-properties.yaml``) yield empty defaults rather than raising,
so minimal/synthetic task packages used in tests can omit them. Required
files (``task.yaml``, ``prompt.md``) raise :class:`TaskPackageError` if
absent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

__all__ = [
    "TaskPackage",
    "TaskPackageError",
    "load_task_package",
]


class TaskPackageError(ValueError):
    """Raised when a task package is missing required files or fields."""


@dataclass(frozen=True)
class TaskPackage:
    """A SPEC §41.4 eval task package.

    Fields map 1:1 to the on-disk layout. ``raw_task`` is the parsed
    ``task.yaml`` dict (so callers can access task-specific fields like
    ``secrets`` or ``budget`` without us enumerating every key).
    """

    dir: Path
    suite: str
    task: str
    source_commit: str
    image_digest: str
    timeout: int
    budget: dict[str, Any]
    allowed_network: list[str]
    secrets: dict[str, str]
    grader_version: str
    prompt: str
    environment_lock: str
    setup_script: str
    grader_dir: Path
    hidden_dir: Path
    expected_properties: dict[str, Any]
    policy: dict[str, Any]
    readme: str
    raw_task: dict[str, Any] = field(default_factory=dict)

    @property
    def grader_run_py(self) -> Path:
        """Path to the grader's ``run.py`` entrypoint."""
        return self.grader_dir / "run.py"

    def to_dict(self) -> dict[str, Any]:
        """Plain dict form (for serialization).

        Secret values are masked in both the top-level ``secrets`` field
        and inside ``raw_task`` (so that callers dumping the dict to logs
        can never leak secret values).
        """
        masked_raw = dict(self.raw_task)
        if isinstance(masked_raw.get("secrets"), dict):
            masked_raw["secrets"] = {k: "***" for k in masked_raw["secrets"]}
        return {
            "dir": str(self.dir),
            "suite": self.suite,
            "task": self.task,
            "source_commit": self.source_commit,
            "image_digest": self.image_digest,
            "timeout": self.timeout,
            "budget": dict(self.budget),
            "allowed_network": list(self.allowed_network),
            "secrets": {k: "***" for k in self.secrets},  # never leak secret values
            "grader_version": self.grader_version,
            "prompt_len": len(self.prompt),
            "environment_lock_len": len(self.environment_lock),
            "setup_script_len": len(self.setup_script),
            "grader_dir": str(self.grader_dir),
            "hidden_dir": str(self.hidden_dir),
            "expected_properties": dict(self.expected_properties),
            "policy": dict(self.policy),
            "readme_len": len(self.readme),
            "raw_task": masked_raw,
        }


def load_task_package(
    task_dir: Path | str | None = None,
    **kwargs: Any,
) -> TaskPackage:
    """Load a task package from ``task_dir`` (or legacy ``dir``).

    Required files: ``task.yaml``, ``prompt.md``.
    Optional files (default to empty): ``environment.lock``, ``setup.sh``,
    ``grader/``, ``hidden/``, ``expected-properties.yaml``, ``policy.yaml``,
    ``README.md``.

    Raises:
        TaskPackageError: if directory does not exist or required files are
            missing.
    """
    target = task_dir if task_dir is not None else kwargs.get("dir")
    if target is None:
        raise TypeError("load_task_package() missing required argument: 'task_dir'")
    d = Path(target)
    if not d.exists():
        raise TaskPackageError(f"task package directory does not exist: {d}")
    if not d.is_dir():
        raise TaskPackageError(f"task package path is not a directory: {d}")

    task_yaml_path = d / "task.yaml"
    if not task_yaml_path.exists():
        raise TaskPackageError(f"required file missing: {task_yaml_path}")
    raw_task: dict[str, Any] = _load_yaml(task_yaml_path) or {}

    prompt_path = d / "prompt.md"
    if not prompt_path.exists():
        raise TaskPackageError(f"required file missing: {prompt_path}")
    prompt = prompt_path.read_text(encoding="utf-8")

    # suite and task default to the parent dir name and the dir name,
    # respectively, but can be overridden in task.yaml.
    suite = str(raw_task.get("suite") or d.parent.name)
    task = str(raw_task.get("task") or d.name)
    source_commit = str(raw_task.get("source_commit", "") or "")
    image_digest = str(raw_task.get("image_digest", "") or "")
    timeout = int(raw_task.get("timeout", 1800) or 1800)
    budget = raw_task.get("budget", {}) or {}
    if not isinstance(budget, dict):
        raise TaskPackageError(f"task.yaml 'budget' must be a mapping, got {type(budget)}")
    allowed_network = raw_task.get("allowed_network", []) or []
    if not isinstance(allowed_network, list):
        raise TaskPackageError(
            f"task.yaml 'allowed_network' must be a list, got {type(allowed_network)}"
        )
    allowed_network = [str(x) for x in allowed_network]
    secrets = raw_task.get("secrets", {}) or {}
    if not isinstance(secrets, dict):
        raise TaskPackageError(f"task.yaml 'secrets' must be a mapping, got {type(secrets)}")
    secrets = {str(k): str(v) for k, v in secrets.items()}
    grader_version = str(raw_task.get("grader_version", "0.1.0") or "0.1.0")

    environment_lock = _read_text(d / "environment.lock")
    setup_script = _read_text(d / "setup.sh")

    grader_dir = d / "grader"
    if not grader_dir.exists():
        # Some task packages keep the grader at the top level; create an
        # empty grader/ for callers that expect it.
        grader_dir.mkdir(parents=True, exist_ok=True)
    hidden_dir = d / "hidden"
    if not hidden_dir.exists():
        hidden_dir.mkdir(parents=True, exist_ok=True)

    expected_properties = _load_yaml(d / "expected-properties.yaml") or {}
    if not isinstance(expected_properties, dict):
        expected_properties = {}
    policy = _load_yaml(d / "policy.yaml") or {}
    if not isinstance(policy, dict):
        policy = {}
    readme = _read_text(d / "README.md")

    return TaskPackage(
        dir=d,
        suite=suite,
        task=task,
        source_commit=source_commit,
        image_digest=image_digest,
        timeout=timeout,
        budget=dict(budget),
        allowed_network=list(allowed_network),
        secrets=secrets,
        grader_version=grader_version,
        prompt=prompt,
        environment_lock=environment_lock,
        setup_script=setup_script,
        grader_dir=grader_dir,
        hidden_dir=hidden_dir,
        expected_properties=dict(expected_properties),
        policy=dict(policy),
        readme=readme,
        raw_task=dict(raw_task),
    )


def _load_yaml(p: Path) -> Any:
    """Load a YAML file; return ``None`` if it doesn't exist."""
    if not p.exists():
        return None
    try:
        return yaml.safe_load(p.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise TaskPackageError(f"invalid YAML in {p}: {exc}") from exc


def _read_text(p: Path) -> str:
    """Read a text file; return empty string if it doesn't exist."""
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8")
