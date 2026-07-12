/**
 * @forge/provider-anthropic — Anthropic Messages API renderer.
 *
 * Maps canonical context to the Anthropic Messages API with system blocks,
 * tool_use/tool_result content blocks, cache_control breakpoints, and the
 * `anthropic-version` header. Same `Transport` pattern as other providers.
 */
import type {
  ProviderRenderer,
  RenderCompatibilityInput,
  CompatibilityResult,
  CanonicalRenderInput,
  RenderedProviderRequest,
  ProviderResponse,
  ProjectedResponse,
  UsageRecord,
  ProviderRequest,
  ProviderTransport,
  ProviderResponseChunk,
  ContinuationInput,
  ContinuationDecision,
  ProviderToolSchema,
} from "@forge/provider-core";
import { BaseProviderRenderer } from "@forge/provider-core";
import type { TokenCount } from "@forge/domain";

// ────────────────────────── Anthropic wire shapes ────────────────────────────

export interface AnthropicSystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" } | undefined;
}

export interface AnthropicContentBlock {
  readonly type: "text" | "tool_use" | "tool_result";
  readonly text?: string | undefined;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly input?: Readonly<Record<string, unknown>> | undefined;
  readonly tool_use_id?: string | undefined;
  readonly content?: string | readonly AnthropicContentBlock[] | undefined;
  readonly cache_control?: { readonly type: "ephemeral" } | undefined;
}

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

export interface AnthropicToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export interface AnthropicRequestBody {
  readonly model: string;
  readonly system: readonly AnthropicSystemBlock[];
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: readonly AnthropicToolSchema[] | undefined;
  readonly tool_choice?: { readonly type: "auto" | "any" | "tool"; readonly name?: string } | undefined;
  readonly max_tokens: number;
  readonly temperature?: number | undefined;
  readonly stream: true;
  readonly metadata?: { readonly user_id?: string } | undefined;
}

// ────────────────────────── Renderer ─────────────────────────────────────────

export class AnthropicRenderer extends BaseProviderRenderer {
  readonly providerId = "anthropic";
  readonly version = "1.0.0";

