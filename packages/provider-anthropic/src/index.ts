/**
 * @terminus/provider-anthropic — Anthropic Messages API renderer.
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
  ReasoningEffort,
} from "@terminus/provider-core";
import {
  BaseProviderRenderer,
  ReasoningReplayLedger,
  normalizeModelId,
} from "@terminus/provider-core";
import type { TokenCount } from "@terminus/domain";

// ────────────────────────── Model generations ────────────────────────────────

/**
 * How this model id wants its reasoning configured.
 *
 * The Messages API changed shape under Terminus between 4.5 and 4.7 and the
 * old shape is now a hard 400, not a deprecation warning:
 *
 *   - `adaptive` — Claude 4.6 and later, including every Claude 5 model.
 *     `thinking: {type: "adaptive"}`; depth is `output_config.effort`;
 *     `budget_tokens` is removed (400 on 4.7+, Fable 5, Opus 5, Sonnet 5).
 *   - `budget` — Claude 4.5 and earlier. `thinking: {type: "enabled",
 *     budget_tokens: N}` is the only way to think at all, and only for a model
 *     whose capability snapshot says it reasons.
 *
 * Sampling parameters (`temperature`, `top_p`, `top_k`) were removed alongside
 * `budget_tokens`, so nothing in the `adaptive` generation may carry them.
 * That combination — `budget_tokens` plus `temperature: 0.2` — is exactly what
 * this renderer used to send, and it 400s on every current model.
 */
export type AnthropicThinkingGeneration = "adaptive" | "budget";

/** `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-mythos-5`, … */
const CLAUDE_5_PATTERN = /^claude-(?:opus|fable|sonnet|mythos|haiku)-5(?:[-_].*)?$/;

/** `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-4-6`, … */
const CLAUDE_4_ADAPTIVE_PATTERN = /^claude-(?:opus|sonnet|haiku)-4-(\d+)(?:[-_].*)?$/;

/** The 4.x minor version at which `budget_tokens` stopped being the interface. */
const ADAPTIVE_THINKING_MINOR = 6;

export function anthropicThinkingGeneration(modelId: string): AnthropicThinkingGeneration {
  const id = normalizeModelId(modelId);
  if (CLAUDE_5_PATTERN.test(id)) return "adaptive";
  const four = CLAUDE_4_ADAPTIVE_PATTERN.exec(id);
  if (four !== null && Number.parseInt(four[1]!, 10) >= ADAPTIVE_THINKING_MINOR) return "adaptive";
  // An id this renderer does not recognise (a gateway alias, a fine-tune) is
  // treated as pre-4.6: the old shape is accepted by old models and rejected
  // by new ones, and the new shape is rejected by old ones. Only one of those
  // two mistakes is recoverable by the user renaming their model.
  return "budget";
}

/**
 * `output_config.effort` is GA on the adaptive generation and errors on
 * Sonnet 4.5 / Haiku 4.5, so it travels with the generation, not separately.
 */
export function anthropicSupportsEffort(modelId: string): boolean {
  return anthropicThinkingGeneration(modelId) === "adaptive";
}

/** Anthropic has no xhigh/ultra rung, so those canonical depths saturate at max. */
export function anthropicEffort(effort: ReasoningEffort | null | undefined): "low" | "medium" | "high" | "max" | null {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return effort;
    case "xhigh":
    case "ultra":
      return "max";
    default:
      // Absent means "the user did not choose": send nothing and take
      // Anthropic's own default (`high`), rather than pinning a level the
      // user never asked for and invalidating the cache when they do choose.
      return null;
  }
}

/** `budget_tokens` must be at least 1024 and strictly below `max_tokens`. */
const MINIMUM_THINKING_BUDGET_TOKENS = 1_024;

// ────────────────────────── Anthropic wire shapes ────────────────────────────

export interface AnthropicSystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" } | undefined;
}

export interface AnthropicContentBlock {
  readonly type: "text" | "tool_use" | "tool_result" | "thinking" | "redacted_thinking";
  readonly text?: string | undefined;
  /** `thinking` blocks only: the reasoning text, replayed exactly as received. */
  readonly thinking?: string | undefined;
  /** `thinking` blocks only: the signature that makes the block replayable. */
  readonly signature?: string | undefined;
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
  readonly cache_control?: { readonly type: "ephemeral" } | undefined;
}

/** `{type:"adaptive"}` on 4.6+, `{type:"enabled", budget_tokens}` before it. */
export type AnthropicThinkingConfig =
  | { readonly type: "adaptive"; readonly display?: "summarized" | "omitted" | undefined }
  | { readonly type: "enabled"; readonly budget_tokens: number };

