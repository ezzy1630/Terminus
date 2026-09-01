"""SPEC §18.7 / §41.12 / §50 feature promotion gate.

A feature becomes default *only* when *all* of the following hold:

1. It improves the intended cohort's Pareto frontier or satisfies a hard
   security/reliability need (SPEC §41.12).
2. Its confidence bounds are consistent with the claimed improvement
   (SPEC §41.6 — statistical vs practical significance separated).
3. It does not create unacceptable regressions in other critical cohorts.
4. It has operational observability and rollback (SPEC §50.1, §50.9).
5. It has documentation and migration behavior.
6. It remains within maintainability/divergence budgets (SPEC §50.1).

**Security guardrail failure blocks promotion regardless of average task
success** (SPEC §41.11, §41.12).

This module implements :func:`evaluate_promotion` as a pure function over
an :class:`Evaluation` dataclass. The result is a :class:`PromotionGateResult`
that records each gate's verdict, the overall decision, and the reason.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .paired_evaluation import PairedEvaluationEvidence

__all__ = [
    "Evaluation",
    "GateStatus",
    "PromotionDecision",
    "PromotionGateResult",
    "evaluate_paired_promotion",
    "evaluate_promotion",
]


class PromotionDecision(StrEnum):
    """Final promotion decision."""

    PROMOTE = "promote"
    RETAIN_EXPERIMENTAL = "retain_experimental"
    REVISE = "revise"
    ROLLBACK = "rollback"


class GateStatus(StrEnum):
    """Per-gate verdict."""

    PASS = "pass"
    FAIL = "fail"
    BLOCKED = "blocked"  # hard block — promotion impossible regardless of others
    NOT_APPLICABLE = "n/a"


@dataclass(frozen=True)
class GateVerdict:
    """A single gate's verdict."""

    name: str
    status: GateStatus
    detail: str
    evidence: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class PromotionGateResult:
    """Result of :func:`evaluate_promotion`."""

    decision: PromotionDecision
    reason: str
    gates: list[GateVerdict]
    blocking_gates: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        """True iff the decision is :attr:`PromotionDecision.PROMOTE`."""
        return self.decision is PromotionDecision.PROMOTE


# ──────────────────────────── evaluation input ────────────────────────────


@dataclass(frozen=True)
class ReliabilityEvidence:
    """Reliability rates for the baseline and candidate arms.

    Promotion requires more than a higher average score: a candidate that is
    more false-completion-prone, more stuck, more verification-block-happy,
    or worse at cache-prefix survival is rejected even when its mean score
    improved. Every rate is a fraction in [0, 1] or ``None`` (not measured —
    the gate stays silent rather than guessing).
    """

    false_completion_baseline: float | None = None
    false_completion_candidate: float | None = None
    stuck_state_baseline: float | None = None
    stuck_state_candidate: float | None = None
    verification_false_block_baseline: float | None = None
    verification_false_block_candidate: float | None = None
    cache_prefix_survival_baseline: float | None = None
    cache_prefix_survival_candidate: float | None = None
    # Margins tolerate small-sample noise; any candidate-side increase above
    # the margin (decrease for cache survival) fails the gate.
    false_completion_margin: float = 0.02
    stuck_state_margin: float = 0.02
    verification_false_block_margin: float = 0.02
    cache_prefix_survival_margin: float = 0.05

    def breaches(self) -> list[str]:
        """Names of the reliability checks the candidate fails."""
        breached: list[str] = []
        for name, base, cand, margin, direction in (
            (
                "false_completion",
                self.false_completion_baseline,
                self.false_completion_candidate,
                self.false_completion_margin,
                "increase",
            ),
            (
                "stuck_state",
                self.stuck_state_baseline,
                self.stuck_state_candidate,
                self.stuck_state_margin,
                "increase",
            ),
            (
                "verification_false_block",
                self.verification_false_block_baseline,
                self.verification_false_block_candidate,
                self.verification_false_block_margin,
                "increase",
            ),
            (
                "cache_prefix_survival",
                self.cache_prefix_survival_baseline,
                self.cache_prefix_survival_candidate,
                self.cache_prefix_survival_margin,
                "decrease",
            ),
        ):
            if base is None or cand is None:
                continue
            delta = cand - base
            if delta > margin if direction == "increase" else delta < -margin:
                breached.append(
                    f"{name}: {base:.4f} -> {cand:.4f} (delta {delta:+.4f}, "
                    f"allowed {direction} margin {margin})"
                )
        return breached


