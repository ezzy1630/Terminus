"""Run Harbor-format benchmarks through their pinned compatible runners.

The suite manifest owns the pins; :func:`adapter_for_suite` validates them and
translates one canonical :class:`RunRequest` into the exact ``harbor run``
argv. This module takes that argv, substitutes the Terminus agent import path
for the placeholder agent id, forwards the control-plane environment Harbor
must hand the shim, executes Harbor, and reads Harbor's own
``results.json`` back into a :class:`RunRecord`.

Grading belongs to Harbor: the shim writes the agent's work into the container
and returns, and Harbor's per-task verifier produces the reward. The reward is
recorded as the run's grader result; nothing here re-derives a verdict.

Harbor and Pier require Docker. When the selected executable is absent this
module raises :class:`HarborUnavailable` rather than emitting a degraded record.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import tomllib
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..evidence import EvidenceClass
from ..run_record import CostBreakdown, GraderResult, Outcome, RunRecord, utc_now
from .benchmark_adapters import BenchmarkManifest, adapter_for_suite
from .harness_runner import RunRequest, apply_metrics_to_record, build_evaluation_identity

__all__ = [
    "HarborTrialOutcome",
    "HarborUnavailable",
    "benchmark_sources_cache_dir",
    "build_harbor_argv",
    "build_pier_argv",
    "collect_trial_results",
    "materialize_task_source",
    "run_harbor_tasks",
]

_DEFAULT_TIMEOUT_SECONDS = 14_400.0


class HarborUnavailable(RuntimeError):
    """Harbor (or its Docker runtime) is not usable on this machine."""


def benchmark_sources_cache_dir(environ: Mapping[str, str] | None = None) -> Path:
    """Return the persistent cache outside the repository validation surface."""
    source = environ if environ is not None else os.environ
    explicit = source.get("TERMINUS_BENCHMARK_CACHE_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()
    xdg = source.get("XDG_CACHE_HOME")
    cache_root = Path(xdg).expanduser() if xdg else Path.home() / ".cache"
    return cache_root / "terminus" / "benchmark-sources"


@dataclass(frozen=True)
class HarborTrialOutcome:
    """One Harbor trial, read back from its ``result.json``."""

    task_name: str
    rewards: dict[str, float]
    exception: str | None
    task_checksum: str
    agent_name: str
    model_name: str | None
    results_path: Path

    @property
    def score(self) -> float:
        """Mean reward, clamped to ``[0, 1]``."""
        if not self.rewards:
            return 0.0
        primary = self.rewards.get("reward")
        value = (
            float(primary)
            if isinstance(primary, (int, float))
            else sum(self.rewards.values()) / len(self.rewards)
        )
        return min(1.0, max(0.0, value))

    @property
    def passed(self) -> bool:
        """Harbor's verdict: a full reward and no trial exception."""
        return bool(self.rewards) and self.exception is None and self.score >= 1.0

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form for the run record's artifacts."""
        return {
            "task_name": self.task_name,
            "rewards": dict(self.rewards),
            "exception": self.exception,
            "task_checksum": self.task_checksum,
            "agent_name": self.agent_name,
            "model_name": self.model_name,
            "results_path": str(self.results_path),
        }


def build_harbor_argv(
    base_argv: Sequence[str],
    *,
    agent_import_path: str,
    agent_env: Mapping[str, str],
    jobs_dir: Path,
    n_attempts: int = 1,
) -> list[str]:
    """Finish the adapter's pinned argv into an executable ``harbor run``.

    The adapter emits ``--agent <harness id>``; Harbor resolves a custom agent
    from a ``module:Class`` import path, so the value is substituted rather
    than appended (``--agent-import-path`` is deprecated upstream in favour of
    ``--agent``). Control-plane configuration is forwarded with ``--ae``, which
    is how Harbor injects environment into an agent.
    """
    argv = list(base_argv)
    if "--agent" in argv:
        argv[argv.index("--agent") + 1] = agent_import_path
    else:
        argv.extend(["--agent", agent_import_path])
    argv.extend(["--jobs-dir", str(jobs_dir)])
    argv.extend(["--n-attempts", str(n_attempts)])
    for key in sorted(agent_env):
        argv.extend(["--ae", f"{key}={agent_env[key]}"])
    return argv


