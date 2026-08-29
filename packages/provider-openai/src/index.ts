/**
 * @terminus/provider-openai — OpenAI chat-completions renderer.
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
  ReasoningEffort,
} from "@terminus/provider-core";
import { BaseProviderRenderer } from "@terminus/provider-core";
import type { TokenCount } from "@terminus/domain";

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

// ────────────────────────── OpenAI Responses API wire shapes ─────────────────

export interface OpenAiResponsesTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict?: boolean | undefined;
}

export interface OpenAiResponsesReasoningConfig {
  readonly effort?: "minimal" | "low" | "medium" | "high" | undefined;
  readonly summary?: "auto" | "none" | undefined;
}

export interface OpenAiResponsesInputItem {
  readonly role?: "system" | "developer" | "user" | "assistant" | undefined;
  readonly content?: string | undefined;
  readonly type?: "message" | "function_call" | "function_call_output" | undefined;
  readonly call_id?: string | undefined;
  readonly name?: string | undefined;
  readonly arguments?: string | undefined;
  readonly output?: string | undefined;
}

export interface OpenAiResponsesRequestBody {
  readonly model: string;
  readonly input: string | readonly OpenAiResponsesInputItem[];
  readonly tools?: readonly OpenAiResponsesTool[] | undefined;
  readonly tool_choice?: "auto" | "none" | "required" | { readonly type: "function"; readonly name: string } | undefined;
  readonly temperature?: number | undefined;
  readonly max_output_tokens?: number | undefined;
  readonly reasoning?: OpenAiResponsesReasoningConfig | undefined;
  readonly store?: boolean | undefined;
  readonly previous_response_id?: string | undefined;
  readonly stream: true;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

// ────────────────────────── Renderer ─────────────────────────────────────────

/**
 * Map the Terminus effort level onto OpenAI's scale. `max` has no separate
 * OpenAI level, so it saturates at `high` rather than silently downgrading to
 * the default.
 */
export function openAiReasoningEffort(
  effort: ReasoningEffort | null | undefined,
): "minimal" | "low" | "medium" | "high" {
  switch (effort) {
    case "low": return "low";
    case "high": return "high";
    case "max": return "high";
    case "medium": return "medium";
    default: return "medium";
  }
}

export interface OpenAiRendererOptions {
  /** Per-turn reasoning depth (H7). Absent keeps the previous `medium`. */
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
}

export class OpenAiRenderer extends BaseProviderRenderer {
  readonly providerId = "openai";
  readonly version = "1.0.0";

  private readonly options: OpenAiRendererOptions;

  constructor(options: OpenAiRendererOptions = {}) {
    super();
    this.options = options;
  }

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
    this.assertCompilationAuthority(input);
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
        ? { reasoning_effort: openAiReasoningEffort(this.options.reasoningEffort) }
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
    const cacheBreakpoint = input.cachePlan.breakpoints.includes(messages.length);

    if (frag.kind === "tool_result") {
      let toolCallId = frag.id;
      let resultContent = fragmentText(frag);
      try {
        const raw = JSON.parse(fragmentText(frag)) as Record<string, unknown>;
        if (raw && typeof raw === "object" && raw.protocol === "terminus.tool-result.v1" && typeof raw.provider_call_id === "string") {
          toolCallId = raw.provider_call_id;
          resultContent = typeof raw.result === "string" ? raw.result : JSON.stringify(raw.result);
        }
      } catch {
        // use raw text
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: resultContent,
      });
      continue;
    }

    if (frag.kind === "recent_episode") {
      try {
        const raw = JSON.parse(fragmentText(frag)) as Record<string, unknown>;
        if (raw && typeof raw === "object" && raw.protocol === "terminus.tool-call.v1" && typeof raw.provider_call_id === "string") {
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: raw.provider_call_id,
                type: "function",
                function: {
                  name: String(raw.tool_name),
                  arguments: JSON.stringify(raw.arguments ?? {}),
                },
              },
            ],
          });
          continue;
        }
      } catch {
        // use raw text
      }
      messages.push({
        role: "assistant",
        content: fragmentText(frag),
      });
      continue;
    }

    const role = fragmentRole(frag.kind);
    messages.push({
      role,
      content: fragmentText(frag),
      ...(cacheBreakpoint && firstUserBlock ? { cache_control: "ephemeral" as const } : {}),
    });
    if (role === "user") firstUserBlock = false;
  }
  return messages;
}

/**
 * Resolve the fragment's renderable text. Prefers in-band `textContent`
 * (the pragmatic shortcut for package-layer callers that already have the
 * rendered text); falls back to the artifact URI for callers that wire in a
 * real artifact store at a higher layer (e.g. the kernel renderer will
 * dereference the URI before sending to the provider).
 */
