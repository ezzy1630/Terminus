/**
 * @forge/provider-openai — OpenAI chat-completions renderer.
 *
 * Maps canonical context → OpenAI Chat Completions API format. Handles tool
 * schemas (function calling), system messages, cache control headers,
 * continuation IDs, reasoning summaries. Strict exact-prefix behavior for
 * cache. No actual fetch — exposes `renderRequest()` that returns a
 * serializable request body; HTTP is delegated to a `Transport` interface.
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
  ProviderResponseChunk,
  ProviderRequest,
  ProviderTransport,
  ContinuationInput,
  ContinuationDecision,
  ProviderToolSchema,
} from "@forge/provider-core";
import { BaseProviderRenderer } from "@forge/provider-core";
import type { TokenCount } from "@forge/domain";

// ────────────────────────── OpenAI wire shapes ───────────────────────────────

export interface OpenAiChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool" | "developer";
  readonly content: string;
  readonly cache_control?: "ephemeral" | undefined;
  readonly tool_call_id?: string | undefined;
  readonly tool_calls?: readonly OpenAiToolCall[] | undefined;
  readonly name?: string | undefined;
}

export interface OpenAiToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAiToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly strict: boolean;
  };
}

export interface OpenAiRequestBody {
  readonly model: string;
  readonly messages: readonly OpenAiChatMessage[];
  readonly tools?: readonly OpenAiToolSchema[] | undefined;
  readonly tool_choice?: "auto" | "none" | "required" | { readonly type: "function"; readonly function: { readonly name: string } } | undefined;
  readonly temperature?: number | undefined;
  readonly max_output_tokens?: number | undefined;
  readonly reasoning_effort?: "minimal" | "low" | "medium" | "high" | undefined;
  readonly store?: boolean | undefined;
  readonly previous_response_id?: string | undefined;
  readonly stream: true;
  readonly stream_options?: { readonly include_usage: boolean };
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

// ────────────────────────── Renderer ─────────────────────────────────────────

export class OpenAiRenderer extends BaseProviderRenderer {
  readonly providerId = "openai";
  readonly version = "1.0.0";

  override compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    const base = super.compatibility(input);
    const incompatibilities = [...base.incompatibilities];
    if (input.toolSchemas.length > 128) {
      incompatibilities.push("OpenAI supports at most 128 tools");
    }
    return {
      compatible: incompatibilities.length === 0,
      incompatibilities,
      downgradesRequired: base.downgradesRequired,
    };
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    const messages = renderMessages(input);
    const tools = renderTools(input.toolSchemas);
    const body: OpenAiRequestBody = {
      model: input.model.modelKey,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.continuationId
        ? { previous_response_id: input.continuationId }
        : {}),
      ...(input.outputProfile === "terse"
        ? { temperature: 0.2 }
        : input.outputProfile === "structured"
          ? { temperature: 0 }
          : {}),
      ...(input.reasoningReserveTokens > 0n
        ? { reasoning_effort: "medium" as const }
        : {}),
      ...(input.provider.policy.retentionMode === "organization_zdr"
        ? { store: false }
        : {}),
      max_output_tokens: Number(input.outputReserveTokens),
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
          const _exhaustive: never = chunk.kind;
          void _exhaustive;
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
    const base = super.continuationPolicy(input);
    if (base.canContinue && input.continuationId) {
      return { ...base, newContinuationId: input.continuationId };
    }
    return base;
  }
}

// ────────────────────────── Helpers ──────────────────────────────────────────

function renderMessages(input: CanonicalRenderInput): readonly OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];
  let firstUserBlock = true;
  for (const frag of input.fragments) {
    const role = fragmentRole(frag.kind);
    const cacheBreakpoint = input.cachePlan.breakpoints.includes(messages.length);
    messages.push({
      role,
      content: frag.contentRef.uri,
      ...(cacheBreakpoint && firstUserBlock ? { cache_control: "ephemeral" as const } : {}),
    });
    if (role === "user") firstUserBlock = false;
  }
  return messages;
}

function fragmentRole(kind: string): OpenAiChatMessage["role"] {
  switch (kind) {
    case "authority":
    case "project_rule":
    case "task_contract":
      return "developer";
    case "tool_result":
      return "tool";
    case "recent_episode":
      return "assistant";
    case "user_attachment":
      return "user";
    default:
      return "user";
  }
}

function renderTools(schemas: readonly ProviderToolSchema[]): readonly OpenAiToolSchema[] {
  return schemas.map((s) => ({
    type: "function" as const,
    function: {
      name: s.id,
      description: s.summary,
      parameters: s.inputSchema,
      strict: s.trustLevel === "builtin",
    },
  }));
}

function toProviderRequest(input: CanonicalRenderInput, providerId: string): ProviderRequest {
  return {
    providerId,
    model: input.model.modelKey,
    blocks: input.fragments.map((f) => ({
      role: fragmentRole(f.kind) as "system" | "user" | "assistant" | "tool" | "developer",
      content: f.contentRef.uri,
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

// ────────────────────────── Transport (interface only) ───────────────────────

/**
 * OpenAI-compatible transport. Implementations supply an HTTP client (e.g.
 * `fetch`-based) that posts to `https://api.openai.com/v1/chat/completions`
 * (or an enterprise base URL) and parses the SSE stream.
 *
 * This package does NOT perform the HTTP call. The adapter/mini-service owns
 * the wire so test fakes can replace it.
 */
export interface OpenAiTransport extends ProviderTransport {
  /** Sends a rendered OpenAI request and streams back response chunks. */
  stream(
    request: ProviderRequest,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | null,
  ): AsyncIterable<ProviderResponseChunk>;
}

/** Convenience entrypoint for tests/adapters: render a request body. */
export function renderRequest(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
  const renderer = new OpenAiRenderer();
  return renderer.render(input);
}

export type { ProviderRenderer, ProviderResponseChunk };
