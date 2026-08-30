"""SWE-bench Pro instance materialisation, prediction writing, and evaluation.

SWE-bench Pro (Scale AI) is a 731-instance, multi-language successor to
SWE-bench: given a repository at a base commit and an issue, the agent must
produce a patch that makes the instance's hidden ``fail_to_pass`` tests pass
without breaking ``pass_to_pass``.

The pieces this module owns:

1. **Instance resolution** — from a local JSON/JSONL file (offline, pinned) or
   from the pinned Hugging Face revision when ``datasets`` is installed.
2. **Materialisation** — clone the instance's repository and check out its base
   commit into the run workspace, so a Terminus turn has something real to
   edit.
3. **Prediction writing** — two files, because two readers exist and neither is
   optional:

   * ``predictions.json`` — the canonical SWE-bench prediction shape
     (``instance_id``, ``model_name_or_path``, ``model_patch``).
   * ``patches.json`` — what SWE-bench Pro's own ``swe_bench_pro_eval.py``
     consumes via ``--patch_path`` (``instance_id``, ``patch``, ``prefix``).

4. **Evaluation** — invoke the pinned ``swe_bench_pro_eval.py`` when its
   checkout is configured and Docker is usable; otherwise return
   ``{"status": "evaluation_pending", ...}`` with the prediction path. That is
   a real state — the patch exists and can be graded later — not a stub verdict.

Configuration:

``TERMINUS_SWEBENCH_PRO_HARNESS_DIR``
    Path to a checkout of ``scaleapi/SWE-bench_Pro-os`` containing
    ``swe_bench_pro_eval.py`` and ``run_scripts/``.
``TERMINUS_SWEBENCH_PRO_INSTANCES``
    Path to a JSON/JSONL file of instance records, for fully offline runs.
``TERMINUS_SWEBENCH_PRO_REPO_URL_TEMPLATE``
    Clone URL template, ``{repo}``-formatted. Defaults to
    ``https://github.com/{repo}.git``.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..run_record import GraderResult

__all__ = [
    "SWE_BENCH_PRO_DATASET",
    "SWE_BENCH_PRO_HARNESS_COMMIT",
    "SWE_BENCH_PRO_HARNESS_REPOSITORY",
    "SWE_BENCH_PRO_REVISION",
    "Materialization",
    "Prediction",
    "SweBenchProError",
    "SweBenchProInstance",
    "evaluate_prediction",
    "grader_result_for_report",
    "load_instance",
    "materialize_instance",
    "read_evaluation_report",
    "write_prediction_files",
]

SWE_BENCH_PRO_DATASET = "ScaleAI/SWE-bench_Pro"
SWE_BENCH_PRO_REVISION = "7ab5114912baf22bb098818e604c02fe7ad2c11f"
SWE_BENCH_PRO_HARNESS_REPOSITORY = "https://github.com/scaleapi/SWE-bench_Pro-os.git"
SWE_BENCH_PRO_HARNESS_COMMIT = "ca10a60a5fcae51e6948ffe1485d4153d421e6c5"
SWE_BENCH_PRO_SPLIT = "test"
SWE_BENCH_PRO_TASK_COUNT = 731

_DEFAULT_REPO_URL_TEMPLATE = "https://github.com/{repo}.git"
_GIT_TIMEOUT_SECONDS = 1_800.0
_EVAL_TIMEOUT_SECONDS = 7_200.0


class SweBenchProError(RuntimeError):
    """A SWE-bench Pro precondition could not be met."""


@dataclass(frozen=True)
class SweBenchProInstance:
    """One SWE-bench Pro instance, as published in the dataset."""

    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    requirements: str = ""
    interface: str = ""
    repo_language: str = ""
    fail_to_pass: str = ""
    pass_to_pass: str = ""
    dockerhub_tag: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> SweBenchProInstance:
        """Build an instance from a dataset row, requiring the load-bearing fields."""
        missing = [
            key
            for key in ("instance_id", "repo", "base_commit", "problem_statement")
            if not str(raw.get(key) or "").strip()
        ]
        if missing:
            raise SweBenchProError(
                f"SWE-bench Pro instance record is missing required fields: {', '.join(missing)}"
            )
        return cls(
            instance_id=str(raw["instance_id"]),
            repo=str(raw["repo"]),
            base_commit=str(raw["base_commit"]),
            problem_statement=str(raw["problem_statement"]),
            requirements=str(raw.get("requirements") or ""),
            interface=str(raw.get("interface") or ""),
            repo_language=str(raw.get("repo_language") or ""),
            fail_to_pass=str(raw.get("fail_to_pass") or ""),
            pass_to_pass=str(raw.get("pass_to_pass") or ""),
            dockerhub_tag=str(raw.get("dockerhub_tag") or ""),
            raw=dict(raw),
        )

    @property
    def image_reference(self) -> str | None:
        """The published per-instance image, when the row names one."""
        return f"jefzda/sweap-images:{self.dockerhub_tag}" if self.dockerhub_tag else None

    def instruction(self) -> str:
        """The prompt handed to the agent: issue plus stated requirements."""
        sections = [self.problem_statement.strip()]
        if self.requirements.strip():
            sections.append("## Requirements\n\n" + self.requirements.strip())
        if self.interface.strip():
            sections.append("## Interface\n\n" + self.interface.strip())
        return "\n\n".join(section for section in sections if section)


def _iter_records(path: Path) -> list[dict[str, Any]]:
    """Read a JSON array or a JSONL file of instance records."""
    text = path.read_text(encoding="utf-8")
    stripped = text.lstrip()
    if stripped.startswith("["):
        loaded = json.loads(text)
        return [dict(item) for item in loaded if isinstance(item, Mapping)]
    if stripped.startswith("{") and stripped.rstrip().endswith("}") and "\n" not in stripped.strip():
        single = json.loads(text)
        return [dict(single)] if isinstance(single, Mapping) else []
    records: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, Mapping):
            records.append(dict(item))
    return records


def load_instance(
    instance_id: str,
    *,
    instance_file: Path | None = None,
    dataset: str = SWE_BENCH_PRO_DATASET,
    revision: str = SWE_BENCH_PRO_REVISION,
    split: str = SWE_BENCH_PRO_SPLIT,
) -> SweBenchProInstance:
    """Resolve one instance record.

    A local file is preferred because it is offline and byte-pinned. The
    Hugging Face dataset at the pinned revision is the fallback, and requires
    the optional ``datasets`` dependency.
    """
    path = instance_file or (
        Path(os.environ["TERMINUS_SWEBENCH_PRO_INSTANCES"])
        if os.environ.get("TERMINUS_SWEBENCH_PRO_INSTANCES")
        else None
    )
    if path is not None:
        if not path.exists():
            raise SweBenchProError(f"instance file does not exist: {path}")
        for record in _iter_records(path):
            if str(record.get("instance_id")) == instance_id:
                return SweBenchProInstance.from_mapping(record)
        raise SweBenchProError(f"instance {instance_id!r} is not in {path}")

    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise SweBenchProError(
            "no --instance-file was given and the optional `datasets` package is not "
            f"installed, so {dataset}@{revision} cannot be resolved"
        ) from exc
    rows = load_dataset(dataset, split=split, revision=revision)
    for row in rows:
        if str(row.get("instance_id")) == instance_id:
            return SweBenchProInstance.from_mapping(row)
    raise SweBenchProError(f"instance {instance_id!r} is not in {dataset}@{revision}[{split}]")


@dataclass(frozen=True)
class Materialization:
    """A checked-out instance repository, ready for one Terminus turn."""

    workspace: Path
    repo: str
    base_commit: str
    clone_url: str
    head_revision: str

    def local_diff(self) -> str:
        """Return the workspace's diff against the base commit.

        Used as the fallback when the control plane's ``/v1/tasks/:id/diff``
        returned nothing — for example because the workspace was opened as a
        plain directory rather than a git checkout.
        """
        git = shutil.which("git")
        if git is None or not (self.workspace / ".git").exists():
            return ""
        # `add -A -N` makes new files visible to `git diff` without staging
        # their contents, so untracked work is not silently dropped.
        subprocess.run(
            [git, "-C", str(self.workspace), "add", "-A", "-N"],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
        )
        completed = subprocess.run(
            [git, "-C", str(self.workspace), "--no-pager", "diff", self.base_commit],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
        )
        return completed.stdout if completed.returncode == 0 else ""

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form for the run record's artifacts."""
        return {
            "workspace": str(self.workspace),
            "repo": self.repo,
            "base_commit": self.base_commit,
            "clone_url": self.clone_url,
            "head_revision": self.head_revision,
        }


