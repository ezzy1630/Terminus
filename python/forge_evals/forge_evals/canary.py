"""Tier 2 — small live-provider canary with paired baseline/candidate arms.

The canary answers, per PR that touches agent behavior, one question: *under
identical model, effort, task, environment, seed, and budget, does the
candidate behave differently from the baseline — and is the difference an
improvement?*

Five compact tasks cover the archetypes where harness regressions show up
first (read-only diagnosis, single-file edit, multi-file edit, failing-test
repair, repository discovery with incomplete initial context). Success is
decided by each task's deterministic grader (repository state plus tests);
LLM judges may add diagnostics but never appear on the success path.

Paired-ness is enforced structurally:

- both arms are built from the same request (one seed per run, same seed
  across arms) so every identity field except the harness commit matches;
- the model-fixed identity key must match across arms and the harness
  commits must differ (a comparison of identical commits is rejected);
- the report is emitted even when arms disagree in identity — as an
  explicitly ineligible result, never as a silent comparison.

The report is a *diagnostic* artifact: it is directly comparable evidence,
not a promotion decision. Promotion runs through the Tier 3 cohort pipeline
and the promotion gate.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .run_record import RunRecord
from .trajectory_diff import TrajectoryDiff, diff_trajectories

__all__ = [
    "CANARY_TASKS",
    "CANARY_TASK_ROOT",
    "RETRIEVAL_V1_TASKS",
    "CanaryReport",
    "CanaryTaskSpec",
    "canary_report_version",
    "run_canary",
]

CANARY_REPORT_VERSION = "terminus.canary.comparison/v1"
CANARY_TASK_ROOT = Path(__file__).resolve().parents[1] / "evals" / "tasks" / "canary"

# A pair runner receives one canary task spec and the seed, and returns the
# (baseline, candidate) RunRecord pair for exactly that cell. The runner
# owns arm construction (harness, control plane, model pinning); this module
# owns pairing, identity enforcement, and the comparison artifact.
PairRunner = Callable[["CanaryTaskSpec", int], tuple[RunRecord, RunRecord]]


@dataclass(frozen=True)
class CanaryTaskSpec:
    """One task spec: id, archetype, and suite."""

    task_id: str
    archetype: str
    suite: str = "canary"

    @property
    def package_dir(self) -> Path:
        return Path(__file__).resolve().parents[1] / "evals" / "tasks" / self.suite / self.task_id


# The five canary archetypes. Keep the list stable: cohort metrics slice by
# archetype, and the canary's per-PR comparability depends on the set not
# churning.
CANARY_TASKS: tuple[CanaryTaskSpec, ...] = (
    CanaryTaskSpec("diag-001", "read_only_diagnosis"),
    CanaryTaskSpec("edit-single-001", "single_file_edit"),
    CanaryTaskSpec("edit-multi-001", "multi_file_edit"),
    CanaryTaskSpec("test-repair-001", "failing_test_repair"),
    CanaryTaskSpec("repo-discovery-001", "repository_discovery"),
)

RETRIEVAL_V1_TASKS: tuple[CanaryTaskSpec, ...] = (
    CanaryTaskSpec("retrieval-named-01", "named_file_edit", suite="retrieval-v1"),
    CanaryTaskSpec("retrieval-named-02", "named_file_edit", suite="retrieval-v1"),
    CanaryTaskSpec("retrieval-symptom-01", "symptom_discovery", suite="retrieval-v1"),
    CanaryTaskSpec("retrieval-symptom-02", "symptom_bugfix", suite="retrieval-v1"),
    CanaryTaskSpec("retrieval-cross-file-01", "cross_file_reference", suite="retrieval-v1"),
)


@dataclass
class CanaryReport:
    """The paired canary comparison artifact (``terminus.canary.comparison/v1``)."""

    report: str = CANARY_REPORT_VERSION
    baseline_commit: str = ""
    candidate_commit: str = ""
    model_fixed_key: str = ""
    identity_locked: bool = False
    identity_issues: list[str] = field(default_factory=list)
    eligible: bool = False
    tasks: list[dict[str, Any]] = field(default_factory=list)
    aggregate: dict[str, Any] = field(default_factory=dict)
    ineligible_reason: str | None = None
    is_aa_test: bool = False

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form; run records are represented by their ids only."""

        def strip_record(payload: dict[str, Any]) -> dict[str, Any]:
            return {key: value for key, value in payload.items() if key != "record"}

        return {
            "report": self.report,
            "baseline_commit": self.baseline_commit,
            "candidate_commit": self.candidate_commit,
            "is_aa_test": self.is_aa_test,
            "model_fixed_key": self.model_fixed_key,
            "identity_locked": self.identity_locked,
            "identity_issues": list(self.identity_issues),
            "eligible": self.eligible,
            "tasks": [
                {
                    **{key: value for key, value in row.items() if key != "record"},
                    "baseline": strip_record(row["baseline"]),
                    "candidate": strip_record(row["candidate"]),
                }
                for row in self.tasks
            ],
            "aggregate": dict(self.aggregate),
            "ineligible_reason": self.ineligible_reason,
        }


def canary_report_version() -> str:
    """Return the canary report schema version string."""
    return CANARY_REPORT_VERSION