function fragmentText(frag: { readonly textContent?: string | undefined; readonly contentRef: { readonly uri: string } }): string {
  return frag.textContent ?? frag.contentRef.uri;
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

/**
 * Keywords OpenAI's strict function schemas reject or ignore.
 *
 * `default` is the one that bites us: our builtin schemas use it to document
 * an optional parameter's fallback, which is exactly the shape strict mode
 * forbids. The combinators are listed because strict mode understands only
 * `anyOf`, and an unsupported keyword fails the whole request rather than the
 * field it appears on.
 */
const NON_STRICT_SCHEMA_KEYWORDS: readonly string[] = [
  "default",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "contains",
  "minProperties",
  "maxProperties",
];

/**
 * Answer whether a JSON Schema already satisfies OpenAI strict function calling.
 *
 * `strict` is a claim about the schema, not a compliment to its author. The
 * endpoint rejects the request outright — `'required' is required to be
 * supplied and to be an array including every key in properties` — when the
 * claim is false, so it is only ever set where it is already true. Our builtin
 * tools deliberately carry optional parameters with defaults (`read` has
 * `max_bytes`), so most of them render as ordinary, non-strict function
 * schemas. Rendering a conformant schema as non-strict costs a guarantee;
 * rendering a non-conformant one as strict costs the turn.
 */
export function schemaSatisfiesStrictMode(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  for (const keyword of NON_STRICT_SCHEMA_KEYWORDS) {
    if (keyword in schema) return false;
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.every((branch) => schemaSatisfiesStrictMode(branch))) return false;
  }
  if (isPlainObject(schema.$defs)) {
    if (!Object.values(schema.$defs).every((def) => schemaSatisfiesStrictMode(def))) return false;
  }
  if ("items" in schema) {
    // Tuple validation is not part of strict mode.
    if (Array.isArray(schema.items)) return false;
    if (!schemaSatisfiesStrictMode(schema.items)) return false;
  }
  const properties = schema.properties;
  const declaresObject = schema.type === "object" || properties !== undefined;
  if (!declaresObject) return true;
  if (!isPlainObject(properties)) return false;
  if (schema.additionalProperties !== false) return false;
  const required = schema.required;
  if (!Array.isArray(required)) return false;
  const names = Object.keys(properties);
  const declared = new Set(required.filter((name): name is string => typeof name === "string"));
  if (declared.size !== required.length) return false;
  if (declared.size !== names.length) return false;
  for (const name of names) {
    if (!declared.has(name)) return false;
    if (!schemaSatisfiesStrictMode(properties[name])) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderTools(schemas: readonly ProviderToolSchema[]): readonly OpenAiToolSchema[] {
  return schemas.map((s) => ({
    type: "function" as const,
    function: {
      name: s.id,
      description: s.summary,
      parameters: s.inputSchema,
      strict: schemaSatisfiesStrictMode(s.inputSchema),
    },
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

/** Convenience entrypoint for tests/adapters: render a chat-completions request body. */
export function renderRequest(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
  const renderer = new OpenAiRenderer();
  return renderer.render(input);
}

/**
 * Keys that exist only in the Chat Completions dialect.
 *
 * `cache_control` is the prompt-cache marker `renderMessages` stamps on the
 * first cached user block. Chat Completions ignores an unknown key; the
 * Responses API rejects the whole request with
 * `Unknown parameter: 'input[4].cache_control'` — observed live against the
 * ChatGPT Codex endpoint on 2026-08-29. The other three are structural: a
 * Responses item names its tool call with `call_id`/`name`/`arguments`, not
 * with a `tool_calls` array or a `tool` role.
 */
const CHAT_ONLY_ITEM_KEYS = ["cache_control", "tool_calls", "tool_call_id", "name"] as const;

/**
 * Drop `cache_control` anywhere it appears, however deeply nested.
 *
 * The top-level rewrite below already produces clean items, but a content part
 * or a tool parameter schema can carry the marker too, and one stray key fails
 * the entire request rather than the field.
 */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (typeof value !== "object" || value === null) return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "cache_control") continue;
    cleaned[key] = withoutCacheControl(nested);
  }
  return cleaned;
}

/** Strip every Chat-Completions-only key from a Responses request body. */
export function sanitizeResponsesBody(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return withoutCacheControl(body) as Readonly<Record<string, unknown>>;
}

/**
 * Rewrite Chat Completions messages as Responses input items.
 *
 * The two dialects are not the same shape wearing different names: a tool
 * result is a `function_call_output` item rather than a `tool` role, and an
 * assistant tool call is its own `function_call` item rather than a field on
 * the assistant message. Passing the chat array through unchanged — which is
 * what this did — sent the endpoint keys it rejects.
 */
export function toResponsesInputItems(
  messages: readonly OpenAiChatMessage[],
): readonly OpenAiResponsesInputItem[] {
  const items: OpenAiResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id !== "") {
      items.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length > 0) {
      if (message.content !== "") {
        items.push({ role: "assistant", content: message.content });
      }
      for (const call of toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    // `tool` without a call id has nothing to attach to; the Responses API has
    // no such role, so it is carried as an ordinary user turn.
    items.push({
      role: message.role === "tool" ? "user" : message.role,
      content: message.content,
    });
  }
  return items;
}

/** Render a native OpenAI Responses API request body. */
export async function renderResponsesRequest(
  input: CanonicalRenderInput,
  options: OpenAiRendererOptions = {},
): Promise<RenderedProviderRequest> {
  const renderer = new OpenAiRenderer(options);
  const rendered = await renderer.render(input);
  const body = rendered.body as unknown as OpenAiRequestBody;
  const responsesBody: OpenAiResponsesRequestBody = {
    model: body.model,
    input: toResponsesInputItems(body.messages),
    stream: true,
    ...(body.tools && body.tools.length > 0
      ? {
          tools: body.tools.map((t) => ({
            type: "function" as const,
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            strict: t.function.strict,
          })),
        }
      : {}),
    ...(body.max_output_tokens !== undefined ? { max_output_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning_effort !== undefined
      ? { reasoning: { effort: body.reasoning_effort, summary: "auto" } }
      : {}),
    ...(body.previous_response_id !== undefined ? { previous_response_id: body.previous_response_id } : {}),
    ...(body.store !== undefined ? { store: body.store } : {}),
  };
  return {
    ...rendered,
    body: sanitizeResponsesBody(responsesBody as unknown as Readonly<Record<string, unknown>>),
  };
}

export type { ProviderRenderer, ProviderResponseChunk };

export * from "./model_profiles.js";
export * from "./stream.js";
export * from "./chatgpt_codex.js";

