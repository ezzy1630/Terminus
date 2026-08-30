"""Resumable execution plan for the full AA Coding Agent Index campaign."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .aa_coding_index import AaCodingIndexComponent, AaCodingIndexContract
from .runners.benchmark_adapters import BenchmarkManifest, load_benchmark_manifest
from .runners.harbor_runner import materialize_task_source

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Mapping, Sequence

    from .run_record import RunRecord

__all__ = [
    "AaCampaignAttempt",
    "AaCampaignExecution",
    "AaCampaignFailure",
    "AaCampaignPlan",
    "build_aa_campaign_plan",
    "discover_task_ids",
    "execute_aa_campaign_plan",
]


@dataclass(frozen=True, order=True)
class AaCampaignAttempt:
    """One immutable suite/task/seed cell in the 978-attempt matrix."""

    suite: str
    task: str
    seed: int
    manifest_path: Path
    task_dir: Path

    @property
    def key(self) -> tuple[str, str, int]:
        return self.suite, self.task, self.seed


@dataclass(frozen=True)
class AaCampaignPlan:
    """Complete campaign schedule plus the cells still requiring execution."""

    attempts: tuple[AaCampaignAttempt, ...]
    pending: tuple[AaCampaignAttempt, ...]
    completed_keys: frozenset[tuple[str, str, int]]


@dataclass(frozen=True)
class AaCampaignFailure:
    """One attempt that produced no record and therefore remains resumable."""

    attempt: AaCampaignAttempt
    error_type: str
    detail: str


@dataclass(frozen=True)
class AaCampaignExecution:
    """Records and explicit failures from one bounded execution pass."""

    records: tuple[RunRecord, ...]
    failures: tuple[AaCampaignFailure, ...]


def discover_task_ids(manifest: BenchmarkManifest, source_root: Path) -> tuple[str, ...]:
    """Read exact task ids from the pinned source and reject count drift."""

    if manifest.task_path is None:
        raise ValueError(f"{manifest.suite_id}: manifest has no task source path")
    tasks_root = source_root / manifest.task_path
    if not tasks_root.is_dir():
        raise ValueError(f"{manifest.suite_id}: task source path does not exist: {tasks_root}")
    tasks = tuple(
        sorted(
            child.name
            for child in tasks_root.iterdir()
            if child.is_dir() and (child / "task.toml").is_file()
        )
    )
    if len(tasks) != manifest.task_count:
        raise ValueError(
            f"{manifest.suite_id}: discovered {len(tasks)} task directories; "
            f"expected {manifest.task_count}"
        )
    return tasks


def build_aa_campaign_plan(
    contract: AaCodingIndexContract,
    *,
    manifest_paths: Mapping[str, Path],
    sources_dir: Path,
    existing_records: Sequence[RunRecord] = (),
    harness: str,
    starting_seed: int = 0,
    admissible_record: Callable[[RunRecord], bool] | None = None,
) -> AaCampaignPlan:
    """Materialize pinned sources and build a deterministic resumable matrix."""

    if starting_seed < 0:
        raise ValueError("starting_seed must be non-negative")
    candidates: dict[tuple[str, str, int], list[RunRecord]] = {}
    for record in existing_records:
        if record.harness != harness:
            continue
        candidates.setdefault((record.suite, record.task, record.random_seed), []).append(record)
    completed = frozenset(
        key
        for key, records in candidates.items()
        if len(records) == 1 and (admissible_record is None or admissible_record(records[0]))
    )
    attempts: list[AaCampaignAttempt] = []
    for component in contract.components:
        manifest_path = manifest_paths.get(component.suite)
        if manifest_path is None:
            raise ValueError(f"no manifest path supplied for suite {component.suite}")
        manifest = load_benchmark_manifest(manifest_path)
        _validate_component_manifest(component, manifest)
        source = materialize_task_source(manifest, sources_dir)
        task_ids = discover_task_ids(manifest, source)
        attempts.extend(
            _component_attempts(
                component,
                task_ids,
                manifest_path=manifest_path,
                source_root=source,
                task_path=manifest.task_path or "",
                attempts_per_task=contract.attempts_per_task,
                starting_seed=starting_seed,
            )
        )
    all_attempts = tuple(attempts)
    pending = tuple(attempt for attempt in all_attempts if attempt.key not in completed)
    return AaCampaignPlan(
        attempts=all_attempts,
        pending=pending,
        completed_keys=completed,
    )


def execute_aa_campaign_plan(
    plan: AaCampaignPlan,
    run_attempt: Callable[[AaCampaignAttempt], RunRecord],
    *,
    concurrency: int,
    on_record: Callable[[RunRecord], None] | None = None,
    on_failure: Callable[[AaCampaignFailure], None] | None = None,
) -> AaCampaignExecution:
    """Execute pending cells concurrently without dropping failed attempts."""

    if concurrency <= 0:
        raise ValueError("concurrency must be positive")
    records: list[RunRecord] = []
    failures: list[AaCampaignFailure] = []
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        pending = {executor.submit(run_attempt, attempt): attempt for attempt in plan.pending}
        for future in as_completed(pending):
            attempt = pending[future]
            try:
                record = future.result()
            except Exception as error:
                failure = AaCampaignFailure(
                    attempt=attempt,
                    error_type=type(error).__name__,
                    detail=str(error)[:2_000],
                )
                failures.append(failure)
                if on_failure is not None:
                    on_failure(failure)
                continue
            if (record.suite, record.task, record.random_seed) != attempt.key:
                failure = AaCampaignFailure(
                    attempt=attempt,
                    error_type="RunIdentityMismatch",
                    detail=(
                        f"runner returned {(record.suite, record.task, record.random_seed)!r} "
                        f"for {attempt.key!r}"
                    ),
                )
                failures.append(failure)
                if on_failure is not None:
                    on_failure(failure)
                continue
            records.append(record)
            if on_record is not None:
                on_record(record)
    return AaCampaignExecution(
        records=tuple(
            sorted(records, key=lambda record: (record.suite, record.task, record.random_seed))
        ),
        failures=tuple(sorted(failures, key=lambda failure: failure.attempt.key)),
    )


def _component_attempts(
    component: AaCodingIndexComponent,
    task_ids: Iterable[str],
    *,
    manifest_path: Path,
    source_root: Path,
    task_path: str,
    attempts_per_task: int,
    starting_seed: int,
) -> Iterable[AaCampaignAttempt]:
    for task in task_ids:
        for offset in range(attempts_per_task):
            yield AaCampaignAttempt(
                suite=component.suite,
                task=task,
                seed=starting_seed + offset,
                manifest_path=manifest_path,
                task_dir=source_root / task_path / task,
            )


def _validate_component_manifest(
    component: AaCodingIndexComponent,
    manifest: BenchmarkManifest,
) -> None:
    if manifest.suite_id != component.suite:
        raise ValueError(
            f"component {component.component_id} expects {component.suite}, "
            f"manifest declares {manifest.suite_id}"
        )
    if manifest.task_count != component.task_count:
        raise ValueError(
            f"component {component.component_id} expects {component.task_count} tasks, "
            f"manifest declares {manifest.task_count}"
        )