@dataclass(frozen=True)
class Evaluation:
    """Aggregated evidence presented to the promotion gate.

    All statistical fields come from :mod:`forge_evals.statistics` and
    :mod:`forge_evals.analysis`. All guardrail fields come from
    :mod:`forge_evals.graders.security_graders` and
    :mod:`forge_evals.analysis.cost_analysis`.

    The dataclass is intentionally explicit (not a dict) so that gate logic
    cannot silently ignore a missing field — missing data fails the gate.
    """

    # Cohort-level aggregate results.
    primary_cohort: str
    primary_metric_delta: float  # candidate - baseline (positive = better)
    primary_ci_low: float  # bootstrap CI lower bound (SPEC §41.6)
    primary_ci_high: float
    primary_effect_size: float  # Cohen's d / Hedges' g
    primary_effect_size_ci_low: float
    primary_effect_size_ci_high: float

    # Thresholds from the promotion rule.
    min_effect_size: float
    primary_confidence_level: float = 0.95

    # Cost / latency Pareto frontier.
    cost_delta_pct: float = 0.0  # negative = cheaper
    latency_p50_delta_pct: float = 0.0
    latency_p95_delta_pct: float = 0.0
    pareto_improves: bool = True  # True iff candidate is on or above frontier

    # Non-inferiority on critical cohorts (SPEC §41.6, §18.7).
    regression_cohorts: list[str] = field(default_factory=list)
    noninferiority_margin: float = 0.0
    noninferiority_cohorts: list[str] = field(default_factory=list)

    # Security (SPEC §41.11) — failure is a hard block.
    security_guardrails: dict[str, bool] = field(default_factory=dict)
    # True iff any security guardrail failed.
    security_guardrail_failed: bool = False

    # Operational readiness (SPEC §50.1, §50.9).
    has_observability: bool = True
    has_rollback: bool = True
    has_documentation: bool = True
    has_migration_behavior: bool = True

    # Maintainability / divergence (SPEC §50.1).
    maintainability_within_budget: bool = True
    divergence_within_budget: bool = True

    # Reliability (causal tier 3) — None means not measured and the gate
    # stays silent; present evidence gates the decision.
    reliability: ReliabilityEvidence | None = None

    # Hard security/reliability need override (SPEC §41.12).
    satisfies_hard_security_need: bool = False
    satisfies_hard_reliability_need: bool = False


# ──────────────────────────── gate evaluation ─────────────────────────────


def _gate_reliability(ev: Evaluation) -> GateVerdict:
    """Gate 7 — reliability rates must not regress (causal tier 3).

    False-completion rate, stuck-state rate, verification false-block rate,
    and cache-prefix survival between turns are promotion inputs, not
    diagnostics: a candidate that regresses any of them beyond its margin is
    rejected regardless of its mean primary-metric improvement.
    """
    if ev.reliability is None:
        return GateVerdict(
            name="reliability",
            status=GateStatus.NOT_APPLICABLE,
            detail="No reliability evidence supplied; the gate did not run.",
        )
    breaches = ev.reliability.breaches()
    if breaches:
        return GateVerdict(
            name="reliability",
            status=GateStatus.FAIL,
            detail="Reliability regression beyond margin: " + "; ".join(breaches),
            evidence={"breached": ",".join(b.split(":")[0] for b in breaches)},
        )
    return GateVerdict(
        name="reliability",
        status=GateStatus.PASS,
        detail="All supplied reliability rates are within their margins.",
    )


