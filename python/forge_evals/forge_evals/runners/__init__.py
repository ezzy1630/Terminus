"""Harness runners (SPEC §41.5).

Drivers that turn a (task, harness, seed) triple into a
:class:`forge_evals.run_record.RunRecord`.
"""

from __future__ import annotations

from .baseline_adapters import (
    ClaudeCodeAdapter,
    CodexAdapter,
    OhMyPiAdapter,
    PiAdapter,
    PinnedOpenCodeAdapter,
    TerminusFullAdapter,
    TerminusMinimalAdapter,
    get_baseline_harness,
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
    "Budgets",
    "ClaudeCodeAdapter",
    "CodexAdapter",
    "CrossHarnessPlan",
    "CrossHarnessResult",
    "CrossHarnessRunner",
    "CrossTaskSpec",
    "EnvironmentDigest",
    "FakeProvider",
    "FakeProviderBuilder",
    "FakeProviderChunk",
    "FakeProviderOptions",
    "FakeScriptHarness",
    "GraderOutcome",
    "Harness",
    "HarnessResult",
    "HarnessRunner",
    "HarnessSpec",
    "MiniSweAgentAdapter",
    "MiniSweAgentTurn",
    "ModelCapabilitySnapshot",
    "OhMyPiAdapter",
    "PiAdapter",
    "PinnedOpenCodeAdapter",
    "RunRequest",
    "ScriptStep",
    "TerminusFullAdapter",
    "TerminusMinimalAdapter",
    "TrajectoryEvent",
    "TrajectoryRecorder",
    "fake_text_provider",
    "fake_tool_call_provider",
    "get_baseline_harness",
    "make_default_cost",
    "run_paired_comparison",
]

