/**
 * @terminus/provider-conformance — golden test exports + exit gate (§38.19).
 *
 * Exports the exit gate, provider gate result types, snapshot store,
 * and fixture factories for external test use.
 */
export {
  ExitGateResult,
  ProviderGateResult,
  runExitGate,
  buildProviderGateResult,
} from "./exit-gate.js";

export {
  VersionedSnapshot,
  CapabilitySnapshotStore,
  InMemorySnapshotStore,
} from "./snapshot-store.js";
