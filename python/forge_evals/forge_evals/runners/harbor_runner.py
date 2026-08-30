"""Run Terminal-Bench through Harbor with the Terminus agent shim.

The suite manifest owns the pins; :func:`adapter_for_suite` validates them and
translates one canonical :class:`RunRequest` into the exact ``harbor run``
argv. This module takes that argv, substitutes the Terminus agent import path
for the placeholder agent id, forwards the control-plane environment Harbor
must hand the shim, executes Harbor, and reads Harbor's own
``results.json`` back into a :class:`RunRecord`.

Grading belongs to Harbor: the shim writes the agent's work into the container
and returns, and Harbor's per-task verifier produces the reward. The reward is
recorded as the run's grader result; nothing here re-derives a verdict.

Harbor requires Docker. When the ``harbor`` executable is absent this module
raises :class:`HarborUnavailable` rather than emitting a degraded record.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..evidence import EvidenceClass
from ..run_record import GraderResult, Outcome, RunRecord, utc_now
from .benchmark_adapters import adapter_for_suite
from .harness_runner import RunRequest, build_evaluation_identity

__all__ = [
    "HarborTrialOutcome",
    "HarborUnavailable",
    "build_harbor_argv",
    "collect_trial_results",
    "run_harbor_tasks",
]

_DEFAULT_TIMEOUT_SECONDS = 14_400.0


class HarborUnavailable(RuntimeError):
    """Harbor (or its Docker runtime) is not usable on this machine."""


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
) -> str:
    """Content-address the pinned Harbor inputs for this run.

    Harbor's ``results.json`` does not report the resolved container image
    digest, so the suite's ``image_digest_policy: per_task_required`` cannot be
    satisfied from Harbor's output alone. The digest below binds the dataset
    pin, the agent, the Harbor version, and each trial's own task checksum —
    which is real, content-addressed identity — and the missing image digest is
    reported separately rather than faked.
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
    return "sha256:" + digest.hexdigest()


def _harbor_version(executable: str) -> str:
    try:
        completed = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return (completed.stdout or completed.stderr).strip()[:200] or "unknown"


def run_harbor_tasks(
    *,
    manifest_path: Path,
    request: RunRequest,
    seed: int,
    agent_import_path: str,
    agent_env: Mapping[str, str],
    jobs_dir: Path,
    harbor_executable: str = "harbor",
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
) -> RunRecord:
    """Execute one Terminal-Bench task through Harbor and record the outcome."""
    adapter = adapter_for_suite(manifest_path)
    invocation = adapter.translate(request)
    if invocation.argv is None:  # pragma: no cover - harbor adapter always builds argv
        raise HarborUnavailable("the Harbor adapter produced no invocation argv")

    resolved = shutil.which(harbor_executable)
    if resolved is None:
        raise HarborUnavailable(
            f"{harbor_executable!r} is not on PATH; Terminal-Bench requires Harbor and Docker"
        )

    jobs_dir.mkdir(parents=True, exist_ok=True)
    argv = build_harbor_argv(
        invocation.argv,
        agent_import_path=agent_import_path,
        agent_env=agent_env,
        jobs_dir=jobs_dir,
    )
    argv[0] = resolved
    started_at = utc_now()
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
        env={**os.environ, **agent_env},
    )
    finished_at = utc_now()
    outcomes = collect_trial_results(jobs_dir)
    canonical_task = request.task.rsplit("/", 1)[-1]
    matching = [
        outcome
        for outcome in outcomes
        if outcome.task_name.rsplit("/", 1)[-1] == canonical_task
    ]
    if len(matching) > 1:
        raise HarborUnavailable(
            f"Harbor wrote {len(matching)} results for task {request.task!r}; "
            "the run is ambiguous"
        )
    version = _harbor_version(resolved)
    environment_digest = _environment_digest(argv, matching, version)

    grader_results = [
        GraderResult(
            grader_id=f"harbor:{adapter.manifest.dataset}@{adapter.manifest.dataset_version}",
            grader_version=str(adapter.manifest.suite_version),
            passed=outcome.passed,
            score=outcome.score,
            evidence=[
                f"harbor rewards: {json.dumps(outcome.rewards, sort_keys=True)}",
                *( [f"trial exception: {outcome.exception}"] if outcome.exception else [] ),
            ],
            metadata=outcome.to_dict(),
        )
        for outcome in matching
    ]
    if not grader_results:
        grader_results = [
            GraderResult(
                grader_id=f"harbor:{adapter.manifest.dataset}@{adapter.manifest.dataset_version}",
                grader_version=str(adapter.manifest.suite_version),
                passed=False,
                score=0.0,
                evidence=[
                    f"harbor exited {completed.returncode} and wrote no unambiguous trial result.json under "
                    f"{jobs_dir}",
                    completed.stderr[-4_000:],
                ],
                metadata={"harbor_exit_code": completed.returncode},
            )
        ]

    scored_trial = matching[0] if len(matching) == 1 else None
    outcome_value = (
        Outcome.COMPLETED
        if scored_trial is not None and scored_trial.exception is None
        else Outcome.ERROR
    )
    record = RunRecord(
        run_id=f"harbor-{request.suite}-{request.task}-{seed}-{uuid.uuid4().hex[:8]}",
        suite=request.suite,
        task=request.task,
        harness=request.harness_id,
        harness_commit=request.harness_commit,
        model_capability_snapshot={
            **request.model_snapshot.to_dict(),
            "harbor_version": version,
            "agent_import_path": agent_import_path,
        },
        environment_digest=environment_digest,
        random_seed=seed,
        budgets=request.budgets.to_dict(),
        outcome=outcome_value,
        grader_results=grader_results,
        artifacts=[
            {
                "kind": "benchmark_adapter_manifest",
                "invocation": invocation.to_dict(),
                "argv": _redact_argv(argv),
            },
            {
                "kind": "harbor_trials",
                "trials": [o.to_dict() for o in matching],
                "jobs_dir": str(jobs_dir),
                "harbor_exit_code": completed.returncode,
            },
            {
                "kind": "resolved_image_digest",
                "status": "unreported_by_harbor",
                "detail": (
                    "harbor results.json carries task_checksum but no resolved container "
                    "image digest; the suite's per_task_required policy cannot be satisfied "
                    "from Harbor output alone"
                ),
            },
        ],
        notes=json.dumps(
            {
                "mode": "live",
                "runner": "harbor",
                "dataset": f"{adapter.manifest.dataset}@{adapter.manifest.dataset_version}",
                "stdout_tail": completed.stdout[-2_000:],
                "stderr_tail": completed.stderr[-2_000:],
            },
            sort_keys=True,
        ),
        evidence_class=EvidenceClass.EXTERNAL_LIVE,
        evaluation_identity=build_evaluation_identity(
            request, environment_digest=environment_digest
        ),
        start=started_at,
        end=finished_at,
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