def _run_git(args: list[str]) -> subprocess.CompletedProcess[str]:
    git = shutil.which("git")
    if git is None:
        raise SweBenchProError("git is not on PATH; a SWE-bench Pro instance cannot be checked out")
    return subprocess.run(
        [git, *args],
        capture_output=True,
        text=True,
        timeout=_GIT_TIMEOUT_SECONDS,
        check=False,
    )


def _canonical_repo_ref(value: str) -> str:
    """Normalize the harmless spelling differences Git uses for remotes."""
    return value.strip().rstrip("/").removesuffix(".git")


def materialize_instance(
    instance: SweBenchProInstance,
    workspace: Path,
    *,
    repo_url_template: str | None = None,
) -> Materialization:
    """Clone ``instance.repo`` and check out its base commit into ``workspace``.

    An existing checkout of the same repository is reused and reset to the base
    commit, so re-running a seed does not re-clone a large repository.
    """
    template = (
        repo_url_template
        or os.environ.get("TERMINUS_SWEBENCH_PRO_REPO_URL_TEMPLATE")
        or _DEFAULT_REPO_URL_TEMPLATE
    )
    clone_url = template.format(repo=instance.repo)
    workspace.mkdir(parents=True, exist_ok=True)

    if not (workspace / ".git").exists():
        if any(workspace.iterdir()):
            raise SweBenchProError(
                f"workspace {workspace} is not empty and is not a git checkout; "
                "refusing to materialise an instance over unrelated files"
            )
        cloned = _run_git(["clone", "--no-checkout", clone_url, str(workspace)])
        if cloned.returncode != 0:
            raise SweBenchProError(
                f"git clone {clone_url} failed: {cloned.stderr.strip()[:500]}"
            )

    remote = _run_git(["-C", str(workspace), "remote", "get-url", "origin"])
    if remote.returncode != 0:
        raise SweBenchProError(
            f"workspace {workspace} is a git checkout but its origin cannot be read; "
            "refusing to materialise an unverified repository"
        )
    if _canonical_repo_ref(remote.stdout) != _canonical_repo_ref(clone_url):
        raise SweBenchProError(
            f"workspace {workspace} points at unrelated repository {remote.stdout.strip()!r}; "
            f"expected {clone_url!r}"
        )

    fetched = _run_git(["-C", str(workspace), "fetch", "--depth", "1", "origin", instance.base_commit])
    if fetched.returncode != 0:
        # A shallow fetch of a single commit is not supported by every server;
        # a full fetch is the honest fallback rather than a silent skip.
        fetched = _run_git(["-C", str(workspace), "fetch", "origin"])
        if fetched.returncode != 0:
            raise SweBenchProError(
                f"git fetch for {instance.instance_id} failed: {fetched.stderr.strip()[:500]}"
            )
    checked_out = _run_git(["-C", str(workspace), "checkout", "--force", instance.base_commit])
    if checked_out.returncode != 0:
        raise SweBenchProError(
            f"git checkout {instance.base_commit} failed: {checked_out.stderr.strip()[:500]}"
        )
    cleaned = _run_git(["-C", str(workspace), "clean", "-fdx"])
    if cleaned.returncode != 0:
        raise SweBenchProError(
            f"git clean for {instance.instance_id} failed: {cleaned.stderr.strip()[:500]}"
        )
    head = _run_git(["-C", str(workspace), "rev-parse", "HEAD"])
    if head.returncode != 0 or head.stdout.strip() != instance.base_commit:
        actual = head.stdout.strip() or "unknown"
        raise SweBenchProError(
            f"materialised {instance.instance_id} at {actual}, expected base commit "
            f"{instance.base_commit}"
        )
    return Materialization(
        workspace=workspace,
        repo=instance.repo,
        base_commit=instance.base_commit,
        clone_url=clone_url,
        head_revision=head.stdout.strip() if head.returncode == 0 else "unknown",
    )


