"""Reproducible, paired Harbor campaign orchestration.

Harbor's ``results.json`` is a useful execution envelope, but it is not a
paired-evaluation record by itself.  This module puts an exact task/model
identity around one result, normalizes Harbor's optional agent telemetry, and
keeps configuration or infrastructure failures out of the scored sample.

The runner is deliberately command-oriented: each harness is given its own
fully pinned ``harbor run`` command.  That makes Terminus, Pi, and OpenCode
comparable without importing their private APIs or pretending that one
harness's telemetry is available in another harness.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

from ..evidence import EvidenceClass
from ..identity import EvaluationIdentity
from ..run_record import CostBreakdown, GraderResult, Outcome, RunRecord

__all__ = [
    "CampaignFailure",
    "CampaignFailureKind",
    "HarborCampaignError",
    "HarborCampaignResult",
    "HarborCampaignSpec",
    "HarborHarnessCommand",
    "HarborHarnessIdentity",
    "HarborTaskIdentity",
    "HarborTrialStatus",
    "NormalizedHarborTrial",
    "normalize_harbor_result",
    "run_harbor_campaign",
]


class HarborCampaignError(ValueError):
    """Raised when a Harbor result cannot be trusted for this campaign."""


HarborTrialStatus = Literal[
    "scored",
    "configuration_failure",
    "infrastructure_failure",
]
CampaignFailureKind = Literal["configuration", "infrastructure"]


@dataclass(frozen=True)
class HarborTaskIdentity:
    """Exact identity of the task all campaign members must execute."""

    dataset: str
    dataset_version: str
    source: str
    task_name: str
    task_id: str
    task_checksum: str

    def __post_init__(self) -> None:
        for name, value in (
            ("dataset", self.dataset),
            ("dataset_version", self.dataset_version),
            ("source", self.source),
            ("task_name", self.task_name),
            ("task_id", self.task_id),
            ("task_checksum", self.task_checksum),
        ):
            if not value.strip():
                raise ValueError(f"{name} must be non-empty")

    def to_dict(self) -> dict[str, str]:
        return {
            "dataset": self.dataset,
            "dataset_version": self.dataset_version,
            "source": self.source,
            "task_name": self.task_name,
            "task_id": self.task_id,
            "task_checksum": self.task_checksum,
        }


@dataclass(frozen=True)
class HarborHarnessIdentity:
    """The harness identity supplied by the pinned campaign command."""

    harness_id: str
    harness_commit: str
    harness_config_hash: str

    def __post_init__(self) -> None:
        for name, value in (
            ("harness_id", self.harness_id),
            ("harness_commit", self.harness_commit),
            ("harness_config_hash", self.harness_config_hash),
        ):
            if not value.strip():
                raise ValueError(f"{name} must be non-empty")


@dataclass(frozen=True)
class HarborCampaignSpec:
    """Shared identity and policy for every harness in a paired campaign."""

    suite_id: str
    task: HarborTaskIdentity
    provider: str
    model: str
    model_version: str
    model_capability_snapshot_hash: str
    random_seed: int
    repository_digest: str
    environment_digest: str
    sampling_config_hash: str
    sandbox_policy_hash: str
    network_policy: str
    budget_hash: str
    tool_schema_hash: str
    instruction_hash: str

    def __post_init__(self) -> None:
        if self.random_seed < 0:
            raise ValueError("random_seed must be non-negative")
        for name, value in (
            ("suite_id", self.suite_id),
            ("provider", self.provider),
            ("model", self.model),
            ("model_version", self.model_version),
            ("model_capability_snapshot_hash", self.model_capability_snapshot_hash),
            ("repository_digest", self.repository_digest),
            ("environment_digest", self.environment_digest),
            ("sampling_config_hash", self.sampling_config_hash),
            ("sandbox_policy_hash", self.sandbox_policy_hash),
            ("network_policy", self.network_policy),
            ("budget_hash", self.budget_hash),
            ("tool_schema_hash", self.tool_schema_hash),
            ("instruction_hash", self.instruction_hash),
        ):
            if not value.strip():
                raise ValueError(f"{name} must be non-empty")


@dataclass(frozen=True)
class HarborHarnessCommand:
    """One executable Harbor invocation and its expected result location."""

    identity: HarborHarnessIdentity
    argv: tuple[str, ...]
    result_path: Path
    environment: Mapping[str, str] = field(default_factory=dict)
    timeout_seconds: float = 14_400.0

    def __post_init__(self) -> None:
        if not self.argv or not self.argv[0].strip():
            raise ValueError("argv must contain an executable")
        if self.timeout_seconds <= 0 or not math.isfinite(self.timeout_seconds):
            raise ValueError("timeout_seconds must be finite and positive")


@dataclass(frozen=True)
class CampaignFailure:
    """A command-level failure excluded from paired scored statistics."""

    harness: HarborHarnessIdentity
    kind: CampaignFailureKind
    reason: str
    returncode: int | None = None
    stderr_tail: str = ""


@dataclass(frozen=True)
class NormalizedHarborTrial:
    """Typed metrics extracted from one valid, identity-checked result."""

    task: HarborTaskIdentity
    harness: HarborHarnessIdentity
    provider: str
    model: str
    model_version: str
    random_seed: int
    reward: float
    passed: bool
    steps: int | None
    tokens_input_total: int | None
    tokens_input_cached: int | None
    tokens_output: int | None
    tokens_reasoning: int | None
    cache_hit_ratio: float | None
    wall_clock_ms: int | None
    provider_cost_usd: float | None
    result_path: Path
    exception: str | None = None

    def to_run_record(self, spec: HarborCampaignSpec) -> RunRecord:
        """Project this scored trial into the repository's paired-record schema."""
        total_input = self.tokens_input_total or 0
        cached = self.tokens_input_cached or 0
        output = self.tokens_output or 0
        reasoning = self.tokens_reasoning or 0
        cost = None
        if self.tokens_input_total is not None or self.tokens_output is not None:
            reported = self.provider_cost_usd
            cost = CostBreakdown(
                provider_reported_usd=reported,
                computed_usd=reported if reported is not None else 0.0,
                input_tokens=max(0, total_input - cached),
                output_tokens=output,
                cached_tokens=cached,
                reasoning_tokens=reasoning,
                cache_read_tokens=cached,
                source="harbor_provider_reported" if reported is not None else "unpriced",
            )
        identity = EvaluationIdentity(
            task_id=spec.task.task_name,
            task_version=f"{spec.task.dataset}@{spec.task.dataset_version}",
            repository_digest=spec.repository_digest,
            environment_digest=spec.environment_digest,
            harness_id=self.harness.harness_id,
            harness_commit=self.harness.harness_commit,
            harness_config_hash=self.harness.harness_config_hash,
            provider=self.provider,
            model=self.model,
            model_version=self.model_version,
            model_capability_snapshot_hash=spec.model_capability_snapshot_hash,
            random_seed=spec.random_seed,
            sampling_config_hash=spec.sampling_config_hash,
            sandbox_policy_hash=spec.sandbox_policy_hash,
            network_policy=spec.network_policy,
            budget_hash=spec.budget_hash,
            tool_schema_hash=spec.tool_schema_hash,
            instruction_hash=spec.instruction_hash,
        )
        grader = GraderResult(
            grader_id=f"harbor:{spec.task.dataset}@{spec.task.dataset_version}",
            grader_version="harbor-trial-result-v1",
            passed=self.passed,
            score=self.reward,
            evidence=[f"result={self.result_path}"],
            metadata={
                "status": "scored",
                "task_checksum": self.task.task_checksum,
                "source": self.task.source,
            },
        )
        record = RunRecord.new(
            suite=spec.suite_id,
            task=spec.task.task_name,
            harness=self.harness.harness_id,
            harness_commit=self.harness.harness_commit,
            environment_digest=spec.environment_digest,
            random_seed=spec.random_seed,
            model_capability_snapshot={
                "provider": self.provider,
                "model": self.model,
                "model_version": self.model_version,
                "capability_snapshot_hash": spec.model_capability_snapshot_hash,
            },
            budgets={"budget_hash": spec.budget_hash},
            evaluation_identity=identity,
            evidence_class=EvidenceClass.EXTERNAL_LIVE,
            independently_verified=True,
            provider_receipts=[
                {
                    "receipt_id": f"harbor:{self.result_path}",
                    "provider": self.provider,
                    "model": self.model,
                    "verified": True,
                    "artifact_ref": str(self.result_path),
                }
            ],
        )
        record.outcome = Outcome.COMPLETED if self.passed else Outcome.FAILED
        record.grader_results = [grader]
        record.cost = cost
        record.tokens_input_fresh = max(0, total_input - cached)
        record.tokens_input_cached = cached
        record.tokens_output = output
        record.tokens_reasoning = reasoning
        record.cache_hit_ratio = self.cache_hit_ratio
        record.steps = self.steps or 0
        record.wall_clock_ms = self.wall_clock_ms
        record.harness_verdict = {"status": "scored", "admitted": self.passed}
        record.artifacts = [
            {
                "kind": "harbor_result",
                "path": str(self.result_path),
                "task": self.task.to_dict(),
            }
        ]
        return record