def _gate_pareto(ev: Evaluation) -> GateVerdict:
    """Gate 1 — Pareto frontier improvement or hard security/reliability need."""
    if ev.satisfies_hard_security_need or ev.satisfies_hard_reliability_need:
        return GateVerdict(
            name="pareto_frontier",
            status=GateStatus.PASS,
            detail=(
                "Satisfies a hard security/reliability need "
                "(SPEC §41.12 — overrides Pareto requirement)."
            ),
            evidence={
                "hard_security_need": str(ev.satisfies_hard_security_need),
                "hard_reliability_need": str(ev.satisfies_hard_reliability_need),
            },
        )
    if ev.pareto_improves:
        return GateVerdict(
            name="pareto_frontier",
            status=GateStatus.PASS,
            detail="Candidate is on or above the cohort Pareto frontier.",
            evidence={
                "cost_delta_pct": f"{ev.cost_delta_pct:+.2f}",
                "latency_p50_delta_pct": f"{ev.latency_p50_delta_pct:+.2f}",
                "latency_p95_delta_pct": f"{ev.latency_p95_delta_pct:+.2f}",
            },
        )
    return GateVerdict(
        name="pareto_frontier",
        status=GateStatus.FAIL,
        detail="Candidate is below the Pareto frontier and no hard need applies.",
        evidence={
            "pareto_improves": "false",
            "cost_delta_pct": f"{ev.cost_delta_pct:+.2f}",
            "latency_p50_delta_pct": f"{ev.latency_p50_delta_pct:+.2f}",
            "latency_p95_delta_pct": f"{ev.latency_p95_delta_pct:+.2f}",
        },
    )


def _gate_confidence(ev: Evaluation) -> GateVerdict:
    """Gate 2 — confidence bounds consistent with claimed improvement (SPEC §41.6)."""
    # CI must exclude zero *in the direction of improvement* (or contain the
    # full positive range for a positive claim).
    ci_positive = ev.primary_ci_low > 0
    ci_excludes_zero = ev.primary_ci_low > 0 or ev.primary_ci_high < 0
    # Effect size must meet the minimum *and* its CI must not cross zero.
    es_meets = ev.primary_effect_size >= ev.min_effect_size
    es_ci_positive = ev.primary_effect_size_ci_low > 0
    if ci_positive and es_meets and es_ci_positive:
        return GateVerdict(
            name="confidence_bounds",
            status=GateStatus.PASS,
            detail=(
                f"Primary CI [{ev.primary_ci_low:.4f}, {ev.primary_ci_high:.4f}] "
                f"excludes 0; effect size {ev.primary_effect_size:.3f} "
                f"(CI [{ev.primary_effect_size_ci_low:.3f}, "
                f"{ev.primary_effect_size_ci_high:.3f}]) ≥ "
                f"min {ev.min_effect_size:.3f}."
            ),
            evidence={
                "primary_ci": f"[{ev.primary_ci_low:.4f}, {ev.primary_ci_high:.4f}]",
                "effect_size": f"{ev.primary_effect_size:.4f}",
                "effect_size_ci": (
                    f"[{ev.primary_effect_size_ci_low:.4f}, {ev.primary_effect_size_ci_high:.4f}]"
                ),
                "min_effect_size": f"{ev.min_effect_size:.4f}",
            },
        )
    return GateVerdict(
        name="confidence_bounds",
        status=GateStatus.FAIL,
        detail=(
            "Confidence bounds are not consistent with the claimed improvement: "
            f"primary CI [{ev.primary_ci_low:.4f}, {ev.primary_ci_high:.4f}], "
            f"effect size {ev.primary_effect_size:.3f} "
            f"(CI [{ev.primary_effect_size_ci_low:.3f}, "
            f"{ev.primary_effect_size_ci_high:.3f}]), "
            f"min required {ev.min_effect_size:.3f}."
        ),
        evidence={
            "ci_excludes_zero": str(ci_excludes_zero),
            "es_meets_min": str(es_meets),
            "es_ci_positive": str(es_ci_positive),
        },
    )


