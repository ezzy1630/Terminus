"""Derived paired evidence for model-fixed promotion decisions.

This module turns immutable :class:`RunRecord` pairs into statistical evidence.
It refuses to manufacture a comparison when identity, task, seed, or sample
requirements are missing. The resulting evidence is still experimental until
an independent verifier and the configured release harness attest to it.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from typing import Literal

from .evidence import EvidenceClass, has_complete_provider_receipt
from .run_record import RunRecord
from .statistics.bootstrap import bootstrap_ci
from .statistics.effect_size import cohens_d_paired
from .statistics.noninferiority import NonInferiorityResult, noninferiority_t_test
from .statistics.paired import PairedDelta, PairedSequence, TestResult, paired_t_test

__all__ = [
    "PairIdentityBinding",
    "PairedEvaluationEvidence",
    "PairingIssue",
    "derive_paired_evidence",
]

MetricName = Literal["passed", "primary_score", "duration_seconds", "cost_usd"]


@dataclass(frozen=True)
class PairingIssue:
    """A reason a candidate/baseline pair is not promotion eligible."""

    key: str
    reason: str


@dataclass(frozen=True)
class PairIdentityBinding:
    """Content keys binding one statistical pair to its source records."""

    task: str
    baseline_result_key: str
    candidate_result_key: str
    model_fixed_key: str


@dataclass(frozen=True)
class PairedEvaluationEvidence:
    """Statistical evidence derived from exact model-fixed pairs."""

    baseline_harness: str
    candidate_harness: str
    metric: MetricName
    pairs: tuple[PairedDelta, ...]
    identity_bindings: tuple[PairIdentityBinding, ...]
    mean_delta: float
    ci_low: float
    ci_high: float
    effect_size: float
    effect_size_ci_low: float
    effect_size_ci_high: float
    paired_test: TestResult
    noninferiority: NonInferiorityResult | None
    confidence_level: float
    identity_locked: bool
    eligible: bool
    same_model: bool = False
    live_evidence_complete: bool = False
    holdout_complete: bool = False
    provider_receipts_complete: bool = False
    cohort_complete: bool = False
    issues: tuple[PairingIssue, ...] = field(default_factory=tuple)

    @property
    def n(self) -> int:
        return len(self.pairs)

    @property
    def deltas(self) -> list[float]:
        return [pair.delta for pair in self.pairs]

    def to_dict(self) -> dict[str, object]:
        """Serialize derived evidence without dropping blocking issues."""
        ni = self.noninferiority
        return {
            "baseline_harness": self.baseline_harness,
            "candidate_harness": self.candidate_harness,
            "metric": self.metric,
            "pairs": [
                {
                    "task": pair.task,
                    "baseline": pair.baseline,
                    "candidate": pair.candidate,
                    "delta": pair.delta,
                }
                for pair in self.pairs
            ],
            "identity_bindings": [
                {
                    "task": binding.task,
                    "baseline_result_key": binding.baseline_result_key,
                    "candidate_result_key": binding.candidate_result_key,
                    "model_fixed_key": binding.model_fixed_key,
                }
                for binding in self.identity_bindings
            ],
            "n": self.n,
            "mean_delta": self.mean_delta,
            "ci": [self.ci_low, self.ci_high],
            "effect_size": self.effect_size,
            "effect_size_ci": [self.effect_size_ci_low, self.effect_size_ci_high],
            "paired_test": self.paired_test.to_dict(),
            "confidence_level": self.confidence_level,
            "noninferiority": ni.to_dict() if ni is not None else None,
            "identity_locked": self.identity_locked,
            "same_model": self.same_model,
            "live_evidence_complete": self.live_evidence_complete,
            "holdout_complete": self.holdout_complete,
            "provider_receipts_complete": self.provider_receipts_complete,
            "cohort_complete": self.cohort_complete,
            "eligible": self.eligible,
            "issues": [{"key": issue.key, "reason": issue.reason} for issue in self.issues],
        }


def _metric_value(record: RunRecord, metric: MetricName) -> float:
    if metric == "passed":
        return 1.0 if record.passed else 0.0
    if metric == "primary_score":
        return record.primary_score
    if metric == "duration_seconds":
        return record.duration_seconds
    if record.cost is None:
        raise ValueError(f"run {record.run_id} has no cost for cost_usd metric")
    return record.cost.computed_usd


def _index_records(records: Sequence[RunRecord], side: str) -> tuple[dict[tuple[str, str, int], RunRecord], list[PairingIssue]]:
    indexed: dict[tuple[str, str, int], RunRecord] = {}
    issues: list[PairingIssue] = []
    for record in records:
        key = (record.suite, record.task, record.random_seed)
        if key in indexed:
            issues.append(PairingIssue(
                key=f"{side}:{key}",
                reason="duplicate task/seed record; pairing is ambiguous",
            ))
        else:
            indexed[key] = record
    return indexed, issues


def derive_paired_evidence(
    baseline_records: Sequence[RunRecord],
    candidate_records: Sequence[RunRecord],
    *,
    baseline_harness: str | None = None,
    candidate_harness: str | None = None,
    metric: MetricName = "passed",
    noninferiority_margin: float | None = None,
    confidence_level: float = 0.95,
    min_pairs: int = 2,
    n_bootstrap: int = 2_000,
    rng_seed: int = 0,
    require_live: bool = False,
    require_independent_verification: bool = False,
    required_holdout_partition: str | None = None,
    required_tasks: Collection[str] | None = None,
    required_seeds: Collection[int] | None = None,
    require_provider_receipts: bool = False,
) -> PairedEvaluationEvidence:
    """Derive paired statistics only from exact, identity-locked records.

    The optional provenance arguments are deliberately fail-closed.  Release
    callers should provide the expected task and seed cohort instead of
    treating a shared but incomplete subset as a complete experiment.
    """
    if not 0 < confidence_level < 1:
        raise ValueError("confidence_level must be in (0, 1)")
    if min_pairs <= 0:
        raise ValueError("min_pairs must be positive")
    if n_bootstrap <= 0:
        raise ValueError("n_bootstrap must be positive")
    if baseline_harness is None:
        baseline_harness = baseline_records[0].harness if baseline_records else "unknown"
    if candidate_harness is None:
        candidate_harness = candidate_records[0].harness if candidate_records else "unknown"

    baseline, issues = _index_records(baseline_records, "baseline")
    candidate, candidate_issues = _index_records(candidate_records, "candidate")
    issues.extend(candidate_issues)
    pairs: list[PairedDelta] = []
    identity_bindings: list[PairIdentityBinding] = []
    same_model = True
    live_evidence_complete = require_live or require_independent_verification
    holdout_complete = required_holdout_partition is not None
    provider_receipts_complete = require_provider_receipts

    expected_keys: set[tuple[str, str, int]] | None = None
    if required_tasks is not None or required_seeds is not None:
        if required_tasks is None or required_seeds is None:
            issues.append(PairingIssue("cohort", "required_tasks and required_seeds must be supplied together"))
        else:
            expected_keys = {
                (baseline_records[0].suite if baseline_records else "unknown", task, seed)
                for task in required_tasks
                for seed in required_seeds
            }
            observed_suites = {record.suite for record in (*baseline_records, *candidate_records)}
            if len(observed_suites) != 1:
                issues.append(PairingIssue("cohort", "expected task/seed cohort spans multiple suites"))
            elif expected_keys:
                suite = next(iter(observed_suites))
                expected_keys = {(suite, task, seed) for _, task, seed in expected_keys}

    for key in sorted(set(baseline) & set(candidate)):
        b = baseline[key]
        c = candidate[key]
        pair_key = f"{key[0]}:{key[1]}:seed={key[2]}"
        b_identity = b.evaluation_identity
        c_identity = c.evaluation_identity
        if b_identity is None or c_identity is None:
            issues.append(PairingIssue(pair_key, "both records require locked evaluation identity"))
            continue
        if b_identity.task_id != b.task or c_identity.task_id != c.task:
            issues.append(PairingIssue(pair_key, "identity task id does not match run record"))
            continue
        if b_identity.random_seed != b.random_seed or c_identity.random_seed != c.random_seed:
            issues.append(PairingIssue(pair_key, "identity seed does not match run record"))
            continue
        if b_identity.harness_id != b.harness or c_identity.harness_id != c.harness:
            issues.append(PairingIssue(pair_key, "identity harness id does not match run record"))
            continue
        if not b_identity.is_complete or not c_identity.is_complete:
            issues.append(
                PairingIssue(
                    pair_key,
                    "both records require complete task, policy, tool, and instruction identity",
                )
            )
            continue
        if not b_identity.compatible_model_fixed(c_identity):
            same_model = False
            issues.append(PairingIssue(pair_key, "model-fixed identity differs across harnesses"))
            continue
        if b_identity.provider != c_identity.provider or b_identity.model != c_identity.model:
            same_model = False
            issues.append(PairingIssue(pair_key, "provider/model identity differs across harnesses"))
            continue
        if require_live or require_independent_verification:
            live_ok = (
                b.evidence_class is EvidenceClass.EXTERNAL_LIVE
                and c.evidence_class is EvidenceClass.EXTERNAL_LIVE
            )
            verified_ok = b.independently_verified and c.independently_verified
            if not live_ok or (require_independent_verification and not verified_ok):
                live_evidence_complete = False
                issues.append(PairingIssue(pair_key, "both records require verified external live evidence"))
                continue
        if required_holdout_partition is not None and (
            b.holdout_partition != required_holdout_partition
            or c.holdout_partition != required_holdout_partition
        ):
            holdout_complete = False
            issues.append(PairingIssue(pair_key, "both records require the configured holdout partition"))
            continue
        if require_provider_receipts and (
            not b.provider_receipts
            or not c.provider_receipts
            or any(not has_complete_provider_receipt(r) for r in (*b.provider_receipts, *c.provider_receipts))
        ):
            provider_receipts_complete = False
            issues.append(PairingIssue(pair_key, "both records require complete provider receipts"))
            continue
        if b.end is None or c.end is None:
            issues.append(PairingIssue(pair_key, "both records require terminal end timestamps"))
            continue
        try:
            baseline_value = _metric_value(b, metric)
            candidate_value = _metric_value(c, metric)
        except ValueError as error:
            issues.append(PairingIssue(pair_key, str(error)))
            continue
        pairs.append(PairedDelta(task=pair_key, baseline=baseline_value, candidate=candidate_value))
        identity_bindings.append(PairIdentityBinding(
            task=pair_key,
            baseline_result_key=b_identity.result_key,
            candidate_result_key=c_identity.result_key,
            model_fixed_key=b_identity.model_fixed_key,
        ))

    for key in sorted(set(baseline) - set(candidate)):
        issues.append(PairingIssue(f"baseline:{key}", "candidate record is missing"))
    for key in sorted(set(candidate) - set(baseline)):
        issues.append(PairingIssue(f"candidate:{key}", "baseline record is missing"))

    if expected_keys is not None:
        for key in sorted(expected_keys - (set(baseline) & set(candidate))):
            issues.append(PairingIssue(f"cohort:{key}", "required task/seed pair is missing"))
    cohort_complete = expected_keys is not None and not any(
        issue.key.startswith("cohort:") for issue in issues
    )

    sequence = PairedSequence(deltas=pairs)
    deltas = sequence.values
    mean_delta = sum(deltas) / len(deltas) if deltas else 0.0
    ci_low, ci_high = bootstrap_ci(
        deltas,
        lambda sample: sum(sample) / len(sample) if sample else 0.0,
        confidence_level=confidence_level,
        n_resamples=n_bootstrap,
        rng_seed=rng_seed,
    ) if deltas else (0.0, 0.0)
    effect = cohens_d_paired(deltas).value if deltas else 0.0
    effect_ci_low, effect_ci_high = bootstrap_ci(
        deltas,
        lambda sample: cohens_d_paired(sample).value,
        confidence_level=confidence_level,
        n_resamples=n_bootstrap,
        rng_seed=rng_seed + 1,
    ) if deltas else (0.0, 0.0)
    test = paired_t_test(sequence)
    noninferiority = (
        noninferiority_t_test(deltas, noninferiority_margin)
        if noninferiority_margin is not None and deltas
        else None
    )
    identity_locked = not any(
        token in issue.reason
        for issue in issues
        for token in ("identity", "model-fixed", "provider/model")
    )
    eligible = identity_locked and len(pairs) >= min_pairs and not issues
    return PairedEvaluationEvidence(
        baseline_harness=baseline_harness,
        candidate_harness=candidate_harness,
        metric=metric,
        pairs=tuple(pairs),
        identity_bindings=tuple(identity_bindings),
        mean_delta=mean_delta,
        ci_low=ci_low,
        ci_high=ci_high,
        effect_size=effect,
        effect_size_ci_low=effect_ci_low,
        effect_size_ci_high=effect_ci_high,
        paired_test=test,
        noninferiority=noninferiority,
        confidence_level=confidence_level,
        identity_locked=identity_locked,
        eligible=eligible,
        same_model=same_model,
        live_evidence_complete=live_evidence_complete,
        holdout_complete=holdout_complete,
        provider_receipts_complete=provider_receipts_complete,
        cohort_complete=cohort_complete,
        issues=tuple(issues),
    )
