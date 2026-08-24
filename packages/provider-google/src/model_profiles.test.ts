import { describe, expect, test } from "bun:test";
import { modelProfileSchema } from "@terminus/domain";
import { GOOGLE_PROFILE_BUNDLES } from "./model_profiles.js";

describe("Google provider-owned profiles", () => {
  test("bind neutral routing data to Google rendering data", () => {
    for (const { model, rendering } of GOOGLE_PROFILE_BUNDLES) {
      expect(modelProfileSchema.safeParse(model).success).toBe(true);
      expect(model.renderingProfileRef).toBe(rendering.id);
      expect(model.adapterRef).toBe(rendering.adapterRef);
      expect("cachingStrategy" in model).toBe(false);
      expect(rendering.caching.mode).toBe("explicit_resource");
      expect(rendering.toolDialect).toBe("function_declarations");
    }
  });
});
