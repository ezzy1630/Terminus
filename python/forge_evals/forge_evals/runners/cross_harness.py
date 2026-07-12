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

import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Protocol

from ..run_record import RunRecord
from .harness_runner import Budgets, Harness, HarnessRunner, ModelCapabilitySnapshot, RunRequest

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


@dataclass(frozen=True)
class TaskSpec:
    """A task to run across all harnesses."""

    suite: str
    task: str
    task_dir: Path


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
        rng = random.Random(plan.rng_seed)
        records: list[RunRecord] = []
        total = plan.total_runs
        completed = 0
        for task in plan.tasks:
            for seed in plan.seeds:
                harnesses = list(plan.harnesses)
                if plan.randomize_harness_order:
                    rng.shuffle(harnesses)
                for hs in harnesses:
                    runner = HarnessRunner(harness=hs.factory)
                    request = RunRequest(
                        suite=task.suite,
                        task=task.task,
                        task_dir=task.task_dir,
                        harness_id=hs.harness_id,
                        harness_commit=hs.harness_commit,
                        model_snapshot=plan.model_snapshot,
                        random_seed=seed,
                        budgets=plan.budgets,
                        experiment_assignments=list(plan.experiment_assignments),
                    )
                    record = runner.run(request)
                    records.append(record)
                    completed += 1
                    self.reporter(completed, total, record)
        return CrossHarnessResult(records=records)


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