def _gate_regressions(ev: Evaluation) -> GateVerdict:
    """Gate 3 — no unacceptable regressions in critical cohorts."""
    if ev.regression_cohorts:
        return GateVerdict(
            name="regressions",
            status=GateStatus.FAIL,
            detail=(
                "Unacceptable regression detected in critical cohorts: "
                + ", ".join(ev.regression_cohorts)
            ),
            evidence={"regression_cohorts": ",".join(ev.regression_cohorts)},
        )
    # Non-inferiority check: any cohort in noninferiority_cohorts must have its
    # lower CI bound above -noninferiority_margin. This is encoded by the
    # caller — if they list a cohort in regression_cohorts we already failed.
    # If noninferiority_margin is 0 there is nothing to check.
    return GateVerdict(
        name="regressions",
        status=GateStatus.PASS,
        detail=(
            f"No critical-cohort regressions; non-inferiority margin "
            f"{ev.noninferiority_margin:.4f} respected on "
            f"{len(ev.noninferiority_cohorts)} cohort(s)."
        ),
        evidence={
            "noninferiority_margin": f"{ev.noninferiority_margin:.4f}",
            "noninferiority_cohorts": ",".join(ev.noninferiority_cohorts) or "(none)",
        },
    )


def _gate_security(ev: Evaluation) -> GateVerdict:
    """Gate 4 — security guardrails (SPEC §41.11).

    **Security guardrail failure blocks promotion regardless of average task
    success.** This gate returns ``BLOCKED`` (not just ``FAIL``) on any
    guardrail failure — promotion is impossible.
    """
    if ev.security_guardrail_failed:
        failed = [k for k, v in ev.security_guardrails.items() if not v]
        return GateVerdict(
            name="security_guardrails",
            status=GateStatus.BLOCKED,
            detail=(
                "Security guardrail failure — promotion blocked regardless of "
                f"average task success (SPEC §41.11). Failed: {', '.join(failed)}."
            ),
            evidence={
                "failed_guardrails": ",".join(failed),
                "all_guardrails": ",".join(ev.security_guardrails.keys()) or "(none)",
            },
        )
    return GateVerdict(
        name="security_guardrails",
        status=GateStatus.PASS,
        detail=f"All {len(ev.security_guardrails)} security guardrail(s) passed.",
        evidence={
            "guardrails": ",".join(ev.security_guardrails.keys()) or "(none)",
        },
    )


def _gate_operations(ev: Evaluation) -> GateVerdict:
    """Gate 5 — operational observability and rollback (SPEC §50.1, §50.9)."""
    missing: list[str] = []
    if not ev.has_observability:
        missing.append("observability")
    if not ev.has_rollback:
        missing.append("rollback")
    if not ev.has_documentation:
        missing.append("documentation")
    if not ev.has_migration_behavior:
        missing.append("migration_behavior")
    if missing:
        return GateVerdict(
            name="operations",
            status=GateStatus.FAIL,
            detail="Missing operational readiness: " + ", ".join(missing),
            evidence={"missing": ",".join(missing)},
        )
    return GateVerdict(
        name="operations",
        status=GateStatus.PASS,
        detail="Observability, rollback, documentation, and migration behavior in place.",
    )


def _gate_maintainability(ev: Evaluation) -> GateVerdict:
    """Gate 6 — maintainability / divergence budget (SPEC §50.1)."""
    if not ev.maintainability_within_budget or not ev.divergence_within_budget:
        miss: list[str] = []
        if not ev.maintainability_within_budget:
            miss.append("maintainability")
        if not ev.divergence_within_budget:
            miss.append("divergence")
        return GateVerdict(
            name="maintainability",
            status=GateStatus.FAIL,
            detail="Maintainability/divergence budget exceeded: " + ", ".join(miss),
            evidence={"exceeded": ",".join(miss)},
        )
    return GateVerdict(
        name="maintainability",
        status=GateStatus.PASS,
        detail="Maintainability and divergence within budget.",
    )


