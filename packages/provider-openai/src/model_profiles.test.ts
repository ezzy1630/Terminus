import { describe, expect, test } from "bun:test";
import { modelProfileSchema } from "@terminus/domain";
import { OPENAI_PROFILE_BUNDLES } from "./model_profiles.js";

describe("OpenAI provider-owned profiles", () => {
  test("bind neutral routing data to OpenAI rendering data", () => {
    for (const { model, rendering } of OPENAI_PROFILE_BUNDLES) {
      expect(modelProfileSchema.safeParse(model).success).toBe(true);
      expect(model.renderingProfileRef).toBe(rendering.id);
      expect(model.adapterRef).toBe(rendering.adapterRef);
      expect("continuationStrategy" in model).toBe(false);
      expect(rendering.continuationStrategy).toBe("server_history");
      expect(rendering.toolDialect).toBe("responses_function_tools");
    }
  });
});