  override compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    const base = super.compatibility(input);
    const incompatibilities = [...base.incompatibilities];
    if (input.toolSchemas.length > 200) {
      incompatibilities.push("Anthropic supports at most 200 tools");
    }
    return {
      compatible: incompatibilities.length === 0,
      incompatibilities,
      downgradesRequired: base.downgradesRequired,
    };
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    const system = renderSystemBlocks(input);
    const messages = renderMessages(input);
    const tools = renderTools(input.toolSchemas);
    const body: AnthropicRequestBody = {
      model: input.model.modelKey,
      system,
      messages,
      max_tokens: Number(input.outputReserveTokens),
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.outputProfile === "terse"
        ? { temperature: 0.2 }
        : input.outputProfile === "structured"
          ? { temperature: 0 }
          : {}),
    };
    return {
      providerId: this.providerId,
      model: input.model.modelKey,
      request: toProviderRequest(input, this.providerId),
      predictedCachedTokens: predictCachedTokens(input),
      body: body as unknown as Readonly<Record<string, unknown>>,
    };
  }

  async projectResponse(response: ProviderResponse): Promise<ProjectedResponse> {
    const textParts: string[] = [];
    const toolCalls: Array<{ toolCallId: string; toolName: string; arguments: Readonly<Record<string, unknown>> }> = [];
    let continuationId: string | null = null;
    let finishReason: ProjectedResponse["finishReason"] = "stop";
    let reasoning: string | null = null;
    for (const chunk of response.chunks) {
      switch (chunk.kind) {
        case "text":
          if (chunk.text !== undefined) textParts.push(chunk.text);
          if (chunk.reasoning !== undefined) {
            reasoning = (reasoning ?? "") + chunk.reasoning;
          }
          break;
        case "tool_call":
          if (chunk.toolCall) {
            toolCalls.push({
              toolCallId: chunk.toolCall.toolCallId,
              toolName: chunk.toolCall.toolName,
              arguments: chunk.toolCall.arguments,
            });
            finishReason = "tool_use";
          }
          break;
        case "error":
          finishReason = "error";
          break;
        case "done":
          if (chunk.continuationId) continuationId = chunk.continuationId;
          break;
        default: {
          const _e: never = chunk.kind;
          void _e;
        }
      }
    }
    return {
      text: textParts.join(""),
      toolCalls,
      reasoning,
      continuationId,
      finishReason,
    };
  }

  extractUsage(response: ProviderResponse): UsageRecord {
    for (let i = response.chunks.length - 1; i >= 0; i--) {
      const chunk = response.chunks[i]!;
      if (chunk.usage) return chunk.usage;
    }
    return {
      inputTokens: 0n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      cacheWriteTokens: 0n as TokenCount,
      outputTokens: 0n as TokenCount,
      reasoningTokens: 0n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 0,
      timeToFirstTokenMs: null,
    };
  }

  override continuationPolicy(input: ContinuationInput): ContinuationDecision {
    // Anthropic doesn't expose native cross-request continuation in the same
    // way as OpenAI's `previous_response_id`; rely on cache_control instead.
    if (!input.policyAllowsProviderPersistence) {
      return {
        canContinue: false,
        reason: "provider persistence disallowed by policy",
        requiresRerender: false,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    if (input.stablePrefixHashChanged) {
      return {
        canContinue: false,
        reason: "stable prefix hash changed — cache_control breakpoint invalidated",
        requiresRerender: true,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    return {
      canContinue: true,
      reason: "cache_control continuation preserved",
      requiresRerender: false,
      requiresUserConsent: false,
      newContinuationId: input.continuationId,
    };
  }
}

// ────────────────────────── Helpers ──────────────────────────────────────────

function renderSystemBlocks(input: CanonicalRenderInput): readonly AnthropicSystemBlock[] {
  const blocks: AnthropicSystemBlock[] = [];
  for (const f of input.fragments) {
    if (isSystemKind(f.kind)) {
      blocks.push({
        type: "text",
        text: fragmentText(f),
        ...(input.cachePlan.breakpoints.includes(blocks.length)
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      });
    }
  }
  return blocks;
}

function renderMessages(input: CanonicalRenderInput): readonly AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (const f of input.fragments) {
    if (isSystemKind(f.kind)) continue;
    const role: "user" | "assistant" = f.kind === "recent_episode" ? "assistant" : "user";
    messages.push({
      role,
      content: fragmentText(f),
    });
  }
  return messages;
}

/**
 * Resolve the fragment's renderable text. Prefers in-band `textContent`;
 * falls back to the artifact URI when no in-band text is supplied (the
 * kernel renderer dereferences URIs at the wire boundary).
 */
function fragmentText(frag: { readonly textContent?: string | undefined; readonly contentRef: { readonly uri: string } }): string {
  return frag.textContent ?? frag.contentRef.uri;
}

function isSystemKind(kind: string): boolean {
  return kind === "authority" || kind === "project_rule" || kind === "task_contract";
}

function renderTools(schemas: readonly ProviderToolSchema[]): readonly AnthropicToolSchema[] {
  return schemas.map((s) => ({
    name: s.id,
    description: s.summary,
    input_schema: s.inputSchema,
  }));
}

function toProviderRequest(input: CanonicalRenderInput, providerId: string): ProviderRequest {
  return {
    providerId,
    model: input.model.modelKey,
    blocks: input.fragments.map((f) => ({
      role: (isSystemKind(f.kind) ? "system" : f.kind === "recent_episode" ? "assistant" : "user") as "system" | "user" | "assistant" | "tool" | "developer",
      content: fragmentText(f),
      artifactHash: f.contentRef.hash,
      cacheBreakpoint: false,
      confidentiality: f.confidentiality,
    })),
    toolSchemas: input.toolSchemas,
    continuationId: input.continuationId,
    cachePlan: input.cachePlan,
    outputProfile: input.outputProfile,
    reasoningReserveTokens: input.reasoningReserveTokens,
    outputReserveTokens: input.outputReserveTokens,
    hardInputLimit: input.hardInputLimit,
    signal: input.signal,
  };
}

function predictCachedTokens(input: CanonicalRenderInput): TokenCount {
  let cached = 0;
  for (const f of input.fragments) {
    if (f.exactness === "exact") {
      cached += f.estimatedTokens[input.model.modelKey] ?? 0;
    } else {
      break;
    }
  }
  return BigInt(cached) as TokenCount;
}

// ────────────────────────── Transport ────────────────────────────────────────

export interface AnthropicTransport extends ProviderTransport {
  stream(
    request: ProviderRequest,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | null,
  ): AsyncIterable<ProviderResponseChunk>;
}

export function renderRequest(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
  const renderer = new AnthropicRenderer();
  return renderer.render(input);
}
