"""Graders (SPEC §41.5, §41.11, §46.6).

End-state, acceptance, security, and conformance graders. Grader code is
**never** projected into model context (SPEC §41.5).
"""

from __future__ import annotations

from .acceptance import (
    AcceptanceCriterion,
    AcceptanceGrader,
    CriterionPredicate,
    CriterionResult,
    criterion_file_contains,
    criterion_file_exists,
    criterion_test_command,
)
from .conformance import (
    ConformanceCheck,
    ConformanceGrader,
    ContextManifestDurabilityCheck,
    EventOrderingCheck,
    IdempotencyCheck,
    ProviderResponseSchemaCheck,
    ToolResultEnvelopeCheck,
    default_conformance_grader,
)
from .end_state import (
    DiffGrader,
    EndStateGrader,
    EndStateGraderInput,
    FileContainsGrader,
    HiddenTestGrader,
    NoopGrader,
    PassFailGrader,
    ScriptGrader,
    TestRunGrader,
    WorkspaceSnapshot,
    parse_pytest_summary,
)
from .security_graders import (
    ApprovalReplayGrader,
    CommandParserBypassGrader,
    DegradedSandboxGrader,
    DistributedMcpPoisoningGrader,
    ExternalStateMutationGrader,
    McpPoisoningGrader,
    PluginSupplyChainGrader,
    ScopeExpansionGrader,
    SecretExtractionGrader,
    SecurityCatalog,
    WorkspaceEscapeGrader,
    all_security_graders,
    default_security_catalog,
)

__all__ = [
    "AcceptanceCriterion",
    "AcceptanceGrader",
    "ApprovalReplayGrader",
    "CommandParserBypassGrader",
    "ConformanceCheck",
    "ConformanceGrader",
    "ContextManifestDurabilityCheck",
    "CriterionPredicate",
    "CriterionResult",
    "DegradedSandboxGrader",
    "DiffGrader",
    "DistributedMcpPoisoningGrader",
    "EndStateGrader",
    "EndStateGraderInput",
    "EventOrderingCheck",
    "ExternalStateMutationGrader",
    "FileContainsGrader",
    "HiddenTestGrader",
    "IdempotencyCheck",
    "McpPoisoningGrader",
    "NoopGrader",
    "PassFailGrader",
    "PluginSupplyChainGrader",
    "ProviderResponseSchemaCheck",
    "ScopeExpansionGrader",
    "ScriptGrader",
    "SecretExtractionGrader",
    "SecurityCatalog",
    "TestRunGrader",
    "ToolResultEnvelopeCheck",
    "WorkspaceEscapeGrader",
    "WorkspaceSnapshot",
    "all_security_graders",
    "criterion_file_contains",
    "criterion_file_exists",
    "criterion_test_command",
    "default_conformance_grader",
    "default_security_catalog",
    "parse_pytest_summary",
]
