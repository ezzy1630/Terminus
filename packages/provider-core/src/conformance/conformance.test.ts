import { describe, expect, test } from "bun:test";
import { GOLDEN_EPISODES } from "./episodes.js";
import { validateProviderConformance } from "./validator.js";
import type { CanonicalRenderInput, ProjectedResponse, ProviderRenderer, ProviderResponse, RenderCompatibilityInput, RenderedProviderRequest, UsageRecord } from "../index.js";
import { BaseProviderRenderer } from "../index.js";

class MockProviderRenderer extends BaseProviderRenderer {
  readonly providerId = "mock";
  readonly version = "1.0.0";

  override compatibility(input: RenderCompatibilityInput) {
    return { compatible: true, incompatibilities: [], downgradesRequired: [] };
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    return {
      providerId: this.providerId,
      model: input.model.modelKey,
      request: {} as any,
      predictedCachedTokens: 0n as any,
      body: {
        messages: input.fragments.map((f) => ({
          role: f.kind === "authority" ? "developer" : f.kind === "recent_episode" ? "assistant" : f.kind === "tool_result" ? "tool" : "user",
          content: f.textContent ?? "",
          ...(f.kind === "tool_result" ? { tool_call_id: "call_edit_991" } : {}),
        })),
      },
    };
  }

  async projectResponse(response: ProviderResponse): Promise<ProjectedResponse> {
    let text = "";
    const toolCalls: any[] = [];
    let reasoning: string | null = null;
    let finishReason: ProjectedResponse["finishReason"] = "stop";

    for (const chunk of response.chunks) {
      if (chunk.kind === "text") {
        if (chunk.text) text += chunk.text;
        if (chunk.reasoning) reasoning = (reasoning ?? "") + chunk.reasoning;
      } else if (chunk.kind === "tool_call" && chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
        finishReason = "tool_use";
      }
    }
    return { text, toolCalls, reasoning, continuationId: null, finishReason };
  }

  extractUsage(response: ProviderResponse): UsageRecord {
    for (const chunk of response.chunks) {
      if (chunk.usage) return chunk.usage;
    }
    return {
      inputTokens: 0n as any,
      cachedInputTokens: 0n as any,
      cacheWriteTokens: 0n as any,
      outputTokens: 0n as any,
      reasoningTokens: 0n as any,
      toolSchemaTokens: 0n as any,
      latencyMs: 0,
      timeToFirstTokenMs: null,
    };
  }
}

describe("Provider Transcript Conformance Test Laboratory", () => {
  test("golden episodes definitions are valid and distinct", () => {
    expect(GOLDEN_EPISODES.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(GOLDEN_EPISODES.map((e) => e.id));
    expect(ids.size).toBe(GOLDEN_EPISODES.length);
  });

  test("validator catches violations and reports cleanly", async () => {
    const renderer = new MockProviderRenderer();
    const report = await validateProviderConformance(renderer, GOLDEN_EPISODES);
    expect(report.rendererId).toBe("mock");
    expect(report.totalEpisodes).toBe(GOLDEN_EPISODES.length);
  });
});