def build_pier_argv(
    base_argv: Sequence[str],
    *,
    agent_import_path: str,
    agent_env: Mapping[str, str],
    jobs_dir: Path,
    n_attempts: int = 1,
) -> list[str]:
    """Finish the pinned Pier argv without adding Harbor-only agent flags."""
    argv = list(base_argv)
    if "--agent-import-path" not in argv:
        argv.extend(["--agent-import-path", agent_import_path])
    else:
        argv[argv.index("--agent-import-path") + 1] = agent_import_path
    argv.extend(["--jobs-dir", str(jobs_dir), "--n-attempts", str(n_attempts)])
    for key in sorted(agent_env):
        argv.extend(["--ae", f"{key}={agent_env[key]}"])
    return argv


def collect_trial_results(jobs_dir: Path) -> list[HarborTrialOutcome]:
    """Read every trial ``result.json`` Harbor wrote under ``jobs_dir``.

    Harbor 0.22 writes one ``result.json`` per trial and another job-level
    ``result.json`` summary. Only the former has ``task_name`` and
    ``verifier_result``; requiring both prevents the summary from becoming a
    phantom trial. Older local fixtures used the plural spelling, so it is
    retained as an explicit compatibility input rather than the primary path.
    """
    outcomes: list[HarborTrialOutcome] = []
    if not jobs_dir.is_dir():
        return outcomes
    paths = sorted({*jobs_dir.rglob("result.json"), *jobs_dir.rglob("results.json")})
    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, Mapping):
            continue
        if not isinstance(raw.get("task_name"), str) or not isinstance(
            raw.get("verifier_result"), Mapping
        ):
            continue
        verifier = raw.get("verifier_result")
        rewards_raw = verifier.get("rewards") if isinstance(verifier, Mapping) else None
        rewards = {
            str(k): float(v)
            for k, v in (rewards_raw or {}).items()
            if isinstance(v, (int, float)) and not isinstance(v, bool)
        }
        exception_info = raw.get("exception_info")
        exception = (
            f"{exception_info.get('exception_type')}: {exception_info.get('exception_message')}"
            if isinstance(exception_info, Mapping)
            else None
        )
        agent_info = raw.get("agent_info") if isinstance(raw.get("agent_info"), Mapping) else {}
        model_info = agent_info.get("model_info") if isinstance(agent_info, Mapping) else None
        outcomes.append(
            HarborTrialOutcome(
                task_name=str(raw.get("task_name") or path.parent.name),
                rewards=rewards,
                exception=exception,
                task_checksum=str(raw.get("task_checksum") or ""),
                agent_name=str(agent_info.get("name") or "") if agent_info else "",
                model_name=(
                    str(model_info.get("name")) if isinstance(model_info, Mapping) else None
                ),
                results_path=path,
            )
        )
    return outcomes


