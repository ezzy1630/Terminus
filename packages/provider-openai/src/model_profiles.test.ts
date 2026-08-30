import { describe, expect, test } from "bun:test";
import { micros, modelProfileSchema } from "@terminus/domain";
import { GPT_5_6_CONTEXT_HARD_CAP, resolveModelFamily } from "@terminus/provider-core";
import { OPENAI_PROFILE_BUNDLES } from "./model_profiles.js";

describe("OpenAI provider-owned profiles", () => {
  test("name models this harness can actually reach", () => {
    expect(OPENAI_PROFILE_BUNDLES.map(({ model }) => model.modelKey)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    for (const { model } of OPENAI_PROFILE_BUNDLES) {
      expect(resolveModelFamily(model.modelKey)).toBe("gpt-5.6");
      // The 272K billing cliff, not a capability limit: past it the whole
      // request is billed at 2x input / 1.5x output.
      expect(model.capabilities.testedSafeContextTokens).toBe(GPT_5_6_CONTEXT_HARD_CAP);
      expect(model.capabilities.advertisedContextTokens).toBe(1_050_000);
      // Unmeasured on this harness; a fabricated percentile would be weighed
      // by the router as if it had been measured.
      expect(model.latencyModel).toEqual({ p50Ms: 0, p90Ms: 0, p99Ms: 0, ttftMs: 0 });
    }
  });

  test("price the three tiers apart", () => {
    const [sol, terra, luna] = OPENAI_PROFILE_BUNDLES;
    expect(sol!.model.economics.inputMicrosPerMillion).toBe(micros(4_000_000));
    expect(sol!.model.economics.outputMicrosPerMillion).toBe(micros(20_000_000));
    expect(terra!.model.economics.inputMicrosPerMillion).toBe(micros(2_000_000));
    expect(luna!.model.economics.outputMicrosPerMillion).toBe(micros(1_200_000));
  });

  test("bind neutral routing data to OpenAI rendering data", () => {
    for (const { model, rendering } of OPENAI_PROFILE_BUNDLES) {
      expect(modelProfileSchema.safeParse(model).success).toBe(true);
      expect(model.renderingProfileRef).toBe(rendering.id);
      expect(model.adapterRef).toBe(rendering.adapterRef);
      expect("continuationStrategy" in model).toBe(false);
      expect(rendering.continuationStrategy).toBe("server_history");
      expect(rendering.toolDialect).toBe("responses_function_tools");
      expect(rendering.caching).toEqual({
        mode: "explicit_breakpoints",
        minimumTokens: 1_024,
        exactPrefixRequired: true,
      });
    }
  });
});
