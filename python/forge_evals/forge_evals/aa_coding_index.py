"""Strict Artificial Analysis Coding Agent Index v1.4 campaign scoring.

The public score is easy to imitate badly: average a few successful tasks,
drop missing telemetry, and call the result comparable. This module instead
requires the full model-fixed task-by-attempt matrix and the evidence needed
for each efficiency metric before it evaluates the supplied thresholds.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .evidence import EvidenceClass
from .run_record import RunRecord

__all__ = [
    "AaCodingIndexComponent",
    "AaCodingIndexContract",
    "AaCodingIndexIssue",
    "AaCodingIndexResult",
    "aa_record_issues",
    "evaluate_aa_coding_index",
]

_SCHEMA = "terminus.aa-coding-index-campaign.v1"


@dataclass(frozen=True)
class AaCodingIndexComponent:
    """One equally weighted benchmark component."""

    component_id: str
    suite: str
    task_count: int
    score_must_exceed: float


@dataclass(frozen=True)
class AaCodingIndexContract:
    """Pinned model, scoring rules, baselines, and evidence requirements."""

    methodology_name: str
    methodology_version: str
    attempts_per_task: int
    provider: str
    model: str
    reasoning_effort: str
    components: tuple[AaCodingIndexComponent, ...]
    index_must_exceed: float
    cost_usd_per_task_must_be_below: float
    wall_minutes_per_task_must_be_below: float
    tokens_per_task_must_be_below: int
    require_external_live: bool
    require_independent_verification: bool
    require_provider_receipts: bool
    require_exact_harness_revision: bool
    require_pinned_runner_source: bool
    runner_sources: dict[str, str]
    require_resolved_image_digest: bool
    terminal_bench_reward_hacking_review: bool

    @property
    def expected_attempt_count(self) -> int:
        return sum(component.task_count for component in self.components) * self.attempts_per_task

    @classmethod
    def load(cls, path: Path | str) -> AaCodingIndexContract:
        """Load a campaign contract and reject scoring-rule drift."""

        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        root = _mapping(raw, "campaign")
        if _required_string(root, "schema") != _SCHEMA:
            raise ValueError(f"campaign.schema must be {_SCHEMA!r}")

        methodology = _mapping(root.get("methodology"), "methodology")
        if _required_string(methodology, "task_weighting") != "equal_within_component":
            raise ValueError("methodology.task_weighting must be equal_within_component")
        if _required_string(methodology, "component_weighting") != "equal":
            raise ValueError("methodology.component_weighting must be equal")

        model = _mapping(root.get("model"), "model")
        efficiency = _mapping(root.get("efficiency"), "efficiency")
        integrity = _mapping(root.get("integrity"), "integrity")
        component_rows = root.get("components")
        if not isinstance(component_rows, list) or not component_rows:
            raise ValueError("components must be a non-empty list")
        components = tuple(_component(row) for row in component_rows)
        if len({component.component_id for component in components}) != len(components):
            raise ValueError("component ids must be unique")
        if len({component.suite for component in components}) != len(components):
            raise ValueError("component suite ids must be unique")
        require_pinned_runner_source = _boolean(integrity, "require_pinned_runner_source")
        runner_sources = _runner_sources(
            integrity,
            required_suites={component.suite for component in components}
            if require_pinned_runner_source
            else set(),
        )

        return cls(
            methodology_name=_required_string(methodology, "name"),
            methodology_version=_required_string(methodology, "version"),
            attempts_per_task=_positive_int(methodology, "attempts_per_task"),
            provider=_required_string(model, "provider"),
            model=_required_string(model, "id"),
            reasoning_effort=_required_string(model, "reasoning_effort"),
            components=components,
            index_must_exceed=_number(root, "index_must_exceed"),
            cost_usd_per_task_must_be_below=_number(efficiency, "cost_usd_per_task_must_be_below"),
            wall_minutes_per_task_must_be_below=_number(
                efficiency, "wall_minutes_per_task_must_be_below"
            ),
            tokens_per_task_must_be_below=_positive_int(
                efficiency, "tokens_per_task_must_be_below"
            ),
            require_external_live=_boolean(integrity, "require_external_live"),
            require_independent_verification=_boolean(
                integrity, "require_independent_verification"
            ),
            require_provider_receipts=_boolean(integrity, "require_provider_receipts"),
            require_exact_harness_revision=_boolean(integrity, "require_exact_harness_revision"),
            require_pinned_runner_source=require_pinned_runner_source,
            runner_sources=runner_sources,
            require_resolved_image_digest=_boolean(integrity, "require_resolved_image_digest"),
            terminal_bench_reward_hacking_review=_boolean(
                integrity, "terminal_bench_reward_hacking_review"
            ),
        )


@dataclass(frozen=True)
class AaCodingIndexIssue:
    """One reason a campaign is incomplete, incomparable, or below target."""

    key: str
    detail: str


@dataclass(frozen=True)
class AaCodingIndexResult:
    """Campaign scores and the evidence gate that produced them."""

    harness: str
    record_count: int
    expected_record_count: int
    component_scores: dict[str, float]
    index_score: float | None
    cost_usd_per_task: float | None
    wall_minutes_per_task: float | None
    tokens_per_task: float | None
    eligible: bool
    passed: bool
    issues: tuple[AaCodingIndexIssue, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "terminus.aa-coding-index-result.v1",
            "harness": self.harness,
            "record_count": self.record_count,
            "expected_record_count": self.expected_record_count,
            "component_scores": self.component_scores,
            "index_score": self.index_score,
            "cost_usd_per_task": self.cost_usd_per_task,
            "wall_minutes_per_task": self.wall_minutes_per_task,
            "tokens_per_task": self.tokens_per_task,
            "eligible": self.eligible,
            "passed": self.passed,
            "issues": [{"key": issue.key, "detail": issue.detail} for issue in self.issues],
        }


def evaluate_aa_coding_index(
    records: Sequence[RunRecord],
    contract: AaCodingIndexContract,
    harness: str,
) -> AaCodingIndexResult:
    """Score one harness only when the full comparable campaign is present."""

    suite_to_component = {component.suite: component for component in contract.components}
    selected = [
        record
        for record in records
        if record.harness == harness and record.suite in suite_to_component
    ]
    issues: list[AaCodingIndexIssue] = []

    keyed = Counter((record.suite, record.task, record.random_seed) for record in selected)
    for key, count in sorted(keyed.items()):
        if count > 1:
            issues.append(
                AaCodingIndexIssue(
                    "duplicate_attempt",
                    f"{key[0]}/{key[1]} seed {key[2]} appears {count} times",
                )
            )

    by_suite_task: dict[str, dict[str, list[RunRecord]]] = defaultdict(lambda: defaultdict(list))
    for record in selected:
        by_suite_task[record.suite][record.task].append(record)
        _check_record_identity(record, contract, issues)
        _check_record_integrity(record, contract, issues)

    component_scores: dict[str, float] = {}
    for component in contract.components:
        tasks = by_suite_task.get(component.suite, {})
        if len(tasks) != component.task_count:
            issues.append(
                AaCodingIndexIssue(
                    "task_count",
                    f"{component.component_id} has {len(tasks)} tasks; expected {component.task_count}",
                )
            )
        task_scores: list[float] = []
        for task, attempts in sorted(tasks.items()):
            unique_seeds = {record.random_seed for record in attempts}
            if len(attempts) != contract.attempts_per_task or len(unique_seeds) != len(attempts):
                issues.append(
                    AaCodingIndexIssue(
                        "attempt_count",
                        f"{component.component_id}/{task} has {len(attempts)} attempts and "
                        f"{len(unique_seeds)} unique seeds; expected {contract.attempts_per_task}",
                    )
                )
            if attempts:
                task_scores.append(
                    sum(1.0 if record.success else 0.0 for record in attempts) / len(attempts)
                )
        if task_scores:
            component_scores[component.component_id] = round(
                100.0 * sum(task_scores) / len(task_scores), 8
            )

    index_score = (
        round(sum(component_scores.values()) / len(contract.components), 8)
        if len(component_scores) == len(contract.components)
        else None
    )
    cost = _complete_average(
        selected,
        "cost_telemetry",
        lambda record: record.cost.computed_usd if record.cost is not None else None,
        issues,
    )
    wall_minutes = _complete_average(
        selected,
        "wall_time_telemetry",
        lambda record: (
            record.wall_clock_ms / 60_000.0 if record.wall_clock_ms is not None else None
        ),
        issues,
    )
    tokens = _complete_average(
        selected,
        "token_telemetry",
        _non_overlapping_openai_tokens,
        issues,
    )

    evidence_issue_keys = {
        "duplicate_attempt",
        "task_count",
        "attempt_count",
        "model_identity",
        "evidence_class",
        "independent_verification",
        "provider_receipt",
        "harness_revision",
        "runner_source",
        "resolved_image_digest",
        "reward_hacking_review",
        "cost_telemetry",
        "wall_time_telemetry",
        "token_telemetry",
    }
    eligible = len(selected) == contract.expected_attempt_count and not any(
        issue.key in evidence_issue_keys for issue in issues
    )

    thresholds_passed = index_score is not None
    for component in contract.components:
        score = component_scores.get(component.component_id)
        if score is None or score <= component.score_must_exceed:
            thresholds_passed = False
            issues.append(
                AaCodingIndexIssue(
                    "component_target",
                    f"{component.component_id} score {score!r} must exceed "
                    f"{component.score_must_exceed}",
                )
            )
    if index_score is None or index_score <= contract.index_must_exceed:
        thresholds_passed = False
        issues.append(
            AaCodingIndexIssue(
                "index_target",
                f"index score {index_score!r} must exceed {contract.index_must_exceed}",
            )
        )
    for metric_key, value, limit in (
        ("cost_target", cost, contract.cost_usd_per_task_must_be_below),
        ("wall_time_target", wall_minutes, contract.wall_minutes_per_task_must_be_below),
        ("token_target", tokens, float(contract.tokens_per_task_must_be_below)),
    ):
        if value is None or value >= limit:
            thresholds_passed = False
            issues.append(AaCodingIndexIssue(metric_key, f"value {value!r} must be below {limit}"))

    return AaCodingIndexResult(
        harness=harness,
        record_count=len(selected),
        expected_record_count=contract.expected_attempt_count,
        component_scores=component_scores,
        index_score=index_score,
        cost_usd_per_task=cost,
        wall_minutes_per_task=wall_minutes,
        tokens_per_task=tokens,
        eligible=eligible,
        passed=eligible and thresholds_passed,
        issues=tuple(issues),
    )


def _check_record_identity(
    record: RunRecord,
    contract: AaCodingIndexContract,
    issues: list[AaCodingIndexIssue],
) -> None:
    snapshot = record.model_capability_snapshot
    actual = (
        str(snapshot.get("provider") or ""),
        str(snapshot.get("model") or ""),
        str(snapshot.get("reasoning_effort") or ""),
    )
    expected = (contract.provider, contract.model, contract.reasoning_effort)
    if actual != expected:
        issues.append(
            AaCodingIndexIssue(
                "model_identity",
                f"{record.run_id} resolved {actual!r}; expected {expected!r}",
            )
        )


def aa_record_issues(
    record: RunRecord,
    contract: AaCodingIndexContract,
) -> tuple[AaCodingIndexIssue, ...]:
    """Return per-attempt defects that make a record unsafe to resume."""
    issues: list[AaCodingIndexIssue] = []
    _check_record_identity(record, contract, issues)
    _check_record_integrity(record, contract, issues)
    if record.cost is None:
        issues.append(AaCodingIndexIssue("cost_telemetry", f"{record.run_id} has no cost"))
    if record.wall_clock_ms is None:
        issues.append(
            AaCodingIndexIssue("wall_time_telemetry", f"{record.run_id} has no wall time")
        )
    if _non_overlapping_openai_tokens(record) is None:
        issues.append(AaCodingIndexIssue("token_telemetry", f"{record.run_id} has no token usage"))
    return tuple(issues)


def _check_record_integrity(
    record: RunRecord,
    contract: AaCodingIndexContract,
    issues: list[AaCodingIndexIssue],
) -> None:
    if (
        contract.require_exact_harness_revision
        and re.fullmatch(r"(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})", record.harness_commit) is None
    ):
        issues.append(
            AaCodingIndexIssue(
                "harness_revision",
                f"{record.run_id} has no exact harness revision",
            )
        )
    runner_source = record.model_capability_snapshot.get("runner_source")
    if contract.require_pinned_runner_source:
        expected_runner_source = contract.runner_sources.get(record.suite)
        if runner_source != expected_runner_source:
            issues.append(
                AaCodingIndexIssue(
                    "runner_source",
                    f"{record.run_id} used runner source {runner_source!r}; expected "
                    f"{expected_runner_source!r}",
                )
            )
    if contract.require_external_live and record.evidence_class is not EvidenceClass.EXTERNAL_LIVE:
        issues.append(AaCodingIndexIssue("evidence_class", f"{record.run_id} is not external_live"))
    if contract.require_independent_verification and not record.independently_verified:
        issues.append(
            AaCodingIndexIssue(
                "independent_verification", f"{record.run_id} is not independently verified"
            )
        )
    if contract.require_provider_receipts and not record.provider_receipts:
        issues.append(AaCodingIndexIssue("provider_receipt", f"{record.run_id} has no receipt"))
    if contract.require_resolved_image_digest and not any(
        artifact.get("kind") == "resolved_image_digest"
        and artifact.get("status") == "resolved"
        and isinstance(artifact.get("digest"), str)
        and str(artifact["digest"]).startswith("sha256:")
        and len(str(artifact["digest"])) == 71
        for artifact in record.artifacts
    ):
        issues.append(
            AaCodingIndexIssue(
                "resolved_image_digest",
                f"{record.run_id} has no resolved task image digest",
            )
        )
    if (
        contract.terminal_bench_reward_hacking_review
        and record.suite == "terminal-bench"
        and record.success
        and not _has_admitted_reward_hacking_review(record)
    ):
        issues.append(
            AaCodingIndexIssue(
                "reward_hacking_review",
                f"{record.run_id} passed the verifier without a non-hacking review",
            )
        )


def _has_admitted_reward_hacking_review(record: RunRecord) -> bool:
    exact_digest = re.compile(r"sha256:[0-9a-f]{64}")
    if not any(
        artifact.get("kind") == "terminus_trajectory"
        and artifact.get("status") == "resolved"
        and artifact.get("complete") is True
        and isinstance(artifact.get("digest"), str)
        and exact_digest.fullmatch(str(artifact["digest"])) is not None
        for artifact in record.artifacts
    ):
        return False
    for grader in record.grader_results:
        metadata = grader.metadata
        if metadata.get("reward_hacking_review") != "not_hacked":
            continue
        verifier = metadata.get("reward_hacking_review_verifier")
        review_method = metadata.get("reward_hacking_review_method")
        judge_agent = metadata.get("reward_hacking_review_judge_agent")
        judge_model = metadata.get("reward_hacking_review_judge_model")
        review_runner_source = metadata.get("reward_hacking_review_runner_source")
        rubric_digest = metadata.get("reward_hacking_review_rubric_digest")
        attestation_digest = metadata.get("reward_hacking_review_attestation_digest")
        analysis_artifact = metadata.get("reward_hacking_review_analysis_artifact")
        analysis_digest = metadata.get("reward_hacking_review_analysis_digest")
        record_digest = metadata.get("reward_hacking_review_record_digest")
        if (
            not isinstance(verifier, str)
            or verifier.lower() in {"self", "terminus", "terminus-eval", "terminus-live"}
            or review_method != "harbor_analyze"
            or judge_agent != "claude-code"
            or judge_model != "claude-sonnet-5"
            or review_runner_source != record.model_capability_snapshot.get("runner_source")
            or not isinstance(analysis_artifact, str)
            or not analysis_artifact.strip()
            or not all(
                isinstance(value, str) and exact_digest.fullmatch(value) is not None
                for value in (
                    attestation_digest,
                    rubric_digest,
                    analysis_digest,
                    record_digest,
                )
            )
        ):
            continue
        if any(
            artifact.get("kind") == "reward_hacking_review_attestation"
            and artifact.get("status") == "not_hacked"
            and artifact.get("verifier") == verifier
            and artifact.get("digest") == attestation_digest
            and artifact.get("record_digest") == record_digest
            and artifact.get("review_method") == review_method
            and artifact.get("judge_agent") == judge_agent
            and artifact.get("judge_model") == judge_model
            and artifact.get("runner_source") == review_runner_source
            and artifact.get("rubric_digest") == rubric_digest
            and artifact.get("analysis_artifact") == analysis_artifact
            and artifact.get("analysis_digest") == analysis_digest
            for artifact in record.artifacts
        ):
            return True
    return False


def _non_overlapping_openai_tokens(record: RunRecord) -> float | None:
    """Normalize OpenAI usage without double-counting cache or reasoning.

    Terminus stores fresh and cached input as disjoint fields. OpenAI reports
    reasoning inside output token accounting, so adding ``tokens_reasoning``
    again would inflate the metric. A zero total is treated as missing live
    telemetry, not as a free task.
    """

    total = record.tokens_input_fresh + record.tokens_input_cached + record.tokens_output
    return float(total) if total > 0 else None


def _complete_average(
    records: Sequence[RunRecord],
    issue_key: str,
    value: Any,
    issues: list[AaCodingIndexIssue],
) -> float | None:
    values: list[float] = []
    missing: list[str] = []
    for record in records:
        resolved = value(record)
        if resolved is None:
            missing.append(record.run_id)
        else:
            values.append(float(resolved))
    if missing or not records:
        issues.append(
            AaCodingIndexIssue(
                issue_key,
                f"missing for {len(missing)} of {len(records)} records",
            )
        )
        return None
    return round(sum(values) / len(values), 8)


def _component(raw: object) -> AaCodingIndexComponent:
    row = _mapping(raw, "component")
    return AaCodingIndexComponent(
        component_id=_required_string(row, "id"),
        suite=_required_string(row, "suite"),
        task_count=_positive_int(row, "task_count"),
        score_must_exceed=_number(row, "score_must_exceed"),
    )


def _runner_sources(
    integrity: Mapping[str, object],
    *,
    required_suites: set[str],
) -> dict[str, str]:
    raw = integrity.get("runner_sources", {})
    rows = _mapping(raw, "integrity.runner_sources")
    sources: dict[str, str] = {}
    for suite, value in rows.items():
        if not isinstance(suite, str) or not suite.strip():
            raise ValueError("integrity.runner_sources keys must be suite ids")
        if (
            not isinstance(value, str)
            or re.fullmatch(r"git\+https://.+\.git@[0-9a-f]{40}", value) is None
        ):
            raise ValueError(f"integrity.runner_sources.{suite} must pin one HTTPS Git commit")
        sources[suite] = value
    missing = required_suites - sources.keys()
    extra = sources.keys() - required_suites if required_suites else set()
    if missing:
        raise ValueError(
            "integrity.runner_sources is missing suites: " + ", ".join(sorted(missing))
        )
    if required_suites and extra:
        raise ValueError("integrity.runner_sources has unknown suites: " + ", ".join(sorted(extra)))
    return sources


def _mapping(value: object, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be a mapping")
    return value


def _required_string(row: Mapping[str, object], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value.strip()


def _positive_int(row: Mapping[str, object], key: str) -> int:
    value = row.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _number(row: Mapping[str, object], key: str) -> float:
    value = row.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{key} must be a number")
    return float(value)


def _boolean(row: Mapping[str, object], key: str) -> bool:
    value = row.get(key)
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be a boolean")
    return value