@dataclass(frozen=True)
class HarborCampaignResult:
    """Scored records plus explicitly separated command failures."""

    records: tuple[RunRecord, ...]
    failures: tuple[CampaignFailure, ...]


def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise HarborCampaignError(f"{label} must be an object")
    return value


def _required_text(raw: Mapping[str, object], key: str, label: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise HarborCampaignError(f"{label}.{key} must be a non-empty string")
    return value


def _nonnegative_int(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise HarborCampaignError(f"{label} must be a non-negative integer")
    return value


def _optional_nonnegative_int(raw: Mapping[str, object], key: str, label: str) -> int | None:
    value = raw.get(key)
    if value is None:
        return None
    return _nonnegative_int(value, f"{label}.{key}")


def _optional_nonnegative_float(raw: Mapping[str, object], key: str, label: str) -> float | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise HarborCampaignError(f"{label}.{key} must be a non-negative number")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise HarborCampaignError(f"{label}.{key} must be a finite non-negative number")
    return number


def _datetime(raw: Mapping[str, object], key: str, label: str) -> datetime | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise HarborCampaignError(f"{label}.{key} must be an ISO timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise HarborCampaignError(f"{label}.{key} is not an ISO timestamp") from error


def _classify_exception(exception: str) -> CampaignFailureKind:
    lowered = exception.lower()
    if any(word in lowered for word in ("api key", "credential", "authentication", "model")):
        return "configuration"
    return "infrastructure"


def _usage(raw: Mapping[str, object], label: str) -> tuple[int | None, int | None, int | None, float | None, int | None]:
    contexts: list[Mapping[str, object]] = []
    agent_result = raw.get("agent_result")
    if isinstance(agent_result, Mapping):
        contexts.append(agent_result)
    steps = raw.get("step_results")
    if isinstance(steps, list):
        for index, item in enumerate(steps):
            step = _mapping(item, f"{label}.step_results[{index}]")
            context = step.get("agent_result")
            if isinstance(context, Mapping):
                contexts.append(context)
    elif steps is not None:
        raise HarborCampaignError(f"{label}.step_results must be a list")
    if not contexts:
        return None, None, None, None, None
    input_tokens = 0
    cached_tokens = 0
    output_tokens = 0
    costs: list[float] = []
    for index, context in enumerate(contexts):
        for key, target in (
            ("n_input_tokens", "input"),
            ("n_cache_tokens", "cached"),
            ("n_output_tokens", "output"),
        ):
            value = context.get(key)
            if value is None:
                continue
            parsed = _nonnegative_int(value, f"{label}.agent_result[{index}].{key}")
            if target == "input":
                input_tokens += parsed
            elif target == "cached":
                cached_tokens += parsed
            else:
                output_tokens += parsed
        cost = _optional_nonnegative_float(context, "cost_usd", f"{label}.agent_result[{index}]")
        if cost is not None:
            costs.append(cost)
    step_count = len(steps) if isinstance(steps, list) and steps else len(contexts)
    return input_tokens, cached_tokens, output_tokens, sum(costs) if costs else None, step_count


def normalize_harbor_result(
    result_path: Path,
    *,
    spec: HarborCampaignSpec,
    harness: HarborHarnessIdentity,
) -> NormalizedHarborTrial | CampaignFailure:
    """Read one Harbor result and reject any mismatch before scoring it."""
    try:
        raw_value = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return CampaignFailure(harness, "infrastructure", f"cannot read result: {error}")
    raw = _mapping(raw_value, "result")
    label = str(result_path)
    task_name = _required_text(raw, "task_name", label)
    task_id = _required_text(raw, "task_id", label)
    checksum = _required_text(raw, "task_checksum", label)
    source = _required_text(raw, "source", label)
    for observed, expected, key in (
        (task_name, spec.task.task_name, "task_name"),
        (task_id, spec.task.task_id, "task_id"),
        (checksum, spec.task.task_checksum, "task_checksum"),
        (source, spec.task.source, "source"),
    ):
        if observed != expected:
            raise HarborCampaignError(
                f"task identity mismatch for {key}: expected {expected!r}, got {observed!r}"
            )
    for key, expected in (("dataset", spec.task.dataset), ("dataset_version", spec.task.dataset_version)):
        if key in raw and raw[key] != expected:
            raise HarborCampaignError(
                f"task identity mismatch for {key}: expected {expected!r}, got {raw[key]!r}"
            )
    agent = _mapping(raw.get("agent_info"), f"{label}.agent_info")
    _required_text(agent, "name", f"{label}.agent_info")
    model_info = _mapping(agent.get("model_info"), f"{label}.agent_info.model_info")
    observed_model = _required_text(model_info, "name", f"{label}.agent_info.model_info")
    observed_provider = model_info.get("provider")
    if observed_model != spec.model:
        raise HarborCampaignError(
            f"model identity mismatch: expected {spec.model!r}, got {observed_model!r}"
        )
    if not isinstance(observed_provider, str) or not observed_provider.strip():
        raise HarborCampaignError("provider identity is missing from Harbor model_info")
    if observed_provider != spec.provider:
        raise HarborCampaignError(
            f"provider identity mismatch: expected {spec.provider!r}, got {observed_provider!r}"
        )
    verifier = raw.get("verifier_result")
    verifier_map = _mapping(verifier, f"{label}.verifier_result") if verifier is not None else None
    rewards = verifier_map.get("rewards") if verifier_map is not None else None
    rewards_map = _mapping(rewards, f"{label}.verifier_result.rewards") if rewards is not None else None
    if rewards_map:
        values: list[float] = []
        for key, value in rewards_map.items():
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
                raise HarborCampaignError(f"{label}.verifier_result.rewards.{key} must be finite")
            values.append(float(value))
        primary = rewards_map.get("reward")
        reward = float(primary) if isinstance(primary, (int, float)) else sum(values) / len(values)
        if not 0.0 <= reward <= 1.0:
            raise HarborCampaignError(f"{label}.verifier_result reward must be in [0, 1]")
    else:
        exception_map = raw.get("exception_info")
        exception = None
        if isinstance(exception_map, Mapping):
            exception = ": ".join(
                part
                for part in (exception_map.get("exception_type"), exception_map.get("exception_message"))
                if isinstance(part, str) and part
            )
        if exception is None:
            exception = "Harbor produced no verifier rewards"
        return CampaignFailure(harness, _classify_exception(exception), exception)
    exception_map = raw.get("exception_info")
    exception = None
    if isinstance(exception_map, Mapping):
        exception = ": ".join(
            part
            for part in (exception_map.get("exception_type"), exception_map.get("exception_message"))
            if isinstance(part, str) and part
        ) or None
    started = _datetime(raw, "started_at", label)
    finished = _datetime(raw, "finished_at", label)
    wall_clock_ms = None
    if started is not None and finished is not None:
        elapsed = (finished - started).total_seconds()
        if elapsed < 0:
            raise HarborCampaignError(f"{label}.finished_at precedes started_at")
        wall_clock_ms = round(elapsed * 1_000)
    input_tokens, cached_tokens, output_tokens, cost, steps = _usage(raw, label)
    cache_ratio = None
    if input_tokens:
        if cached_tokens is not None and cached_tokens > input_tokens:
            raise HarborCampaignError(f"{label} cache tokens exceed input tokens")
        cache_ratio = cached_tokens / input_tokens if cached_tokens is not None else 0.0
    return NormalizedHarborTrial(
        task=spec.task,
        harness=harness,
        provider=spec.provider,
        model=observed_model,
        model_version=spec.model_version,
        random_seed=spec.random_seed,
        reward=reward,
        passed=reward >= 1.0 and exception is None,
        steps=steps,
        tokens_input_total=input_tokens,
        tokens_input_cached=cached_tokens,
        tokens_output=output_tokens,
        tokens_reasoning=None,
        cache_hit_ratio=cache_ratio,
        wall_clock_ms=wall_clock_ms,
        provider_cost_usd=cost,
        result_path=result_path,
        exception=exception,
    )


def _failure_kind(stderr: str) -> CampaignFailureKind:
    lowered = stderr.lower()
    return "configuration" if any(word in lowered for word in ("api key", "credential", "authentication", "model")) else "infrastructure"


def run_harbor_campaign(
    spec: HarborCampaignSpec,
    commands: Sequence[HarborHarnessCommand],
) -> HarborCampaignResult:
    """Run each pinned command once and return only identity-valid scored records."""
    records: list[RunRecord] = []
    failures: list[CampaignFailure] = []
    seen_harnesses: set[str] = set()
    for command in commands:
        name = command.identity.harness_id
        if name in seen_harnesses:
            raise HarborCampaignError(f"duplicate harness in campaign: {name}")
        seen_harnesses.add(name)
        env = os.environ.copy()
        env.update({str(key): str(value) for key, value in command.environment.items()})
        try:
            completed = subprocess.run(
                list(command.argv),
                cwd=command.result_path.parent,
                env=env,
                capture_output=True,
                text=True,
                timeout=command.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as error:
            failures.append(CampaignFailure(command.identity, "infrastructure", str(error)))
            continue
        except subprocess.TimeoutExpired as error:
            failures.append(CampaignFailure(command.identity, "infrastructure", f"timed out: {error}"))
            continue
        if completed.returncode != 0 and not command.result_path.is_file():
            failures.append(
                CampaignFailure(
                    command.identity,
                    _failure_kind(completed.stderr),
                    f"Harbor exited {completed.returncode}",
                    completed.returncode,
                    completed.stderr[-4_000:],
                )
            )
            continue
        normalized = normalize_harbor_result(command.result_path, spec=spec, harness=command.identity)
        if isinstance(normalized, CampaignFailure):
            failures.append(normalized)
            continue
        records.append(normalized.to_run_record(spec))
    return HarborCampaignResult(tuple(records), tuple(failures))
