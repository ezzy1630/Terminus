"""Run a task package's *declared* grader against the post-run workspace.

The eval lab's anti-gaming rule is that the harness never grades itself. This
module is the independent verdict path used by the live runner: it locates the
grader that a task package declares, executes it against the workspace the run
left behind, and turns its output into a :class:`GraderResult`.

Two grader protocols exist in this repository and both are supported, because
both are real:

``json_stdio``
    The generated cohort packages under ``python/forge_evals/evals/tasks/``
    read a JSON payload on stdin (``{"workdir": ..., ...}``) and print a JSON
    object ``{"passed", "score", "evidence", "metadata"}`` on stdout.

``exit_code``
    The hand-written packages under ``evals/tasks/`` run with the workspace as
    the working directory, print human-readable ``PASS``/``FAIL`` text, and
    signal the verdict with the process exit code (0 = pass).

``auto`` (the default) feeds the JSON payload on stdin *and* sets the working
directory, then prefers a well-formed JSON verdict on stdout and falls back to
the exit code. A grader that crashes, times out, or cannot be located produces
a failing result with the reason in ``evidence`` — never a silent pass.

A task package may pin the protocol explicitly in ``task.yaml``::

    grader:
      entrypoint: grader/run.py
      protocol: json_stdio
      timeout_seconds: 600

Both the nested (``task: {...}``) and flat ``task.yaml`` layouts are read.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..run_record import GraderResult

__all__ = [
    "GraderProtocol",
    "TaskGraderSpec",
    "acceptance_criteria_for_task",
    "load_task_grader_spec",
    "run_task_grader",
]

GraderProtocol = str  # "auto" | "json_stdio" | "exit_code"

_DEFAULT_TIMEOUT_SECONDS = 900.0
_OUTPUT_TAIL = 4_000


class _GraderAssetError(RuntimeError):
    """Private grader assets could not be staged without overwriting run output."""


@contextmanager
def _staged_grader_assets(workspace: Path, private_root: Path | None) -> Iterator[None]:
    """Temporarily project private hidden tests only after the harness stopped."""
    if private_root is None:
        yield
        return
    if not private_root.is_dir():
        raise _GraderAssetError(f"private grader asset directory is missing: {private_root}")
    staged: list[Path] = []
    try:
        for source in sorted(private_root.iterdir()):
            destination = workspace / source.name
            if destination.exists():
                raise _GraderAssetError(
                    f"workspace created reserved grader path: {destination.relative_to(workspace)}"
                )
            if source.is_dir():
                shutil.copytree(source, destination)
            else:
                shutil.copy2(source, destination)
            staged.append(destination)
        yield
    finally:
        for destination in reversed(staged):
            if destination.is_dir():
                shutil.rmtree(destination)
            else:
                destination.unlink(missing_ok=True)


@dataclass(frozen=True)
class TaskGraderSpec:
    """The grader a task package declares, resolved to an executable path."""

    task_id: str
    grader_id: str
    grader_version: str
    entrypoint: Path | None
    protocol: GraderProtocol
    timeout_seconds: float
    acceptance_criteria: list[dict[str, Any]] = field(default_factory=list)

    @property
    def available(self) -> bool:
        """Whether the declared grader entrypoint actually exists on disk."""
        return self.entrypoint is not None and self.entrypoint.is_file()


def _task_block(raw: Any) -> dict[str, Any]:
    """Return the task mapping from either task.yaml layout."""
    if not isinstance(raw, dict):
        return {}
    nested = raw.get("task")
    if isinstance(nested, dict):
        merged = {k: v for k, v in raw.items() if k != "task"}
        merged.update(nested)
        return merged
    return dict(raw)


def _load_task_yaml(task_dir: Path) -> dict[str, Any]:
    path = task_dir / "task.yaml"
    if not path.exists():
        return {}
    import yaml

    return _task_block(yaml.safe_load(path.read_text(encoding="utf-8")))


def acceptance_criteria_for_task(task_dir: Path) -> list[dict[str, Any]]:
    """Return the task's declared acceptance criteria as contract criteria.

    The result is shaped for the Terminus task contract: every entry has a
    stable ``id`` and a human-readable ``statement``. Criteria are read from
    ``task.yaml`` (``acceptance_criteria``) first and from the optional
    sibling ``acceptance.yaml`` second. Free-text criteria authored as plain
    strings are given a deterministic ``id`` so evidence can reference them.
    """
    raw_lists: list[Any] = []
    task_yaml = _load_task_yaml(task_dir)
    raw_lists.append(task_yaml.get("acceptance_criteria"))
    acceptance_path = task_dir / "acceptance.yaml"
    if acceptance_path.exists():
        import yaml

        loaded = yaml.safe_load(acceptance_path.read_text(encoding="utf-8"))
        raw_lists.append(loaded.get("acceptance_criteria") if isinstance(loaded, dict) else loaded)

    criteria: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_lists:
        if not isinstance(raw, list):
            continue
        for item in raw:
            criterion = _normalize_criterion(item, index=len(criteria))
            if criterion is None or criterion["id"] in seen:
                continue
            seen.add(criterion["id"])
            criteria.append(criterion)
    return criteria


def _normalize_criterion(item: Any, *, index: int) -> dict[str, Any] | None:
    if isinstance(item, str):
        statement = item.strip()
        if not statement:
            return None
        return {
            "id": f"criterion-{index + 1:02d}",
            "statement": statement,
            "required": True,
        }
    if not isinstance(item, dict):
        return None
    statement = str(
        item.get("statement") or item.get("description") or item.get("text") or ""
    ).strip()
    if not statement:
        return None
    criterion_id = str(item.get("id") or f"criterion-{index + 1:02d}")
    normalized: dict[str, Any] = {
        "id": criterion_id[:128],
        "statement": statement[:4096],
        "required": bool(item.get("required", True)),
    }
    # The control plane's contract schema is `.strict()` and accepts exactly
    # id / statement / verification_hint / required (index.ts:5075-5081). A
    # task-package `kind` or `type` is carried as a verification hint rather
    # than as an unknown key that would 400 the whole task creation.
    hint = item.get("verification_hint") or item.get("kind") or item.get("type")
    if isinstance(hint, str) and hint.strip():
        normalized["verification_hint"] = hint.strip()[:4096]
    return normalized


def load_task_grader_spec(task_dir: Path | str) -> TaskGraderSpec:
    """Resolve the grader a task package declares.

    The declaration is ``task.yaml``'s optional ``grader`` mapping; when it is
    absent the package convention (``grader/run.py``) applies. The returned
    spec always names the task and the grader version so a run record can cite
    them even when the entrypoint is missing.
    """
    d = Path(task_dir)
    task_yaml = _load_task_yaml(d)
    task_id = str(task_yaml.get("id") or task_yaml.get("task") or d.name)
    grader_version = str(task_yaml.get("grader_version") or "0.0.0")

    declared = task_yaml.get("grader")
    entrypoint_name = "grader/run.py"
    protocol: GraderProtocol = "auto"
    timeout_seconds = _DEFAULT_TIMEOUT_SECONDS
    if isinstance(declared, dict):
        entrypoint_name = str(declared.get("entrypoint") or entrypoint_name)
        candidate_protocol = str(declared.get("protocol") or "auto")
        if candidate_protocol in ("auto", "json_stdio", "exit_code"):
            protocol = candidate_protocol
        raw_timeout = declared.get("timeout_seconds")
        if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
            timeout_seconds = float(raw_timeout)
    elif isinstance(declared, str) and declared.strip():
        entrypoint_name = declared.strip()

    entrypoint = (d / entrypoint_name).resolve()
    return TaskGraderSpec(
        task_id=task_id,
        grader_id=f"task:{task_id}",
        grader_version=grader_version,
        entrypoint=entrypoint if entrypoint.is_file() else None,
        protocol=protocol,
        timeout_seconds=timeout_seconds,
        acceptance_criteria=acceptance_criteria_for_task(d),
    )


def run_task_grader(
    task_dir: Path | str,
    workspace: Path | str,
    *,
    objective: str = "",
    spec: TaskGraderSpec | None = None,
    python_executable: str | None = None,
    grader_assets_dir: Path | None = None,
) -> GraderResult:
    """Execute the task's declared grader against ``workspace``.

    ``workspace`` is the post-run workspace, i.e. the directory the agent was
    actually allowed to mutate. It is normally the task directory itself for
    internal tasks, and a materialised checkout for external benchmarks.
    """
    d = Path(task_dir)
    ws = Path(workspace)
    resolved = spec or load_task_grader_spec(d)

    if not resolved.available:
        return GraderResult(
            grader_id=resolved.grader_id,
            grader_version=resolved.grader_version,
            passed=False,
            score=0.0,
            evidence=[
                f"task package declares no runnable grader entrypoint under {d}",
            ],
            metadata={"grader_status": "missing_entrypoint", "task_dir": str(d)},
        )
    if not ws.is_dir():
        return GraderResult(
            grader_id=resolved.grader_id,
            grader_version=resolved.grader_version,
            passed=False,
            score=0.0,
            evidence=[f"workspace does not exist: {ws}"],
            metadata={"grader_status": "missing_workspace", "workspace": str(ws)},
        )

    entrypoint = resolved.entrypoint
    assert entrypoint is not None  # guaranteed by `available`
    payload = json.dumps(
        {
            "workdir": str(ws),
            "task_dir": str(d),
            "task_id": resolved.task_id,
            "objective": objective,
            "acceptance_criteria": resolved.acceptance_criteria,
        },
        sort_keys=True,
    )
    argv = [python_executable or sys.executable, str(entrypoint)]
    try:
        with _staged_grader_assets(ws, grader_assets_dir):
            completed = subprocess.run(
                argv,
                cwd=str(ws),
                input=payload,
                capture_output=True,
                text=True,
                timeout=resolved.timeout_seconds,
                check=False,
            )
    except _GraderAssetError as exc:
        return GraderResult(
            grader_id=resolved.grader_id,
            grader_version=resolved.grader_version,
            passed=False,
            score=0.0,
            evidence=[str(exc)],
            metadata={"grader_status": "asset_isolation_error"},
        )
    except subprocess.TimeoutExpired:
        return GraderResult(
            grader_id=resolved.grader_id,
            grader_version=resolved.grader_version,
            passed=False,
            score=0.0,
            evidence=[f"grader timed out after {resolved.timeout_seconds:.0f}s"],
            metadata={"grader_status": "timeout"},
        )
    except OSError as exc:
        return GraderResult(
            grader_id=resolved.grader_id,
            grader_version=resolved.grader_version,
            passed=False,
            score=0.0,
            evidence=[f"grader could not be executed: {exc}"],
            metadata={"grader_status": "exec_error"},
        )

    return _verdict_from_process(resolved, completed)


def _verdict_from_process(
    spec: TaskGraderSpec,
    completed: subprocess.CompletedProcess[str],
) -> GraderResult:
    decoded = _decode_json_verdict(completed.stdout) if spec.protocol != "exit_code" else None
    if decoded is not None:
        passed = bool(decoded.get("passed"))
        raw_score = decoded.get("score", 1.0 if passed else 0.0)
        score = float(raw_score) if isinstance(raw_score, (int, float)) else 0.0
        score = min(1.0, max(0.0, score))
        evidence_raw = decoded.get("evidence")
        evidence = (
            [str(item) for item in evidence_raw]
            if isinstance(evidence_raw, list)
            else [str(evidence_raw)]
            if evidence_raw is not None
            else []
        )
        metadata_raw = decoded.get("metadata")
        metadata: dict[str, Any] = dict(metadata_raw) if isinstance(metadata_raw, dict) else {}
        metadata.update(
            {
                "grader_status": "ran",
                "grader_protocol": "json_stdio",
                "exit_code": completed.returncode,
            }
        )
        return GraderResult(
            grader_id=spec.grader_id,
            grader_version=spec.grader_version,
            passed=passed,
            score=score,
            evidence=evidence,
            metadata=metadata,
        )

    if spec.protocol == "json_stdio":
        # The package promised a JSON verdict and did not produce one. That is
        # a grader defect, and a defect is not a pass.
        return GraderResult(
            grader_id=spec.grader_id,
            grader_version=spec.grader_version,
            passed=False,
            score=0.0,
            evidence=[
                "grader declared protocol json_stdio but stdout was not a JSON verdict",
                completed.stdout[-_OUTPUT_TAIL:],
            ],
            metadata={"grader_status": "malformed_output", "exit_code": completed.returncode},
        )

    passed = completed.returncode == 0
    evidence = [f"grader exit code {completed.returncode}"]
    if completed.stdout.strip():
        evidence.append(f"stdout: {completed.stdout[-_OUTPUT_TAIL:]}")
    if completed.stderr.strip():
        evidence.append(f"stderr: {completed.stderr[-_OUTPUT_TAIL:]}")
    return GraderResult(
        grader_id=spec.grader_id,
        grader_version=spec.grader_version,
        passed=passed,
        score=1.0 if passed else 0.0,
        evidence=evidence,
        metadata={
            "grader_status": "ran",
            "grader_protocol": "exit_code",
            "exit_code": completed.returncode,
        },
    )


def _decode_json_verdict(stdout: str) -> dict[str, Any] | None:
    """Return the JSON verdict object a grader printed, if it printed one.

    Graders are allowed to print progress text before the verdict, so the
    last non-empty line is tried first and the whole payload second.
    """
    candidates: list[str] = []
    lines = [line for line in stdout.splitlines() if line.strip()]
    if lines:
        candidates.append(lines[-1])
    stripped = stdout.strip()
    if stripped and (not lines or stripped != lines[-1]):
        candidates.append(stripped)
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict) and "passed" in parsed:
            return parsed
    return None