def _identity_issue(baseline: RunRecord, candidate: RunRecord) -> str | None:
    """Why this pair is not a model-fixed comparison, or None."""
    b = baseline.evaluation_identity
    c = candidate.evaluation_identity
    if b is None or c is None:
        return "one side has no evaluation identity"
    if b.model_fixed_key != c.model_fixed_key:
        fields = [
            name
            for name, value in b.to_dict().items()
            if name not in {"harness_id", "harness_commit", "harness_config_hash"}
            and c.to_dict().get(name) != value
        ]
        return f"model-fixed identity mismatch on: {', '.join(sorted(fields))}"
    if not b.is_complete or not c.is_complete:
        return "identity is incomplete (missing: fields are not promotion-eligible)"
    return None


def _side_payload(record: RunRecord) -> dict[str, Any]:
    """One arm of a task row: verdict plus the diff-relevant facts."""
    return {
        "run_id": record.run_id,
        "harness_commit": record.harness_commit,
        "passed": record.success,
        "outcome": record.outcome.value,
        "primary_score": record.primary_score,
        "grader_ids": [g.grader_id for g in record.grader_results],
        # A "false completion" is the harness admitting a completion the
        # graders reject — the canary's most important single signal. A bare
        # disagreement (harness failed, grader passed) is recorded but does
        # not count as one.
        "harness_grader_disagreement": record.harness_grader_disagreement,
        "false_completion": (record.harness_verdict.get("admitted") is True and not record.success),
        "tokens": {
            "input_fresh": record.tokens_input_fresh,
            "input_cached": record.tokens_input_cached,
            "output": record.tokens_output,
            "reasoning": record.tokens_reasoning,
        },
        "wall_clock_ms": record.wall_clock_ms,
        "steps": record.steps,
        "tool_error_rate": record.tool_error_rate,
        "cost_usd": None if record.cost is None else record.cost.computed_usd,
        "record": record,
    }


def _aggregate_task_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate the task rows into per-arm and per-archetype rollups."""
    baseline_passed = sum(1 for row in rows if row["baseline"]["passed"])
    candidate_passed = sum(1 for row in rows if row["candidate"]["passed"])
    false_completions = {
        side: sum(1 for row in rows if row[side]["false_completion"])
        for side in ("baseline", "candidate")
    }
    by_archetype: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = by_archetype.setdefault(
            row["archetype"],
            {"tasks": 0, "baseline_passed": 0, "candidate_passed": 0},
        )
        entry["tasks"] += 1
        entry["baseline_passed"] += 1 if row["baseline"]["passed"] else 0
        entry["candidate_passed"] += 1 if row["candidate"]["passed"] else 0
    cost_by_side: dict[str, float] = {}
    for side in ("baseline", "candidate"):
        total = 0.0
        for row in rows:
            record: RunRecord = row[side]["record"]
            if record.cost is not None:
                total += float(record.cost.computed_usd)
        cost_by_side[side] = total
    return {
        "tasks": len(rows),
        "baseline_resolved": baseline_passed,
        "candidate_resolved": candidate_passed,
        "resolved_delta": candidate_passed - baseline_passed,
        "false_completions": false_completions,
        "by_archetype": by_archetype,
        "cost_usd": cost_by_side,
    }


def run_canary(
    run_task_pair: PairRunner,
    *,
    baseline_commit: str,
    candidate_commit: str,
    seed: int = 42,
    output_dir: Path | str | None = None,
    tasks: tuple[CanaryTaskSpec, ...] = CANARY_TASKS,
    is_aa_test: bool = False,
) -> CanaryReport:
    """Run the canary and produce the paired comparison report.

    ``run_task_pair`` is invoked as ``run_task_pair(task_spec, seed)`` and
    must return the ``(baseline_record, candidate_record)`` pair for that
    cell. Injecting the runner keeps this module testable offline (fixture
    records) and lets the CLI bind it to the live control plane without
    duplicating identity logic.
    """
    report = CanaryReport(
        baseline_commit=baseline_commit,
        candidate_commit=candidate_commit,
        is_aa_test=is_aa_test,
    )
    if baseline_commit == candidate_commit and not is_aa_test:
        report.ineligible_reason = (
            f"baseline and candidate commits are identical ({baseline_commit}); "
            "a canary compares two different harness revisions"
        )
        return report

    for spec in tasks:
        baseline, candidate = run_task_pair(spec, seed)
        issue = _identity_issue(baseline, candidate)
        diff: TrajectoryDiff = diff_trajectories(baseline.to_dict(), candidate.to_dict())
        report.tasks.append(
            {
                "task": spec.task_id,
                "archetype": spec.archetype,
                "seed": seed,
                "identity_locked": issue is None,
                "identity_issue": issue,
                "baseline": _side_payload(baseline),
                "candidate": _side_payload(candidate),
                "trajectory_diff": diff.to_dict(),
                "trajectory_diff_summary": diff.summary_lines(),
            }
        )

    report.identity_issues = sorted(
        {row["identity_issue"] for row in report.tasks if row["identity_issue"]}
    )
    report.model_fixed_key = (
        report.tasks[0]["baseline"]["record"].evaluation_identity.model_fixed_key
        if report.tasks and report.tasks[0]["baseline"]["record"].evaluation_identity is not None
        else ""
    )
    report.identity_locked = not report.identity_issues
    report.eligible = report.identity_locked and bool(report.tasks)
    report.aggregate = _aggregate_task_rows(report.tasks)

    if output_dir is not None:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "canary-report.json").write_text(
            json.dumps(report.to_dict(), indent=2, sort_keys=True), encoding="utf-8"
        )
    return report
