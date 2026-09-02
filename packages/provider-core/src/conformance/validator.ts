import type {
  ProviderRenderer,
} from "../index.js";
import type {
  ConformanceReport,
  ConformanceViolation,
  GoldenEpisode,
} from "./types.js";

export async function validateProviderConformance(
  renderer: ProviderRenderer,
  episodes: readonly GoldenEpisode[],
): Promise<ConformanceReport> {
  const violations: ConformanceViolation[] = [];
  let passedCount = 0;

  for (const ep of episodes) {
    let episodePassed = true;

    // 1. Compatibility check
    const compat = renderer.compatibility({
      provider: ep.input.provider,
      model: ep.input.model,
      fragments: ep.input.fragments,
      toolSchemas: ep.input.toolSchemas,
      hardInputLimit: ep.input.hardInputLimit,
    });
    if (!compat.compatible) {
      episodePassed = false;
      violations.push({
        episodeId: ep.id,
        rendererId: renderer.providerId,
        check: "compatibility",
        expected: true,
        actual: compat.incompatibilities,
        message: `Compatibility check failed: ${compat.incompatibilities.join(", ")}`,
      });
      continue;
    }

    // 2. Render request
    let rendered;
    try {
      rendered = await renderer.render(ep.input);
    } catch (err) {
      episodePassed = false;
      violations.push({
        episodeId: ep.id,
        rendererId: renderer.providerId,
        check: "render",
        expected: "rendered request",
        actual: err instanceof Error ? err.message : String(err),
        message: `Render call threw exception: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // 3. Provider-specific wire expectations
    const body = rendered.body as Record<string, unknown>;
    const exp = renderer.providerId === "openai" ? ep.expectations.openai : ep.expectations.anthropic;

    if (renderer.providerId === "openai") {
      const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
      const roles = messages.map((m) => m.role);
      for (const expectedRole of exp.roles) {
        if (!roles.includes(expectedRole)) {
          episodePassed = false;
          violations.push({
            episodeId: ep.id,
            rendererId: renderer.providerId,
            check: "openai.roles",
            expected: expectedRole,
            actual: roles,
            message: `Rendered messages missing expected role: ${expectedRole}`,
          });
        }
      }
      if (exp.hasToolResults) {
        const toolMsg = messages.find((m) => m.role === "tool");
        if (!toolMsg || !toolMsg.tool_call_id) {
          episodePassed = false;
          violations.push({
            episodeId: ep.id,
            rendererId: renderer.providerId,
            check: "openai.tool_call_id",
            expected: "present on role=tool",
            actual: toolMsg,
            message: "Tool result message missing required tool_call_id",
          });
        }
      }
    } else if (renderer.providerId === "anthropic") {
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
      if (exp.hasToolResults) {
        // Look for structured tool_result block in user messages
        let foundToolResult = false;
        for (const m of messages) {
          if (Array.isArray(m.content)) {
            const hasBlock = m.content.some((b: Record<string, unknown>) => b.type === "tool_result" && typeof b.tool_use_id === "string");
            if (hasBlock) foundToolResult = true;
          }
        }
        if (!foundToolResult) {
          episodePassed = false;
          violations.push({
            episodeId: ep.id,
            rendererId: renderer.providerId,
            check: "anthropic.tool_result_block",
            expected: "content block with type=tool_result and tool_use_id",
            actual: messages,
            message: "Anthropic tool result was flattened or missing native tool_result block",
          });
        }
      }
    }

    // 4. Response Projection
    try {
      const projection = await renderer.projectResponse(ep.simulatedResponse);
      if (projection.text !== ep.expectedProjection.text) {
        episodePassed = false;
        violations.push({
          episodeId: ep.id,
          rendererId: renderer.providerId,
          check: "projection.text",
          expected: ep.expectedProjection.text,
          actual: projection.text,
          message: `Projected text mismatch: expected "${ep.expectedProjection.text}", got "${projection.text}"`,
        });
      }
      if (projection.toolCalls.length !== ep.expectedProjection.toolCalls.length) {
        episodePassed = false;
        violations.push({
          episodeId: ep.id,
          rendererId: renderer.providerId,
          check: "projection.toolCalls",
          expected: ep.expectedProjection.toolCalls.length,
          actual: projection.toolCalls.length,
          message: `Projected tool call count mismatch: expected ${ep.expectedProjection.toolCalls.length}, got ${projection.toolCalls.length}`,
        });
      }
      if (projection.reasoning !== ep.expectedProjection.reasoning) {
        episodePassed = false;
        violations.push({
          episodeId: ep.id,
          rendererId: renderer.providerId,
          check: "projection.reasoning",
          expected: ep.expectedProjection.reasoning,
          actual: projection.reasoning,
          message: `Projected reasoning mismatch: expected "${ep.expectedProjection.reasoning}", got "${projection.reasoning}"`,
        });
      }
    } catch (err) {
      episodePassed = false;
      violations.push({
        episodeId: ep.id,
        rendererId: renderer.providerId,
        check: "projectResponse",
        expected: "projected response",
        actual: err instanceof Error ? err.message : String(err),
        message: `projectResponse call threw exception: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 5. Usage extraction. Every normalized field participates in the
    // contract; checking only inputTokens let cache/reasoning/cost drift pass.
    try {
      const usage = renderer.extractUsage(ep.simulatedResponse);
      const usageFields = [
        "inputTokens",
        "cachedInputTokens",
        "cacheWriteTokens",
        "outputTokens",
        "reasoningTokens",
        "toolSchemaTokens",
        "latencyMs",
        "timeToFirstTokenMs",
      ] as const;
      for (const field of usageFields) {
        if (usage[field] !== ep.expectedUsage[field]) {
          episodePassed = false;
          violations.push({
            episodeId: ep.id,
            rendererId: renderer.providerId,
            check: `usage.${field}`,
            expected: ep.expectedUsage[field],
            actual: usage[field],
            message: `Usage ${field} mismatch`,
          });
        }
      }
    } catch (err) {
      episodePassed = false;
      violations.push({
        episodeId: ep.id,
        rendererId: renderer.providerId,
        check: "extractUsage",
        expected: "usage record",
        actual: err instanceof Error ? err.message : String(err),
        message: `extractUsage threw exception: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (episodePassed) {
      passedCount++;
    }
  }

  return {
    rendererId: renderer.providerId,
    totalEpisodes: episodes.length,
    passedEpisodes: passedCount,
    failedEpisodes: episodes.length - passedCount,
    passed: violations.length === 0,
    violations,
    testedAt: new Date().toISOString(),
  };
}
