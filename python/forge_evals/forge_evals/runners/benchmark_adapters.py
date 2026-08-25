"""External benchmark adapter boundaries (SPEC §41.2, §41.3).

The eval lab owns the canonical suite manifest and the translation into an
external harness request. It does not own Harbor or the SWE-bench runner.
Those dependencies are injected at the boundary and must report the resolved
container digest before a run can be recorded.

Fixture harnesses remain in :mod:`baseline_adapters`. They are intentionally
separate from these adapters and cannot produce benchmark evidence.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal, Protocol

import yaml

from .baseline_adapters import ExternalHarnessUnavailable
from .harness_runner import HarnessResult, RunRequest
from .trajectory_recorder import TrajectoryRecorder

__all__ = [
    "SWE_BENCH_HARNESS_COMMIT",
    "SWE_BENCH_VERIFIED_REVISION",
    "TERMINAL_BENCH_HARBOR_COMMIT",
    "TERMINAL_BENCH_TASK_COMMIT",
    "BenchmarkAdapter",
    "BenchmarkAdapterError",
    "BenchmarkExecution",
    "BenchmarkInvocation",
    "BenchmarkManifest",
    "BenchmarkManifestError",
    "HarborAdapter",
    "HarborTerminalBenchAdapter",
    "LiveBenchmarkHarness",
    "SWEBenchVerifiedAdapter",
    "SweBenchVerifiedAdapter",
    "TranslatedTaskManifest",
    "adapter_for_suite",
    "load_benchmark_manifest",
]

BenchmarkKind = Literal["harbor", "swebench"]

TERMINAL_BENCH_REGISTRY_REPOSITORY = "https://github.com/harbor-framework/harbor.git"
TERMINAL_BENCH_HARBOR_COMMIT = "72f7dd0134162c5b7229f6a31286e05a49c0f8a4"
TERMINAL_BENCH_TASK_REPOSITORY = "https://github.com/laude-institute/terminal-bench-2.git"
TERMINAL_BENCH_TASK_COMMIT = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c"
SWE_BENCH_DATASET = "SWE-bench/SWE-bench_Verified"
SWE_BENCH_VERIFIED_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
SWE_BENCH_HARNESS_REPOSITORY = "https://github.com/SWE-bench/SWE-bench.git"
SWE_BENCH_HARNESS_COMMIT = "7a21e05772954cc81471ae19d56f436cecf43c54"

_GIT_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_SHA256_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_ALL_ZERO_DIGEST = "sha256:" + "0" * 64


class BenchmarkManifestError(ValueError):
    """Raised when an external benchmark manifest is not exact enough to run."""


class BenchmarkAdapterError(RuntimeError):
    """Raised when a live adapter returns incomplete or unverifiable evidence."""


@dataclass(frozen=True)
class BenchmarkManifest:
    """Validated, exact pin set for one external benchmark suite."""

    suite_id: str
    suite_version: int
    adapter_kind: BenchmarkKind
    dataset: str
    dataset_version: str | None
    dataset_revision: str
    task_count: int
    source: str
    cohorts: tuple[str, ...]
    image_digest_policy: str
    harness_repository: str
    harness_commit: str
    task_repository: str | None = None
    task_commit: str | None = None
    split: str | None = None
    language: str | None = None
    registry_repository: str | None = None
    registry_commit: str | None = None
    registry_path: str | None = None

    @classmethod
    def from_mapping(cls, raw: Mapping[str, object]) -> BenchmarkManifest:
        """Parse and validate a suite YAML mapping.

        Only the two external benchmark formats are accepted here. The
        internal fixture suite deliberately has no external adapter section.
        """

        suite = _mapping(raw.get("suite"), "suite")
        suite_id = _string(suite, "id", "suite.id")
        suite_version = _positive_int(suite, "version", "suite.version")
        task_count = _positive_int(suite, "task_count", "suite.task_count")
        source = _https_url(suite, "source", "suite.source")
        cohorts = _string_tuple(suite, "cohorts", "suite.cohorts")
        adapter = _mapping(suite.get("adapter"), "suite.adapter")
        kind = _literal(adapter, "kind", "suite.adapter.kind", ("harbor", "swebench"))

        # A benchmark with per-task or per-instance images must never be
        # represented by a guessed suite-wide image digest.
        if "pinned_image_digest" in suite:
            raise BenchmarkManifestError(
                f"{suite_id}: suite-wide pinned_image_digest is not valid for {kind}; "
                "the live harness must report each resolved image digest"
            )

        harness = _mapping(adapter.get("harness"), "suite.adapter.harness")
        harness_repository = _https_url(harness, "repository", "suite.adapter.harness.repository")
        harness_commit = _commit(harness, "commit", "suite.adapter.harness.commit")
        adapter_task_count = _positive_int(adapter, "task_count", "suite.adapter.task_count")
        if adapter_task_count != task_count:
            raise BenchmarkManifestError(
                f"{suite_id}: suite.task_count ({task_count}) does not match "
                f"suite.adapter.task_count ({adapter_task_count})"
            )

        if kind == "harbor":
            return cls._from_harbor(
                suite_id=suite_id,
                suite_version=suite_version,
                task_count=task_count,
                source=source,
                cohorts=cohorts,
                adapter=adapter,
                harness_repository=harness_repository,
                harness_commit=harness_commit,
            )

        return cls._from_swebench(
            suite_id=suite_id,
            suite_version=suite_version,
            task_count=task_count,
            source=source,
            cohorts=cohorts,
            adapter=adapter,
            harness_repository=harness_repository,
            harness_commit=harness_commit,
        )

    @classmethod
    def _from_harbor(
        cls,
        *,
        suite_id: str,
        suite_version: int,
        task_count: int,
        source: str,
        cohorts: tuple[str, ...],
        adapter: Mapping[str, object],
        harness_repository: str,
        harness_commit: str,
    ) -> BenchmarkManifest:
        if suite_id != "terminal-bench":
            raise BenchmarkManifestError(
                f"Harbor adapter must be used by suite terminal-bench, got {suite_id!r}"
            )
        if task_count != 89:
            raise BenchmarkManifestError(
                f"terminal-bench@2.0 must contain exactly 89 tasks, got {task_count}"
            )
        if harness_repository != TERMINAL_BENCH_REGISTRY_REPOSITORY:
            raise BenchmarkManifestError(
                "terminal-bench harness repository is not the pinned Harbor repository"
            )
        if harness_commit != TERMINAL_BENCH_HARBOR_COMMIT:
            raise BenchmarkManifestError(
                "terminal-bench Harbor commit does not match the pinned registry snapshot"
            )

        dataset = _string(adapter, "dataset", "suite.adapter.dataset")
        dataset_version = _string(adapter, "dataset_version", "suite.adapter.dataset_version")
        if dataset != "terminal-bench" or dataset_version != "2.0":
            raise BenchmarkManifestError("Harbor adapter must pin the terminal-bench@2.0 dataset")

        registry = _mapping(adapter.get("registry"), "suite.adapter.registry")
        registry_repository = _https_url(
            registry, "repository", "suite.adapter.registry.repository"
        )
        registry_commit = _commit(registry, "commit", "suite.adapter.registry.commit")
        registry_path = _string(registry, "path", "suite.adapter.registry.path")
        if registry_repository != TERMINAL_BENCH_REGISTRY_REPOSITORY:
            raise BenchmarkManifestError(
                "terminal-bench registry repository does not match the Harbor pin"
            )
        if registry_commit != TERMINAL_BENCH_HARBOR_COMMIT or registry_path != "registry.json":
            raise BenchmarkManifestError(
                "terminal-bench registry path or commit does not match the exact pin"
            )

        task_source = _mapping(adapter.get("task_source"), "suite.adapter.task_source")
        task_repository = _https_url(
            task_source, "repository", "suite.adapter.task_source.repository"
        )
        task_commit = _commit(task_source, "commit", "suite.adapter.task_source.commit")
        if (
            task_repository != TERMINAL_BENCH_TASK_REPOSITORY
            or task_commit != TERMINAL_BENCH_TASK_COMMIT
        ):
            raise BenchmarkManifestError(
                "terminal-bench task source does not match the exact Harbor registry pin"
            )

        image_digest_policy = _string(
            adapter, "image_digest_policy", "suite.adapter.image_digest_policy"
        )
        if image_digest_policy != "per_task_required":
            raise BenchmarkManifestError(
                "terminal-bench requires one resolved image digest per task"
            )

        return cls(
            suite_id=suite_id,
            suite_version=suite_version,
            adapter_kind="harbor",
            dataset=dataset,
            dataset_version=dataset_version,
            dataset_revision=registry_commit,
            task_count=task_count,
            source=source,
            cohorts=cohorts,
            image_digest_policy=image_digest_policy,
            harness_repository=harness_repository,
            harness_commit=harness_commit,
            task_repository=task_repository,
            task_commit=task_commit,
            registry_repository=registry_repository,
            registry_commit=registry_commit,
            registry_path=registry_path,
        )

    @classmethod
    def _from_swebench(
        cls,
        *,
        suite_id: str,
        suite_version: int,
        task_count: int,
        source: str,
        cohorts: tuple[str, ...],
        adapter: Mapping[str, object],
        harness_repository: str,
        harness_commit: str,
    ) -> BenchmarkManifest:
        if suite_id != "swe-bench-verified":
            raise BenchmarkManifestError(
                f"SWE-bench adapter must be used by suite swe-bench-verified, got {suite_id!r}"
            )
        if task_count != 500:
            raise BenchmarkManifestError(
                f"SWE-bench Verified must contain exactly 500 tasks, got {task_count}"
            )
        if cohorts != ("python-repos",):
            raise BenchmarkManifestError(
                "SWE-bench Verified scope must be exactly ['python-repos']"
            )
        if harness_repository != SWE_BENCH_HARNESS_REPOSITORY:
            raise BenchmarkManifestError(
                "SWE-bench harness repository is not the pinned upstream repository"
            )
        if harness_commit != SWE_BENCH_HARNESS_COMMIT:
            raise BenchmarkManifestError(
                "SWE-bench harness commit does not match the pinned evaluator"
            )

        dataset = _string(adapter, "dataset", "suite.adapter.dataset")
        split = _string(adapter, "split", "suite.adapter.split")
        revision = _commit(adapter, "revision", "suite.adapter.revision")
        language = _string(adapter, "language", "suite.adapter.language").lower()
        image_digest_policy = _string(
            adapter, "image_digest_policy", "suite.adapter.image_digest_policy"
        )
        if dataset != SWE_BENCH_DATASET or split != "test":
            raise BenchmarkManifestError(
                "SWE-bench adapter must pin SWE-bench/SWE-bench_Verified split test"
            )
        if revision != SWE_BENCH_VERIFIED_REVISION:
            raise BenchmarkManifestError(
                "SWE-bench Verified dataset revision does not match the exact pin"
            )
        if language != "python":
            raise BenchmarkManifestError(
                "SWE-bench Verified adapter is restricted to the canonical Python scope"
            )
        if image_digest_policy != "per_instance_required":
            raise BenchmarkManifestError(
                "SWE-bench Verified requires one resolved image digest per instance"
            )

        return cls(
            suite_id=suite_id,
            suite_version=suite_version,
            adapter_kind="swebench",
            dataset=dataset,
            dataset_version=None,
            dataset_revision=revision,
            task_count=task_count,
            source=source,
            cohorts=cohorts,
            image_digest_policy=image_digest_policy,
            harness_repository=harness_repository,
            harness_commit=harness_commit,
            split=split,
            language=language,
        )

    def to_dict(self) -> dict[str, object]:
        """Return the exact pin set without adding runtime evidence."""

        adapter: dict[str, object] = {
            "kind": self.adapter_kind,
            "dataset": self.dataset,
            "task_count": self.task_count,
            "image_digest_policy": self.image_digest_policy,
            "harness": {
                "repository": self.harness_repository,
                "commit": self.harness_commit,
            },
        }
        if self.dataset_version is not None:
            adapter["dataset_version"] = self.dataset_version
        if self.adapter_kind == "swebench":
            adapter["revision"] = self.dataset_revision
        if self.split is not None:
            adapter["split"] = self.split
        if self.language is not None:
            adapter["language"] = self.language
        if self.adapter_kind == "harbor":
            adapter["registry"] = {
                "repository": self.registry_repository,
                "commit": self.registry_commit,
                "path": self.registry_path,
            }
            adapter["task_source"] = {
                "repository": self.task_repository,
                "commit": self.task_commit,
            }
        return {
            "suite": {
                "id": self.suite_id,
                "version": self.suite_version,
                "source": self.source,
                "task_count": self.task_count,
                "cohorts": list(self.cohorts),
                "adapter": adapter,
            }
        }


@dataclass(frozen=True)
class TranslatedTaskManifest:
    """Canonical task identity translated to an external harness format."""

    adapter_kind: BenchmarkKind
    suite_id: str
    task_id: str
    dataset: str
    dataset_version: str | None
    dataset_revision: str
    task_count: int
    image_digest_policy: str
    harness_repository: str
    harness_commit: str
    task_repository: str | None = None
    task_commit: str | None = None
    split: str | None = None
    language: str | None = None

    def to_dict(self) -> dict[str, object]:
        """Return the translated manifest used by the live runner."""

        return {
            "adapter_kind": self.adapter_kind,
            "suite_id": self.suite_id,
            "task_id": self.task_id,
            "dataset": self.dataset,
            "dataset_version": self.dataset_version,
            "dataset_revision": self.dataset_revision,
            "task_count": self.task_count,
            "image_digest_policy": self.image_digest_policy,
            "harness_repository": self.harness_repository,
            "harness_commit": self.harness_commit,
            "task_repository": self.task_repository,
            "task_commit": self.task_commit,
            "split": self.split,
            "language": self.language,
        }


@dataclass(frozen=True)
class BenchmarkInvocation:
    """An external execution request produced by an adapter."""

    executable: str
    argv: tuple[str, ...] | None
    task_manifest: TranslatedTaskManifest
    notes: str = ""

    def to_dict(self) -> dict[str, object]:
        """Return a log-safe invocation description."""

        return {
            "executable": self.executable,
            "argv": list(self.argv) if self.argv is not None else None,
            "task_manifest": self.task_manifest.to_dict(),
            "notes": self.notes,
        }


@dataclass(frozen=True)
class BenchmarkExecution:
    """Result returned by a live harness boundary.

    Image digests are supplied by the harness after pulling or resolving the
    task image. They are deliberately not inferred from tags or invented by
    the adapter.
    """

    harness_result: HarnessResult
    resolved_image_digests: tuple[str, ...]


class LiveBenchmarkHarness(Protocol):
    """The only execution dependency accepted by an external adapter."""

    def is_available(self) -> bool:
        """Return whether the pinned live harness and its runtime are usable."""
        ...

    def run(
        self,
        invocation: BenchmarkInvocation,
        request: RunRequest,
        recorder: TrajectoryRecorder,
    ) -> BenchmarkExecution:
        """Execute one translated task and return independently resolved evidence."""
        ...


class BenchmarkAdapter(Protocol):
    """Harness-compatible interface for an external benchmark adapter."""

    manifest: BenchmarkManifest

    def translate(self, request: RunRequest) -> BenchmarkInvocation:
        """Translate one canonical request into an external harness request."""
        ...

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        """Run through an injected live harness, or fail closed."""
        ...


class _ExternalBenchmarkAdapter(ABC):
    """Shared validation and execution boundary for external benchmark adapters."""

    _adapter_kind: BenchmarkKind
    _executable: str

    def __init__(
        self,
        manifest: BenchmarkManifest,
        live_harness: LiveBenchmarkHarness | None = None,
    ) -> None:
        if manifest.adapter_kind != self._adapter_kind:
            raise BenchmarkManifestError(
                f"expected {self._adapter_kind} manifest, got {manifest.adapter_kind}"
            )
        self.manifest = manifest
        self._live_harness = live_harness

    def _translated_task_manifest(self, request: RunRequest) -> TranslatedTaskManifest:
        if request.suite != self.manifest.suite_id:
            raise BenchmarkAdapterError(
                f"benchmark request suite {request.suite!r} does not match "
                f"adapter manifest {self.manifest.suite_id!r}"
            )
        if not request.task.strip():
            raise BenchmarkAdapterError("benchmark task id is required")
        return TranslatedTaskManifest(
            adapter_kind=self.manifest.adapter_kind,
            suite_id=self.manifest.suite_id,
            task_id=request.task,
            dataset=self.manifest.dataset,
            dataset_version=self.manifest.dataset_version,
            dataset_revision=self.manifest.dataset_revision,
            task_count=self.manifest.task_count,
            image_digest_policy=self.manifest.image_digest_policy,
            harness_repository=self.manifest.harness_repository,
            harness_commit=self.manifest.harness_commit,
            task_repository=self.manifest.task_repository,
            task_commit=self.manifest.task_commit,
            split=self.manifest.split,
            language=self.manifest.language,
        )

    @abstractmethod
    def translate(self, request: RunRequest) -> BenchmarkInvocation:
        """Translate one canonical request for the concrete benchmark."""
        ...

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        """Execute one live task without manufacturing a degraded result."""

        invocation = self.translate(request)
        live_harness = self._live_harness
        if live_harness is None:
            raise ExternalHarnessUnavailable(
                f"{self.manifest.suite_id}: live {self._executable} harness is unavailable; "
                "fixture mode remains non-release"
            )
        if not live_harness.is_available():
            raise ExternalHarnessUnavailable(
                f"{self.manifest.suite_id}: pinned {self._executable} harness is unavailable"
            )

        execution = live_harness.run(invocation, request, recorder)
        if not isinstance(execution, BenchmarkExecution):
            raise BenchmarkAdapterError(
                "live benchmark harness returned no BenchmarkExecution boundary result"
            )
        environment_digest = _validate_execution(execution, self.manifest)

        evidence_artifact = {
            "type": "benchmark_adapter_manifest",
            "evidence_status": "unverified",
            "invocation": invocation.to_dict(),
            "resolved_image_digests": list(execution.resolved_image_digests),
        }
        notes = execution.harness_result.notes.strip()
        adapter_note = (
            "external benchmark adapter; release evidence requires independent verification"
        )
        notes = f"{notes}; {adapter_note}" if notes else adapter_note
        return replace(
            execution.harness_result,
            artifacts=[evidence_artifact, *execution.harness_result.artifacts],
            notes=notes,
            environment_digest=environment_digest,
        )


class HarborTerminalBenchAdapter(_ExternalBenchmarkAdapter):
    """Translate Terminal-Bench 2.0 requests into Harbor invocations."""

    _adapter_kind: BenchmarkKind = "harbor"
    _executable = "harbor"

    def translate(self, request: RunRequest) -> BenchmarkInvocation:
        """Build the pinned Harbor CLI request for one Terminal-Bench task."""

        task_manifest = self._translated_task_manifest(request)
        if request.model_snapshot.model.strip() == "":
            raise BenchmarkAdapterError("a model is required for a Harbor invocation")
        if self.manifest.dataset_version is None:
            raise BenchmarkManifestError("Harbor manifest is missing dataset_version")
        dataset_ref = f"{self.manifest.dataset}@{self.manifest.dataset_version}"
        argv = (
            self._executable,
            "run",
            "--dataset",
            dataset_ref,
            "--agent",
            request.harness_id,
            "--model",
            request.model_snapshot.model,
            "--n-concurrent",
            "1",
            "--include-task-name",
            request.task,
        )
        return BenchmarkInvocation(
            executable=self._executable,
            argv=argv,
            task_manifest=task_manifest,
            notes=(
                "Harbor resolves the exact registry/task pins. The live runner must "
                "return the task image digest before this result is usable."
            ),
        )


class SweBenchVerifiedAdapter(_ExternalBenchmarkAdapter):
    """Translate SWE-bench Verified requests into the live evaluator boundary."""

    _adapter_kind: BenchmarkKind = "swebench"
    _executable = "swebench"

    def translate(self, request: RunRequest) -> BenchmarkInvocation:
        """Describe the pinned SWE-bench task without inventing a patch artifact.

        The official evaluator consumes an agent-produced patch. Since this
        package does not own that live agent process, ``argv`` is intentionally
        ``None`` until an injected runner supplies the patch/evaluator bridge.
        """

        return BenchmarkInvocation(
            executable=self._executable,
            argv=None,
            task_manifest=self._translated_task_manifest(request),
            notes=(
                "The live harness must produce the patch artifact and invoke the "
                "pinned SWE-bench evaluator; no fixture patch is synthesized."
            ),
        )


HarborAdapter = HarborTerminalBenchAdapter
SWEBenchVerifiedAdapter = SweBenchVerifiedAdapter


def load_benchmark_manifest(path: Path | str) -> BenchmarkManifest:
    """Load and validate an external suite manifest from YAML."""

    manifest_path = Path(path)
    if not manifest_path.exists():
        raise BenchmarkManifestError(f"benchmark manifest does not exist: {manifest_path}")
    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise BenchmarkManifestError(f"invalid YAML in {manifest_path}: {exc}") from exc
    if not isinstance(raw, Mapping):
        raise BenchmarkManifestError(f"benchmark manifest root must be a mapping: {manifest_path}")
    return BenchmarkManifest.from_mapping(raw)


def adapter_for_suite(
    path: Path | str,
    *,
    live_harness: LiveBenchmarkHarness | None = None,
) -> BenchmarkAdapter:
    """Load the exact suite and construct its external adapter."""

    manifest = load_benchmark_manifest(path)
    if manifest.adapter_kind == "harbor":
        return HarborTerminalBenchAdapter(manifest, live_harness=live_harness)
    return SweBenchVerifiedAdapter(manifest, live_harness=live_harness)


def _validate_execution(
    execution: BenchmarkExecution,
    manifest: BenchmarkManifest,
) -> str:
    digests = execution.resolved_image_digests
    if len(digests) != 1:
        raise BenchmarkAdapterError(
            f"{manifest.suite_id}: expected one resolved image digest for one task, "
            f"got {len(digests)}"
        )
    digest = digests[0]
    if _SHA256_DIGEST.fullmatch(digest) is None or digest == _ALL_ZERO_DIGEST:
        raise BenchmarkAdapterError(
            f"{manifest.suite_id}: live harness returned an invalid image digest"
        )
    return digest


def _mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise BenchmarkManifestError(f"{field_name} must be a mapping")
    return value


def _string(mapping: Mapping[str, object], key: str, field_name: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise BenchmarkManifestError(f"{field_name} must be a non-empty string")
    return value


def _https_url(mapping: Mapping[str, object], key: str, field_name: str) -> str:
    value = _string(mapping, key, field_name)
    if not value.startswith("https://"):
        raise BenchmarkManifestError(f"{field_name} must use https://")
    return value


def _commit(mapping: Mapping[str, object], key: str, field_name: str) -> str:
    value = _string(mapping, key, field_name)
    if _GIT_COMMIT.fullmatch(value) is None:
        raise BenchmarkManifestError(f"{field_name} must be a 40-character git commit")
    return value


def _positive_int(mapping: Mapping[str, object], key: str, field_name: str) -> int:
    value = mapping.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise BenchmarkManifestError(f"{field_name} must be a positive integer")
    return value


def _string_tuple(mapping: Mapping[str, object], key: str, field_name: str) -> tuple[str, ...]:
    value = mapping.get(key)
    if not isinstance(value, list) or not value:
        raise BenchmarkManifestError(f"{field_name} must be a non-empty list")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise BenchmarkManifestError(f"{field_name} must contain only non-empty strings")
    return tuple(value)


def _literal(
    mapping: Mapping[str, object],
    key: str,
    field_name: str,
    choices: tuple[BenchmarkKind, ...],
) -> BenchmarkKind:
    value = _string(mapping, key, field_name)
    if value not in choices:
        choices_text = ", ".join(choices)
        raise BenchmarkManifestError(f"{field_name} must be one of {choices_text}")
    return value
