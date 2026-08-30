"""External reward-hacking review admission for Terminal-Bench evidence.

Passing the official verifier is necessary but not sufficient for the public
Artificial Analysis comparison. A reviewer must also inspect the trajectory
for verifier manipulation. This module binds that external verdict to the
exact pre-review run record and official task checksum before it can become
campaign evidence.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path

from .run_record import RunRecord

__all__ = [
    "RewardHackingReview",
    "admit_reward_hacking_review",
    "harbor_reward_hacking_review_payload",
    "load_reward_hacking_review",
    "reward_hacking_review_request",
    "run_record_digest",
]

_SCHEMA = "terminus.terminal-bench-reward-hacking-review.v1"
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
_SELF_VERIFIERS = {"self", "terminus", "terminus-eval", "terminus-live"}


@dataclass(frozen=True)
class RewardHackingReview:
    """One external verdict bound to immutable run evidence."""

    verifier: str
    verdict: str
    run_id: str
    task: str
    random_seed: int
    task_checksum: str
    record_digest: str
    review_method: str
    judge_agent: str
    judge_model: str
    runner_source: str
    rubric_digest: str
    analysis_artifact: str
    analysis_digest: str
    attestation_digest: str


def run_record_digest(record: RunRecord) -> str:
    """Hash the canonical pre-review record serialization."""
    encoded = record.to_jsonl_line().encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def load_reward_hacking_review(path: Path | str) -> RewardHackingReview:
    """Load a fail-closed external review document and hash its exact bytes."""
    review_path = Path(path)
    payload = review_path.read_bytes()
    try:
        raw = json.loads(payload)
    except ValueError as error:
        raise ValueError("reward-hacking review must be valid JSON") from error
    if not isinstance(raw, Mapping):
        raise ValueError("reward-hacking review must be a JSON object")
    if raw.get("schema") != _SCHEMA:
        raise ValueError(f"reward-hacking review schema must be {_SCHEMA}")
    verifier = _required_string(raw, "verifier")
    if verifier.lower() in _SELF_VERIFIERS:
        raise ValueError("reward-hacking review requires an external verifier identity")
    verdict = _required_string(raw, "verdict")
    if verdict not in {"not_hacked", "hacked"}:
        raise ValueError("reward-hacking review verdict must be not_hacked or hacked")
    random_seed = raw.get("random_seed")
    if isinstance(random_seed, bool) or not isinstance(random_seed, int) or random_seed < 0:
        raise ValueError("reward-hacking review random_seed must be non-negative")
    record_digest = _exact_digest(raw, "record_digest")
    review_method = _required_string(raw, "review_method")
    if review_method != "harbor_analyze":
        raise ValueError("reward-hacking review method must be harbor_analyze")
    runner_source = _required_string(raw, "runner_source")
    if re.fullmatch(r"git\+https://.+\.git@[0-9a-f]{40}", runner_source) is None:
        raise ValueError("reward-hacking review runner_source must pin one Git commit")
    return RewardHackingReview(
        verifier=verifier,
        verdict=verdict,
        run_id=_required_string(raw, "run_id"),
        task=_required_string(raw, "task"),
        random_seed=random_seed,
        task_checksum=_required_string(raw, "task_checksum"),
        record_digest=record_digest,
        review_method=review_method,
        judge_agent=_required_string(raw, "judge_agent"),
        judge_model=_required_string(raw, "judge_model"),
        runner_source=runner_source,
        rubric_digest=_exact_digest(raw, "rubric_digest"),
        analysis_artifact=_required_string(raw, "analysis_artifact"),
        analysis_digest=_exact_digest(raw, "analysis_digest"),
        attestation_digest="sha256:" + hashlib.sha256(payload).hexdigest(),
    )


def reward_hacking_review_request(record: RunRecord) -> dict[str, object]:
    """Build the immutable handoff an external reviewer must attest to."""
    if record.suite != "terminal-bench" or not record.success:
        raise ValueError("reward-hacking review applies only to passing Terminal-Bench records")
    checksums = [
        grader.metadata.get("task_checksum")
        for grader in record.grader_results
        if grader.passed and isinstance(grader.metadata.get("task_checksum"), str)
    ]
    if len(checksums) != 1 or not checksums[0]:
        raise ValueError("passing record has no unambiguous official task checksum")
    return {
        "schema": "terminus.terminal-bench-reward-hacking-review-request.v1",
        "review_schema": _SCHEMA,
        "run_id": record.run_id,
        "task": record.task,
        "random_seed": record.random_seed,
        "task_checksum": checksums[0],
        "record_digest": run_record_digest(record),
        "jobs_artifacts": [
            artifact
            for artifact in record.artifacts
            if artifact.get("kind")
            in {"harbor_trials", "benchmark_adapter_manifest", "terminus_trajectory"}
        ],
    }


def harbor_reward_hacking_review_payload(
    record: RunRecord,
    *,
    analysis_path: Path,
    runner_source: str,
    rubric_path: Path,
) -> dict[str, object]:
    """Translate pinned Harbor ``analysis.json`` into the admission schema."""
    analysis_bytes = analysis_path.read_bytes()
    try:
        analysis = json.loads(analysis_bytes)
    except ValueError as error:
        raise ValueError("Harbor analysis.json is not valid JSON") from error
    if not isinstance(analysis, Mapping):
        raise ValueError("Harbor analysis.json must be an object")
    checks = analysis.get("checks")
    reward_check = checks.get("reward_hacking") if isinstance(checks, Mapping) else None
    if not isinstance(reward_check, Mapping):
        raise ValueError("Harbor analysis omitted the reward_hacking check")
    outcome = reward_check.get("outcome")
    if outcome == "pass":
        verdict = "not_hacked"
    elif outcome == "fail":
        verdict = "hacked"
    else:
        raise ValueError("Harbor reward_hacking outcome was not_applicable or malformed")
    task_checksum = _official_task_checksum(record)
    return {
        "schema": _SCHEMA,
        "verifier": "harbor-analyze:claude-code:claude-sonnet-5",
        "verdict": verdict,
        "run_id": record.run_id,
        "task": record.task,
        "random_seed": record.random_seed,
        "task_checksum": task_checksum,
        "record_digest": run_record_digest(record),
        "review_method": "harbor_analyze",
        "judge_agent": "claude-code",
        "judge_model": "claude-sonnet-5",
        "runner_source": runner_source,
        "rubric_digest": "sha256:" + hashlib.sha256(rubric_path.read_bytes()).hexdigest(),
        "analysis_artifact": str(analysis_path.resolve()),
        "analysis_digest": "sha256:" + hashlib.sha256(analysis_bytes).hexdigest(),
        "analysis_summary": str(analysis.get("summary") or ""),
        "analysis_explanation": str(reward_check.get("explanation") or ""),
    }


def admit_reward_hacking_review(
    record: RunRecord,
    review: RewardHackingReview,
) -> RunRecord:
    """Attach a matching external review without changing the original evidence."""
    if record.suite != "terminal-bench" or not record.success:
        raise ValueError("reward-hacking review applies only to passing Terminal-Bench records")
    expected = (record.run_id, record.task, record.random_seed, run_record_digest(record))
    actual = (review.run_id, review.task, review.random_seed, review.record_digest)
    if actual != expected:
        raise ValueError("reward-hacking review does not match the exact run record")

    matching_graders = [
        grader
        for grader in record.grader_results
        if grader.passed and grader.metadata.get("task_checksum") == review.task_checksum
    ]
    if len(matching_graders) != 1:
        raise ValueError("reward-hacking review does not match one official task checksum")

    record.grader_results = [
        replace(
            grader,
            metadata={
                **grader.metadata,
                "reward_hacking_review": review.verdict,
                "reward_hacking_review_verifier": review.verifier,
                "reward_hacking_review_method": review.review_method,
                "reward_hacking_review_judge_agent": review.judge_agent,
                "reward_hacking_review_judge_model": review.judge_model,
                "reward_hacking_review_runner_source": review.runner_source,
                "reward_hacking_review_rubric_digest": review.rubric_digest,
                "reward_hacking_review_attestation_digest": review.attestation_digest,
                "reward_hacking_review_analysis_artifact": review.analysis_artifact,
                "reward_hacking_review_analysis_digest": review.analysis_digest,
                "reward_hacking_review_record_digest": review.record_digest,
            },
        )
        if grader is matching_graders[0]
        else grader
        for grader in record.grader_results
    ]
    record.artifacts.append(
        {
            "kind": "reward_hacking_review_attestation",
            "status": review.verdict,
            "verifier": review.verifier,
            "digest": review.attestation_digest,
            "record_digest": review.record_digest,
            "review_method": review.review_method,
            "judge_agent": review.judge_agent,
            "judge_model": review.judge_model,
            "runner_source": review.runner_source,
            "rubric_digest": review.rubric_digest,
            "analysis_artifact": review.analysis_artifact,
            "analysis_digest": review.analysis_digest,
        }
    )
    return record


def _official_task_checksum(record: RunRecord) -> str:
    checksums = [
        grader.metadata.get("task_checksum")
        for grader in record.grader_results
        if grader.passed and isinstance(grader.metadata.get("task_checksum"), str)
    ]
    if len(checksums) != 1 or not checksums[0]:
        raise ValueError("passing record has no unambiguous official task checksum")
    return str(checksums[0])


def _required_string(row: Mapping[str, object], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"reward-hacking review {key} must be a non-empty string")
    return value.strip()


def _exact_digest(row: Mapping[str, object], key: str) -> str:
    value = _required_string(row, key)
    if _DIGEST.fullmatch(value) is None:
        raise ValueError(f"reward-hacking review {key} must be an exact sha256 digest")
    return value
