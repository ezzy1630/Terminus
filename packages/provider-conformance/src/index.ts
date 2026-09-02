/**
 * @terminus/provider-conformance — golden test exports + exit gate (§38.19).
 *
 * Exports the exit gate, provider gate result types, snapshot store,
 * and fixture factories for external test use.
 */
export { runExitGate, buildProviderGateResult } from "./exit-gate.js";
export type { ExitGateResult, ProviderGateResult } from "./exit-gate.js";
export {
  IMMUTABLE_ARTIFACT_REF_PATTERN,
  MODEL_PROFILE_CHECK_IDS,
  MODEL_PROFILE_CONFORMANCE_SCHEMA_VERSION,
  buildModelProfileConformanceReport,
  isImmutableArtifactRef,
  runModelProfileExitGate,
  validateModelProfileConformanceReport,
} from "./model-profile.js";
export type {
  ConformanceEvidenceClass,
  ModelProfileCheckId,
  ModelProfileCheckResult,
  ModelProfileConformanceReport,
  ModelProfileExitGateResult,
  ModelProfileReportInput,
} from "./model-profile.js";

export { InMemorySnapshotStore } from "./snapshot-store.js";
export type { VersionedSnapshot, CapabilitySnapshotStore } from "./snapshot-store.js";
