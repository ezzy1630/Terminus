"""Evidence provenance shared by runners, paired comparisons, and release gates.

Fixtures are useful for exercising the evaluation plumbing, but they are not
external benchmark evidence.  The provenance fields in this module make that
distinction explicit instead of inferring it from a harness name or a note.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Any

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
    # CLI output and other synthetic observations deliberately use a separate
    # diagnostic receipt kind.  A successful process exit or a stdout hash is
    # not proof that an authenticated provider request happened.
    if receipt.get("receipt_kind") != "provider":
        return False
    required = (
        "receipt_id",
        "provider",
        "model",
        "request_id",
        "endpoint_hash",
        "account_hash",
        "response_artifact_ref",
    )
    if any(not isinstance(receipt.get(key), str) or not receipt[key].strip() for key in required):
        return False
    if any(not _safe_hash(receipt[key]) for key in ("endpoint_hash", "account_hash")):
        return False
    response_artifact = receipt["response_artifact_ref"]
    if not response_artifact.startswith("artifact://sha256/"):
        return False
    usage = receipt.get("usage")
    if not isinstance(usage, Mapping):
        return False
    # Usage telemetry must contain numeric input/output counts.  Zero is valid
    # for a failed or cached turn; omission is not.
    if any(not isinstance(usage.get(key), (int, float)) for key in ("input", "output")):
        return False
    verified = receipt.get("verified")
    return verified is True


def _safe_hash(value: Any) -> bool:
    """Accept only a content hash, never a raw endpoint or account value."""
    return isinstance(value, str) and value.startswith("sha256:") and len(value) == 71
