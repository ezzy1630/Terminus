import { describe, expect, test } from "bun:test";
import { modelProfileSchema } from "@terminus/domain";
import { LOCAL_PROFILE_BUNDLES } from "./model_profiles.js";

describe("local provider-owned profiles", () => {
  test("bind neutral routing data to local rendering data", () => {
    for (const { model, rendering } of LOCAL_PROFILE_BUNDLES) {
      expect(modelProfileSchema.safeParse(model).success).toBe(true);
      expect(model.renderingProfileRef).toBe(rendering.id);
      expect(model.adapterRef).toBe(rendering.adapterRef);
      expect(model.capabilities.offlineExecution).toBe(true);
      expect("structuredOutputRepair" in model).toBe(false);
      expect(rendering.structuredOutputRepair.dialect).toBe(
        "grammar_constrained",
      );
    }
  });
});
