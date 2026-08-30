import { describe, expect, test } from "bun:test";
import { STANDALONE_ALWAYS_ON_TOOL_IDS } from "../agent-tools.js";
import {
  TERMINUS_ADAPTIVE_PROFILE_ID,
  TERMINUS_DECLARABLE_TOOL_IDS,
  TERMINUS_MINIMAL_TOOL_IDS,
  buildEvidenceIdentity,
  createTerminusAdaptiveProfile,
  createTerminusExecutionProfile,
  createTerminusMinimalProfile,
  resolveTerminusProfileMode,
  terminusAdaptiveProfileSchema,
  terminusMinimalProfileSchema,
  validateTerminusExecutionProfile,
  validateTerminusMinimalProfile,
} from "./minimal-profile.js";

describe("terminus-minimal profile", () => {
  test("pins one provider/model and the narrow standalone tool set", () => {
    const profile = createTerminusMinimalProfile({
      providerId: "local",
      modelKey: "local/test",
      configuration: { transport: "fixture", toolsEnabled: true },
    });
    expect(profile.toolIds).toEqual([...TERMINUS_MINIMAL_TOOL_IDS].sort());
    expect(profile.routerEnabled).toBe(false);
    expect(profile.memoryEnabled).toBe(false);
    expect(profile.workflowEnabled).toBe(false);
    expect(profile.subagentsEnabled).toBe(false);
    expect(terminusMinimalProfileSchema.safeParse(profile).success).toBe(true);
    expect(validateTerminusMinimalProfile(profile)).toEqual(profile);
  });

  test("the declared set is the executable set", () => {
    // Three inventories used to disagree: the profile declared
    // read/patch/exec, the prompt documented grep/glob/exec_poll, and the
    // dispatch guard rejected anything outside the profile. They are now the
    // same list, and every id in it has a real schema.
    expect([...TERMINUS_MINIMAL_TOOL_IDS].sort()).toEqual([...STANDALONE_ALWAYS_ON_TOOL_IDS].sort());
    expect(TERMINUS_DECLARABLE_TOOL_IDS).toContain("capability");
    expect(TERMINUS_DECLARABLE_TOOL_IDS).toContain("web_fetch");
  });

  test("an activated tool widens the declared set; direct replies may declare none; unknown tools are refused", () => {
    const withFetch = createTerminusMinimalProfile({
      providerId: "local",
      modelKey: "local/test",
      toolIds: [...TERMINUS_MINIMAL_TOOL_IDS, "web_fetch"],
    });
    expect(withFetch.toolIds).toContain("web_fetch");
    expect(validateTerminusMinimalProfile(withFetch)).toEqual(withFetch);
    expect(() => createTerminusMinimalProfile({
      providerId: "local",
      modelKey: "local/test",
      toolIds: ["read", "rm_rf"],
    })).toThrow(/unknown tool/);
    const direct = createTerminusMinimalProfile({
      providerId: "local",
      modelKey: "local/test",
      toolIds: [],
    });
    expect(direct.toolIds).toEqual([]);
    expect(validateTerminusMinimalProfile(direct)).toEqual(direct);
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

  test("keeps adaptive delegation distinct from the permanent minimal control arm", () => {
    const minimal = createTerminusExecutionProfile({
      mode: "minimal",
      providerId: "openai",
      modelKey: "gpt-5.6-terra",
    });
    const adaptive = createTerminusExecutionProfile({
      mode: "adaptive",
      providerId: "openai",
      modelKey: "gpt-5.6-terra",
    });

    expect(minimal.profileId).toBe("terminus-minimal");
    expect(minimal.subagentsEnabled).toBe(false);
    expect(adaptive.profileId).toBe(TERMINUS_ADAPTIVE_PROFILE_ID);
    expect(adaptive.subagentsEnabled).toBe(true);
    expect(adaptive.routerEnabled).toBe(false);
    expect(adaptive.memoryEnabled).toBe(false);
    expect(adaptive.workflowEnabled).toBe(false);
    expect(adaptive.profileHash).not.toBe(minimal.profileHash);
    expect(terminusAdaptiveProfileSchema.safeParse(adaptive).success).toBe(true);
    expect(validateTerminusExecutionProfile(adaptive)).toEqual(adaptive);
  });

  test("requires an explicit adaptive profile until its promotion gate passes", () => {
    expect(resolveTerminusProfileMode(undefined)).toBe("minimal");
    expect(resolveTerminusProfileMode(null)).toBe("minimal");
    expect(resolveTerminusProfileMode("")).toBe("minimal");
    expect(resolveTerminusProfileMode("minimal")).toBe("minimal");
    expect(resolveTerminusProfileMode("adaptive")).toBe("adaptive");
    expect(() => resolveTerminusProfileMode("full")).toThrow("TERMINUS_HARNESS_PROFILE");

    const adaptive = createTerminusAdaptiveProfile({ providerId: "local", modelKey: "local/test" });
    expect(() => validateTerminusExecutionProfile({ ...adaptive, subagentsEnabled: false })).toThrow();
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

    const adaptive = createTerminusAdaptiveProfile({ providerId: "local", modelKey: "local/test" });
    const adaptiveIdentity = buildEvidenceIdentity({ ...base, profile: adaptive });
    expect(adaptiveIdentity.profileHash).toBe(adaptive.profileHash);
    expect(adaptiveIdentity.identityHash).not.toBe(first.identityHash);
  });
});
