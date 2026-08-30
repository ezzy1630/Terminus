"""Live-run glue between the CLI, TerminusHarness, and benchmark bridges (R8).

The eval gate previously had no executable live path: ``cli.py run`` blocked
non-fixture invocations outright, the real ``TerminusHarness`` driver was
orphaned behind a fake-server test, and the SWE-bench adapter returned
``argv=None`` forever. This module composes those pieces honestly:

* one live run = TerminusHarness.run() + workspace diff extraction;
* the extracted patch is attached as an artifact — never synthesized;
* grading stays with the runner's graders / control-plane verification
  evidence (anti-gaming separation is preserved);
* SWE-bench evaluation invokes the pinned official evaluator **only** when a
  real patch exists and the ``swebench`` tool is importable; otherwise the
  record states that evaluation is pending rather than faking a pass.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .harness_runner import HarnessResult, RunRequest
from .terminus_harness import TerminusControlError, TerminusHarness


class LiveRunError(RuntimeError):
    """A precondition for executing a live evaluation was not met."""


@dataclass(frozen=True)
class TaskWorkspace:
    """Where an internal task actually runs, and how it got there."""

    package_dir: Path
    workspace: Path
    setup_status: str
    setup_exit_code: int | None = None
    setup_output: str = ""
    base_commit: str | None = None
    vcs_status: str = "none"
    grader_assets_dir: Path | None = None
    grader_assets_digest: str | None = None

    @property
    def is_scratch(self) -> bool:
        """Whether the agent edits a scratch tree rather than the package."""
        return self.workspace != self.package_dir

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form for the run record's artifacts."""
        return {
            "package_dir": str(self.package_dir),
            "workspace": str(self.workspace),
            "setup_status": self.setup_status,
            "setup_exit_code": self.setup_exit_code,
            "setup_output_tail": self.setup_output[-2_000:],
            "base_commit": self.base_commit,
            "vcs_status": self.vcs_status,
            "grader_assets": (
                {
                    # The assets are outside the model workspace, but this
                    # local filesystem move is not a verified sandbox.
                    "isolated": False,
                    "path_separated": True,
                    "access_isolation_verified": False,
                    "isolation_method": "parent_directory_path_separation_only",
                    "digest": self.grader_assets_digest,
                }
                if self.grader_assets_dir is not None
                else {
                    "isolated": False,
                    "path_separated": False,
                    "access_isolation_verified": False,
                    "isolation_method": "unavailable",
                    "digest": None,
                }
            ),
        }


# Identity for the fixture commit. A repository with no configured user cannot
# commit at all, and borrowing the operator's name would attribute a generated
# fixture to a person.
_FIXTURE_AUTHOR_NAME = "forge-evals"
_FIXTURE_AUTHOR_EMAIL = "forge-evals@localhost"
_GIT_TIMEOUT_SECONDS = 120.0


def _tree_digest(root: Path) -> str:
    """Content-address a private grader asset tree without exposing its path."""
    digest = hashlib.sha256()
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\x00")
        digest.update(path.read_bytes())
        digest.update(b"\x00")
    return "sha256:" + digest.hexdigest()


def _isolate_grader_assets(workspace: Path) -> tuple[Path | None, str | None]:
    """Move setup-created hidden tests outside the agent-visible workspace."""
    hidden = workspace / "hidden"
    if not hidden.exists():
        return None, None
    private_root = workspace.parent / f".{workspace.name}.grader-assets"
    if private_root.exists():
        raise LiveRunError(f"private grader asset directory already exists: {private_root}")
    private_root.mkdir(mode=0o700)
    shutil.move(str(hidden), str(private_root / "hidden"))
    return private_root, _tree_digest(private_root)


