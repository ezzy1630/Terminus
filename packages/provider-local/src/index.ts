/**
 * @forge/provider-local — local-model renderer.
 *
 * Chat-template-aware, tokenizer-aware. Same Transport pattern as other
 * providers (OpenAI-compatible local endpoint).
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

// ────────────────────────── Local wire shapes ────────────────────────────────

/** OpenAI-compatible local request body. */
export interface LocalRequestBody {
  readonly model: string;
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant" | "tool";
    readonly content: string;
  }[];
  readonly tools?: readonly {
    readonly type: "function";
    readonly function: { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> };
  }[] | undefined;
  readonly temperature?: number | undefined;
  readonly max_tokens?: number | undefined;
  readonly stream: true;
  readonly stop?: readonly string[] | undefined;
  /** Optional chat-template override (some local servers support this). */
  readonly chat_template?: string | undefined;
  /** Tokenizer-aware: explicit seed for deterministic local runs. */
  readonly seed?: number | undefined;
}

// ────────────────────────── Tokenizer interface ──────────────────────────────

export interface LocalTokenizer {
  countTokens(text: string): number;
  /** Returns the chat-template-rendered string for a sequence of messages. */
  renderChatTemplate(messages: readonly { readonly role: string; readonly content: string }[]): string;
}

/** A trivial whitespace-based tokenizer for tests and default use. */
export class WhitespaceTokenizer implements LocalTokenizer {
  countTokens(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }
  renderChatTemplate(messages: readonly { readonly role: string; readonly content: string }[]): string {
    return messages.map((m) => `<|${m.role}|>\n${m.content}\n<|end|>`).join("\n");
  }
}

// ────────────────────────── Renderer ─────────────────────────────────────────

export class LocalRenderer extends BaseProviderRenderer {
  readonly providerId = "local";
  readonly version = "1.0.0";
  private readonly tokenizer: LocalTokenizer;

  constructor(tokenizer: LocalTokenizer = new WhitespaceTokenizer()) {
    super();
    this.tokenizer = tokenizer;
  }

  override compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    const base = super.compatibility(input);
    return base;
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    const messages = renderMessages(input);
    const tools = renderTools(input.toolSchemas);
    const body: LocalRequestBody = {
      model: input.model.modelKey,
      messages,
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.outputProfile === "terse"
        ? { temperature: 0.2 }
        : input.outputProfile === "structured"
          ? { temperature: 0 }
          : {}),
      max_tokens: Number(input.outputReserveTokens),
      ...(input.provider.policy.retentionMode === "local_only" ? { seed: 42 } : {}),
    };
    return {
      providerId: this.providerId,
      model: input.model.modelKey,
      request: toProviderRequest(input, this.providerId),
      predictedCachedTokens: 0n as TokenCount, // Local servers typically don't expose cache.
      body: body as unknown as Readonly<Record<string, unknown>>,
    };
  }

  async projectResponse(response: ProviderResponse): Promise<ProjectedResponse> {
    const textParts: string[] = [];
    const toolCalls: Array<{ toolCallId: string; toolName: string; arguments: Readonly<Record<string, unknown>> }> = [];
    let continuationId: string | null = null;
    let finishReason: ProjectedResponse["finishReason"] = "stop";
    for (const chunk of response.chunks) {
      switch (chunk.kind) {
        case "text":
          if (chunk.text !== undefined) textParts.push(chunk.text);
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
    return { text: textParts.join(""), toolCalls, reasoning: null, continuationId, finishReason };
  }

  extractUsage(response: ProviderResponse): UsageRecord {
    for (let i = response.chunks.length - 1; i >= 0; i--) {
      const chunk = response.chunks[i]!;
      if (chunk.usage) return chunk.usage;
    }
    // Fall back to tokenizer-based estimate.
    let totalText = "";
    for (const chunk of response.chunks) {
      if (chunk.kind === "text" && chunk.text !== undefined) totalText += chunk.text;
    }
    return {
      inputTokens: 0n as TokenCount,
      cachedInputTokens: 0n as TokenCount,
      cacheWriteTokens: 0n as TokenCount,
      outputTokens: BigInt(this.tokenizer.countTokens(totalText)) as TokenCount,
      reasoningTokens: 0n as TokenCount,
      toolSchemaTokens: 0n as TokenCount,
      latencyMs: 0,
      timeToFirstTokenMs: null,
    };
  }

  override continuationPolicy(input: ContinuationInput): ContinuationDecision {
    // Local providers typically have no native continuation; require re-render
    // of the full context.
    if (input.stablePrefixHashChanged) {
      return {
        canContinue: false,
        reason: "stable prefix hash changed — re-render required",
        requiresRerender: true,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    return {
      canContinue: true,
      reason: "local continuation via full re-render",
      requiresRerender: true,
      requiresUserConsent: false,
      newContinuationId: input.continuationId,
    };
  }
}

// ────────────────────────── Helpers ──────────────────────────────────────────

function renderMessages(
  input: CanonicalRenderInput,
): readonly { readonly role: "system" | "user" | "assistant" | "tool"; readonly content: string }[] {
  return input.fragments.map((f) => ({
    role: fragmentRole(f.kind),
    content: fragmentText(f),
  }));
}

/**
 * Resolve the fragment's renderable text. Prefers in-band `textContent`;
 * falls back to the artifact URI when no in-band text is supplied (the
 * kernel renderer dereferences URIs at the wire boundary).
 */
function fragmentText(frag: { readonly textContent?: string | undefined; readonly contentRef: { readonly uri: string } }): string {
  return frag.textContent ?? frag.contentRef.uri;
}

function fragmentRole(kind: string): "system" | "user" | "assistant" | "tool" {
  switch (kind) {
    case "authority":
    case "project_rule":
    case "task_contract":
      return "system";
    case "tool_result":
      return "tool";
    case "recent_episode":
      return "assistant";
    default:
      return "user";
  }
}

function renderTools(
  schemas: readonly ProviderToolSchema[],
): readonly {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> };
}[] {
  return schemas.map((s) => ({
    type: "function" as const,
    function: { name: s.id, description: s.summary, parameters: s.inputSchema },
  }));
}

function toProviderRequest(input: CanonicalRenderInput, providerId: string): ProviderRequest {
  return {
    providerId,
    model: input.model.modelKey,
    blocks: input.fragments.map((f) => ({
      role: fragmentRole(f.kind) as "system" | "user" | "assistant" | "tool" | "developer",
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

// ────────────────────────── Transport ────────────────────────────────────────

export interface LocalTransport extends ProviderTransport {
  stream(
    request: ProviderRequest,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | null,
  ): AsyncIterable<ProviderResponseChunk>;
}

export function renderRequest(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
  const renderer = new LocalRenderer();
  return renderer.render(input);
}
