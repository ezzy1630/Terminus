/**
 * @terminus/provider-google — Google Gemini renderer.
 *
 * Maps to `generateContent` with `systemInstruction`, `functionDeclarations`,
 * and `cachedContent`. Same Transport pattern as other providers.
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
} from "@terminus/provider-core";
import { BaseProviderRenderer } from "@terminus/provider-core";
import type { TokenCount } from "@terminus/domain";

// ────────────────────────── Google wire shapes ───────────────────────────────

export interface GeminiPart {
  readonly text?: string | undefined;
  readonly functionCall?: { readonly name: string; readonly args: Readonly<Record<string, unknown>> } | undefined;
  readonly functionResponse?: { readonly name: string; readonly response: Readonly<Record<string, unknown>> } | undefined;
}

export interface GeminiContent {
  readonly role: "user" | "model" | "function";
  readonly parts: readonly GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface GeminiRequestBody {
  readonly contents: readonly GeminiContent[];
  readonly systemInstruction?: { readonly parts: readonly { readonly text: string }[] } | undefined;
  readonly tools?: readonly { readonly functionDeclarations: readonly GeminiFunctionDeclaration[] }[] | undefined;
  readonly toolConfig?: { readonly functionCallingConfig: { readonly mode: "AUTO" | "ANY" | "NONE" } } | undefined;
  readonly cachedContent?: string | undefined;
  readonly generationConfig?: {
    readonly temperature?: number | undefined;
    readonly maxOutputTokens?: number | undefined;
    readonly thinkingConfig?: { readonly includeThoughts: boolean; readonly thinkingBudget?: number | undefined } | undefined;
  } | undefined;
}

// ────────────────────────── Renderer ─────────────────────────────────────────

export class GoogleRenderer extends BaseProviderRenderer {
  readonly providerId = "google";
  readonly version = "1.0.0";

  override compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    const base = super.compatibility(input);
    const incompatibilities = [...base.incompatibilities];
    if (input.toolSchemas.length > 128) {
      incompatibilities.push("Gemini supports at most 128 function declarations");
    }
    return {
      compatible: incompatibilities.length === 0,
      incompatibilities,
      downgradesRequired: base.downgradesRequired,
    };
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    const systemInstruction = renderSystemInstruction(input);
    const contents = renderContents(input);
    const tools = renderTools(input.toolSchemas);
    const body: GeminiRequestBody = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools.length > 0
        ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: "AUTO" as const } } }
        : {}),
      ...(input.continuationId ? { cachedContent: input.continuationId } : {}),
      generationConfig: {
        ...(input.outputProfile === "terse"
          ? { temperature: 0.2 }
          : input.outputProfile === "structured"
            ? { temperature: 0 }
            : {}),
        maxOutputTokens: Number(input.outputReserveTokens),
        ...(input.reasoningReserveTokens > 0n
          ? { thinkingConfig: { includeThoughts: true, thinkingBudget: Number(input.reasoningReserveTokens) } }
          : {}),
      },
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
    let toolCallIdx = 0;
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
              toolCallId: chunk.toolCall.toolCallId ?? `call-${toolCallIdx++}`,
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
    return { text: textParts.join(""), toolCalls, reasoning, continuationId, finishReason };
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
    if (!input.policyAllowsProviderPersistence) {
      return {
        canContinue: false,
        reason: "provider persistence disallowed by policy",
        requiresRerender: false,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    if (input.continuationId === null) {
      return {
        canContinue: false,
        reason: "no cachedContent id present",
        requiresRerender: false,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    if (input.stablePrefixHashChanged) {
      return {
        canContinue: false,
        reason: "stable prefix hash changed — cachedContent invalidated",
        requiresRerender: true,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    return {
      canContinue: true,
      reason: "cachedContent preserved",
      requiresRerender: false,
      requiresUserConsent: false,
      newContinuationId: input.continuationId,
    };
  }
}

// ────────────────────────── Helpers ──────────────────────────────────────────

function renderSystemInstruction(
  input: CanonicalRenderInput,
): { readonly parts: readonly { readonly text: string }[] } | null {
  const systemFrags = input.fragments.filter((f) => isSystemKind(f.kind));
  if (systemFrags.length === 0) return null;
  return { parts: systemFrags.map((f) => ({ text: fragmentText(f) })) };
}

function renderContents(input: CanonicalRenderInput): readonly GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const f of input.fragments) {
    if (isSystemKind(f.kind)) continue;
    const role: "user" | "model" | "function" =
      f.kind === "recent_episode" ? "model" : f.kind === "tool_result" ? "function" : "user";
    contents.push({ role, parts: [{ text: fragmentText(f) }] });
  }
  return contents;
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

function renderTools(schemas: readonly ProviderToolSchema[]): readonly GeminiFunctionDeclaration[] {
  return schemas.map((s) => ({
    name: s.id,
    description: s.summary,
    parameters: s.inputSchema,
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

export interface GoogleTransport extends ProviderTransport {
  stream(
    request: ProviderRequest,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | null,
  ): AsyncIterable<ProviderResponseChunk>;
}

export function renderRequest(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
  const renderer = new GoogleRenderer();
  return renderer.render(input);
}
