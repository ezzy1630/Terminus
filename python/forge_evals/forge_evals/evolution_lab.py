"""Sealed Evolution Lab contracts for the Terminus evaluation plane.

The lab may propose and evaluate harness changes. It cannot perform effects,
read hidden evaluation inputs as an optimizer, alter graders or promotion
policy, or promote its own candidates. Promotion authority stays in a separate
trusted service. The actor checks below are policy contracts for the offline
package, not a process-isolation boundary; production use must enforce the
roles in separate identities and processes.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from math import isfinite
from types import MappingProxyType

__all__ = [
    "CanaryDecision",
    "CanaryObservation",
    "CandidateLifecycle",
    "CandidateStage",
    "CausalAblationPlan",
    "CoevolutionExperiment",
    "EvaluationActor",
    "EvaluationPartition",
    "EvaluationReceipt",
    "EvolutionCandidate",
    "FailureAttribution",
    "ParetoArchive",
    "ParetoPoint",
    "PartitionAccessError",
    "PromotionSignature",
    "RepairMemory",
    "RepairMemoryEntry",
    "assert_partition_access",
]


class EvaluationPartition(StrEnum):
    """Partitions named by the north-star evaluation protocol."""

    TRAINING_FAILURES = "training_failures"
    DEVELOPMENT = "development"
    FOCUSED_HOLDOUT = "focused_holdout"
    BROAD_HOLDOUT = "broad_holdout"
    SECURITY_HOLDOUT = "security_holdout"
    FINAL_RELEASE_HOLDOUT = "final_release_holdout"


class EvaluationActor(StrEnum):
    """Roles with intentionally different visibility and authority."""

    OPTIMIZER = "optimizer"
    EVALUATOR = "evaluator"
    PROMOTION_SERVICE = "promotion_service"


class PartitionAccessError(PermissionError):
    """Raised when a role attempts to read a protected partition."""


_OPTIMIZER_PARTITIONS = frozenset(
    {EvaluationPartition.TRAINING_FAILURES, EvaluationPartition.DEVELOPMENT}
)


def assert_partition_access(actor: EvaluationActor, partition: EvaluationPartition) -> None:
    """Reject hidden-partition reads by the optimizer and promotion service.

    The evaluator owns hidden task execution. The promotion service consumes
    signed receipts only, so it has no raw partition access either.
    """

    if actor is EvaluationActor.EVALUATOR:
        return
    if actor is EvaluationActor.OPTIMIZER and partition in _OPTIMIZER_PARTITIONS:
        return
    raise PartitionAccessError(f"{actor.value} cannot read {partition.value}")


class CandidateStage(StrEnum):
    """Ordered validation and release stages."""

    PROPOSED = "proposed"
    STATIC = "static"
    SOURCE_FAILURE = "source_failure"
    REPLAY = "replay"
    FOCUSED_HOLDOUT = "focused_holdout"
    BROAD_HOLDOUT = "broad_holdout"
    SECURITY_CHAOS = "security_chaos"
    SIGNED = "signed"
    CANARY = "canary"
    PROMOTED = "promoted"
    REJECTED = "rejected"
    ROLLED_BACK = "rolled_back"


_VALIDATION_SEQUENCE = (
    CandidateStage.STATIC,
    CandidateStage.SOURCE_FAILURE,
    CandidateStage.REPLAY,
    CandidateStage.FOCUSED_HOLDOUT,
    CandidateStage.BROAD_HOLDOUT,
    CandidateStage.SECURITY_CHAOS,
)

_CONTENT_HASH = re.compile(r"[0-9a-f]{64}")
_COMMIT_HASH = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")


def _is_content_hash(value: str) -> bool:
    return (
        value.startswith("sha256:")
        and _CONTENT_HASH.fullmatch(value.removeprefix("sha256:")) is not None
    )


def _is_artifact_ref(value: str) -> bool:
    prefix = "artifact://sha256/"
    return (
        value.startswith(prefix) and _CONTENT_HASH.fullmatch(value.removeprefix(prefix)) is not None
    )


def _freeze_float_mapping(values: Mapping[str, float]) -> Mapping[str, float]:
    return MappingProxyType(dict(values))


def _freeze_bool_mapping(values: Mapping[str, bool]) -> Mapping[str, bool]:
    return MappingProxyType(dict(values))


def _require_finite(values: Mapping[str, float], field_name: str) -> None:
    invalid = [name for name, value in values.items() if not isfinite(value)]
    if invalid:
        raise ValueError(f"{field_name} contains non-finite metrics: {', '.join(sorted(invalid))}")


@dataclass(frozen=True)
class FailureAttribution:
    """Trace-backed explanation of a mined failure and its likely contributors."""

    attribution_id: str
    source_failure_ids: tuple[str, ...]
    trace_refs: tuple[str, ...]
    root_cause: str
    target_component: str
    component_contributions: Mapping[str, float]
    confounders: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_finite(self.component_contributions, "component_contributions")
        object.__setattr__(
            self,
            "component_contributions",
            _freeze_float_mapping(self.component_contributions),
        )
        required = {
            "attribution_id": self.attribution_id,
            "root_cause": self.root_cause,
            "target_component": self.target_component,
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise ValueError(f"attribution fields must be non-empty: {', '.join(missing)}")
        if not self.source_failure_ids:
            raise ValueError("attribution requires at least one source failure")
        if not self.trace_refs or any(not _is_artifact_ref(ref) for ref in self.trace_refs):
            raise ValueError("attribution requires immutable trace references")
        if self.target_component not in self.component_contributions:
            raise ValueError("target component requires an explicit contribution")
        invalid = [
            component
            for component, contribution in self.component_contributions.items()
            if contribution < 0.0 or contribution > 1.0
        ]
        if invalid:
            raise ValueError(
                "component contributions must be in [0, 1]: " + ", ".join(sorted(invalid))
            )
        total = sum(self.component_contributions.values())
        if abs(total - 1.0) > 1e-9:
            raise ValueError("component contributions must sum to 1")


@dataclass(frozen=True)
class CausalAblationPlan:
    """Preregistered cells that separate component effects from bundle effects."""

    changed_components: tuple[str, ...]
    cells: tuple[frozenset[str], ...]
    preregistration_ref: str

    def __post_init__(self) -> None:
        if not self.changed_components or any(not item.strip() for item in self.changed_components):
            raise ValueError("ablation plan requires named changed components")
        if len(set(self.changed_components)) != len(self.changed_components):
            raise ValueError("ablation plan changed components must be unique")
        if not _is_artifact_ref(self.preregistration_ref):
            raise ValueError("ablation plan requires an immutable preregistration")
        changed = frozenset(self.changed_components)
        if any(not cell.issubset(changed) for cell in self.cells):
            raise ValueError("ablation cells may contain only changed components")
        required_cells = {frozenset(), changed}
        required_cells.update(frozenset({component}) for component in changed)
        missing = required_cells.difference(self.cells)
        if missing:
            raise ValueError("ablation plan requires baseline, singleton, and full-bundle cells")


@dataclass(frozen=True)
class EvolutionCandidate:
    """A trace-grounded, prediction-bearing harness change proposal."""

    candidate_id: str
    experiment_id: str
    source_commit: str
    platform: str
    baseline_version: str
    candidate_version: str
    configuration_identity: str
    attribution: FailureAttribution
    ablation_plan: CausalAblationPlan
    source_failure_ids: tuple[str, ...]
    root_cause: str
    target_component: str
    changed_components: tuple[str, ...]
    forbidden_components: tuple[str, ...]
    predicted_improvements: Mapping[str, float]
    regression_floors: Mapping[str, float]
    predicted_cost_delta_pct: float
    predicted_latency_delta_pct: float
    security_effect: str
    privacy_effect: str
    required_tests: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_finite(self.predicted_improvements, "predicted_improvements")
        _require_finite(self.regression_floors, "regression_floors")
        if not isfinite(self.predicted_cost_delta_pct) or not isfinite(
            self.predicted_latency_delta_pct
        ):
            raise ValueError("predicted cost and latency deltas must be finite")
        object.__setattr__(
            self, "predicted_improvements", _freeze_float_mapping(self.predicted_improvements)
        )
        object.__setattr__(self, "regression_floors", _freeze_float_mapping(self.regression_floors))
        required_text = {
            "candidate_id": self.candidate_id,
            "experiment_id": self.experiment_id,
            "platform": self.platform,
            "baseline_version": self.baseline_version,
            "candidate_version": self.candidate_version,
            "configuration_identity": self.configuration_identity,
            "root_cause": self.root_cause,
            "target_component": self.target_component,
            "security_effect": self.security_effect,
            "privacy_effect": self.privacy_effect,
        }
        missing = [name for name, value in required_text.items() if not value.strip()]
        if missing:
            raise ValueError(f"candidate fields must be non-empty: {', '.join(missing)}")
        if _COMMIT_HASH.fullmatch(self.source_commit) is None:
            raise ValueError("candidate source_commit must be an exact Git object hash")
        if not _is_content_hash(self.configuration_identity):
            raise ValueError("candidate configuration_identity must be content-addressed")
        if not self.source_failure_ids:
            raise ValueError("candidate requires at least one source failure")
        if not self.predicted_improvements:
            raise ValueError("candidate requires a falsifiable improvement prediction")
        if not self.required_tests:
            raise ValueError("candidate requires predeclared tests")
        if self.target_component not in self.changed_components:
            raise ValueError("target_component must be present in changed_components")
        if self.source_failure_ids != self.attribution.source_failure_ids:
            raise ValueError("candidate source failures must match its attribution")
        if self.root_cause != self.attribution.root_cause:
            raise ValueError("candidate root cause must match its attribution")
        if self.target_component != self.attribution.target_component:
            raise ValueError("candidate target component must match its attribution")
        if self.changed_components != self.ablation_plan.changed_components:
            raise ValueError("candidate changes must match its causal ablation plan")
        forbidden_changes = set(self.changed_components).intersection(self.forbidden_components)
        if forbidden_changes:
            names = ", ".join(sorted(forbidden_changes))
            raise ValueError(f"candidate changes forbidden components: {names}")


@dataclass(frozen=True)
class EvaluationReceipt:
    """Immutable evidence emitted by the isolated evaluator."""

    candidate_id: str
    candidate_version: str
    experiment_id: str
    source_commit: str
    platform: str
    evaluator_principal: str
    run_manifest_ref: str
    configuration_identity: str
    resolved_configuration_identity: str
    stage: CandidateStage
    artifact_ref: str
    passed: bool
    partition: EvaluationPartition | None = None
    cohorts: tuple[str, ...] = ()
    models: tuple[str, ...] = ()
    metric_deltas: Mapping[str, float] = field(default_factory=dict)
    security_guardrails: Mapping[str, bool] = field(default_factory=dict)
    notes: str = ""

    def __post_init__(self) -> None:
        _require_finite(self.metric_deltas, "metric_deltas")
        object.__setattr__(self, "metric_deltas", _freeze_float_mapping(self.metric_deltas))
        object.__setattr__(
            self, "security_guardrails", _freeze_bool_mapping(self.security_guardrails)
        )
        if self.stage not in _VALIDATION_SEQUENCE:
            raise ValueError(f"{self.stage.value} is not an evaluation stage")
        required_identity = (
            self.candidate_id,
            self.candidate_version,
            self.experiment_id,
            self.platform,
            self.evaluator_principal,
            self.configuration_identity,
            self.resolved_configuration_identity,
        )
        if any(not value.strip() for value in required_identity):
            raise ValueError("evaluation receipt requires candidate, run, and evaluator identity")
        if _COMMIT_HASH.fullmatch(self.source_commit) is None:
            raise ValueError("evaluation receipt requires an exact source commit")
        if not _is_artifact_ref(self.artifact_ref):
            raise ValueError("evaluation receipt requires an immutable artifact reference")
        if not _is_artifact_ref(self.run_manifest_ref):
            raise ValueError("evaluation receipt requires an immutable run manifest")
        if not _is_content_hash(self.configuration_identity):
            raise ValueError("evaluation receipt requires a content-addressed configuration identity")
        if self.resolved_configuration_identity != self.configuration_identity:
            raise ValueError("evaluation receipt configuration identity does not match its resolved run manifest")
        expected_partition = {
            CandidateStage.FOCUSED_HOLDOUT: EvaluationPartition.FOCUSED_HOLDOUT,
            CandidateStage.BROAD_HOLDOUT: EvaluationPartition.BROAD_HOLDOUT,
            CandidateStage.SECURITY_CHAOS: EvaluationPartition.SECURITY_HOLDOUT,
        }.get(self.stage)
        if self.partition is not expected_partition:
            expected_name = expected_partition.value if expected_partition is not None else "none"
            raise ValueError(f"{self.stage.value} receipt requires partition {expected_name}")


@dataclass(frozen=True)
class PromotionSignature:
    """Verified signature metadata supplied by the trusted promotion service."""

    candidate_id: str
    candidate_version: str
    receipt_refs: tuple[str, ...]
    signer_principal: str
    policy_hash: str
    signature_ref: str

    def __post_init__(self) -> None:
        if not self.signer_principal.strip():
            raise ValueError("signer_principal must be non-empty")
        if not self.candidate_id.strip() or not self.candidate_version.strip():
            raise ValueError("promotion signature requires candidate identity")
        if not self.receipt_refs or any(not _is_artifact_ref(ref) for ref in self.receipt_refs):
            raise ValueError("promotion signature requires immutable ordered receipts")
        if not _is_content_hash(self.policy_hash):
            raise ValueError("policy_hash must be content-addressed")
        if not _is_artifact_ref(self.signature_ref):
            raise ValueError("signature_ref must be an immutable artifact reference")


class CanaryDecision(StrEnum):
    """Result of comparing canary evidence with preregistered predictions."""

    PROMOTE = "promote"
    CONTINUE = "continue"
    ROLLBACK = "rollback"


@dataclass(frozen=True)
class CanaryObservation:
    """Observed canary metrics and hard-guardrail results."""

    candidate_id: str
    candidate_version: str
    experiment_id: str
    source_commit: str
    platform: str
    run_manifest_ref: str
    configuration_identity: str
    resolved_configuration_identity: str
    artifact_ref: str
    sample_size: int
    metric_deltas: Mapping[str, float]
    security_guardrails: Mapping[str, bool]

    def __post_init__(self) -> None:
        _require_finite(self.metric_deltas, "metric_deltas")
        object.__setattr__(self, "metric_deltas", _freeze_float_mapping(self.metric_deltas))
        object.__setattr__(
            self, "security_guardrails", _freeze_bool_mapping(self.security_guardrails)
        )
        if not _is_artifact_ref(self.artifact_ref):
            raise ValueError("canary observation requires an immutable artifact reference")
        required_identity = (
            self.candidate_id,
            self.candidate_version,
            self.experiment_id,
            self.platform,
            self.configuration_identity,
            self.resolved_configuration_identity,
        )
        if any(not value.strip() for value in required_identity):
            raise ValueError("canary observation requires candidate and run identity")
        if _COMMIT_HASH.fullmatch(self.source_commit) is None:
            raise ValueError("canary observation requires an exact source commit")
        if not _is_artifact_ref(self.run_manifest_ref):
            raise ValueError("canary observation requires an immutable run manifest")
        if not _is_content_hash(self.configuration_identity):
            raise ValueError("canary observation requires a content-addressed configuration identity")
        if self.resolved_configuration_identity != self.configuration_identity:
            raise ValueError("canary configuration identity does not match its resolved run manifest")
        if self.sample_size <= 0:
            raise ValueError("sample_size must be positive")


@dataclass
class CandidateLifecycle:
    """Enforce stage order, separation of duties, and automatic rollback."""

    candidate: EvolutionCandidate
    stage: CandidateStage = CandidateStage.PROPOSED
    receipts: list[EvaluationReceipt] = field(default_factory=list)
    signature: PromotionSignature | None = None
    rollback_reasons: list[str] = field(default_factory=list)

    def record_receipt(
        self, receipt: EvaluationReceipt, *, actor: EvaluationActor
    ) -> CandidateStage:
        if actor is not EvaluationActor.EVALUATOR:
            raise PermissionError("only the evaluator may record evaluation receipts")
        if self.stage in {
            CandidateStage.REJECTED,
            CandidateStage.ROLLED_BACK,
            CandidateStage.PROMOTED,
        }:
            raise ValueError(f"candidate lifecycle is terminal at {self.stage.value}")
        expected = (
            _VALIDATION_SEQUENCE[len(self.receipts)]
            if len(self.receipts) < len(_VALIDATION_SEQUENCE)
            else None
        )
        if receipt.stage is not expected:
            expected_name = expected.value if expected else "signature"
            raise ValueError(
                f"expected {expected_name} after {self.stage.value}, got {receipt.stage.value}"
            )
        if (
            receipt.candidate_id != self.candidate.candidate_id
            or receipt.candidate_version != self.candidate.candidate_version
            or receipt.experiment_id != self.candidate.experiment_id
            or receipt.source_commit != self.candidate.source_commit
            or receipt.platform != self.candidate.platform
            or receipt.configuration_identity != self.candidate.configuration_identity
            or receipt.resolved_configuration_identity != self.candidate.configuration_identity
        ):
            raise ValueError("evaluation receipt does not match the candidate")
        self.receipts.append(receipt)
        self.stage = receipt.stage
        if not receipt.passed:
            self.stage = CandidateStage.REJECTED
            return self.stage
        if receipt.stage is CandidateStage.BROAD_HOLDOUT and (
            len(set(receipt.cohorts)) < 2 or len(set(receipt.models)) < 2
        ):
            self.stage = CandidateStage.REJECTED
            self.rollback_reasons.append(
                "broad holdout did not demonstrate transfer across cohorts and models"
            )
        if receipt.stage is CandidateStage.SECURITY_CHAOS:
            failed = [name for name, passed in receipt.security_guardrails.items() if not passed]
            if failed:
                self.stage = CandidateStage.REJECTED
                self.rollback_reasons.append(
                    "security or chaos guardrails failed: " + ", ".join(sorted(failed))
                )
        return self.stage

    def sign(self, signature: PromotionSignature, *, actor: EvaluationActor) -> None:
        if actor is not EvaluationActor.PROMOTION_SERVICE:
            raise PermissionError("only the promotion service may sign candidates")
        if self.stage is not CandidateStage.SECURITY_CHAOS:
            raise ValueError("candidate must pass the full validation ladder before signing")
        expected_receipts = tuple(receipt.artifact_ref for receipt in self.receipts)
        if (
            signature.candidate_id != self.candidate.candidate_id
            or signature.candidate_version != self.candidate.candidate_version
            or signature.receipt_refs != expected_receipts
        ):
            raise ValueError("promotion signature does not bind the candidate and ordered receipts")
        self.signature = signature
        self.stage = CandidateStage.SIGNED

    def begin_canary(self, *, actor: EvaluationActor) -> None:
        if actor is not EvaluationActor.PROMOTION_SERVICE:
            raise PermissionError("only the promotion service may start a canary")
        if self.stage is not CandidateStage.SIGNED or self.signature is None:
            raise ValueError("candidate must have a promotion signature before canary")
        self.stage = CandidateStage.CANARY

    def assess_canary(
        self,
        observation: CanaryObservation,
        *,
        actor: EvaluationActor,
        minimum_sample_size: int,
    ) -> CanaryDecision:
        if actor is not EvaluationActor.PROMOTION_SERVICE:
            raise PermissionError("only the promotion service may assess canary evidence")
        if self.stage is not CandidateStage.CANARY:
            raise ValueError("candidate is not in canary")
        if minimum_sample_size <= 0:
            raise ValueError("minimum_sample_size must be positive")
        if (
            observation.candidate_id != self.candidate.candidate_id
            or observation.candidate_version != self.candidate.candidate_version
            or observation.experiment_id != self.candidate.experiment_id
            or observation.source_commit != self.candidate.source_commit
            or observation.platform != self.candidate.platform
            or observation.configuration_identity != self.candidate.configuration_identity
            or observation.resolved_configuration_identity != self.candidate.configuration_identity
        ):
            raise ValueError("canary observation does not match the candidate")

        violations: list[str] = []
        failed_guardrails = [
            name for name, passed in observation.security_guardrails.items() if not passed
        ]
        if failed_guardrails:
            violations.append("failed guardrails: " + ", ".join(sorted(failed_guardrails)))
        for metric, minimum_delta in self.candidate.predicted_improvements.items():
            observed = observation.metric_deltas.get(metric)
            if observed is None or observed < minimum_delta:
                violations.append(
                    f"prediction violated for {metric}: expected >= {minimum_delta}, got {observed}"
                )
        for metric, floor in self.candidate.regression_floors.items():
            observed = observation.metric_deltas.get(metric)
            if observed is None or observed < floor:
                violations.append(
                    f"regression floor violated for {metric}: expected >= {floor}, got {observed}"
                )

        if violations:
            self.rollback_reasons.extend(violations)
            self.stage = CandidateStage.ROLLED_BACK
            return CanaryDecision.ROLLBACK
        if observation.sample_size < minimum_sample_size:
            return CanaryDecision.CONTINUE
        self.stage = CandidateStage.PROMOTED
        return CanaryDecision.PROMOTE


@dataclass(frozen=True)
class CoevolutionExperiment:
    """Preregistered factorial comparison of model and harness changes."""

    experiment_id: str
    model_profiles: tuple[str, ...]
    harness_versions: tuple[str, ...]
    partition: EvaluationPartition
    preregistration_ref: str

    def __post_init__(self) -> None:
        if not self.experiment_id.strip():
            raise ValueError("coevolution experiment requires an identifier")
        if len(set(self.model_profiles)) < 2 or len(set(self.harness_versions)) < 2:
            raise ValueError("coevolution requires at least two models and two harness versions")
        if self.partition not in {
            EvaluationPartition.BROAD_HOLDOUT,
            EvaluationPartition.SECURITY_HOLDOUT,
            EvaluationPartition.FINAL_RELEASE_HOLDOUT,
        }:
            raise ValueError("coevolution experiments require a hidden evaluation partition")
        if not _is_artifact_ref(self.preregistration_ref):
            raise ValueError("coevolution requires an immutable preregistration")

    @property
    def cells(self) -> tuple[tuple[str, str], ...]:
        """Return the complete model-by-harness factorial in deterministic order."""

        return tuple(
            (model, harness)
            for model in sorted(set(self.model_profiles))
            for harness in sorted(set(self.harness_versions))
        )


@dataclass(frozen=True)
class ParetoPoint:
    """One measured configuration in the success/cost/latency/attention space."""

    candidate_id: str
    evidence_ref: str
    success_rate: float
    cost: float
    latency: float
    human_attention: float
    hard_guardrails_passed: bool

    def __post_init__(self) -> None:
        values = {
            "success_rate": self.success_rate,
            "cost": self.cost,
            "latency": self.latency,
            "human_attention": self.human_attention,
        }
        _require_finite(values, "pareto point")
        if not _is_artifact_ref(self.evidence_ref):
            raise ValueError("pareto point requires immutable measurement evidence")
        if not 0.0 <= self.success_rate <= 1.0:
            raise ValueError("success_rate must be in [0, 1]")
        if self.cost < 0 or self.latency < 0 or self.human_attention < 0:
            raise ValueError("cost, latency, and human_attention must be non-negative")

    def dominates(self, other: ParetoPoint) -> bool:
        no_worse = (
            self.success_rate >= other.success_rate
            and self.cost <= other.cost
            and self.latency <= other.latency
            and self.human_attention <= other.human_attention
        )
        strictly_better = (
            self.success_rate > other.success_rate
            or self.cost < other.cost
            or self.latency < other.latency
            or self.human_attention < other.human_attention
        )
        return no_worse and strictly_better


@dataclass
class ParetoArchive:
    """Keep only hard-safe, non-dominated measured configurations."""

    points: list[ParetoPoint] = field(default_factory=list)

    def add(self, point: ParetoPoint) -> bool:
        if not point.hard_guardrails_passed:
            return False
        if any(existing.dominates(point) for existing in self.points):
            return False
        self.points = [existing for existing in self.points if not point.dominates(existing)]
        self.points.append(point)
        self.points.sort(key=lambda item: item.candidate_id)
        return True


@dataclass(frozen=True)
class RepairMemoryEntry:
    """Evidence-backed record of a failed or rolled-back repair attempt."""

    flaw_signature: str
    source_failure_ids: tuple[str, ...]
    attempted_candidate_id: str
    measured_effects: Mapping[str, float]
    interactions: tuple[str, ...]
    rejected_hypotheses: tuple[str, ...]
    rollback_reasons: tuple[str, ...]
    evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_finite(self.measured_effects, "measured_effects")
        object.__setattr__(self, "measured_effects", _freeze_float_mapping(self.measured_effects))


@dataclass
class RepairMemory:
    """Store deduplicated repair failures without granting them authority."""

    entries: dict[str, RepairMemoryEntry] = field(default_factory=dict)

    def record(self, entry: RepairMemoryEntry) -> None:
        if not entry.flaw_signature.strip():
            raise ValueError("flaw_signature must be non-empty")
        if not entry.evidence_refs or any(not _is_artifact_ref(ref) for ref in entry.evidence_refs):
            raise ValueError("repair memory requires immutable evidence references")
        key = f"{entry.flaw_signature}:{entry.attempted_candidate_id}"
        self.entries[key] = entry
