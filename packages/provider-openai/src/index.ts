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
  ProviderReasoningItem,
  ProviderRequest,
  ProviderTransport,
  ContinuationInput,
  ContinuationDecision,
  ProviderToolSchema,
  ReasoningEffort,
  ContextFragment,
} from "@terminus/provider-core";
import {
  BaseProviderRenderer,
  ReasoningReplayLedger,
  resolveModelFamily,
} from "@terminus/provider-core";
import { computeContentHash } from "@terminus/context-ir";
import type { TokenCount } from "@terminus/domain";

export { ReasoningReplayLedger };
export { CodexTurnState, chatGptCodexRequestHeaders } from "./codex_turn_state.js";

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
  readonly reasoning_effort?: string | undefined;
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
  /**
   * The level as the *model* names it, not as Terminus names it: GPT-5.6
   * accepts `none|low|medium|high|xhigh|max` and an unrecognised level is a
   * 400, so this is a string rather than a closed union.
   */
  readonly effort?: string | undefined;
  readonly summary?: "auto" | "none" | undefined;
}

/** `text.verbosity` — how long the model's prose answer should be. */
export type OpenAiTextVerbosity = "low" | "medium" | "high";

export interface OpenAiResponsesTextConfig {
  readonly verbosity: OpenAiTextVerbosity;
}

/** One `summary_text` part of a replayed reasoning item. */
export interface OpenAiResponsesReasoningSummaryPart {
  readonly type: "summary_text";
  readonly text: string;
}

export interface OpenAiPromptCacheBreakpoint {
  readonly mode: "explicit";
}

export interface OpenAiResponsesInputTextContent {
  readonly type: "input_text";
  readonly text: string;
  readonly prompt_cache_breakpoint?: OpenAiPromptCacheBreakpoint | undefined;
}

export type OpenAiResponsesMessageContent =
  | string
  | readonly OpenAiResponsesInputTextContent[];

export interface OpenAiResponsesInputItem {
  readonly role?: "system" | "developer" | "user" | "assistant" | undefined;
  readonly content?: OpenAiResponsesMessageContent | undefined;
  readonly type?: "message" | "function_call" | "function_call_output" | "reasoning" | undefined;
  readonly call_id?: string | undefined;
  readonly name?: string | undefined;
  readonly arguments?: string | undefined;
  readonly output?: OpenAiResponsesMessageContent | undefined;
  /** `reasoning` items only: the provider's own item id (`rs_…`). */
  readonly id?: string | undefined;
  /** `reasoning` items only: the opaque blob from `include`. */
  readonly encrypted_content?: string | undefined;
  /** `reasoning` items only: the summary parts, replayed as received. */
  readonly summary?: readonly OpenAiResponsesReasoningSummaryPart[] | undefined;
}

export interface OpenAiPromptCacheOptions {
  readonly mode: "implicit" | "explicit";
  readonly ttl?: "30m" | undefined;
}

