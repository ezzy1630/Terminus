"""Evidence-derived conformance-level tests."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from forge_evals.cli import main as eval_cli
from forge_evals.conformance_levels import (
    CONFORMANCE_REQUIREMENTS,
    ConformanceEvidence,
    ConformanceLevel,
    assess_conformance,
)

NOW = datetime(2026, 8, 23, tzinfo=UTC)
COMMIT = "a" * 40
PLATFORM = "macos-arm64"


def _receipt(requirement: str) -> ConformanceEvidence:
    return ConformanceEvidence(
        requirement=requirement,
        commit=COMMIT,
        platform=PLATFORM,
        passed=True,
        observed_at=NOW - timedelta(hours=1),
        expires_at=NOW + timedelta(days=7),
        artifact_ref=f"artifact://sha256/{'b' * 64}",
        signer_principal="release-evidence-service",
        signature_ref=f"artifact://sha256/{'c' * 64}",
    )


def _through(level: ConformanceLevel) -> list[ConformanceEvidence]:
    requirements: set[str] = set()
    for candidate_level in ConformanceLevel:
        if candidate_level > level:
            break
        requirements.update(CONFORMANCE_REQUIREMENTS[candidate_level])
    return [_receipt(requirement) for requirement in sorted(requirements)]


def test_no_evidence_means_no_conformance_claim() -> None:
    assessment = assess_conformance([], commit=COMMIT, platform=PLATFORM, now=NOW)
    assert assessment.highest_level is None
    assert assessment.to_system_card_fragment()["conformance_level"] == "UNVERIFIED"
    assert not assessment.dominance_proven


def test_levels_require_contiguous_lower_level_evidence() -> None:
    only_l2 = [
        _receipt(requirement)
        for requirement in CONFORMANCE_REQUIREMENTS[ConformanceLevel.L2_DURABLE]
    ]
    assessment = assess_conformance(only_l2, commit=COMMIT, platform=PLATFORM, now=NOW)
    assert assessment.highest_level is None

    through_l2 = assess_conformance(
        _through(ConformanceLevel.L2_DURABLE),
        commit=COMMIT,
        platform=PLATFORM,
        now=NOW,
    )
    assert through_l2.highest_level is ConformanceLevel.L2_DURABLE


def test_stale_wrong_commit_wrong_platform_and_failed_receipts_are_rejected() -> None:
    base = _receipt("protocol_schema_conformance")
    evidence = [
        replace(base, expires_at=NOW),
        replace(base, commit="d" * 40),
        replace(base, platform="linux-x86_64"),
        replace(base, passed=False),
    ]
    assessment = assess_conformance(evidence, commit=COMMIT, platform=PLATFORM, now=NOW)
    assert assessment.highest_level is None
    assert len(assessment.rejected_evidence) == 4


def test_dominance_requires_every_lower_level_and_independent_reproduction() -> None:
    without_reproduction = [
        receipt
        for receipt in _through(ConformanceLevel.L6_DOMINANCE)
        if receipt.requirement != "independent_reproduction"
    ]
    incomplete = assess_conformance(
        without_reproduction,
        commit=COMMIT,
        platform=PLATFORM,
        now=NOW,
    )
    assert incomplete.highest_level is ConformanceLevel.L5_EVOLUTIONARY
    assert not incomplete.dominance_proven

    complete = assess_conformance(
        _through(ConformanceLevel.L6_DOMINANCE),
        commit=COMMIT,
        platform=PLATFORM,
        now=NOW,
    )
    assert complete.highest_level is ConformanceLevel.L6_DOMINANCE
    assert not complete.dominance_proven
    assert complete.to_system_card_fragment()["conformance_level"] == "UNVERIFIED"

    with pytest.raises(TypeError, match="cryptographic_verification"):
        assess_conformance(
            _through(ConformanceLevel.L6_DOMINANCE),
            commit=COMMIT,
            platform=PLATFORM,
            now=NOW,
            cryptographic_verification=True,  # type: ignore[call-arg]
        )


def test_future_and_duplicate_or_conflicting_receipts_fail_closed() -> None:
    future = replace(
        _receipt("protocol_schema_conformance"),
        observed_at=NOW + timedelta(minutes=1),
        expires_at=NOW + timedelta(days=1),
    )
    future_assessment = assess_conformance([future], commit=COMMIT, platform=PLATFORM, now=NOW)
    assert future_assessment.highest_level is None
    assert any("future" in reason for reason in future_assessment.rejected_evidence)

    requirement = "protocol_schema_conformance"
    duplicate_assessment = assess_conformance(
        [_receipt(requirement), replace(_receipt(requirement), passed=False)],
        commit=COMMIT,
        platform=PLATFORM,
        now=NOW,
    )
    assert duplicate_assessment.highest_level is None
    assert any("ambiguous" in reason for reason in duplicate_assessment.rejected_evidence)


def test_receipts_require_signed_immutable_evidence() -> None:
    with pytest.raises(ValueError, match="immutable artifact"):
        replace(_receipt("protocol_schema_conformance"), signature_ref="signature.txt")
    with pytest.raises(ValueError, match="signer"):
        replace(_receipt("protocol_schema_conformance"), signer_principal="")
    with pytest.raises(ValueError, match="boolean"):
        ConformanceEvidence.from_dict(
            {
                "requirement": "protocol_schema_conformance",
                "commit": COMMIT,
                "platform": PLATFORM,
                "passed": "false",
                "observed_at": NOW.isoformat(),
                "expires_at": (NOW + timedelta(days=1)).isoformat(),
                "artifact_ref": f"artifact://sha256/{'b' * 64}",
                "signer_principal": "release-evidence-service",
                "signature_ref": f"artifact://sha256/{'c' * 64}",
            }
        )


def test_conformance_cli_reports_structure_but_refuses_a_release_gate(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    receipts = []
    for receipt in _through(ConformanceLevel.L0_PROTOCOL):
        receipts.append(
            {
                "requirement": receipt.requirement,
                "commit": receipt.commit,
                "platform": receipt.platform,
                "passed": receipt.passed,
                "observed_at": receipt.observed_at.isoformat(),
                "expires_at": receipt.expires_at.isoformat(),
                "artifact_ref": receipt.artifact_ref,
                "signer_principal": receipt.signer_principal,
                "signature_ref": receipt.signature_ref,
            }
        )
    evidence_path = tmp_path / "evidence.json"
    evidence_path.write_text(json.dumps(receipts), encoding="utf-8")

    args = [
        "conformance",
        "--evidence",
        str(evidence_path),
        "--commit",
        COMMIT,
        "--platform",
        PLATFORM,
        "--as-of",
        NOW.isoformat(),
        "--require-level",
        "L0_PROTOCOL",
    ]
    assert eval_cli(args) == 1
    output = json.loads(capsys.readouterr().out)
    assert output["conformance_level"] == "UNVERIFIED"
    assert output["structural_candidate_level"] == "L0_PROTOCOL"
    assert output["evidence_verification"] == "structural_only"
    assert output["dominance_proven"] is False

    args[-1] = "L1_LOCAL_SAFE"
    assert eval_cli(args) == 1
