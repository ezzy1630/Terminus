/**
 * Compatibility exports for desktop surfaces.
 *
 * The projection contract lives in @terminus/public-client so TUI and
 * desktop consume the same defensive event interpretation. Keeping this
 * module preserves the existing desktop import boundary without making the
 * desktop state store authoritative over the public event schema.
 */
export {
  deriveComputerUseActivity,
  derivePendingApprovals,
  deriveSubagentActivity,
  deriveVerificationActivity,
  extractUnifiedDiffs,
  mergePendingApprovals,
  operationLabel,
  pendingApprovalFromServerRow,
  projectEvent,
} from "@terminus/public-client";

export type {
  ClientEventProjection,
  ComputerUseActivity,
  PendingApproval,
  SubagentActivity,
  VerificationActivity,
} from "@terminus/public-client";
