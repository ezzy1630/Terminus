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

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .harness_runner import HarnessResult, RunRequest
from .terminus_harness import TerminusControlError, TerminusHarness


class LiveRunError(RuntimeError):
    """A precondition for executing a live evaluation was not met."""


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
