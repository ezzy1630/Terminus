import { describe, expect, test } from "bun:test";
import { micros, modelProfileSchema, type ModelProfile } from "@terminus/domain";
import {
  DeterministicRoleRouter,
  PosteriorTracker,
  ProfileRegistry,
  RoleRouter,
  StageRouter,
} from "./index.js";

function profile(id: string, family: string): ModelProfile {
  return modelProfileSchema.parse({
    id,
    adapterRef: `${id}:adapter`,
    renderingProfileRef: `${id}:renderer`,
    modelKey: `${id}:model`,
    version: "v1",
    modelFamilyRef: family,
    economics: {
      inputMicrosPerMillion: micros(100_000),
      cachedInputMicrosPerMillion: micros(50_000),
      outputMicrosPerMillion: micros(200_000),
      reasoningAccounting: false,
    },
    latencyModel: { p50Ms: 100, p90Ms: 200, p99Ms: 400, ttftMs: 50 },
    allowedConfidentiality: ["public", "workspace"],
    capabilities: {
      codingQuality: "high",
      toolReliability: "high",
      structuredOutput: true,
      imageInput: true,
      advertisedContextTokens: 128_000,
      testedSafeContextTokens: 100_000,
      securityReasoning: "high",
      reasoningStrength: "high",
      offlineExecution: false,
    },
  }) as ModelProfile;
}

describe("RoleRouter", () => {
  test("maps declared profiles to deterministic stages and authority", () => {
    const stageRouter = new StageRouter(
      new ProfileRegistry([profile("profile:a", "family:a")]),
      new PosteriorTracker(),
    );
    const router = new RoleRouter(stageRouter);

    const implementer = router.route({
      roleProfile: "primary_implementer",
      confidentiality: "workspace",
    });
    const scout = router.route({
      roleProfile: "cheap_classifier_scout",
      confidentiality: "workspace",
    });
    const reviewer = router.route({
      roleProfile: "read_only_reviewer_oracle",
      confidentiality: "workspace",
    });
    const vision = router.route({
      roleProfile: "vision_enabled_media",
      confidentiality: "workspace",
    });

    expect(implementer.stage).toBe("implementer");
    expect(implementer.authority).toBe("write");
    expect(scout.stage).toBe("classifier");
    expect(scout.authority).toBe("read_only");
    expect(reviewer.stage).toBe("reviewer");
    expect(reviewer.authority).toBe("read_only");
    expect(vision.stage).toBe("vision");
    expect(vision.requiresImageInput).toBe(true);
    expect(vision.deterministic).toBe(true);
    expect(vision.route.chosenProfileId).toBe("profile:a");
  });

  test("exports the deterministic router as the explicit default facade", () => {
    expect(DeterministicRoleRouter).toBe(RoleRouter);
  });

  test("uses a stable profile-id tie break instead of registry insertion order", () => {
    const stageRouter = new StageRouter(
      new ProfileRegistry([
        profile("profile:z", "family:z"),
        profile("profile:a", "family:a"),
      ]),
      new PosteriorTracker(),
    );

    expect(stageRouter.route({ stage: "classifier", confidentiality: "workspace" }).chosenProfileId)
      .toBe("profile:a");
  });
});
