import { describe, expect, test } from "bun:test";
import { GOLDEN_EPISODES, validateProviderConformance } from "@terminus/provider-core";
import { OpenAiRenderer } from "./index.js";

describe("OpenAI Provider Transcript Conformance", () => {
  test("passes all golden semantic episodes in conformance laboratory", async () => {
    const renderer = new OpenAiRenderer();
    const report = await validateProviderConformance(renderer, GOLDEN_EPISODES);
    if (!report.passed) {
      console.error("OpenAI Conformance Violations:", JSON.stringify(report.violations, null, 2));
    }
    expect(report.passed).toBe(true);
    expect(report.failedEpisodes).toBe(0);
    expect(report.passedEpisodes).toBe(GOLDEN_EPISODES.length);
  });
});
