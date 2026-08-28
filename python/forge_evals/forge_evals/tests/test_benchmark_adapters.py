"""Focused tests for the external benchmark adapter boundary."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from forge_evals.evidence import EvidenceClass
from forge_evals.run_record import Outcome
from forge_evals.runners import (
    BenchmarkAdapterError,
    BenchmarkExecution,
    BenchmarkInvocation,
    ExternalHarnessContract,
    ExternalHarnessUnavailable,
    HarborTerminalBenchAdapter,
    HarnessResult,
    LiveHarnessContract,
    ModelCapabilitySnapshot,
    RunRequest,
    SweBenchVerifiedAdapter,
    TerminusFullAdapter,
    TerminusMinimalAdapter,
    TrajectoryRecorder,
    adapter_for_suite,
    get_baseline_harness,
    select_harness,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
SUITES_DIR = REPO_ROOT / "evals" / "suites"
VALID_IMAGE_DIGEST = "sha256:" + "a" * 64


def _request(tmp_path: Path, *, suite: str, task: str) -> RunRequest:
    task_dir = tmp_path / task
    task_dir.mkdir()
    return RunRequest(
        suite=suite,
        task=task,
        task_dir=task_dir,
        harness_id="terminus-2",
        harness_commit="7a21e05772954cc81471ae19d56f436cecf43c54",
        model_snapshot=ModelCapabilitySnapshot(
            provider="test",
            model="test-model",
            api_version="v1",
            context_window=128_000,
            max_output_tokens=8_192,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
        ),
        random_seed=7,
    )


def _harness_result() -> HarnessResult:
    return HarnessResult(
        outcome=Outcome.COMPLETED,
        final_revision="live-revision",
        cost=None,
        artifacts=[],
        context_manifests=[],
        grader_outcomes=[],
        evidence_class=EvidenceClass.EXTERNAL_LIVE,
    )


class _StubLiveHarness:
    is_live_runner = True
    contract = ExternalHarnessContract(
        harness_id="harbor-test",
        repository="https://github.com/harbor-framework/harbor.git",
        commit="72f7dd0134162c5b7229f6a31286e05a49c0f8a4",
        runner_version="test-runner-v1",
        pin_verified=True,
    )

    def __init__(
        self, *, available: bool, digests: tuple[str, ...] = (VALID_IMAGE_DIGEST,)
    ) -> None:
        self.available = available
        self.digests = digests
        self.invocation: BenchmarkInvocation | None = None

    def is_available(self) -> bool:
        return self.available

    def run(
        self,
        invocation: BenchmarkInvocation,
        request: RunRequest,
        recorder: TrajectoryRecorder,
    ) -> BenchmarkExecution:
        self.invocation = invocation
        return BenchmarkExecution(
            harness_result=_harness_result(),
            resolved_image_digests=self.digests,
        )


class _MarkedLiveHarness:
    is_live_runner = True
    contract = LiveHarnessContract(
        harness_id="terminus-full",
        exact_pin="sha256:" + "b" * 64,
        pin_verified=True,
        runner_version="test-runner-v1",
    )

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        return _harness_result()


def test_harbor_translation_uses_pinned_dataset_and_task_filter(tmp_path: Path) -> None:
    adapter = adapter_for_suite(SUITES_DIR / "terminal-bench.yaml")
    assert isinstance(adapter, HarborTerminalBenchAdapter)

    invocation = adapter.translate(
        _request(tmp_path, suite="terminal-bench", task="chess-best-move")
    )

    assert invocation.argv == (
        "harbor",
        "run",
        "--dataset",
        "terminal-bench@2.0",
        "--agent",
        "terminus-2",
        "--model",
        "test-model",
        "--n-concurrent",
        "1",
        "--include-task-name",
        "chess-best-move",
    )
    assert invocation.task_manifest.dataset_revision.startswith("72f7dd0")
    assert invocation.task_manifest.task_commit is not None
    assert invocation.task_manifest.task_commit.startswith("69671fba")


def test_swebench_translation_does_not_invent_a_patch_command(tmp_path: Path) -> None:
    adapter = adapter_for_suite(SUITES_DIR / "swe-bench-verified.yaml")
    assert isinstance(adapter, SweBenchVerifiedAdapter)

    invocation = adapter.translate(
        _request(
            tmp_path,
            suite="swe-bench-verified",
            task="astropy__astropy-12907",
        )
    )

    assert invocation.argv is None
    assert invocation.task_manifest.dataset == "SWE-bench/SWE-bench_Verified"
    assert invocation.task_manifest.split == "test"
    assert invocation.task_manifest.language == "python"
    assert invocation.task_manifest.dataset_revision.startswith("78f471bf")


def test_manifest_serialization_preserves_swe_revision() -> None:
    adapter = adapter_for_suite(SUITES_DIR / "swe-bench-verified.yaml")

    serialized = adapter.manifest.to_dict()
    suite = serialized["suite"]
    assert isinstance(suite, dict)
    adapter_data = suite["adapter"]
    assert isinstance(adapter_data, dict)

    assert adapter_data["revision"] == adapter.manifest.dataset_revision


@pytest.mark.parametrize(
    "suite_file,suite_id,task",
    [
        ("terminal-bench.yaml", "terminal-bench", "chess-best-move"),
        ("swe-bench-verified.yaml", "swe-bench-verified", "astropy__astropy-12907"),
    ],
)
def test_external_adapter_fails_closed_without_live_harness(
    tmp_path: Path,
    suite_file: str,
    suite_id: str,
    task: str,
) -> None:
    adapter = adapter_for_suite(SUITES_DIR / suite_file)

    with pytest.raises(ExternalHarnessUnavailable, match="live"):
        adapter.run(
            _request(tmp_path, suite=suite_id, task=task),
            TrajectoryRecorder(run_id="test-run"),
        )


def test_external_adapter_fails_closed_when_harness_reports_unavailable(tmp_path: Path) -> None:
    live_harness = _StubLiveHarness(available=False)
    adapter = adapter_for_suite(SUITES_DIR / "terminal-bench.yaml", live_harness=live_harness)

    with pytest.raises(ExternalHarnessUnavailable, match="unavailable"):
        adapter.run(
            _request(tmp_path, suite="terminal-bench", task="chess-best-move"),
            TrajectoryRecorder(run_id="test-run"),
        )


def test_live_boundary_requires_a_real_image_digest(tmp_path: Path) -> None:
    live_harness = _StubLiveHarness(available=True, digests=())
    adapter = adapter_for_suite(SUITES_DIR / "terminal-bench.yaml", live_harness=live_harness)

    with pytest.raises(BenchmarkAdapterError, match="one resolved image digest"):
        adapter.run(
            _request(tmp_path, suite="terminal-bench", task="chess-best-move"),
            TrajectoryRecorder(run_id="test-run"),
        )


def test_live_boundary_records_translation_and_resolved_digest(tmp_path: Path) -> None:
    live_harness = _StubLiveHarness(available=True)
    adapter = adapter_for_suite(SUITES_DIR / "terminal-bench.yaml", live_harness=live_harness)

    result = adapter.run(
        _request(tmp_path, suite="terminal-bench", task="chess-best-move"),
        TrajectoryRecorder(run_id="test-run"),
    )

    assert live_harness.invocation is not None
    assert result.outcome is Outcome.COMPLETED
    assert result.artifacts[0]["type"] == "benchmark_adapter_manifest"
    assert result.artifacts[0]["evidence_status"] == "unverified"
    assert result.artifacts[0]["resolved_image_digests"] == [VALID_IMAGE_DIGEST]
    assert result.environment_digest == VALID_IMAGE_DIGEST
    assert "release evidence requires independent verification" in result.notes


def test_external_adapter_rejects_request_for_another_suite(tmp_path: Path) -> None:
    adapter = adapter_for_suite(
        SUITES_DIR / "terminal-bench.yaml",
        live_harness=_StubLiveHarness(available=True),
    )

    with pytest.raises(BenchmarkAdapterError, match="does not match adapter manifest"):
        adapter.run(
            _request(tmp_path, suite="swe-bench-verified", task="wrong-suite"),
            TrajectoryRecorder(run_id="test-run"),
        )


def test_existing_fixture_mode_remains_non_release() -> None:
    fixture = get_baseline_harness("forge_minimal")

    assert isinstance(fixture, TerminusMinimalAdapter)
    assert "fixture-only" in fixture.notes
    assert "not a live harness run" in fixture.notes


@pytest.mark.parametrize(
    "requested_id,canonical_id,adapter_type",
    [
        ("terminus-minimal", "terminus-minimal", TerminusMinimalAdapter),
        ("forge_minimal", "terminus-minimal", TerminusMinimalAdapter),
        ("terminus-full", "terminus-full", TerminusFullAdapter),
        ("forge_full", "terminus-full", TerminusFullAdapter),
    ],
)
def test_terminus_harness_ids_are_canonical_with_explicit_adr_aliases(
    requested_id: str, canonical_id: str, adapter_type: type[object]
) -> None:
    selection = select_harness(requested_id, fixture_mode=True)

    assert selection.harness_id == canonical_id
    assert selection.fixture_only
    assert not selection.release_eligible
    assert isinstance(selection.harness, adapter_type)


def test_harness_selection_fails_closed_when_live_evidence_is_required() -> None:
    with pytest.raises(ExternalHarnessUnavailable, match="live evidence is unavailable"):
        select_harness("terminus-full", require_live=True)


def test_harness_selection_accepts_only_verified_live_runner() -> None:
    live_harness = _MarkedLiveHarness()

    selection = select_harness(
        "forge_full",
        require_live=True,
        live_harness=live_harness,
        live_pin="sha256:" + "b" * 64,
        live_pin_verified=True,
        live_contract=live_harness.contract,
    )

    assert selection.harness_id == "terminus-full"
    assert not selection.fixture_only
    assert selection.release_eligible


def test_zero_digest_in_suite_manifest_is_rejected(tmp_path: Path) -> None:
    source = yaml.safe_load((SUITES_DIR / "terminal-bench.yaml").read_text(encoding="utf-8"))
    source["suite"]["pinned_image_digest"] = "sha256:" + "0" * 64
    manifest_path = tmp_path / "terminal-bench.yaml"
    manifest_path.write_text(yaml.safe_dump(source), encoding="utf-8")

    with pytest.raises(ValueError, match="suite-wide pinned_image_digest"):
        adapter_for_suite(manifest_path)