/** Depth and pacing controls that replaced `budget_tokens`. */
export interface AnthropicOutputConfig {
  readonly effort?: "low" | "medium" | "high" | "max" | undefined;
}

export interface AnthropicRequestBody {
  readonly model: string;
  readonly system: readonly AnthropicSystemBlock[];
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: readonly AnthropicToolSchema[] | undefined;
  readonly tool_choice?: { readonly type: "auto" | "any" | "tool"; readonly name?: string } | undefined;
  readonly max_tokens: number;
  readonly temperature?: number | undefined;
  readonly thinking?: AnthropicThinkingConfig | undefined;
  readonly output_config?: AnthropicOutputConfig | undefined;
  readonly stream: true;
  readonly metadata?: { readonly user_id?: string } | undefined;
}

/**
 * Betas this body's own fields require, in `anthropic-beta` order.
 *
 * The header is not a capability announcement: sending a beta the request does
 * not use opts the whole call into that beta's semantics for no reason, and
 * the kernel connector allowlist has to admit every name that appears. So the
 * list is derived from the body rather than configured, and an ordinary
 * request produces none at all.
 *
 * Deliberately *not* here: adaptive thinking, `output_config.effort`,
 * interleaved thinking, fine-grained tool streaming and strict tools are all
 * GA and require no header.
 */
export function anthropicRequiredBetas(
  body: Readonly<Record<string, unknown>>,
): readonly string[] {
  const betas: string[] = [];
  if (isRecord(body.context_management)) betas.push("context-management-2025-06-27");
  const outputConfig = isRecord(body.output_config) ? body.output_config : null;
  if (outputConfig !== null && isRecord(outputConfig.task_budget)) {
    betas.push("task-budgets-2026-03-13");
  }
  if (bodyUsesCompaction(body)) betas.push("compact-2026-01-12");
  if (body.fallbacks !== undefined) betas.push("server-side-fallback-2026-07-01");
  if (body.speed === "fast") betas.push("fast-mode-2026-02-01");
  return betas;
}

function bodyUsesCompaction(body: Readonly<Record<string, unknown>>): boolean {
  const contextManagement = isRecord(body.context_management) ? body.context_management : null;
  if (contextManagement === null || !Array.isArray(contextManagement.edits)) return false;
  return contextManagement.edits.some(
    (edit) => isRecord(edit) && typeof edit.type === "string" && edit.type.startsWith("compact_"),
  );
}

