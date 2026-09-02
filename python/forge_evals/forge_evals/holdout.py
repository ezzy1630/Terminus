"""Held-out partition registry and enforcement.

The causal comparison is only as good as its partitions: a candidate tuned
against the tasks it is evaluated on has not proven anything. This module
is the single source of truth for which (suite, cohort, task) cells are

- ``dev``     — development tasks. Any run may touch them; results are
               diagnostics only.
- ``holdout`` — held out. Live evaluation is permitted on a schedule, but a
               promotion decision may read holdout results only for the
               pre-registered comparison, and candidates may never be tuned
               against them (enforced structurally: tuning reads dev
               partitions).
- ``blocked`` — reserved or contaminated cells. Evaluation must refuse to
               run them; a blocked cell in a run set fails the comparison
               closed.

The registry lives in ``evals/holdout-partitions.yaml`` so partitions can be
audited and changed like any other contract, with the change requiring a
registry commit — not a note in a run directory.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

import yaml

from .run_record import RunRecord

__all__ = [
    "Partition",
    "PartitionError",
    "PartitionRegistry",
    "load_partition_registry",
]


def _resolve_default_registry() -> Path:
    candidates = [
        Path(os.environ["TERMINUS_ROOT"]) / "evals" / "holdout-partitions.yaml" if "TERMINUS_ROOT" in os.environ else None,
        Path.cwd() / "evals" / "holdout-partitions.yaml",
        Path(__file__).resolve().parents[3] / "evals" / "holdout-partitions.yaml",
    ]
    for c in candidates:
        if c is not None and c.is_file():
            return c
    return Path(__file__).resolve().parents[3] / "evals" / "holdout-partitions.yaml"


_DEFAULT_REGISTRY = _resolve_default_registry()


class PartitionError(RuntimeError):
    """A run set violates the partition registry."""


class Partition(StrEnum):
    """Partition classes (see module docstring)."""

    DEV = "dev"
    HOLDOUT = "holdout"
    BLOCKED = "blocked"


@dataclass(frozen=True)
class PartitionRule:
    """One registry entry: a cell selector plus its partition class."""

    suite: str
    cohort: str | None
    task: str | None
    partition: Partition
    note: str = ""

    def matches(self, suite: str, task: str) -> bool:
        """Whether this rule selects the given cell.

        A rule with a ``task`` matches only that task; a rule with only a
        ``cohort`` matches every task in the cohort (the caller resolves the
        task's cohort from its suite manifest; the registry keeps the
        cohort for documentation and defaults). Rules are matched
        most-specific-first by the registry.
        """
        if self.suite != suite:
            return False
        return self.task is None or self.task == task


class PartitionRegistry:
    """The loaded partition registry with lookup and enforcement."""

    def __init__(self, rules: list[PartitionRule]) -> None:
        self._rules = rules

    @property
    def rules(self) -> list[PartitionRule]:
        return list(self._rules)

    def partition_for(self, suite: str, task: str) -> Partition:
        """The partition class for one (suite, task) cell.

        Most-specific rule wins (task rule over suite-wide rule). Cells no
        rule names default to ``dev`` — explicit, not implicit, holding out.
        """
        task_rule = next(
            (rule for rule in self._rules if rule.task == task and rule.suite == suite),
            None,
        )
        if task_rule is not None:
            return task_rule.partition
        suite_rule = next(
            (rule for rule in self._rules if rule.suite == suite and rule.task is None),
            None,
        )
        if suite_rule is not None:
            return suite_rule.partition
        return Partition.DEV

    def unknown_rules(self, suites: set[str]) -> list[str]:
        """Registry rules naming suites the caller does not know."""
        return [
            f"{rule.suite}/{rule.task or '*'}: suite not in run set"
            for rule in self._rules
            if rule.suite not in suites
        ]

    def enforcement_issues(self, records: list[RunRecord]) -> list[str]:
        """Partition violations in a run set, fail-closed.

        - ``blocked`` cells must not appear at all.
        - ``holdout`` cells must carry their partition label on the record
          (the runner stamps it) so downstream consumers cannot mistake a
          holdout run for a dev run.
        """
        issues: list[str] = []
        for record in records:
            partition = self.partition_for(record.suite, record.task)
            if partition is Partition.BLOCKED:
                issues.append(f"{record.run_id}: {record.suite}/{record.task} is a blocked cell")
            elif (
                partition is Partition.HOLDOUT
                and record.holdout_partition != Partition.HOLDOUT.value
            ):
                issues.append(
                    f"{record.run_id}: {record.suite}/{record.task} is a holdout cell "
                    f"but the record is not stamped holdout_partition={Partition.HOLDOUT.value!r}"
                )
        return issues


def load_partition_registry(
    path: Path | str | None = None,
) -> PartitionRegistry:
    """Load ``evals/holdout-partitions.yaml`` (or an explicit path)."""
    registry_path = Path(path) if path is not None else _DEFAULT_REGISTRY
    if not registry_path.is_file():
        # An absent registry is a configuration error: partitioning is part
        # of the contract, not an optional nicety.
        raise PartitionError(
            f"partition registry not found: {registry_path} — partitions are "
            "required for any baseline/candidate comparison"
        )
    raw = yaml.safe_load(registry_path.read_text(encoding="utf-8")) or {}
    partitions = raw.get("partitions")
    if not isinstance(partitions, list) or len(partitions) == 0:
        raise PartitionError(
            f"partition registry {registry_path} has missing or empty 'partitions' list"
        )
    rules: list[PartitionRule] = []
    for entry in partitions:
        if not isinstance(entry, dict):
            continue
        partition = Partition(str(entry.get("partition", Partition.DEV.value)))
        rules.append(
            PartitionRule(
                suite=str(entry.get("suite", "")),
                cohort=entry.get("cohort"),
                task=entry.get("task"),
                partition=partition,
                note=str(entry.get("note", "")),
            )
        )
    return PartitionRegistry(rules)


def registry_to_dict(registry: PartitionRegistry) -> dict[str, Any]:
    """JSON-safe projection (used by the comparison report)."""
    return {
        "partitions": [
            {
                "suite": rule.suite,
                "cohort": rule.cohort,
                "task": rule.task,
                "partition": rule.partition.value,
                "note": rule.note,
            }
            for rule in registry.rules
        ]
    }