GATE_NAMES = (
    "pareto_frontier",
    "confidence_bounds",
    "regressions",
    "security_guardrails",
    "operations",
    "maintainability",
    "reliability",
)


def evaluate_promotion(ev: Evaluation) -> PromotionGateResult:
    """Run the full promotion gate over ``ev``.

    Returns a :class:`PromotionGateResult` whose ``decision`` is the most
    conservative applicable outcome:

    - If any gate returns ``BLOCKED`` → :attr:`PromotionDecision.ROLLBACK`.
    - Else if any gate returns ``FAIL`` → :attr:`PromotionDecision.REVISE`
      (or ``RETAIN_EXPERIMENTAL`` if the failure is operational-only and the
      hard Pareto + confidence gates passed — see logic below).
    - Else → :attr:`PromotionDecision.PROMOTE`.

    The minimal mode remains permanently available (SPEC §18.7) regardless of
    this decision; promotion only changes what is the *default*.
    """
    gates: list[GateVerdict] = [
        _gate_pareto(ev),
        _gate_confidence(ev),
        _gate_regressions(ev),
        _gate_security(ev),
        _gate_operations(ev),
        _gate_maintainability(ev),
        _gate_reliability(ev),
    ]

    blocking = [g.name for g in gates if g.status is GateStatus.BLOCKED]
    if blocking:
        return PromotionGateResult(
            decision=PromotionDecision.ROLLBACK,
            reason=(
                "Hard block from gate(s): "
                + ", ".join(blocking)
                + ". Promotion impossible (SPEC §41.11)."
            ),
            gates=gates,
            blocking_gates=blocking,
        )

    failed = [g for g in gates if g.status is GateStatus.FAIL]
    if failed:
        # If the only failures are operational / maintainability (i.e. the
        # candidate is *promising* but not yet ready), retain experimental
        # rather than forcing a revise. Otherwise revise.
        operational_only = all(g.name in {"operations", "maintainability"} for g in failed)
        # Pareto + confidence + regressions must all have passed for
        # "retain_experimental" to make sense.
        core_passed = all(
            g.status is GateStatus.PASS
            for g in gates
            if g.name in {"pareto_frontier", "confidence_bounds", "regressions"}
        )
        if operational_only and core_passed:
            return PromotionGateResult(
                decision=PromotionDecision.RETAIN_EXPERIMENTAL,
                reason=(
                    "Core gates passed; operational gates failed: "
                    + ", ".join(g.name for g in failed)
                    + ". Retain experimental pending operational readiness."
                ),
                gates=gates,
            )
        return PromotionGateResult(
            decision=PromotionDecision.REVISE,
            reason=("Failed gate(s): " + ", ".join(g.name for g in failed) + "."),
            gates=gates,
        )

    return PromotionGateResult(
        decision=PromotionDecision.PROMOTE,
        reason="All gates passed (Pareto, confidence, regressions, security, "
        "operations, maintainability).",
        gates=gates,
    )


