/**
 * @terminus/provider-openai — the ChatGPT Codex render profile.
 *
 * `https://chatgpt.com/backend-api/codex/responses` speaks the Responses API,
 * but it is not `api.openai.com`: it rejects a body that a plain Responses
 * request would happily carry. Measured against the live endpoint on
 * 2026-08-28:
 *
 *   - `store: true` → 400 "Store must be set to false"; `stream: false` → 400.
 *   - `max_output_tokens`, `temperature`, `top_p`, `previous_response_id`
 *     → 400 "Unsupported parameter". They are deleted, not clamped: the
 *     endpoint refuses the whole request rather than ignoring the field.
 *   - `input` must be a list.
 *   - `include: ["reasoning.encrypted_content"]`, `prompt_cache_key`,
 *     `reasoning: {effort, summary}` and function tools are accepted.
 *   - a function tool claiming `strict: true` is validated against OpenAI's
 *     strict rules → 400 "Invalid schema for function 'read' … Missing
 *     'max_bytes'" for any schema with an optional parameter. The Codex CLI
 *     sends `strict: false`, so we do too.
 *
 * Reasoning levels are per-model and richer than Terminus's four (a model may
 * advertise `xhigh` or `ultra`), so the UI level is clamped into whatever the
 * catalogue says this slug accepts instead of being sent verbatim.
 *
 * Terminus's own loop drives the turn. This profile borrows the bearer token
 * and the model catalogue from the Codex CLI login and nothing else.
 */
import type {
  CanonicalRenderInput,
  CompatibilityResult,
  ContinuationDecision,
  ContinuationInput,
  ProjectedResponse,
  ProviderRenderer,
  ProviderRequest,
  ProviderResponse,
  ReasoningEffort,
  RenderCompatibilityInput,
  RenderedProviderRequest,
  UsageRecord,
} from "@terminus/provider-core";
import { OpenAiRenderer, renderResponsesRequest, sanitizeResponsesBody } from "./index.js";

/** Fields the endpoint rejects outright. Deleted, never translated. */
export const CHATGPT_CODEX_FORBIDDEN_BODY_FIELDS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "previous_response_id",
] as const;

/**
 * What the Codex model catalogue says about one slug. Everything here comes
 * from `GET /backend-api/codex/models`; nothing is inferred.
 */
export interface ChatGptCodexModelProfile {
  readonly slug: string;
  /** `supported_reasoning_levels`, in the catalogue's own order. */
  readonly reasoningLevels: readonly string[];
  /** `default_reasoning_level`, used when the UI level maps to nothing. */
  readonly defaultReasoningLevel: string | null;
  readonly supportsParallelToolCalls: boolean;
  readonly supportsReasoningSummaries: boolean;
}

export interface ChatGptCodexRenderOptions {
  /** Per-turn reasoning depth, clamped into the model's advertised levels. */
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
  /** Stable per-thread cache key. Not a credential and not user content. */
  readonly promptCacheKey?: string | null | undefined;
  readonly profile?: ChatGptCodexModelProfile | null | undefined;
}

/**
 * Levels that mean "as much as this model will do", strongest first. The UI's
 * `max` saturates at the strongest one the model actually advertises rather
 * than silently dropping to the default.
 */
const MAXIMAL_LEVELS = ["ultra", "max", "xhigh", "high"] as const;

/**
 * Map a Terminus effort onto a level this model advertises.
 *
 * Returns null when the model advertises no levels at all, in which case no
 * `reasoning` block is sent — an unrecognised level is a 400, and a guess is
 * worse than the model's own default.
 */
export function chatGptCodexReasoningLevel(
  effort: ReasoningEffort | null | undefined,
  profile: ChatGptCodexModelProfile | null | undefined,
): string | null {
  const levels = profile?.reasoningLevels ?? [];
  if (levels.length === 0) return null;
  const has = (name: string): string | null => levels.find((level) => level === name) ?? null;
  if (effort === "max") {
    for (const candidate of MAXIMAL_LEVELS) {
      const found = has(candidate);
      if (found !== null) return found;
    }
    return profile?.defaultReasoningLevel ?? levels[levels.length - 1] ?? null;
  }
  if (effort === "low" || effort === "medium" || effort === "high") {
    const exact = has(effort);
    if (exact !== null) return exact;
  }
  const fallback = profile?.defaultReasoningLevel ?? null;
  if (fallback !== null && levels.includes(fallback)) return fallback;
  return levels[0] ?? null;
}

/**
 * Render a `POST /backend-api/codex/responses` body.
 *
 * The base body is the ordinary Responses rendering; everything below is the
 * measured delta between `api.openai.com` and the Codex endpoint.
 */
