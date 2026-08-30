import { describe, expect, test } from "bun:test";
import { turnEvidenceBundleWire } from "./evidence-bundle-wire.js";

describe("task evidence bundle wire projection", () => {
  test("labels the latest bundle as turn-scoped without breaking v1 field names", () => {
    expect(turnEvidenceBundleWire({
      turnId: "turn-1",
      schemaVersion: "terminus.evidence-bundle.v1",
      identityHash: "sha256:identity",
      bundleArtifact: "artifact://sha256/bundle",
      terminalOutcome: "COMPLETED",
      admissionState: "COMMITTED",
      baseWorkspaceRevision: "base",
      finalWorkspaceRevision: "final",
    })).toEqual({
      schema_version: "terminus.evidence-bundle.v1",
      scope: "turn",
      turn_id: "turn-1",
      identity_hash: "sha256:identity",
      artifact: "artifact://sha256/bundle",
      turn_outcome: "COMPLETED",
      bundle_state: "COMMITTED",
      terminal_outcome: "COMPLETED",
      admission_state: "COMMITTED",
      base_workspace_revision: "base",
      final_workspace_revision: "final",
    });
  });
});