/** The `anthropic-beta` header value, or null when nothing needs one. */
export function anthropicBetaHeader(
  body: Readonly<Record<string, unknown>>,
): string | null {
  const betas = anthropicRequiredBetas(body);
  return betas.length === 0 ? null : betas.join(",");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ────────────────────────── Renderer ─────────────────────────────────────────

export interface AnthropicRendererOptions {
  /** Per-turn reasoning depth (H7); rendered as `output_config.effort`. */
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
  /**
   * `thinking.display`. Anthropic defaults to `omitted` on every current
   * model, which streams empty thinking blocks; `summarized` is what a UI
   * that actually shows reasoning must ask for.
   */
  readonly thinkingDisplay?: "summarized" | "omitted" | undefined;
  /**
   * Per-turn store for thinking blocks. Anthropic rejects an assistant turn
   * whose `tool_use` block is not preceded by the thinking block that produced
   * it, so the blocks are banked when a response is projected and replayed —
   * byte for byte, signature intact — when the next attempt is rendered.
   */
  readonly reasoningReplay?: ReasoningReplayLedger | undefined;
}

export class AnthropicRenderer extends BaseProviderRenderer {
  readonly providerId = "anthropic";
  readonly version = "1.0.0";

  private readonly options: AnthropicRendererOptions;
  readonly reasoningReplay: ReasoningReplayLedger;

  constructor(options: AnthropicRendererOptions = {}) {
    super();
    this.reasoningReplay = options.reasoningReplay ?? new ReasoningReplayLedger();
    this.options = { ...options, reasoningReplay: this.reasoningReplay };
  }

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
    this.assertCompilationAuthority(input);
    const system = renderSystemBlocks(input);
    const messages = renderMessages(input, this.reasoningReplay);
    const tools = renderTools(input.toolSchemas);
    const modelId = String(input.model.modelKey);
    const generation = anthropicThinkingGeneration(modelId);
    const maxTokens = Number(input.outputReserveTokens);
    const effort = anthropicEffort(this.options.reasoningEffort);
    // Adaptive is the only on-mode from 4.6 onward and the model decides its
    // own depth; `output_config.effort` is the dial. Before 4.6 the only dial
    // was a token budget, and a model that does not reason at all rejects the
    // `thinking` field outright — so that branch still asks the capability
    // snapshot first.
    const thinking: AnthropicThinkingConfig | null = generation === "adaptive"
      ? {
          type: "adaptive",
          ...(this.options.thinkingDisplay === undefined ? {} : { display: this.options.thinkingDisplay }),
        }
      : input.provider?.reasoning?.supported === true
        ? { type: "enabled", budget_tokens: legacyThinkingBudget(input.reasoningReserveTokens, maxTokens) }
        : null;
    // Sampling parameters and thinking are mutually exclusive everywhere:
    // removed outright on 4.7+, and rejected alongside `thinking` before that.
    const sampling = thinking !== null
      ? {}
      : input.outputProfile === "terse"
        ? { temperature: 0.2 }
        : input.outputProfile === "structured"
          ? { temperature: 0 }
          : {};
    const body: AnthropicRequestBody = {
      model: input.model.modelKey,
      system,
      messages,
      max_tokens: maxTokens,
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
      ...(thinking === null ? {} : { thinking }),
      ...(effort !== null && anthropicSupportsEffort(modelId) ? { output_config: { effort } } : {}),
      ...sampling,
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
    let refusalReason: string | null = null;
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
          // A refusal is an HTTP 200 whose `content` is not an answer. It
          // outranks `tool_use`/`stop` because it describes the whole turn,
          // and it is terminal: retrying it burns quota to be refused again.
          if (chunk.stopReason === "refusal") {
            finishReason = "refusal";
            refusalReason = chunk.stopDetail ?? null;
          } else if (chunk.stopReason === "max_tokens" && finishReason === "stop") {
            finishReason = "length";
          }
          break;
        default: {
          const _e: never = chunk.kind;
          void _e;
        }
      }
    }
    // Bank the thinking blocks against the tool calls they preceded so the
    // next attempt in this turn replays them in the position Anthropic
    // requires.
    // Keyed, not flat: the entries are what gets persisted so a renderer
    // rebuilt after a restart can still lead each `tool_use` with its
    // signed `thinking` block.
    const replay = this.reasoningReplay.ingestAll(response.chunks);
    const reasoningItems = replay.items;
    const replayEntries = replay.entries;
    return {
      text: textParts.join(""),
      toolCalls,
      reasoning,
      continuationId,
      finishReason,
      ...(finishReason === "refusal" ? { refusalReason } : {}),
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

/**
 * The pre-4.6 thinking budget, clamped into the range the endpoint accepts:
 * at least 1024 tokens, and strictly below `max_tokens`.
 */
function legacyThinkingBudget(reserve: bigint, maxTokens: number): number {
  const ceiling = Math.max(MINIMUM_THINKING_BUDGET_TOKENS, maxTokens - 1);
  const requested = reserve > 0n ? Number(reserve) : MINIMUM_THINKING_BUDGET_TOKENS;
  return Math.min(Math.max(requested, MINIMUM_THINKING_BUDGET_TOKENS), ceiling);
}

/**
 * Cache breakpoints are indices into `input.fragments` — the one array every
 * renderer iterates, so the index means the same thing on every provider.
 * Matching them against `blocks.length` only coincided with the fragment
 * index while the system fragments happened to be a contiguous run at the
 * front; the moment anything else led the array the marker moved to the wrong
 * block, and a misplaced breakpoint is a silent cache-write surcharge with no
 * read on the other side.
 */
function renderSystemBlocks(input: CanonicalRenderInput): readonly AnthropicSystemBlock[] {
  const blocks: AnthropicSystemBlock[] = [];
  let fragmentIndex = -1;
  for (const f of input.fragments) {
    fragmentIndex += 1;
    if (isSystemKind(f.kind)) {
      blocks.push({
        type: "text",
        text: fragmentText(f),
        ...(input.cachePlan.breakpoints.includes(fragmentIndex)
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      });
    }
  }
  return blocks;
}

/**
 * Block types that can carry `cache_control`. `thinking` and
 * `redacted_thinking` cannot: the marker belongs on the last *eligible* block,
 * and a signed thinking block must be replayed byte for byte anyway.
 */
function acceptsCacheControl(block: AnthropicContentBlock): boolean {
  return block.type !== "thinking" && block.type !== "redacted_thinking";
}

/**
 * Stamp the breakpoint on the last block written so far.
 *
 * The compiler's second breakpoint is the last fragment overall, which is the
 * multi-turn placement: marking the tail of the newest turn lets the next
 * request read the whole transcript back instead of only the system prefix.
 * The renderer previously ignored `breakpoints` here entirely, so every turn
 * re-read the prefix and re-processed the entire conversation at full price.
 */
function stampTailBreakpoint(messages: AnthropicMessage[]): void {
  const last = messages[messages.length - 1];
  if (last === undefined) return;
  if (typeof last.content === "string") {
    // A bare string message has no block to mark; promote it to the one-block
    // array form, which is the same bytes to the tokenizer.
    messages[messages.length - 1] = {
      ...last,
      content: [{ type: "text", text: last.content, cache_control: { type: "ephemeral" as const } }],
    };
    return;
  }
  const blocks = last.content as AnthropicContentBlock[];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (!acceptsCacheControl(block)) continue;
    blocks[index] = { ...block, cache_control: { type: "ephemeral" as const } };
    return;
  }
}

function renderMessages(
  input: CanonicalRenderInput,
  reasoningReplay?: ReasoningReplayLedger | undefined,
): readonly AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const breakpoints = new Set(input.cachePlan.breakpoints);
  let fragmentIndex = -1;
  for (const f of input.fragments) {
    fragmentIndex += 1;
    if (isSystemKind(f.kind)) continue;
    // Each branch below appends exactly one block or message and leaves it
    // last, so the breakpoint for this fragment always lands on it.
    const markBreakpoint = breakpoints.has(fragmentIndex);

    if (f.kind === "tool_result") {
      let toolUseId = f.id;
      let resultContent = fragmentText(f);
      let isError = false;
      try {
        const raw = JSON.parse(fragmentText(f)) as Record<string, unknown>;
        if (raw && typeof raw === "object") {
          if (raw.protocol === "terminus.tool-result.v1" && typeof raw.provider_call_id === "string") {
            toolUseId = raw.provider_call_id;
            resultContent = typeof raw.result === "string" ? raw.result : JSON.stringify(raw.result);
            isError = Boolean(raw.is_error);
          }
        }
      } catch {
        // use raw text
      }
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: resultContent,
        ...(isError ? { is_error: true } : {}),
      };
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        (lastMsg.content as AnthropicContentBlock[]).push(block);
      } else {
        messages.push({
          role: "user",
          content: [block],
        });
      }
      if (markBreakpoint) stampTailBreakpoint(messages);
      continue;
    }

    if (f.kind === "recent_episode") {
      try {
        const raw = JSON.parse(fragmentText(f)) as Record<string, unknown>;
        if (raw && typeof raw === "object" && raw.protocol === "terminus.tool-call.v1" && typeof raw.provider_call_id === "string") {
          const block: AnthropicContentBlock = {
            type: "tool_use",
            id: raw.provider_call_id,
            name: String(raw.tool_name),
            input: (raw.arguments as Record<string, unknown>) ?? {},
          };
          // The thinking that produced this call has to lead the assistant
          // turn, unchanged. Dropping or reordering it is a 400, not a
          // downgrade.
          const thinking = (reasoningReplay?.itemsFor(raw.provider_call_id) ?? []).map(
            (item): AnthropicContentBlock => ({
              type: "thinking",
              thinking: item.summary[0] ?? "",
              signature: item.encryptedContent,
            }),
          );
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && Array.isArray(lastMsg.content)) {
            (lastMsg.content as AnthropicContentBlock[]).push(...thinking, block);
          } else {
            messages.push({
              role: "assistant",
              content: [...thinking, block],
            });
          }
          if (markBreakpoint) stampTailBreakpoint(messages);
          continue;
        }
      } catch {
        // use raw text
      }
      messages.push({
        role: "assistant",
        content: fragmentText(f),
      });
      if (markBreakpoint) stampTailBreakpoint(messages);
      continue;
    }

    // Default user fragment
    messages.push({
      role: "user",
      content: fragmentText(f),
    });
    if (markBreakpoint) stampTailBreakpoint(messages);
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

export function renderRequest(
  input: CanonicalRenderInput,
  options: AnthropicRendererOptions = {},
): Promise<RenderedProviderRequest> {
  const renderer = new AnthropicRenderer(options);
  return renderer.render(input);
}

export * from "./model_profiles.js";
export * from "./stream.js";
