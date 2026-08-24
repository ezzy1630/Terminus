"""Evidence-derived Terminus conformance levels.

Conformance is assessed per commit and platform. Source declarations, local
component presence, and lower-level evidence cannot satisfy a higher level.
This module validates receipt structure and identity only. Cryptographic
signature verification remains an explicit upstream boundary. The offline
package cannot mint a verified conformance or dominance claim.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import IntEnum
from typing import Any

__all__ = [
    "CONFORMANCE_REQUIREMENTS",
    "ConformanceAssessment",
    "ConformanceEvidence",
    "ConformanceLevel",
    "assess_conformance",
]


class ConformanceLevel(IntEnum):
    """Normative levels from the Terminus north-star specification."""

    L0_PROTOCOL = 0
    L1_LOCAL_SAFE = 1
    L2_DURABLE = 2
    L3_DISTRIBUTED = 3
    L4_HIGH_ASSURANCE = 4
    L5_EVOLUTIONARY = 5
    L6_DOMINANCE = 6


CONFORMANCE_REQUIREMENTS: dict[ConformanceLevel, frozenset[str]] = {
    ConformanceLevel.L0_PROTOCOL: frozenset(
        {"protocol_schema_conformance", "generated_client_conformance"}
    ),
    ConformanceLevel.L1_LOCAL_SAFE: frozenset(
        {
            "local_task_completion",
            "sandbox_effective_controls",
            "effect_ledger_non_bypassability",
            "evidence_admission",
        }
    ),
    ConformanceLevel.L2_DURABLE: frozenset(
        {"controller_worker_crash_recovery", "durable_authorization_consumption"}
    ),
    ConformanceLevel.L3_DISTRIBUTED: frozenset(
        {"multi_worker_fencing", "partition_recovery", "remote_workload_identity"}
    ),
    ConformanceLevel.L4_HIGH_ASSURANCE: frozenset(
        {
            "trust_separation",
            "independent_verification",
            "strict_connector_conformance",
            "adversarial_security_suite",
        }
    ),
    ConformanceLevel.L5_EVOLUTIONARY: frozenset(
        {"sealed_optimizer", "heldout_promotion", "canary_automatic_rollback"}
    ),
    ConformanceLevel.L6_DOMINANCE: frozenset(
        {
            "locked_competitor_comparison",
            "critical_cohort_noninferiority",
            "best_measured_pareto_point",
            "independent_reproduction",
        }
    ),
}

_CONTENT_HASH = re.compile(r"[0-9a-f]{64}")
_COMMIT_HASH = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
_KNOWN_REQUIREMENTS = frozenset().union(*CONFORMANCE_REQUIREMENTS.values())


def _is_artifact_ref(value: str) -> bool:
    prefix = "artifact://sha256/"
    return (
        value.startswith(prefix) and _CONTENT_HASH.fullmatch(value.removeprefix(prefix)) is not None
    )


@dataclass(frozen=True)
class ConformanceEvidence:
    """One signed verdict for one conformance requirement."""

    requirement: str
    commit: str
    platform: str
    passed: bool
    observed_at: datetime
    expires_at: datetime
    artifact_ref: str
    signer_principal: str
    signature_ref: str

    def __post_init__(self) -> None:
        if self.observed_at.tzinfo is None or self.expires_at.tzinfo is None:
            raise ValueError("evidence timestamps must be timezone-aware")
        if self.expires_at <= self.observed_at:
            raise ValueError("evidence expiry must be after observation")
        if _COMMIT_HASH.fullmatch(self.commit) is None:
            raise ValueError("commit must be an exact Git object hash")
        if not self.platform.strip() or not self.requirement.strip():
            raise ValueError("requirement and platform must be non-empty")
        if not self.signer_principal.strip():
            raise ValueError("conformance evidence requires a signer")
        if not _is_artifact_ref(self.artifact_ref) or not _is_artifact_ref(self.signature_ref):
            raise ValueError("evidence and signature must use immutable artifact references")

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ConformanceEvidence:
        """Decode one JSON-compatible receipt with explicit timestamp parsing."""

        required_strings = (
            "requirement",
            "commit",
            "platform",
            "observed_at",
            "expires_at",
            "artifact_ref",
            "signer_principal",
            "signature_ref",
        )
        decoded: dict[str, str] = {}
        for name in required_strings:
            item = value.get(name)
            if not isinstance(item, str):
                raise ValueError(f"conformance evidence {name} must be a string")
            decoded[name] = item
        passed = value.get("passed")
        if not isinstance(passed, bool):
            raise ValueError("conformance evidence passed must be a boolean")
        return cls(
            requirement=decoded["requirement"],
            commit=decoded["commit"],
            platform=decoded["platform"],
            passed=passed,
            observed_at=datetime.fromisoformat(decoded["observed_at"]),
            expires_at=datetime.fromisoformat(decoded["expires_at"]),
            artifact_ref=decoded["artifact_ref"],
            signer_principal=decoded["signer_principal"],
            signature_ref=decoded["signature_ref"],
        )


@dataclass(frozen=True)
class ConformanceAssessment:
    """Highest contiguous structural candidate supported by accepted evidence."""

    commit: str
    platform: str
    highest_level: ConformanceLevel | None
    satisfied_requirements: frozenset[str]
    missing_by_level: dict[ConformanceLevel, tuple[str, ...]]
    rejected_evidence: tuple[str, ...]

    @property
    def dominance_proven(self) -> bool:
        """The offline structural assessor cannot prove dominance."""

        return False

    def to_system_card_fragment(self) -> dict[str, object]:
        """Return a JSON-compatible, evidence-derived system-card fragment."""

        return {
            "commit": self.commit,
            "platform": self.platform,
            "conformance_level": "UNVERIFIED",
            "structural_candidate_level": (
                self.highest_level.name if self.highest_level is not None else "UNVERIFIED"
            ),
            "evidence_verification": "structural_only",
            "dominance_proven": self.dominance_proven,
            "satisfied_requirements": sorted(self.satisfied_requirements),
            "missing_by_level": {
                level.name: list(missing) for level, missing in self.missing_by_level.items()
            },
            "rejected_evidence": list(self.rejected_evidence),
        }


def assess_conformance(
    evidence: list[ConformanceEvidence],
    *,
    commit: str,
    platform: str,
    now: datetime | None = None,
) -> ConformanceAssessment:
    """Assess one build without accepting stale or ambiguous receipts.

    This function deliberately has no cryptographic-success input. A trusted
    release verifier must resolve artifacts, validate signatures and signer
    authority, and emit the release system card outside this offline package.
    """

    observed_now = now or datetime.now(UTC)
    if observed_now.tzinfo is None:
        raise ValueError("assessment time must be timezone-aware")
    if _COMMIT_HASH.fullmatch(commit) is None:
        raise ValueError("assessment commit must be an exact Git object hash")

    eligible: dict[str, list[ConformanceEvidence]] = {}
    accepted: set[str] = set()
    rejected: list[str] = []
    for receipt in evidence:
        identity = f"{receipt.requirement}@{receipt.artifact_ref}"
        if receipt.requirement not in _KNOWN_REQUIREMENTS:
            rejected.append(f"{identity}: unknown requirement")
        elif receipt.commit != commit:
            rejected.append(f"{identity}: commit mismatch")
        elif receipt.platform != platform:
            rejected.append(f"{identity}: platform mismatch")
        elif receipt.observed_at > observed_now:
            rejected.append(f"{identity}: observation is in the future")
        elif receipt.expires_at <= observed_now:
            rejected.append(f"{identity}: expired")
        else:
            eligible.setdefault(receipt.requirement, []).append(receipt)

    for requirement, receipts in sorted(eligible.items()):
        if len(receipts) != 1:
            rejected.append(
                f"{requirement}: {len(receipts)} current receipts are ambiguous; exactly one is required"
            )
        elif not receipts[0].passed:
            rejected.append(f"{requirement}@{receipts[0].artifact_ref}: failed")
        else:
            accepted.add(requirement)

    highest: ConformanceLevel | None = None
    missing_by_level: dict[ConformanceLevel, tuple[str, ...]] = {}
    lower_level_complete = True
    for level in ConformanceLevel:
        missing = tuple(sorted(CONFORMANCE_REQUIREMENTS[level].difference(accepted)))
        missing_by_level[level] = missing
        if lower_level_complete and not missing:
            highest = level
        else:
            lower_level_complete = False

    return ConformanceAssessment(
        commit=commit,
        platform=platform,
        highest_level=highest,
        satisfied_requirements=frozenset(accepted),
        missing_by_level=missing_by_level,
        rejected_evidence=tuple(sorted(rejected)),
    )