def _git(workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
    git = shutil.which("git")
    if git is None:  # pragma: no cover - git is a hard dependency of the repo
        raise LiveRunError("git is not on PATH; a task workspace cannot be initialised")
    return subprocess.run(
        [git, "-C", str(workspace), *args],
        capture_output=True,
        text=True,
        timeout=_GIT_TIMEOUT_SECONDS,
        check=False,
    )


def initialize_task_repository(workspace: Path) -> str:
    """Make ``workspace`` a git repository with one commit, and return its sha.

    A real coding workspace is a repository. The eval fixture was not one, and
    the control plane's verification step shells out to ``git rev-parse HEAD``
    to identify the tree it is about to check — so the very first live run
    finished the model's work and then died in ``agent_loop_error`` after it.
    A fixture that cannot be diffed or verified is not a realistic fixture, so
    the tree setup.sh built is committed as the run's base.
    """
    for args in (
        ("init", "-q"),
        ("config", "user.name", _FIXTURE_AUTHOR_NAME),
        ("config", "user.email", _FIXTURE_AUTHOR_EMAIL),
        # Never sign a fixture commit: a configured global signing key would
        # otherwise make `git commit` prompt or fail in a headless run.
        ("config", "commit.gpgsign", "false"),
        ("add", "-A"),
        ("commit", "-q", "--no-verify", "-m", "task fixture"),
    ):
        completed = _git(workspace, *args)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()[-500:]
            raise LiveRunError(f"git {args[0]} failed in {workspace}: {detail}")
    head = _git(workspace, "rev-parse", "HEAD")
    if head.returncode != 0 or not head.stdout.strip():
        raise LiveRunError(f"git rev-parse HEAD failed in {workspace}")
    return head.stdout.strip()


def workspace_diff(workspace: Path, base_commit: str) -> str:
    """The workspace's diff against its fixture commit, or ``""``.

    The local fallback for when the control plane's ``/v1/tasks/:id/diff``
    returns nothing. ``add -A -N`` makes new files visible to ``git diff``
    without staging their contents, so work in untracked files is not silently
    dropped from the record.
    """
    if not base_commit or not (workspace / ".git").exists():
        return ""
    _git(workspace, "add", "-A", "-N")
    completed = _git(workspace, "--no-pager", "diff", base_commit)
    return completed.stdout if completed.returncode == 0 else ""


def materialize_task_workspace(
    package_dir: Path,
    workspace: Path,
    *,
    run_setup: bool = True,
    timeout_seconds: float = 900.0,
) -> TaskWorkspace:
    """Build an internal task's fixture tree into a scratch workspace.

    Task packages under ``evals/tasks/**`` do not check their fixtures in: a
    ``setup.sh`` creates ``src/``, the public tests, and ``hidden/`` at run
    time. Running that script inside the package would write generated files
    into the repository, and copying the package into the workspace would hand
    the agent the grader and the hidden tests. So the script is executed with
    the *scratch workspace* as its working directory and the package stays
    read-only outside it — which is also what makes the environment digest a
    hash of the real starting tree.

    The materialised tree is then committed to a fresh git repository: real
    workspaces are repositories, the control plane's verification step reads
    ``git rev-parse HEAD``, and the returned commit is what every later diff is
    taken against.

    Packages without a ``setup.sh`` are self-contained; for those the package
    directory is the workspace, exactly as before, and it is left alone — a
    checked-in package must never be committed to on the eval's behalf.
    """
    setup = package_dir / "setup.sh"
    if not run_setup or not setup.is_file():
        return TaskWorkspace(
            package_dir=package_dir,
            workspace=package_dir,
            setup_status="skipped" if setup.is_file() else "no_setup_script",
            vcs_status="untouched_package",
        )

    if workspace.exists() and any(workspace.iterdir()):
        raise LiveRunError(
            f"workspace {workspace} is not empty; refusing to run {setup} over existing files"
        )
    workspace.mkdir(parents=True, exist_ok=True)
    try:
        completed = subprocess.run(
            ["bash", str(setup.resolve())],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            env={
                **os.environ,
                "TERMINUS_TASK_DIR": str(package_dir.resolve()),
                "TERMINUS_WORKSPACE": str(workspace.resolve()),
            },
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise LiveRunError(f"task setup failed to execute: {error}") from error

    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        raise LiveRunError(
            f"task setup exited {completed.returncode} for {package_dir}: {output[-2_000:]}"
        )
    grader_assets_dir, grader_assets_digest = _isolate_grader_assets(workspace)
    return TaskWorkspace(
        package_dir=package_dir,
        workspace=workspace,
        setup_status="ran",
        setup_exit_code=completed.returncode,
        setup_output=output,
        base_commit=initialize_task_repository(workspace),
        vcs_status="git_initialized",
        grader_assets_dir=grader_assets_dir,
        grader_assets_digest=grader_assets_digest,
    )


def run_live_task(
    harness: TerminusHarness,
    request: RunRequest,
    recorder: Any,
) -> tuple[HarnessResult, dict[str, Any]]:
    """Execute one task through the live harness and extract the patch."""
    result = harness.run(request, recorder)
    task_id = _task_id_from_notes(result.notes)
    patch_payload: dict[str, Any] | None = None
    if task_id is not None:
        try:
            patch_payload = harness.fetch_patch(task_id)
        except TerminusControlError as error:
            # A completed task with an unreadable workspace is an explicit
            # failure state, not a silent no-patch.
            patch_payload = {
                "diff": "",
                "untracked_files": [],
                "truncated": False,
                "git_available": False,
                "extraction_error": str(error),
            }
    if patch_payload is not None:
        result.artifacts.append(
            {
                "kind": "workspace_patch",
                "diff_truncated": patch_payload["truncated"],
                "untracked_files": patch_payload["untracked_files"][:100],
                "diff_chars": len(patch_payload["diff"]),
            }
        )
        notes = json.loads(result.notes) if result.notes else {}
        notes["patch_extracted"] = bool(patch_payload["diff"])
        object.__setattr__(result, "notes", json.dumps(notes, sort_keys=True))
    return result, patch_payload or {}


def write_patch_file(patch_diff: str, destination: Path) -> Path:
    """Persist the model patch for an external evaluator."""
    destination.write_text(patch_diff, encoding="utf-8")
    return destination


def build_swebench_evaluation_argv(
    patch_diff: str,
    instance_id: str,
    predictions_dir: Path,
    suite_manifest: str,
    dataset_name: str = "princeton-nlp/SWE-bench_Verified",
) -> list[str] | None:
    """Build the official-evaluator argv for one instance, or None.

    Returns ``None`` when there is no patch or the pinned ``swebench``
    evaluator is unavailable — callers must record "evaluation pending"
    instead of fabricating a verdict.
    """
    if not patch_diff.strip():
        return None
    if shutil.which("swebench") is None:
        return None
    predictions_path = predictions_dir / f"{instance_id}.json"
    predictions_path.write_text(
        json.dumps({"instance_id": instance_id, "model_patch": patch_diff}),
        encoding="utf-8",
    )
    return [
        "swebench",
        "evaluation",
        "--run_id",
        instance_id,
        # The canonical dataset comes from the validated suite manifest via
        # the caller — never hardcoded independently of it.
        "--dataset_name",
        dataset_name,
        "--predictions_path",
        str(predictions_path),
        "--suite",
        suite_manifest,
    ]


def invoke_external_evaluator(argv: list[str], timeout_seconds: float = 3_600.0) -> dict[str, Any]:
    """Run the pinned evaluator binary and capture its bounded output."""
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    return {
        "exit_code": completed.returncode,
        "stdout_tail": completed.stdout[-4_000:],
        "stderr_tail": completed.stderr[-4_000:],
    }


def _task_id_from_notes(notes: str) -> str | None:
    try:
        parsed = json.loads(notes)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    value = parsed.get("task_id")
    return value if isinstance(value, str) else None


def ensure_temp_predictions_dir(prefix: str = "terminus-swebench-") -> Path:
    return Path(tempfile.mkdtemp(prefix=prefix))