def _environment_digest(
    argv: Sequence[str],
    outcomes: Sequence[HarborTrialOutcome],
    harbor_version: str,
    image_digest: str | None,
) -> str:
    """Content-address the pinned Harbor inputs for this run.

    The digest binds the dataset pin, agent, runner version, official task
    checksum, and resolved OCI image when Docker can report it. Missing image
    identity remains an explicit integrity failure in the run artifacts.
    """
    digest = hashlib.sha256()
    for part in ("argv", *argv, "harbor_version", harbor_version):
        digest.update(str(part).encode("utf-8"))
        digest.update(b"\x00")
    for outcome in outcomes:
        digest.update(outcome.task_name.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(outcome.task_checksum.encode("utf-8"))
        digest.update(b"\n")
    digest.update((image_digest or "missing:resolved_image_digest").encode("utf-8"))
    return "sha256:" + digest.hexdigest()


def _task_image_reference(task_dir: Path) -> str | None:
    """Read the public image reference declared by one immutable task."""
    try:
        raw = tomllib.loads((task_dir / "task.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    environment = raw.get("environment")
    if not isinstance(environment, Mapping):
        return None
    image = environment.get("docker_image")
    return image.strip() if isinstance(image, str) and image.strip() else None


def _resolved_image_artifact(task_dir: Path) -> dict[str, Any]:
    """Resolve the image actually present after the benchmark runner exits."""
    reference = _task_image_reference(task_dir)
    if reference is None:
        return {
            "kind": "resolved_image_digest",
            "status": "task_image_reference_missing",
        }
    try:
        completed = subprocess.run(
            ["docker", "image", "inspect", reference],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {
            "kind": "resolved_image_digest",
            "status": "docker_inspect_unavailable",
            "image_reference": reference,
            "detail": str(error)[:500],
        }
    try:
        rows = json.loads(completed.stdout)
    except ValueError:
        rows = None
    row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], Mapping) else {}
    repo_digests = row.get("RepoDigests") if isinstance(row, Mapping) else None
    resolved = (
        next(
            (
                value.rsplit("@", 1)[-1]
                for value in repo_digests
                if isinstance(value, str) and "@sha256:" in value
            ),
            None,
        )
        if isinstance(repo_digests, list)
        else None
    )
    image_id = row.get("Id") if isinstance(row, Mapping) else None
    if not isinstance(resolved, str):
        return {
            "kind": "resolved_image_digest",
            "status": "registry_digest_unresolved",
            "image_reference": reference,
            "local_image_id": image_id if isinstance(image_id, str) else None,
            "docker_exit_code": completed.returncode,
            "detail": completed.stderr[-500:],
        }
    return {
        "kind": "resolved_image_digest",
        "status": "resolved",
        "image_reference": reference,
        "digest": resolved,
        "local_image_id": image_id if isinstance(image_id, str) else None,
    }


def _runner_version(command: Sequence[str]) -> str:
    try:
        completed = subprocess.run(
            [*command, "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return (completed.stdout or completed.stderr).strip()[:200] or "unknown"


def _runner_command(
    manifest: BenchmarkManifest,
    executable: str,
    explicit_executable: str | None,
) -> tuple[list[str], str]:
    """Resolve an exact upstream runner command, or label an explicit override."""
    if explicit_executable is not None:
        resolved = shutil.which(explicit_executable)
        if resolved is None:
            raise HarborUnavailable(
                f"{explicit_executable!r} is not on PATH; {manifest.suite_id} requires "
                f"{manifest.adapter_kind} and Docker"
            )
        return [resolved], "explicit_unverified"

    uvx = shutil.which("uvx")
    if uvx is None:
        raise HarborUnavailable(
            f"'uvx' is not on PATH; cannot execute pinned {manifest.harness_commit}"
        )
    repository = manifest.harness_repository.removesuffix(".git")
    source = f"git+{repository}.git@{manifest.harness_commit}"
    return [uvx, "--from", source, executable], source


def materialize_task_source(manifest: BenchmarkManifest, sources_dir: Path) -> Path:
    """Clone one immutable local task source for runners that accept only paths."""
    repository = manifest.task_repository
    commit = manifest.task_commit
    if repository is None or commit is None:
        raise HarborUnavailable(f"{manifest.suite_id}: task source is not pinned")
    destination = sources_dir / f"{manifest.suite_id}-{commit[:12]}"
    if destination.exists():
        _verify_task_source(destination, repository, commit)
        return destination

    sources_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{manifest.suite_id}-", dir=sources_dir))
    try:
        cloned = _run_git(
            ["clone", "--filter=blob:none", "--no-checkout", repository, str(staging)]
        )
        if cloned.returncode != 0:
            raise HarborUnavailable(
                f"git clone for {manifest.suite_id} failed: {cloned.stderr[-500:].strip()}"
            )
        fetched = _run_git(["-C", str(staging), "fetch", "--depth", "1", "origin", commit])
        if fetched.returncode != 0:
            raise HarborUnavailable(f"git fetch {commit} failed: {fetched.stderr[-500:].strip()}")
        checked_out = _run_git(["-C", str(staging), "checkout", "--detach", commit])
        if checked_out.returncode != 0:
            raise HarborUnavailable(
                f"git checkout {commit} failed: {checked_out.stderr[-500:].strip()}"
            )
        if destination.exists():
            _verify_task_source(destination, repository, commit)
            return destination
        staging.replace(destination)
        _verify_task_source(destination, repository, commit)
        return destination
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _run_git(argv: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *argv],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def _verify_task_source(path: Path, repository: str, commit: str) -> None:
    remote = _run_git(["-C", str(path), "remote", "get-url", "origin"])
    head = _run_git(["-C", str(path), "rev-parse", "HEAD"])
    if remote.returncode != 0 or remote.stdout.strip() != repository:
        raise HarborUnavailable(f"{path}: cached task source has the wrong origin")
    if head.returncode != 0 or head.stdout.strip() != commit:
        raise HarborUnavailable(f"{path}: cached task source is not at {commit}")


def _agent_summary(outcome: HarborTrialOutcome | None) -> dict[str, Any]:
    """Read the Terminus shim telemetry paired with one official trial result."""
    if outcome is None:
        return {}
    candidates = (
        outcome.results_path.parent / "agent" / "terminus-agent.json",
        outcome.results_path.parent / "terminus-agent.json",
    )
    for path in candidates:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(raw, Mapping):
            return dict(raw)
    return {}


def _trajectory_artifact(
    outcome: HarborTrialOutcome | None,
    summary: Mapping[str, Any],
) -> dict[str, Any]:
    """Resolve and verify the immutable Terminus trajectory Harbor retained."""
    declared = summary.get("trajectory_artifact")
    if outcome is None or not isinstance(declared, Mapping):
        return {"kind": "terminus_trajectory", "status": "missing"}
    file_name = declared.get("file")
    declared_digest = declared.get("digest")
    if not isinstance(file_name, str) or Path(file_name).name != file_name:
        return {"kind": "terminus_trajectory", "status": "invalid_file_name"}
    candidates = (
        outcome.results_path.parent / "agent" / file_name,
        outcome.results_path.parent / file_name,
    )
    path = next((candidate for candidate in candidates if candidate.is_file()), None)
    if path is None:
        return {
            "kind": "terminus_trajectory",
            "status": "file_missing",
            "declared_digest": declared_digest,
        }
    try:
        payload = path.read_bytes()
    except OSError as error:
        return {
            "kind": "terminus_trajectory",
            "status": "unreadable",
            "detail": str(error)[:500],
        }
    digest = "sha256:" + hashlib.sha256(payload).hexdigest()
    if declared_digest != digest:
        return {
            "kind": "terminus_trajectory",
            "status": "digest_mismatch",
            "digest": digest,
            "declared_digest": declared_digest,
            "path": str(path),
        }
    event_count = declared.get("event_count")
    complete = declared.get("complete")
    return {
        "kind": "terminus_trajectory",
        "status": "resolved",
        "digest": digest,
        "path": str(path),
        "complete": complete if isinstance(complete, bool) else False,
        "event_count": event_count if isinstance(event_count, int) else None,
    }


def _cost_from_summary(summary: Mapping[str, Any]) -> CostBreakdown | None:
    raw = summary.get("cost")
    if not isinstance(raw, Mapping):
        return None
    try:
        return CostBreakdown(
            provider_reported_usd=(
                float(raw["provider_reported_usd"])
                if raw.get("provider_reported_usd") is not None
                else None
            ),
            computed_usd=float(raw["computed_usd"]),
            input_tokens=int(raw["input_tokens"]),
            output_tokens=int(raw["output_tokens"]),
            cached_tokens=int(raw.get("cached_tokens") or 0),
            reasoning_tokens=int(raw.get("reasoning_tokens") or 0),
            cache_write_tokens=int(raw.get("cache_write_tokens") or 0),
            cache_read_tokens=int(raw.get("cache_read_tokens") or 0),
            reconciliation_delta_usd=(
                float(raw["reconciliation_delta_usd"])
                if raw.get("reconciliation_delta_usd") is not None
                else None
            ),
            reconciliation_flagged=bool(raw.get("reconciliation_flagged", False)),
            source=str(raw.get("source") or "unavailable"),
        )
    except (KeyError, TypeError, ValueError):
        return None


def run_harbor_tasks(
    *,
    manifest_path: Path,
    request: RunRequest,
    seed: int,
    agent_import_path: str,
    agent_env: Mapping[str, str],
    jobs_dir: Path,
    harbor_executable: str | None = None,
    sources_dir: Path | None = None,
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
) -> RunRecord:
    """Execute one Harbor-format benchmark task and record the official verdict."""
    adapter = adapter_for_suite(manifest_path)
    invocation = adapter.translate(request)
    if invocation.argv is None:  # pragma: no cover - harbor adapter always builds argv
        raise HarborUnavailable("the Harbor adapter produced no invocation argv")

    runner_kind = adapter.manifest.adapter_kind
    executable = invocation.executable
    runner_command, runner_source = _runner_command(
        adapter.manifest,
        executable,
        harbor_executable,
    )

    jobs_dir.mkdir(parents=True, exist_ok=True)
    effective_agent_env = {
        **agent_env,
        "TERMINUS_BENCHMARK_SUITE": request.suite,
    }
    if runner_kind == "pier":
        source = materialize_task_source(
            adapter.manifest,
            sources_dir or benchmark_sources_cache_dir(),
        )
        base_argv = list(invocation.argv)
        if "--path" not in base_argv:
            raise HarborUnavailable("the Pier adapter produced no task path")
        path_index = base_argv.index("--path") + 1
        base_argv[path_index] = str(source / base_argv[path_index])
        argv = build_pier_argv(
            base_argv,
            agent_import_path=agent_import_path,
            agent_env=effective_agent_env,
            jobs_dir=jobs_dir,
        )
    else:
        argv = build_harbor_argv(
            invocation.argv,
            agent_import_path=agent_import_path,
            agent_env=effective_agent_env,
            jobs_dir=jobs_dir,
        )
    argv = [*runner_command, *argv[1:]]
    started_at = utc_now()
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
        env={**os.environ, **effective_agent_env},
    )
    finished_at = utc_now()
    outcomes = collect_trial_results(jobs_dir)
    canonical_task = request.task.rsplit("/", 1)[-1]
    matching = [
        outcome for outcome in outcomes if outcome.task_name.rsplit("/", 1)[-1] == canonical_task
    ]
    if len(matching) > 1:
        raise HarborUnavailable(
            f"{runner_kind} wrote {len(matching)} results for task {request.task!r}; "
            "the run is ambiguous"
        )
    version = _runner_version(runner_command)
    image_artifact = _resolved_image_artifact(request.task_dir)
    resolved_image_digest = image_artifact.get("digest")
    environment_digest = _environment_digest(
        argv,
        matching,
        version,
        resolved_image_digest if isinstance(resolved_image_digest, str) else None,
    )

    grader_results = [
        GraderResult(
            grader_id=f"{runner_kind}:{adapter.manifest.dataset}@{adapter.manifest.dataset_version}",
            grader_version=str(adapter.manifest.suite_version),
            passed=outcome.passed,
            score=outcome.score,
            evidence=[
                f"{runner_kind} rewards: {json.dumps(outcome.rewards, sort_keys=True)}",
                *([f"trial exception: {outcome.exception}"] if outcome.exception else []),
            ],
            metadata=outcome.to_dict(),
        )
        for outcome in matching
    ]
    if not grader_results:
        grader_results = [
            GraderResult(
                grader_id=f"{runner_kind}:{adapter.manifest.dataset}@{adapter.manifest.dataset_version}",
                grader_version=str(adapter.manifest.suite_version),
                passed=False,
                score=0.0,
                evidence=[
                    f"{runner_kind} exited {completed.returncode} and wrote no unambiguous trial result.json under "
                    f"{jobs_dir}",
                    completed.stderr[-4_000:],
                ],
                metadata={f"{runner_kind}_exit_code": completed.returncode},
            )
        ]

    scored_trial = matching[0] if len(matching) == 1 else None
    summary = _agent_summary(scored_trial)
    trajectory_artifact = _trajectory_artifact(scored_trial, summary)
    summary_metrics = summary.get("metrics")
    metrics = dict(summary_metrics) if isinstance(summary_metrics, Mapping) else {}
    observed_snapshot = metrics.get("model_snapshot")
    model_snapshot = {
        **request.model_snapshot.to_dict(),
        **(dict(observed_snapshot) if isinstance(observed_snapshot, Mapping) else {}),
        "reasoning_effort": (
            (
                observed_snapshot.get("reasoning_effort")
                if isinstance(observed_snapshot, Mapping)
                else None
            )
            or (
                observed_snapshot.get("selected_reasoning_effort")
                if isinstance(observed_snapshot, Mapping)
                else None
            )
            or request.reasoning_effort
        ),
        f"{runner_kind}_version": version,
        "runner_source": runner_source,
        "agent_import_path": agent_import_path,
    }
    receipts_raw = summary.get("provider_receipts")
    provider_receipts = (
        [dict(receipt) for receipt in receipts_raw if isinstance(receipt, Mapping)]
        if isinstance(receipts_raw, list)
        else []
    )
    independently_verified = (
        scored_trial is not None and scored_trial.exception is None and bool(scored_trial.rewards)
    )
    outcome_value = (
        Outcome.COMPLETED
        if scored_trial is not None and scored_trial.exception is None
        else Outcome.ERROR
    )
    record = RunRecord(
        run_id=f"{runner_kind}-{request.suite}-{request.task}-{seed}-{uuid.uuid4().hex[:8]}",
        suite=request.suite,
        task=request.task,
        harness=request.harness_id,
        harness_commit=request.harness_commit,
        model_capability_snapshot=model_snapshot,
        environment_digest=environment_digest,
        random_seed=seed,
        budgets=request.budgets.to_dict(),
        outcome=outcome_value,
        grader_results=grader_results,
        cost=_cost_from_summary(summary),
        artifacts=[
            {
                "kind": "benchmark_adapter_manifest",
                "invocation": invocation.to_dict(),
                "argv": _redact_argv(argv),
            },
            {
                "kind": f"{runner_kind}_trials",
                "trials": [o.to_dict() for o in matching],
                "jobs_dir": str(jobs_dir),
                f"{runner_kind}_exit_code": completed.returncode,
            },
            image_artifact,
            trajectory_artifact,
        ],
        notes=json.dumps(
            {
                "mode": "live",
                "runner": runner_kind,
                "dataset": f"{adapter.manifest.dataset}@{adapter.manifest.dataset_version}",
                "stdout_tail": completed.stdout[-2_000:],
                "stderr_tail": completed.stderr[-2_000:],
            },
            sort_keys=True,
        ),
        evidence_class=EvidenceClass.EXTERNAL_LIVE,
        independently_verified=independently_verified,
        provider_receipts=provider_receipts,
        evaluation_identity=build_evaluation_identity(
            request, environment_digest=environment_digest
        ),
        start=started_at,
        end=finished_at,
    )
    apply_metrics_to_record(record, metrics)
    record.wall_clock_ms = max(
        1,
        int((finished_at - started_at).total_seconds() * 1_000),
    )
    return record


def _redact_argv(argv: Sequence[str]) -> list[str]:
    """Return the argv with agent-env secrets masked."""
    out: list[str] = []
    redact_next = False
    for item in argv:
        if redact_next:
            key = item.split("=", 1)[0]
            out.append(f"{key}=***" if "TOKEN" in key.upper() else item)
            redact_next = False
            continue
        out.append(item)
        redact_next = item == "--ae"
    return out
