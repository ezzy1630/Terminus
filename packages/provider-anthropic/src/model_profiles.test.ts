import { describe, expect, test } from "bun:test";
import { modelProfileSchema } from "@terminus/domain";
import { ANTHROPIC_PROFILE_BUNDLES } from "./model_profiles.js";

describe("Anthropic provider-owned profiles", () => {
  test("bind neutral routing data to Anthropic rendering data", () => {
    for (const { model, rendering } of ANTHROPIC_PROFILE_BUNDLES) {
      expect(modelProfileSchema.safeParse(model).success).toBe(true);
      expect(model.renderingProfileRef).toBe(rendering.id);
      expect(model.adapterRef).toBe(rendering.adapterRef);
      expect("toolDialect" in model).toBe(false);
      expect(rendering.toolDialect).toBe("messages_tools");
      expect(rendering.systemPromptPlacement).toBe("top_level_system_blocks");
    }
  });
});
