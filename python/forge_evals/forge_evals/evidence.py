"""Evidence provenance shared by runners, paired comparisons, and release gates.

Fixtures are useful for exercising the evaluation plumbing, but they are not
external benchmark evidence.  The provenance fields in this module make that
distinction explicit instead of inferring it from a harness name or a note.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum

__all__ = [
    "RELEASE_HOLDOUT_PARTITIONS",
    "EvidenceClass",
    "has_complete_provider_receipt",
]


class EvidenceClass(StrEnum):
    """Execution provenance carried by a run record."""

    FIXTURE_ONLY = "fixture_only"
    EXTERNAL_LIVE = "external_live"


RELEASE_HOLDOUT_PARTITIONS = frozenset(
    {
        "broad_holdout",
        "security_holdout",
        "final_release_holdout",
        "private_holdout",
    }
)


def has_complete_provider_receipt(receipt: object) -> bool:
    """Return whether an opaque provider receipt has the minimum audit fields.

    The eval plane does not interpret provider-specific payloads.  It only
    requires stable identity and accounting references before treating a live
    result as promotion evidence.
    """

    if not isinstance(receipt, Mapping):
        return False
    required = ("receipt_id", "provider", "model", "artifact_ref")
    if any(not isinstance(receipt.get(key), str) or not receipt[key].strip() for key in required):
        return False
    verified = receipt.get("verified")
    return isinstance(verified, bool)
