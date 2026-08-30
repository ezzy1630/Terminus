"""SPEC §41.1 harness-controlled comparison.

Runs the *same* task across *multiple* harnesses under the *same* model,
environment, and budgets, producing a list of :class:`RunRecord` instances
that can be paired (SPEC §41.6 — "prefer paired comparisons on identical
tasks").

The cross-harness runner is the foundation of the model-fixed comparison
mode (SPEC §18.1). Product-native comparison (each harness's recommended
stack) is handled by running each harness separately with its own model
snapshot — that path doesn't need this module.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from ..run_record import GraderResult, Outcome, RunRecord, utc_now
from .harness_runner import (
    Budgets,
    EnvironmentDigest,
    Harness,
    HarnessRunner,
    ModelCapabilitySnapshot,
    RunRequest,
    build_evaluation_identity,
)
from .live_runner import LiveRunError, materialize_task_workspace
from .task_graders import run_task_grader

if TYPE_CHECKING:
    from ..paired_evaluation import PairedEvaluationEvidence

__all__ = [
    "CrossHarnessPlan",
    "CrossHarnessResult",
    "CrossHarnessRunner",
    "HarnessSpec",
    "TaskSpec",
    "run_paired_comparison",
]


@dataclass(frozen=True)
class HarnessSpec:
    """A harness participating in a cross-harness comparison."""

    harness_id: str
    harness_commit: str
    factory: Harness
    harness_config_hash: str = "missing:harness_config_hash"
    provider_aliases: frozenset[str] = field(default_factory=frozenset)
    pin_verified: bool = False
    provider_account_id: str | None = None
    provider_endpoint: str | None = None
    reasoning_effort: str | None = None
    # Strict campaigns must provide the artifact that actually executed.  A
    # caller-provided ``pin_verified`` flag is advisory and cannot substitute
    # for hashing that artifact at campaign start.
    artifact_path: Path | None = None
    artifact_digest: str | None = None


@dataclass(frozen=True)
class TaskSpec:
    """A task to run across all harnesses."""

    suite: str
    task: str
    task_dir: Path
    holdout_partition: str | None = None


@dataclass(frozen=True)
class CrossHarnessPlan:
    """The plan for a cross-harness comparison run.

    Each (task, harness, seed) triple produces one :class:`RunRecord`.
    ``seeds`` controls the number of independent repeats; the model snapshot
    and budgets are shared across harnesses (SPEC §18.1 — model-fixed mode).
    """

    tasks: list[TaskSpec]
    harnesses: list[HarnessSpec]
    model_snapshot: ModelCapabilitySnapshot
    seeds: list[int]
    budgets: Budgets = field(default_factory=Budgets)
    experiment_assignments: list[dict[str, object]] = field(default_factory=list)
    # If True, harness order is randomized per task to avoid ordering effects.
    randomize_harness_order: bool = True
    rng_seed: int = 0
    output_dir: Path | None = None
    require_exact_pins: bool = False
    tool_schema_hash: str = "missing:tool_schema_hash"
    campaign_id: str = ""
    # A parent-directory move is not a sandbox.  Strict/release campaigns
    # remain blocked until an external verifier supplies this attestation.
    isolation_verified: bool = False
    isolation_attestation_hash: str | None = None

    @property
    def total_runs(self) -> int:
        """Total runs implied by the plan."""
        return len(self.tasks) * len(self.harnesses) * len(self.seeds)


@dataclass
class CrossHarnessResult:
    """The result of a cross-harness comparison run."""

    records: list[RunRecord] = field(default_factory=list)

    def by_harness(self) -> dict[str, list[RunRecord]]:
        """Group records by harness id."""
        out: dict[str, list[RunRecord]] = {}
        for r in self.records:
            out.setdefault(r.harness, []).append(r)
        return out

    def by_task(self) -> dict[str, list[RunRecord]]:
        """Group records by task id."""
        out: dict[str, list[RunRecord]] = {}
        for r in self.records:
            out.setdefault(r.task, []).append(r)
        return out

    def pairs(self) -> list[tuple[RunRecord, RunRecord]]:
        """Return matched (baseline, candidate) record pairs per task/seed.

        Pairs are produced in the order the harnesses are listed in the plan.
        For N harnesses this produces N-1 pairs per (task, seed). Returns
        an empty list if fewer than 2 harnesses participated.
        """
        if len({r.harness for r in self.records}) < 2:
            return []
        pairs: list[tuple[RunRecord, RunRecord]] = []
        by_task_seed: dict[tuple[str, int], list[RunRecord]] = {}
        for r in self.records:
            by_task_seed.setdefault((r.task, r.random_seed), []).append(r)
        for pair_list in by_task_seed.values():
            # Sort by harness id alphabetically so pairs are stable.
            pair_list.sort(key=lambda r: r.harness)
            for i in range(len(pair_list) - 1):
                pairs.append((pair_list[i], pair_list[i + 1]))
        return pairs

    def derive_paired_evidence(
        self,
        baseline_harness: str,
        candidate_harness: str,
        **kwargs: Any,
    ) -> PairedEvaluationEvidence:
        """Derive identity-checked statistics for two named harnesses.

        ``pairs()`` remains a presentation helper. Promotion callers should
        use this method so incomplete or mismatched identity cannot become
        release evidence by accident.
        """
        from ..paired_evaluation import derive_paired_evidence

        baseline = [record for record in self.records if record.harness == baseline_harness]
        candidate = [record for record in self.records if record.harness == candidate_harness]
        return derive_paired_evidence(
            baseline,
            candidate,
            baseline_harness=baseline_harness,
            candidate_harness=candidate_harness,
            **kwargs,
        )


class ProgressReporter(Protocol):
    """Optional progress callback."""

    def __call__(self, completed: int, total: int, record: RunRecord) -> None:
        """Called after each run completes."""
        ...


class NullReporter:
    """No-op progress reporter."""

    def __call__(self, completed: int, total: int, record: RunRecord) -> None:
        pass


class CrossHarnessRunner:
    """Runs a :class:`CrossHarnessPlan` and returns a :class:`CrossHarnessResult`.

    Each individual run uses :class:`HarnessRunner` so the per-run record
    schema is identical to a single-harness run (SPEC §41.5).
    """

    def __init__(self, reporter: ProgressReporter | None = None) -> None:
        self.reporter: ProgressReporter = reporter or NullReporter()

    def run(self, plan: CrossHarnessPlan) -> CrossHarnessResult:
        """Execute the plan and return all records."""
        _validate_plan(plan)
        records: list[RunRecord] = []
        output_dir = plan.output_dir or Path(tempfile.mkdtemp(prefix="terminus-paired-"))
        output_dir.mkdir(parents=True, exist_ok=True)
        records_path = output_dir / "runs.jsonl"
        if records_path.exists():
            raise ValueError(f"paired campaign output already exists: {records_path}")
        assignments = _randomized_assignments(plan)
        campaign_manifest, campaign_digest = _campaign_manifest(plan, assignments)
        manifest_path = output_dir / "campaign-manifest.json"
        if manifest_path.exists():
            raise ValueError(f"paired campaign manifest already exists: {manifest_path}")
        manifest_path.write_text(
            json.dumps(campaign_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        total = plan.total_runs
        for completed, assignment in enumerate(assignments, start=1):
            task = next(
                task
                for task in plan.tasks
                if task.suite == assignment["suite"] and task.task == assignment["task"]
            )
            hs = next(
                harness
                for harness in plan.harnesses
                if harness.harness_id == assignment["harness"]
            )
            try:
                record = self._run_cell(
                    plan,
                    task,
                    hs,
                    _assignment_int(assignment, "seed"),
                    _assignment_int(assignment, "position"),
                    _assignment_order(assignment),
                    output_dir,
                    campaign_digest,
                )
            except Exception as exc:  # one broken cell must remain visible
                record = _error_record(
                    plan,
                    task,
                    hs,
                    _assignment_int(assignment, "seed"),
                    _assignment_int(assignment, "position"),
                    _assignment_order(assignment),
                    campaign_digest,
                    exc,
                )
            records.append(record)
            with records_path.open("a", encoding="utf-8") as output:
                output.write(record.to_jsonl_line() + "\n")
            self.reporter(completed, total, record)
        return CrossHarnessResult(records=records)

    def _run_cell(
        self,
        plan: CrossHarnessPlan,
        task: TaskSpec,
        hs: HarnessSpec,
        seed: int,
        position: int,
        order: list[str],
        output_dir: Path,
        campaign_digest: str,
    ) -> RunRecord:
        workspace = (
            output_dir
            / "workspaces"
            / _safe_component(task.suite)
            / _safe_component(task.task)
            / _safe_component(hs.harness_id)
            / str(seed)
        )
        materialized = materialize_task_workspace(task.task_dir, workspace)
        if not materialized.is_scratch:
            raise LiveRunError(
                f"paired task {task.task_dir} has no setup.sh; refusing to let "
                "harnesses share the immutable task package"
            )
        repository_digest = _workspace_digest(materialized.workspace)
        environment_digest = EnvironmentDigest.from_task_dir(task.task_dir).to_digest()
        policy_hash = _hash_file(task.task_dir / "policy.yaml")
        instruction_hash = _hash_file(task.task_dir / "prompt.md")
        network_policy = _network_policy(task.task_dir)
        task_version = _task_version(task.task_dir)
        cell_assignments = [
            *plan.experiment_assignments,
            {
                "campaign_digest": campaign_digest,
                "harness_order": order,
                "harness_position": position,
            },
        ]
        request = RunRequest(
            suite=task.suite,
            task=task.task,
            task_dir=materialized.workspace,
            task_package_dir=task.task_dir,
            harness_id=hs.harness_id,
            harness_commit=hs.harness_commit,
            model_snapshot=plan.model_snapshot,
            random_seed=seed,
            budgets=plan.budgets,
            experiment_assignments=cell_assignments,
            task_version=task_version,
            repository_digest=repository_digest,
            sandbox_policy_hash=policy_hash,
            network_policy=network_policy,
            tool_schema_hash=plan.tool_schema_hash,
            instruction_hash=instruction_hash,
            harness_config_hash=hs.harness_config_hash,
            holdout_partition=task.holdout_partition,
            provider_account_id=hs.provider_account_id,
            provider_endpoint=hs.provider_endpoint,
            reasoning_effort=hs.reasoning_effort,
        )
        record = HarnessRunner(harness=hs.factory).run(request)
        if record.outcome is Outcome.ERROR:
            record.artifacts.append(
                {
                    "kind": "cell_error",
                    "stage": "harness",
                    "campaign_digest": campaign_digest,
                }
            )
        _validate_provider_receipts(record, plan.model_snapshot, hs)
        grade = run_task_grader(
            task.task_dir,
            materialized.workspace,
            objective=f"{task.suite}/{task.task}",
            grader_assets_dir=materialized.grader_assets_dir,
        )
        record.grader_results.append(grade)
        # A local grader is useful diagnostic output, not independent proof.
        record.independently_verified = False
        record.environment_digest = environment_digest
        record.evaluation_identity = build_evaluation_identity(
            request,
            environment_digest=environment_digest,
        )
        record.workspace_base_commit = materialized.base_commit
        record.artifacts.extend(
            [
                {"kind": "task_workspace", **materialized.to_dict()},
                {
                    "kind": "local_grader_execution",
                    "status": grade.metadata.get("grader_status", "unknown"),
                    "independently_verified": False,
                    "access_isolation_verified": False,
                },
            ]
        )
        return record


_EXACT_REVISION = re.compile(r"(?:(?:git:)?[0-9a-f]{40,64}|sha256:[0-9a-f]{64})")
_EXACT_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def _randomized_assignments(plan: CrossHarnessPlan) -> list[dict[str, object]]:
    """Precompute the complete randomization before any cell executes."""
    rng = random.Random(plan.rng_seed)
    assignments: list[dict[str, object]] = []
    for task in plan.tasks:
        for seed in plan.seeds:
            harnesses = list(plan.harnesses)
            if plan.randomize_harness_order:
                rng.shuffle(harnesses)
            order = [harness.harness_id for harness in harnesses]
            for position, harness_id in enumerate(order):
                assignments.append(
                    {
                        "suite": task.suite,
                        "task": task.task,
                        "seed": seed,
                        "harness": harness_id,
                        "position": position,
                        "order": order,
                    }
                )
    return assignments


def _campaign_manifest(
    plan: CrossHarnessPlan,
    assignments: list[dict[str, object]],
) -> tuple[dict[str, object], str]:
    """Build a redacted, preregistered manifest and its content digest."""
    body: dict[str, object] = {
        "schema": "terminus.cross-harness-campaign.v2",
        "campaign_id": plan.campaign_id or "pending",
        "preregistered": True,
        "model_snapshot": plan.model_snapshot.to_dict(),
        "budgets": plan.budgets.to_dict(),
        "seeds": list(plan.seeds),
        "randomize_harness_order": plan.randomize_harness_order,
        "rng_seed": plan.rng_seed,
        "require_exact_pins": plan.require_exact_pins,
        "isolation_verified": plan.isolation_verified,
        "isolation_attestation_hash": plan.isolation_attestation_hash,
        "tool_schema_hash": plan.tool_schema_hash,
        "experiment_assignments": list(plan.experiment_assignments),
        "tasks": [
            {
                "suite": task.suite,
                "task": task.task,
                "task_package_digest": _workspace_digest(task.task_dir),
                "holdout_partition": task.holdout_partition,
            }
            for task in plan.tasks
        ],
        "harnesses": [
            {
                "harness_id": harness.harness_id,
                "harness_commit": harness.harness_commit,
                "harness_config_hash": harness.harness_config_hash,
                "artifact_digest": harness.artifact_digest,
                "provider_account_hash": _safe_value_hash(harness.provider_account_id),
                "provider_endpoint_hash": _safe_value_hash(harness.provider_endpoint),
            }
            for harness in plan.harnesses
        ],
        "assignments": assignments,
    }
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = "sha256:" + hashlib.sha256(encoded).hexdigest()
    body["campaign_digest"] = digest
    if body["campaign_id"] == "pending":
        body["campaign_id"] = digest
    return body, digest


def _safe_value_hash(value: str | None) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest() if value else "missing"


def _assignment_int(assignment: dict[str, object], key: str) -> int:
    value = assignment.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"campaign assignment {key} is not an integer")
    return value


def _assignment_order(assignment: dict[str, object]) -> list[str]:
    value = assignment.get("order")
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("campaign assignment order is malformed")
    return list(value)


def _error_record(
    plan: CrossHarnessPlan,
    task: TaskSpec,
    harness: HarnessSpec,
    seed: int,
    position: int,
    order: list[str],
    campaign_digest: str,
    error: Exception,
) -> RunRecord:
    """Persist a visible ERROR row when setup or grading cannot complete."""
    environment_digest = EnvironmentDigest.from_task_dir(task.task_dir).to_digest()
    request = RunRequest(
        suite=task.suite,
        task=task.task,
        task_dir=task.task_dir,
        task_package_dir=task.task_dir,
        harness_id=harness.harness_id,
        harness_commit=harness.harness_commit,
        model_snapshot=plan.model_snapshot,
        random_seed=seed,
        budgets=plan.budgets,
        experiment_assignments=[
            *plan.experiment_assignments,
            {
                "campaign_digest": campaign_digest,
                "harness_order": order,
                "harness_position": position,
            },
        ],
        task_version=_task_version(task.task_dir),
        repository_digest="missing:repository_digest",
        sandbox_policy_hash=_hash_file(task.task_dir / "policy.yaml"),
        network_policy=_network_policy(task.task_dir),
        tool_schema_hash=plan.tool_schema_hash,
        instruction_hash=_hash_file(task.task_dir / "prompt.md"),
        harness_config_hash=harness.harness_config_hash,
        holdout_partition=task.holdout_partition,
        provider_account_id=harness.provider_account_id,
        provider_endpoint=harness.provider_endpoint,
        reasoning_effort=harness.reasoning_effort,
    )
    record = RunRecord.new(
        suite=task.suite,
        task=task.task,
        harness=harness.harness_id,
        harness_commit=harness.harness_commit,
        environment_digest=environment_digest,
        random_seed=seed,
        model_capability_snapshot=plan.model_snapshot.to_dict(),
        budgets=plan.budgets.to_dict(),
        evaluation_identity=build_evaluation_identity(
            request,
            environment_digest=environment_digest,
        ),
        holdout_partition=task.holdout_partition,
    )
    record.end = utc_now()
    record.outcome = Outcome.ERROR
    record.notes = f"paired cell error: {type(error).__name__}: {error}"
    record.experiment_assignments = list(request.experiment_assignments)
    record.artifacts.append(
        {
            "kind": "cell_error",
            "stage": "setup_or_harness_or_grader",
            "error_type": type(error).__name__,
            "campaign_digest": campaign_digest,
        }
    )
    return record


def _validate_plan(plan: CrossHarnessPlan) -> None:
    if not plan.tasks:
        raise ValueError("paired campaign requires at least one task")
    if len(plan.harnesses) < 2:
        raise ValueError("paired campaign requires at least two harnesses")
    if not plan.seeds or any(seed < 0 for seed in plan.seeds):
        raise ValueError("paired campaign requires non-negative seeds")
    cells = [(task.suite, task.task) for task in plan.tasks]
    if len(cells) != len(set(cells)):
        raise ValueError("paired campaign contains duplicate task cells")
    harness_ids = [harness.harness_id for harness in plan.harnesses]
    if len(harness_ids) != len(set(harness_ids)):
        raise ValueError("paired campaign contains duplicate harness ids")
    if plan.require_exact_pins:
        for harness in plan.harnesses:
            if (
                not harness.pin_verified
                or _EXACT_REVISION.fullmatch(harness.harness_commit) is None
            ):
                raise ValueError(f"harness {harness.harness_id} does not have a verified exact pin")
            if harness.harness_config_hash.startswith("missing:"):
                raise ValueError(f"harness {harness.harness_id} has no config hash")
            artifact_path = harness.artifact_path or _factory_artifact_path(harness.factory)
            if artifact_path is None or not artifact_path.is_file():
                raise ValueError(
                    f"harness {harness.harness_id} has no executable/artifact for strict pinning"
                )
            if harness.artifact_digest is None or _EXACT_DIGEST.fullmatch(harness.artifact_digest) is None:
                raise ValueError(f"harness {harness.harness_id} has no exact artifact digest")
            actual_digest = _hash_artifact(artifact_path)
            if actual_digest != harness.artifact_digest:
                raise ValueError(
                    f"harness {harness.harness_id} artifact digest changed: "
                    f"expected {harness.artifact_digest}, observed {actual_digest}"
                )
            if not harness.provider_endpoint:
                raise ValueError(f"harness {harness.harness_id} has no provider endpoint binding")
            if not harness.provider_account_id:
                raise ValueError(f"harness {harness.harness_id} has no provider account binding")
        if plan.tool_schema_hash.startswith("missing:"):
            raise ValueError("strict campaign has no tool schema identity")
        if not plan.isolation_verified:
            raise ValueError(
                "strict campaign requires verified external sandbox isolation; "
                "path separation is insufficient"
            )
        if (
            plan.isolation_attestation_hash is None
            or _EXACT_DIGEST.fullmatch(plan.isolation_attestation_hash) is None
        ):
            raise ValueError("strict campaign has no immutable isolation attestation")


def _factory_artifact_path(factory: Harness) -> Path | None:
    executable = getattr(factory, "executable", None)
    if not isinstance(executable, str) or not executable.strip():
        return None
    resolved = Path(executable).expanduser()
    if not resolved.is_absolute():
        from shutil import which

        found = which(executable)
        return Path(found) if found else None
    return resolved


def _hash_artifact(path: Path) -> str:
    if path.is_file():
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    raise ValueError(f"harness artifact is not a file: {path}")


def _safe_component(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._") or "cell"


def _hash_file(path: Path) -> str:
    if not path.is_file():
        return f"missing:{path.name}"
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _workspace_digest(workspace: Path) -> str:
    """Hash the model-visible initial tree, excluding generated tool environments."""
    digest = hashlib.sha256()
    ignored = {".git", ".venv", "__pycache__", ".pytest_cache"}
    for path in sorted(candidate for candidate in workspace.rglob("*") if candidate.is_file()):
        relative = path.relative_to(workspace)
        if any(part in ignored for part in relative.parts):
            continue
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\x00")
        digest.update(path.read_bytes())
        digest.update(b"\x00")
    return "sha256:" + digest.hexdigest()


def _task_yaml(package: Path) -> dict[str, Any]:
    import yaml

    path = package / "task.yaml"
    loaded = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}
    if not isinstance(loaded, dict):
        return {}
    nested = loaded.get("task")
    return dict(nested) if isinstance(nested, dict) else loaded


def _task_version(package: Path) -> str:
    task = _task_yaml(package)
    value = task.get("version") or task.get("source_commit")
    return str(value) if value else "missing:task_version"


def _network_policy(package: Path) -> str:
    task = _task_yaml(package)
    return json.dumps(task.get("allowed_network", []), sort_keys=True, separators=(",", ":"))


def _validate_provider_receipts(
    record: RunRecord,
    snapshot: ModelCapabilitySnapshot,
    harness: HarnessSpec,
) -> None:
    aliases = {snapshot.provider, *harness.provider_aliases}
    for receipt in record.provider_receipts:
        model = str(receipt.get("model") or "")
        provider = str(receipt.get("provider") or "")
        if model and model.split("/", 1)[-1] != snapshot.model.split("/", 1)[-1]:
            raise ValueError(
                f"harness {harness.harness_id} ran model {model!r}, expected {snapshot.model!r}"
            )
        if provider and provider not in aliases:
            raise ValueError(
                f"harness {harness.harness_id} ran provider {provider!r}, expected one of "
                f"{sorted(aliases)!r}"
            )


def _grader_executed(result: GraderResult) -> bool:
    return result.metadata.get("grader_status") == "ran"


def run_paired_comparison(
    tasks: Iterable[TaskSpec],
    harnesses: Iterable[HarnessSpec],
    model_snapshot: ModelCapabilitySnapshot,
    seeds: Iterable[int],
    budgets: Budgets | None = None,
    reporter: ProgressReporter | None = None,
) -> CrossHarnessResult:
    """Convenience: run a paired comparison and return the result.

    Equivalent to constructing a :class:`CrossHarnessPlan` and
    :class:`CrossHarnessRunner` and calling :meth:`CrossHarnessRunner.run`.
    """
    plan = CrossHarnessPlan(
        tasks=list(tasks),
        harnesses=list(harnesses),
        model_snapshot=model_snapshot,
        seeds=list(seeds),
        budgets=budgets or Budgets(),
    )
    return CrossHarnessRunner(reporter=reporter).run(plan)
