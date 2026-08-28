import { describe, expect, test } from "bun:test";
import {
  TERMINUS_MINIMAL_TOOL_IDS,
  buildEvidenceIdentity,
  createTerminusMinimalProfile,
  terminusMinimalProfileSchema,
  validateTerminusMinimalProfile,
} from "./minimal-profile.js";

describe("terminus-minimal profile", () => {
  test("pins one provider/model and the narrow standalone tool set", () => {
    const profile = createTerminusMinimalProfile({
      providerId: "local",
      modelKey: "local/test",
      configuration: { transport: "fixture", toolsEnabled: true },
    });
    expect(profile.toolIds).toEqual([...TERMINUS_MINIMAL_TOOL_IDS]);
    expect(profile.routerEnabled).toBe(false);
    expect(profile.memoryEnabled).toBe(false);
    expect(profile.workflowEnabled).toBe(false);
    expect(profile.subagentsEnabled).toBe(false);
    expect(terminusMinimalProfileSchema.safeParse(profile).success).toBe(true);
    expect(validateTerminusMinimalProfile(profile)).toEqual(profile);
  });

  test("rejects credential-bearing configuration and forged profile identity", () => {
    expect(() => createTerminusMinimalProfile({
      providerId: "local",
      modelKey: "local/test",
      configuration: { apiKey: "must-not-be-accepted" },
    })).toThrow("credential-bearing");
    const profile = createTerminusMinimalProfile({ providerId: "local", modelKey: "local/test" });
    expect(() => validateTerminusMinimalProfile({ ...profile, providerId: "other" })).toThrow("profile hash");
  });

  test("evidence identity is order-independent for references and sensitive to outcome", () => {
    const profile = createTerminusMinimalProfile({ providerId: "local", modelKey: "local/test" });
    const base = {
      taskId: "task-1",
      turnId: "turn-1",
      contractVersion: 2,
      baseWorkspaceRevision: "rev-a",
      finalWorkspaceRevision: "rev-b",
      profile,
      providerAttemptIds: ["attempt-2", "attempt-1"],
      contextManifestIds: ["manifest-1"],
      requestArtifactHashes: ["sha256:req"],
      responseArtifactHashes: ["sha256:res"],
      toolCallIds: ["call-1"],
      verificationResultIds: ["verify-1"],
      proofBundleHash: null,
      terminalOutcome: "COMPLETED" as const,
    };
    const first = buildEvidenceIdentity(base);
    const reordered = buildEvidenceIdentity({
      ...base,
      providerAttemptIds: ["attempt-1", "attempt-2"],
    });
    const blocked = buildEvidenceIdentity({ ...base, terminalOutcome: "BLOCKED" });
    expect(first.identityHash).toBe(reordered.identityHash);
    expect(first.identityHash).not.toBe(blocked.identityHash);
    expect(() => buildEvidenceIdentity({ ...base, profile: { ...profile, modelKey: "other/model" } })).toThrow("profile hash");
  });
});