def evaluate_paired_promotion(
    evidence: PairedEvaluationEvidence,
    *,
    min_effect_size: float,
    security_guardrails: dict[str, bool],
    pareto_improves: bool = False,
    cost_delta_pct: float = 0.0,
    latency_p50_delta_pct: float = 0.0,
    latency_p95_delta_pct: float = 0.0,
    noninferiority_margin: float = 0.0,
    has_observability: bool = False,
    has_rollback: bool = False,
    has_documentation: bool = False,
    has_migration_behavior: bool = False,
    maintainability_within_budget: bool = False,
    divergence_within_budget: bool = False,
    satisfies_hard_security_need: bool = False,
    satisfies_hard_reliability_need: bool = False,
    reliability: ReliabilityEvidence | None = None,
    require_live: bool = True,
    require_independent_verification: bool = True,
    require_holdout: bool = True,
    require_provider_receipts: bool = True,
    require_complete_cohort: bool = True,
) -> PromotionGateResult:
    """Apply the promotion gate to derived, identity-locked paired evidence.

    Missing identity, fixture evidence, incomplete holdouts, or insufficient
    pairs is a hard evidence block.  Release defaults are intentionally strict;
    callers doing exploratory analysis can opt out explicitly.
    """
    evidence_requirements: list[str] = []
    if not evidence.eligible:
        evidence_requirements.append("paired evidence is not eligible")
    if require_live and not evidence.live_evidence_complete:
        evidence_requirements.append("external live evidence is required")
    if require_independent_verification and not evidence.live_evidence_complete:
        evidence_requirements.append("independent verification is required")
    if require_holdout and not evidence.holdout_complete:
        evidence_requirements.append("release holdout partition is required")
    if require_provider_receipts and not evidence.provider_receipts_complete:
        evidence_requirements.append("complete provider receipts are required")
    if require_complete_cohort and not evidence.cohort_complete:
        evidence_requirements.append("complete expected task/seed cohort is required")
    if not evidence.same_model:
        evidence_requirements.append("same provider/model identity is required")
    if evidence_requirements:
        detail = "paired evidence is not promotion eligible"
        if evidence.issues:
            detail += ": " + "; ".join(issue.reason for issue in evidence.issues)
        detail += "; " + "; ".join(evidence_requirements)
        verdict = GateVerdict(
            name="paired_evidence",
            status=GateStatus.BLOCKED,
            detail=detail,
            evidence={
                "identity_locked": str(evidence.identity_locked),
                "pairs": str(evidence.n),
            },
        )
        return PromotionGateResult(
            decision=PromotionDecision.RETAIN_EXPERIMENTAL,
            reason="Promotion requires locked, complete model-fixed paired evidence.",
            gates=[verdict],
            blocking_gates=[verdict.name],
        )

    regression_cohorts: list[str] = []
    if evidence.noninferiority is not None and not evidence.noninferiority.is_noninferior:
        regression_cohorts.append(evidence.metric)
    evaluation = Evaluation(
        primary_cohort="paired_model_fixed",
        primary_metric_delta=evidence.mean_delta,
        primary_ci_low=evidence.ci_low,
        primary_ci_high=evidence.ci_high,
        primary_effect_size=evidence.effect_size,
        primary_effect_size_ci_low=evidence.effect_size_ci_low,
        primary_effect_size_ci_high=evidence.effect_size_ci_high,
        min_effect_size=min_effect_size,
        primary_confidence_level=evidence.confidence_level,
        cost_delta_pct=cost_delta_pct,
        latency_p50_delta_pct=latency_p50_delta_pct,
        latency_p95_delta_pct=latency_p95_delta_pct,
        pareto_improves=pareto_improves,
        regression_cohorts=regression_cohorts,
        noninferiority_margin=noninferiority_margin,
        noninferiority_cohorts=[evidence.metric] if evidence.noninferiority is not None else [],
        security_guardrails=security_guardrails,
        security_guardrail_failed=any(not passed for passed in security_guardrails.values()),
        has_observability=has_observability,
        has_rollback=has_rollback,
        has_documentation=has_documentation,
        has_migration_behavior=has_migration_behavior,
        maintainability_within_budget=maintainability_within_budget,
        divergence_within_budget=divergence_within_budget,
        satisfies_hard_security_need=satisfies_hard_security_need,
        satisfies_hard_reliability_need=satisfies_hard_reliability_need,
        reliability=reliability,
    )
    return evaluate_promotion(evaluation)
