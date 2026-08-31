export interface TurnEvidenceBundleWireInput {
  readonly turnId: string;
  readonly schemaVersion: string;
  readonly identityHash: string;
  readonly bundleArtifact: string;
  readonly terminalOutcome: string;
  readonly admissionState: string;
  readonly baseWorkspaceRevision: string;
  readonly finalWorkspaceRevision: string;
}

/** Load only the verifier results bound to this turn's selected plan. */
export async function turnEvidenceVerificationResultIds(
  verificationPlanId: string | null,
  loadForPlan: (verificationPlanId: string) => Promise<readonly { readonly id: string }[]>,
): Promise<readonly string[]> {
  if (verificationPlanId === null) return [];
  return (await loadForPlan(verificationPlanId)).map((result) => result.id);
}

/**
 * Project the latest turn evidence on a task without implying that the task's
 * completion gate admitted it. The legacy names remain for v1 clients; the
 * explicit scope and aliases remove the ambiguous task-level reading.
 */
export function turnEvidenceBundleWire(input: TurnEvidenceBundleWireInput) {
  return {
    schema_version: input.schemaVersion,
    scope: "turn" as const,
    turn_id: input.turnId,
    identity_hash: input.identityHash,
    artifact: input.bundleArtifact,
    turn_outcome: input.terminalOutcome,
    bundle_state: input.admissionState,
    terminal_outcome: input.terminalOutcome,
    admission_state: input.admissionState,
    base_workspace_revision: input.baseWorkspaceRevision,
    final_workspace_revision: input.finalWorkspaceRevision,
  };
}
