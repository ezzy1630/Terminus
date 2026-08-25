"""Harness runners (SPEC §41.5).

Drivers that turn a (task, harness, seed) triple into a
:class:`forge_evals.run_record.RunRecord`.
"""

from __future__ import annotations

from .baseline_adapters import (
    ClaudeCodeAdapter,
    CodexAdapter,
    ExternalHarnessUnavailable,
    OhMyPiAdapter,
    PiAdapter,
    TerminusFullAdapter,
    TerminusMinimalAdapter,
    get_baseline_harness,
)
from .benchmark_adapters import (
    SWE_BENCH_HARNESS_COMMIT,
    SWE_BENCH_VERIFIED_REVISION,
    TERMINAL_BENCH_HARBOR_COMMIT,
    TERMINAL_BENCH_TASK_COMMIT,
    BenchmarkAdapter,
    BenchmarkAdapterError,
    BenchmarkExecution,
    BenchmarkInvocation,
    BenchmarkManifest,
    BenchmarkManifestError,
    HarborAdapter,
    HarborTerminalBenchAdapter,
    LiveBenchmarkHarness,
    SWEBenchVerifiedAdapter,
    SweBenchVerifiedAdapter,
    TranslatedTaskManifest,
    adapter_for_suite,
    load_benchmark_manifest,
)
from .cross_harness import (
    CrossHarnessPlan,
    CrossHarnessResult,
    CrossHarnessRunner,
    HarnessSpec,
    run_paired_comparison,
)
from .cross_harness import (
    TaskSpec as CrossTaskSpec,
)
from .fake_provider import (
    FakeProvider,
    FakeProviderBuilder,
    FakeProviderChunk,
    FakeProviderOptions,
    ScriptStep,
    fake_text_provider,
    fake_tool_call_provider,
)
from .harness_runner import (
    Budgets,
    EnvironmentDigest,
    FakeScriptHarness,
    GraderOutcome,
    Harness,
    HarnessResult,
    HarnessRunner,
    ModelCapabilitySnapshot,
    RunRequest,
    make_default_cost,
)
from .mini_swe_adapter import MiniSweAgentAdapter, MiniSweAgentTurn
from .trajectory_recorder import TrajectoryEvent, TrajectoryRecorder

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
    "Budgets",
    "ClaudeCodeAdapter",
    "CodexAdapter",
    "CrossHarnessPlan",
    "CrossHarnessResult",
    "CrossHarnessRunner",
    "CrossTaskSpec",
    "EnvironmentDigest",
    "ExternalHarnessUnavailable",
    "FakeProvider",
    "FakeProviderBuilder",
    "FakeProviderChunk",
    "FakeProviderOptions",
    "FakeScriptHarness",
    "GraderOutcome",
    "HarborAdapter",
    "HarborTerminalBenchAdapter",
    "Harness",
    "HarnessResult",
    "HarnessRunner",
    "HarnessSpec",
    "LiveBenchmarkHarness",
    "MiniSweAgentAdapter",
    "MiniSweAgentTurn",
    "ModelCapabilitySnapshot",
    "OhMyPiAdapter",
    "PiAdapter",
    "RunRequest",
    "SWEBenchVerifiedAdapter",
    "ScriptStep",
    "SweBenchVerifiedAdapter",
    "TerminusFullAdapter",
    "TerminusMinimalAdapter",
    "TrajectoryEvent",
    "TrajectoryRecorder",
    "TranslatedTaskManifest",
    "adapter_for_suite",
    "fake_text_provider",
    "fake_tool_call_provider",
    "get_baseline_harness",
    "load_benchmark_manifest",
    "make_default_cost",
    "run_paired_comparison",
]