export interface OpenAiResponsesRequestBody {
  readonly model: string;
  /** The stable prefix. A Responses request carries it here, not as a message. */
  readonly instructions?: string | undefined;
  readonly input: string | readonly OpenAiResponsesInputItem[];
  readonly tools?: readonly OpenAiResponsesTool[] | undefined;
  readonly tool_choice?: "auto" | "none" | "required" | { readonly type: "function"; readonly name: string } | undefined;
  readonly temperature?: number | undefined;
  readonly max_output_tokens?: number | undefined;
  readonly reasoning?: OpenAiResponsesReasoningConfig | undefined;
  readonly text?: OpenAiResponsesTextConfig | undefined;
  readonly store?: boolean | undefined;
  readonly include?: readonly string[] | undefined;
  readonly parallel_tool_calls?: boolean | undefined;
  readonly truncation?: "auto" | "disabled" | undefined;
  readonly prompt_cache_key?: string | undefined;
  readonly prompt_cache_options?: OpenAiPromptCacheOptions | undefined;
  readonly previous_response_id?: string | undefined;
  readonly stream: true;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/**
 * What a stateless Responses caller must ask for.
 *
 * `store: false` means the endpoint keeps nothing between requests, so the
 * reasoning chain only survives a tool round trip if the client asks for the
 * encrypted item and plays it back. Requesting it without replaying it — which
 * is what the Codex profile did — pays for the field and throws it away.
 */
export const OPENAI_RESPONSES_INCLUDE = ["reasoning.encrypted_content"] as const;

// ────────────────────────── Renderer ─────────────────────────────────────────

/**
 * Levels that mean "as much as this model will do", strongest first.
 * `ultra` is a Codex-CLI-only level; it is honoured when a model advertises it
 * and never invented.
 */
const MAXIMAL_LEVELS = ["ultra", "max", "xhigh", "high"] as const;

export interface OpenAiReasoningEffortContext {
  /** Levels this exact model advertises, in the catalogue's own order. */
  readonly levels?: readonly string[] | undefined;
  /** The model id, used to recognise a family whose ladder is known. */
  readonly modelId?: string | undefined;
}

/**
 * Map the Terminus effort onto the level this model actually accepts.
 *
 * The old mapping collapsed `max` to `high` unconditionally, which silently
 * threw away the top two rungs of GPT-5.6's ladder (`xhigh`, `max`) — the UI
 * offered "Max" and the wire carried "high". Three sources of truth, in order:
 *
 *   1. the model's own advertised levels, when the caller has them (the Codex
 *      catalogue publishes `supported_reasoning_levels` per slug);
 *   2. the model family, when the ladder is documented (GPT-5.6 takes
 *      `none|low|medium|high|xhigh|max`);
 *   3. otherwise the conservative pre-5.x ladder, where `high` is the top.
 *
 * A guessed level is a 400, so the fallback saturates rather than invents.
 */
export function openAiReasoningEffort(
  effort: ReasoningEffort | null | undefined,
  context: OpenAiReasoningEffortContext = {},
): string {
  const levels = context.levels ?? [];
  if (levels.length > 0) return clampIntoLevels(effort, levels);
  const family = context.modelId === undefined ? "other" : resolveModelFamily(context.modelId);
  if (effort === "max") return family === "gpt-5.6" ? "max" : "high";
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return "medium";
}

function clampIntoLevels(
  effort: ReasoningEffort | null | undefined,
  levels: readonly string[],
): string {
  const has = (name: string): string | null => levels.find((level) => level === name) ?? null;
  if (effort === "max") {
    for (const candidate of MAXIMAL_LEVELS) {
      const found = has(candidate);
      if (found !== null) return found;
    }
    return levels[levels.length - 1]!;
  }
  if (effort === "low" || effort === "medium" || effort === "high") {
    const exact = has(effort);
    if (exact !== null) return exact;
  }
  return has("medium") ?? levels[0]!;
}

export interface OpenAiRendererOptions {
  /** Per-turn reasoning depth (H7). Absent keeps the vendor default. */
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
  /** Levels this exact model advertises; clamps `max` onto the strongest. */
  readonly reasoningLevels?: readonly string[] | undefined;
  /**
   * `text.verbosity`. `low` by default: GPT-5.6 is already terse and the
   * desktop/TUI shows a transcript, not an essay. Legacy "be brief" prompt
   * text is the wrong lever here — 5.6 over-corrects on it.
   */
  readonly textVerbosity?: OpenAiTextVerbosity | undefined;
  /**
   * Cache-routing affinity. Falls back to the compiled stable-prefix hash,
   * which is stable for exactly as long as the prefix it names.
   */
  readonly promptCacheKey?: string | null | undefined;
  /** Defaults to true; a model whose catalogue denies it passes false. */
  readonly parallelToolCalls?: boolean | undefined;
  /** Per-turn store for encrypted reasoning items, replayed on the next attempt. */
  readonly reasoningReplay?: ReasoningReplayLedger | undefined;
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