@dataclass(frozen=True)
class Prediction:
    """The two prediction files a SWE-bench Pro run produces."""

    instance_id: str
    model_name_or_path: str
    model_patch: str
    predictions_path: Path
    patches_path: Path

    @property
    def has_patch(self) -> bool:
        """Whether the run actually produced a diff."""
        return bool(self.model_patch.strip())


def write_prediction_files(
    *,
    instance_id: str,
    model_name_or_path: str,
    model_patch: str,
    output_dir: Path,
) -> Prediction:
    """Write both prediction formats and return their paths.

    ``predictions.json`` is the canonical SWE-bench prediction record;
    ``patches.json`` is the list shape SWE-bench Pro's ``swe_bench_pro_eval.py``
    reads from ``--patch_path``. Both are written for every run, including runs
    with an empty patch — an empty prediction is evidence too.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    safe_id = instance_id.replace("/", "__")
    predictions_path = output_dir / f"{safe_id}.predictions.json"
    patches_path = output_dir / f"{safe_id}.patches.json"
    predictions_path.write_text(
        json.dumps(
            [
                {
                    "instance_id": instance_id,
                    "model_name_or_path": model_name_or_path,
                    "model_patch": model_patch,
                }
            ],
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    patches_path.write_text(
        json.dumps(
            [
                {
                    "instance_id": instance_id,
                    "patch": model_patch,
                    "prefix": model_name_or_path,
                }
            ],
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    return Prediction(
        instance_id=instance_id,
        model_name_or_path=model_name_or_path,
        model_patch=model_patch,
        predictions_path=predictions_path,
        patches_path=patches_path,
    )


def _harness_dir() -> Path | None:
    raw = os.environ.get("TERMINUS_SWEBENCH_PRO_HARNESS_DIR")
    if not raw:
        return None
    path = Path(raw)
    return path if (path / "swe_bench_pro_eval.py").is_file() else None


def _harness_revision(path: Path) -> str | None:
    """Read the exact evaluator checkout revision, if it is a Git checkout."""
    try:
        revision = _run_git(["-C", str(path), "rev-parse", "HEAD"])
    except (OSError, SweBenchProError, subprocess.SubprocessError):
        return None
    if revision.returncode != 0:
        return None
    value = revision.stdout.strip()
    return value or None


def _sha256_file(path: Path) -> str:
    """Return a content digest for an evaluator input artifact."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def evaluate_prediction(
    prediction: Prediction,
    *,
    manifest_path: Path | None = None,
    output_dir: Path | None = None,
    timeout_seconds: float = _EVAL_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Grade a prediction with the pinned SWE-bench Pro evaluator.

    Returns a status dict. ``evaluation_pending`` is a real, honest state: the
    patch has been written and can be graded by the official harness later. It
    is never reported as a pass or a fail.
    """
    report: dict[str, Any] = {
        "suite": "swe-bench-pro",
        "instance_id": prediction.instance_id,
        "dataset": SWE_BENCH_PRO_DATASET,
        "dataset_revision": SWE_BENCH_PRO_REVISION,
        "harness_repository": SWE_BENCH_PRO_HARNESS_REPOSITORY,
        "harness_commit": SWE_BENCH_PRO_HARNESS_COMMIT,
        "manifest": str(manifest_path) if manifest_path else None,
        "predictions_path": str(prediction.predictions_path),
        "patches_path": str(prediction.patches_path),
    }
    if not prediction.has_patch:
        report["status"] = "no_patch"
        report["detail"] = "the run produced an empty diff; there is nothing to evaluate"
        return report

    harness_dir = _harness_dir()
    if harness_dir is None:
        if manifest_path is not None:
            report["harness_pin_verified"] = False
        report["status"] = "evaluation_pending"
        report["detail"] = (
            "TERMINUS_SWEBENCH_PRO_HARNESS_DIR is not set to a checkout containing "
            "swe_bench_pro_eval.py; the prediction is written and awaiting the "
            "official evaluator"
        )
        return report

    # The normal CLI path supplies the suite manifest. In that path an
    # arbitrary directory containing a similarly named script is not enough:
    # it would make a result look like an official SWE-bench Pro grade while
    # silently using a fork, a stale checkout, or a fixture evaluator. Keep the
    # direct function path useful for focused/offline tests, but fail closed for
    # manifest-scoped execution unless the checkout is exactly pinned.
    if manifest_path is not None:
        actual_revision = _harness_revision(harness_dir)
        report["harness_revision"] = actual_revision
        report["harness_pin_verified"] = actual_revision == SWE_BENCH_PRO_HARNESS_COMMIT
        if not report["harness_pin_verified"]:
            report["status"] = "evaluation_pending"
            report["detail"] = (
                "TERMINUS_SWEBENCH_PRO_HARNESS_DIR is not checked out at the pinned "
                f"evaluator commit {SWE_BENCH_PRO_HARNESS_COMMIT}; actual revision is "
                f"{actual_revision or 'unknown'}"
            )
            return report

    results_dir = output_dir or prediction.predictions_path.parent / "swebench-pro-results"
    results_dir.mkdir(parents=True, exist_ok=True)
    raw_sample_path = harness_dir / "swe_bench_pro_full.csv"
    if manifest_path is not None:
        missing_inputs = [
            str(path)
            for path in (raw_sample_path, harness_dir / "run_scripts")
            if not path.is_file() and not path.is_dir()
        ]
        if missing_inputs:
            report["status"] = "evaluation_pending"
            report["missing_evaluator_inputs"] = missing_inputs
            report["detail"] = (
                "the pinned SWE-bench Pro checkout is missing required evaluator input(s): "
                + ", ".join(missing_inputs)
                + "; supply the byte-pinned raw dataset CSV and evaluator scripts before running"
            )
            return report
        report["raw_sample_sha256"] = _sha256_file(raw_sample_path)
    argv = [
        # Use the interpreter running forge-evals. On macOS and uv-managed
        # checkouts ``python`` may not exist even though ``python3`` does, and
        # a different interpreter could have a different evaluator dependency
        # set installed.
        sys.executable,
        str(harness_dir / "swe_bench_pro_eval.py"),
        f"--raw_sample_path={raw_sample_path}",
        f"--patch_path={prediction.patches_path}",
        f"--output_dir={results_dir}",
        f"--scripts_dir={harness_dir / 'run_scripts'}",
        "--num_workers=1",
        "--dockerhub_username=jefzda",
    ]
    report["argv"] = argv
    try:
        completed = subprocess.run(
            argv,
            cwd=str(harness_dir),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        report["status"] = "evaluator_error"
        report["detail"] = str(exc)
        return report
    report["status"] = "invoked"
    report["exit_code"] = completed.returncode
    report["stdout_tail"] = completed.stdout[-4_000:]
    report["stderr_tail"] = completed.stderr[-4_000:]
    report["results_dir"] = str(results_dir)
    verdict = read_evaluation_report(results_dir, prediction.instance_id)
    if verdict is None:
        report["status"] = "evaluation_incomplete"
        report["detail"] = (
            "the evaluator ran but wrote no report naming this instance; the run is "
            "ungraded, not failed"
        )
        return report
    report["resolved"] = verdict["resolved"]
    report["report_path"] = verdict["report_path"]
    return report


def read_evaluation_report(results_dir: Path, instance_id: str) -> dict[str, Any] | None:
    """Find this instance's verdict in the evaluator's output directory.

    The upstream harness writes its report as JSON under ``--output_dir``. The
    exact file name has changed across releases, so every JSON file is scanned
    for a record naming this instance and carrying a resolution flag. Nothing
    is inferred from a missing file: the caller reports the run as ungraded.
    """
    if not results_dir.is_dir():
        return None
    resolution_keys = ("resolved", "is_resolved", "passed", "success")
    for path in sorted(results_dir.rglob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for candidate in _iter_candidate_records(raw, instance_id):
            for key in resolution_keys:
                if key in candidate and isinstance(candidate[key], bool):
                    return {
                        "resolved": candidate[key],
                        "record": candidate,
                        "report_path": str(path),
                    }
    return None


def _iter_candidate_records(raw: Any, instance_id: str) -> list[dict[str, Any]]:
    """Yield report records that name ``instance_id``, at any nesting depth."""
    found: list[dict[str, Any]] = []
    stack: list[Any] = [raw]
    while stack:
        node = stack.pop()
        if isinstance(node, Mapping):
            if str(node.get("instance_id") or "") == instance_id:
                found.append(dict(node))
            elif instance_id in node:
                value = node[instance_id]
                if isinstance(value, Mapping):
                    found.append({"instance_id": instance_id, **dict(value)})
                # The pinned upstream evaluator writes ``{instance_id: bool}``
                # to ``eval_results.json``. Preserve that exact shape instead
                # of treating a successful evaluation as an incomplete report.
                elif isinstance(value, bool):
                    found.append({"instance_id": instance_id, "resolved": value})
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return found


def grader_result_for_report(report: Mapping[str, Any]) -> GraderResult:
    """Turn an :func:`evaluate_prediction` report into the run's verdict.

    ``evaluation_pending`` is recorded as *not passed* with an explicit status,
    never as a pass: a patch that has not been graded has not resolved
    anything. The state is real and recoverable — the prediction file is on
    disk and the official harness can grade it later.
    """
    status = str(report.get("status") or "unknown")
    resolved = report.get("resolved")
    passed = status == "invoked" and resolved is True
    evidence = [f"swe-bench-pro evaluation status: {status}"]
    for key in ("detail", "predictions_path", "patches_path", "report_path", "exit_code"):
        if report.get(key) is not None:
            evidence.append(f"{key}: {report[key]}")
    return GraderResult(
        grader_id="swe-bench-pro:swe_bench_pro_eval",
        grader_version=SWE_BENCH_PRO_HARNESS_COMMIT[:12],
        passed=passed,
        score=1.0 if passed else 0.0,
        evidence=evidence,
        metadata={
            "grader_status": status,
            "resolved": resolved,
            "dataset": SWE_BENCH_PRO_DATASET,
            "dataset_revision": SWE_BENCH_PRO_REVISION,
        },
    )
