"""Harness runners (SPEC §41.5).

Drivers that turn a (task, harness, seed) triple into a
:class:`forge_evals.run_record.RunRecord`.
"""

from __future__ import annotations

from .cross_harness import (
    CrossHarnessPlan,
    CrossHarnessResult,
    CrossHarnessRunner,
    HarnessSpec,
    TaskSpec as CrossTaskSpec,
    run_paired_comparison,
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
from .trajectory_recorder import TrajectoryEvent, TrajectoryRecorder

__all__ = [
    "Budgets",
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
    "ModelCapabilitySnapshot",
    "RunRequest",
    "ScriptStep",
    "TrajectoryEvent",
    "TrajectoryRecorder",
    "fake_text_provider",
    "fake_tool_call_provider",
    "make_default_cost",
    "run_paired_comparison",
]