  /** The effort this renderer will put on the wire for one model. */
  reasoningEffortFor(modelId: string): string {
    return openAiReasoningEffort(this.options.reasoningEffort, {
      ...(this.options.reasoningLevels === undefined ? {} : { levels: this.options.reasoningLevels }),
      modelId,
    });
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
      // Unconditional: the reasoning reserve is a *context accounting* number,
      // and gating the wire field on it meant the effort the user picked never
      // left the process (the reserve was hardcoded to 0). A model that does
      // not reason has this field stripped one layer up, where the catalogue
      // is known.
      reasoning_effort: this.reasoningEffortFor(String(input.model.modelKey)),
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
      ...(input.estimatedInputTokens === undefined
        ? {}
        : { estimatedInputTokens: input.estimatedInputTokens }),
      ...(input.predictedCacheWriteTokens === undefined
        ? {}
        : { predictedCacheWriteTokens: input.predictedCacheWriteTokens }),
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
          if (chunk.stopReason === "length" && finishReason === "stop") {
            finishReason = "length";
          } else if (chunk.stopReason === "content_filter") {
            finishReason = "refusal";
          }
          break;
        default: {
          const _exhaustive: never = chunk.kind;
          void _exhaustive;
        }
      }
    }
    // Projecting a response is also when the reasoning chain is banked: the
    // items are attached to the tool calls they preceded so the next attempt
    // in this turn can replay each one immediately before its call.
    // Keyed, not flat: the entries are what gets persisted so a renderer
    // rebuilt after a restart can still replay the encrypted item immediately
    // before the `function_call` it produced.
    const replay = this.options.reasoningReplay?.ingestAll(response.chunks) ?? { items: [], entries: [] };
    const reasoningItems = replay.items;
    const replayEntries = replay.entries;
    return {
      text: textParts.join(""),
      toolCalls,
      reasoning,
      continuationId,
      finishReason,
      ...(reasoningItems.length > 0 ? { reasoningItems } : {}),
      ...(replayEntries.length > 0 ? { reasoningReplay: replayEntries } : {}),
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
  reasoningReplay?: ReasoningReplayLedger | undefined,
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
        // The reasoning that produced this call goes back immediately before
        // it, in the order the model emitted it. Anywhere else and the model
        // reads it as reasoning about a different step.
        for (const item of reasoningReplay?.itemsFor(call.id) ?? []) {
          items.push(reasoningInputItem(item));
        }
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

/** One banked reasoning item, as the Responses API expects it back. */
export function reasoningInputItem(item: ProviderReasoningItem): OpenAiResponsesInputItem {
  return {
    type: "reasoning",
    id: item.id,
    encrypted_content: item.encryptedContent,
    summary: item.summary.map((text) => ({ type: "summary_text" as const, text })),
  };
}

/**
 * Fragment kinds that make up the stable prefix.
 *
 * A Responses request names its system prompt `instructions`, a top-level
 * string outside `input`. Sending it as leading `developer` items instead —
 * which is what this did — puts the one genuinely static part of the request
 * inside the array that changes every attempt, and costs the prefix its own
 * identity in the cache. The task contract is deliberately *not* here: it
 * changes per task and belongs with the task, in `input`.
 */
const INSTRUCTION_FRAGMENT_KINDS: ReadonlySet<string> = new Set(["authority", "project_rule"]);
const OPENAI_PROMPT_CACHE_KEY_MAX_CHARS = 64;
const SHA256_PREFIX = "sha256:";
const EXPLICIT_PROMPT_CACHE_BREAKPOINT = { mode: "explicit" } as const;

export interface InstructionSplit {
  readonly instructions: string;
  readonly remaining: readonly ContextFragment[];
}

/** Split the compiled fragments into the `instructions` string and the rest. */
export function splitInstructionFragments(
  fragments: readonly ContextFragment[],
): InstructionSplit {
  const instructions: string[] = [];
  const remaining: ContextFragment[] = [];
  for (const fragment of fragments) {
    if (INSTRUCTION_FRAGMENT_KINDS.has(fragment.kind)) {
      instructions.push(fragmentText(fragment));
      continue;
    }
    remaining.push(fragment);
  }
  return { instructions: instructions.join("\n\n"), remaining };
}

/**
 * Bound cache-routing affinity without leaking a long human-readable scope.
 *
 * Context hashes already have the right 64-character payload, so stripping
 * their algorithm prefix preserves identity. Other oversized keys are
 * content-addressed instead of truncated because the end often carries the
 * distinguishing session or epoch component.
 */
export function normalizePromptCacheKey(key: string): string {
  if (key.length > 0 && key.length <= OPENAI_PROMPT_CACHE_KEY_MAX_CHARS) return key;
  if (/^sha256:[0-9a-f]{64}$/i.test(key)) return key.slice(SHA256_PREFIX.length);
  return computeContentHash(key).slice(SHA256_PREFIX.length);
}

function usesExplicitPromptCaching(input: CanonicalRenderInput): boolean {
  return input.provider.caching.mode === "explicit_breakpoints"
    && resolveModelFamily(String(input.model.modelKey)) === "gpt-5.6";
}

/** Mark the last cacheable content part produced by one canonical fragment. */
function markExplicitPromptCacheBreakpoint(
  items: readonly OpenAiResponsesInputItem[],
): readonly OpenAiResponsesInputItem[] {
  if (items.length === 0) return items;
  const lastIndex = items.length - 1;
  const last = items[lastIndex]!;
  if (typeof last.content === "string") {
    const text = last.content;
    return items.map((item, index) => index === lastIndex
      ? {
          ...item,
          content: [{
            type: "input_text" as const,
            text,
            prompt_cache_breakpoint: EXPLICIT_PROMPT_CACHE_BREAKPOINT,
          }],
        }
      : item);
  }
  if (last.type === "function_call_output" && typeof last.output === "string") {
    const text = last.output;
    return items.map((item, index) => index === lastIndex
      ? {
          ...item,
          output: [{
            type: "input_text" as const,
            text,
            prompt_cache_breakpoint: EXPLICIT_PROMPT_CACHE_BREAKPOINT,
          }],
        }
      : item);
  }
  return items;
}

/**
 * Preserve the compiler's fragment-index cache plan while translating the
 * transcript into the Responses item dialect. Top-level instructions are
 * skipped here; a later input marker still includes them in the cached prefix.
 */
function renderResponsesInputItems(
  input: CanonicalRenderInput,
  reasoningReplay?: ReasoningReplayLedger | undefined,
): readonly OpenAiResponsesInputItem[] {
  const explicitCaching = usesExplicitPromptCaching(input);
  const breakpoints = new Set(input.cachePlan.breakpoints);
  const items: OpenAiResponsesInputItem[] = [];
  for (const [fragmentIndex, fragment] of input.fragments.entries()) {
    if (INSTRUCTION_FRAGMENT_KINDS.has(fragment.kind)) continue;
    const fragmentMessages = renderMessages({
      ...input,
      fragments: [fragment],
      cachePlan: { ...input.cachePlan, breakpoints: [] },
    });
    const fragmentItems = toResponsesInputItems(fragmentMessages, reasoningReplay);
    items.push(...(
      explicitCaching && breakpoints.has(fragmentIndex)
        ? markExplicitPromptCacheBreakpoint(fragmentItems)
        : fragmentItems
    ));
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
  const { instructions } = splitInstructionFragments(input.fragments);
  const items = renderResponsesInputItems(input, options.reasoningReplay);
  const rawPromptCacheKey = typeof options.promptCacheKey === "string" && options.promptCacheKey !== ""
    ? options.promptCacheKey
    // Not a session id, but the next best stable thing this layer can see: the
    // hash of the prefix whose cache entry the key is meant to route to.
    : String(input.cachePlan.stablePrefixHash);
  const promptCacheKey = normalizePromptCacheKey(rawPromptCacheKey);
  const explicitPromptCaching = usesExplicitPromptCaching(input);
  const hasTools = body.tools !== undefined && body.tools.length > 0;
  const responsesBody: OpenAiResponsesRequestBody = {
    model: body.model,
    ...(instructions === "" ? {} : { instructions }),
    input: items,
    stream: true,
    ...(hasTools
      ? {
          tools: body.tools!.map((t) => ({
            type: "function" as const,
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            strict: t.function.strict,
          })),
          // Both vendors default this on and the harness executes calls
          // concurrently; saying so explicitly is what stops the model from
          // serialising a read batch it could have issued at once.
          parallel_tool_calls: options.parallelToolCalls ?? true,
        }
      : {}),
    ...(body.max_output_tokens !== undefined ? { max_output_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning_effort !== undefined
      ? { reasoning: { effort: body.reasoning_effort, summary: "auto" } }
      : {}),
    text: { verbosity: options.textVerbosity ?? "low" },
    // Stateless by construction. `store: true` leaves a copy of every request
    // on OpenAI's side and buys only `previous_response_id`, which this
    // renderer replaces with an explicit encrypted-reasoning replay.
    store: false,
    include: [...OPENAI_RESPONSES_INCLUDE],
    // The endpoint drops the oldest input items rather than failing the whole
    // request when the compiled prompt overshoots the window.
    truncation: "auto",
    prompt_cache_key: promptCacheKey,
    ...(explicitPromptCaching
      ? {
          prompt_cache_options: {
            mode: "explicit" as const,
            ...(input.provider.caching.ttlOptions.includes("30m") ? { ttl: "30m" as const } : {}),
          },
        }
      : {}),
  };
  return {
    ...rendered,
    body: sanitizeResponsesBody(responsesBody as unknown as Readonly<Record<string, unknown>>),
  };
}

export type { ProviderRenderer, ProviderResponseChunk };

export * from "./model_profiles.js";
export * from "./stream.js";
