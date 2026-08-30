import { describe, expect, test } from "bun:test";
import { micros, modelProfileSchema } from "@terminus/domain";
import { resolveModelFamily } from "@terminus/provider-core";
import { anthropicThinkingGeneration } from "./index.js";
import { ANTHROPIC_PROFILE_BUNDLES } from "./model_profiles.js";

describe("Anthropic provider-owned profiles", () => {
  test("name models this harness can actually reach", () => {
    expect(ANTHROPIC_PROFILE_BUNDLES.map(({ model }) => model.modelKey)).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
    ]);
    for (const { model, rendering } of ANTHROPIC_PROFILE_BUNDLES) {
      expect(resolveModelFamily(model.modelKey)).toBe("claude-5");
      expect(anthropicThinkingGeneration(model.modelKey)).toBe("adaptive");
      // 1M context is the default *and* the maximum, at standard pricing.
      expect(model.capabilities.advertisedContextTokens).toBe(1_000_000);
      expect(model.capabilities.testedSafeContextTokens).toBe(1_000_000);
      // 512, down from 1,024 on Opus 4.8: a short stable prefix now caches.
      expect(rendering.caching.minimumTokens).toBe(512);
      expect(model.latencyModel).toEqual({ p50Ms: 0, p90Ms: 0, p99Ms: 0, ttftMs: 0 });
    }
  });

  test("price the three tiers apart", () => {
    const [opus, fable, sonnet] = ANTHROPIC_PROFILE_BUNDLES;
    expect(opus!.model.economics.inputMicrosPerMillion).toBe(micros(5_000_000));
    expect(opus!.model.economics.outputMicrosPerMillion).toBe(micros(25_000_000));
    expect(fable!.model.economics.inputMicrosPerMillion).toBe(micros(10_000_000));
    expect(fable!.model.economics.outputMicrosPerMillion).toBe(micros(50_000_000));
    expect(sonnet!.model.economics.inputMicrosPerMillion).toBe(micros(2_000_000));
    expect(sonnet!.model.economics.outputMicrosPerMillion).toBe(micros(10_000_000));
  });

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