export async function renderChatGptCodexRequest(
  input: CanonicalRenderInput,
  options: ChatGptCodexRenderOptions = {},
): Promise<RenderedProviderRequest> {
  const rendered = await renderResponsesRequest(input, {
    reasoningEffort: options.reasoningEffort ?? null,
  });
  return { ...rendered, body: chatGptCodexBody(rendered.body, options) };
}

/** The body transform, split out so goldens can exercise it without a render. */
export function chatGptCodexBody(
  base: Readonly<Record<string, unknown>>,
  options: ChatGptCodexRenderOptions = {},
): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = { ...base };
  for (const field of CHATGPT_CODEX_FORBIDDEN_BODY_FIELDS) delete body[field];
  body.store = false;
  body.stream = true;
  // Encrypted reasoning is how a stateless (`store: false`) caller keeps a
  // reasoning chain across tool round trips.
  body.include = ["reasoning.encrypted_content"];
  if (typeof options.promptCacheKey === "string" && options.promptCacheKey !== "") {
    body.prompt_cache_key = options.promptCacheKey;
  }
  const level = chatGptCodexReasoningLevel(options.reasoningEffort, options.profile);
  if (level === null) {
    delete body.reasoning;
  } else {
    body.reasoning = {
      effort: level,
      ...(options.profile?.supportsReasoningSummaries === false ? {} : { summary: "auto" }),
    };
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // The Codex backend validates function schemas the way OpenAI validates a
    // strict one: with `strict: true` it demands that `required` list every
    // key in `properties`, and answers 400 "Invalid schema for function
    // 'read' … Missing 'max_bytes'" otherwise. The Codex CLI never claims
    // strict (`ResponsesApiTool { strict: false }`) and sends its schemas as
    // written, optional parameters and all. Impersonating it means doing the
    // same, unconditionally — this endpoint is a different validator from
    // `api.openai.com` and is not worth a second guess.
    body.tools = body.tools.map((tool) =>
      typeof tool === "object" && tool !== null && !Array.isArray(tool) ? { ...tool, strict: false } : tool,
    );
    body.tool_choice = "auto";
    body.parallel_tool_calls = options.profile?.supportsParallelToolCalls === true;
  }
  // Belt and braces: this endpoint rejects the whole request for one unknown
  // key anywhere in `input`, so nothing chat-shaped may survive here even if a
  // caller hands us a body that did not come from `renderResponsesRequest`.
  return sanitizeResponsesBody(body);
}

/**
 * Renderer for a connected ChatGPT/Codex account.
 *
 * Delegates canonical rendering to `OpenAiRenderer` and reports the account's
 * own provider id, so a provider attempt records which account produced it.
 */
export class ChatGptCodexRenderer implements ProviderRenderer {
  readonly providerId: string;
  readonly version = "1.0.0";

  private readonly openAi: OpenAiRenderer;
  private readonly options: ChatGptCodexRenderOptions;

  constructor(providerId: string, options: ChatGptCodexRenderOptions = {}) {
    if (providerId.trim() === "") throw new Error("ChatGPT Codex renderer requires a provider id");
    this.providerId = providerId;
    this.options = options;
    this.openAi = new OpenAiRenderer({ reasoningEffort: options.reasoningEffort ?? null });
  }

  compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    return this.openAi.compatibility(input);
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    const rendered = await renderChatGptCodexRequest(input, this.options);
    return {
      ...rendered,
      providerId: this.providerId,
      request: { ...rendered.request, providerId: this.providerId } as ProviderRequest,
    };
  }

  projectResponse(response: ProviderResponse): Promise<ProjectedResponse> {
    return this.openAi.projectResponse({ ...response, providerId: this.openAi.providerId });
  }

  extractUsage(response: ProviderResponse): UsageRecord {
    return this.openAi.extractUsage({ ...response, providerId: this.openAi.providerId });
  }

  /**
   * `store: false` means the endpoint keeps nothing to continue from, so a
   * native continuation id is never valid here even though the protocol is
   * Responses. Every turn replays its own prefix.
   */
  continuationPolicy(input: ContinuationInput): ContinuationDecision {
    if (input.stablePrefixHashChanged) {
      return {
        canContinue: false,
        reason: "ChatGPT Codex replays the prefix and the stable prefix changed",
        requiresRerender: true,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    return {
      canContinue: true,
      reason: "ChatGPT Codex is stateless (store: false); the client replays the prefix",
      requiresRerender: false,
      requiresUserConsent: false,
      newContinuationId: null,
    };
  }
}
