import { AnthropicRenderer } from "@terminus/provider-anthropic";
import {
  OpenAiRenderer,
  sanitizeResponsesBody,
  toResponsesInputItems,
  type OpenAiChatMessage,
} from "@terminus/provider-openai";
import type {
  CanonicalRenderInput,
  ReasoningEffort,
  CompatibilityResult,
  ContinuationDecision,
  ContinuationInput,
  ProjectedResponse,
  ProviderRenderer,
  ProviderRequest,
  ProviderResponse,
  RenderCompatibilityInput,
  RenderedProviderRequest,
  UsageRecord,
} from "@terminus/provider-core";
import { ReasoningReplayLedger, resolveModelFamily } from "@terminus/provider-core";
import type { GatewayModel } from "./catalog.js";

export interface GatewayRendererOptions {
  /** Per-turn reasoning depth (H7); ignored by models that do not reason. */
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
  /**
   * Cache-routing affinity for the OpenAI-shaped protocols. When absent the
   * compiled stable-prefix hash is used, so a gateway turn always carries a
   * key that is stable for exactly as long as the prefix it names — the
   * gateway path used to carry none at all.
   */
  readonly promptCacheKey?: string | null | undefined;
  /**
   * Reasoning chain carried across the tool round trips of a turn, and
   * restorable across a restart. Supplying a pre-seeded ledger is how a
   * resumed turn replays calls it made before the process died.
   */
  readonly reasoningReplay?: ReasoningReplayLedger | undefined;
}

export class GatewayRenderer implements ProviderRenderer {
  readonly providerId: string;
  readonly version = "1.0.0";

  private readonly models: ReadonlyMap<string, GatewayModel>;
  private readonly openAi: OpenAiRenderer;
  private readonly anthropic: AnthropicRenderer;
  private readonly options: GatewayRendererOptions;
  /** Filled by `projectResponse`, played back by `render`; seedable. */
  readonly reasoningReplay: ReasoningReplayLedger;

  constructor(models: readonly GatewayModel[], options: GatewayRendererOptions = {}) {
    const first = models[0];
    if (first === undefined) throw new Error("gateway renderer requires at least one admitted model");
    if (models.some((model) => model.providerId !== first.providerId)) {
      throw new Error("one gateway renderer cannot mix models from different accounts");
    }
    this.providerId = first.providerId;
    this.models = new Map(models.map((model) => [model.id, model]));
    this.options = options;
    // One ledger shared by both delegates: a gateway turn stays on one
    // upstream, and the replay contract is the same shape on either.
    const reasoningReplay = options.reasoningReplay ?? new ReasoningReplayLedger();
    this.reasoningReplay = reasoningReplay;
    this.openAi = new OpenAiRenderer({ reasoningEffort: options.reasoningEffort ?? null, reasoningReplay });
    this.anthropic = new AnthropicRenderer({ reasoningEffort: options.reasoningEffort ?? null, reasoningReplay });
  }

  compatibility(input: RenderCompatibilityInput): CompatibilityResult {
    const model = this.requireModel(input.model.modelKey);
    return this.delegate(model).compatibility(input);
  }

  async render(input: CanonicalRenderInput): Promise<RenderedProviderRequest> {
    const model = this.requireModel(input.model.modelKey);
    const rendered = await this.delegate(model).render(input);
    // A model that does not advertise reasoning must not be sent a reasoning
    // control: the gateway rejects the request instead of ignoring the field.
    const delegateBody = model.reasoning
      ? rendered.body
      : withoutReasoningControls(rendered.body);
    const promptCacheKey = typeof this.options.promptCacheKey === "string" && this.options.promptCacheKey !== ""
      ? this.options.promptCacheKey
      : String(input.cachePlan.stablePrefixHash);
    const body = model.protocol === "responses"
      ? toResponsesBody(delegateBody, promptCacheKey)
      : model.protocol === "chat_completions"
        ? toChatCompletionsBody(delegateBody, promptCacheKey)
        : delegateBody;
    return {
      ...rendered,
      providerId: this.providerId,
      request: { ...rendered.request, providerId: this.providerId } as ProviderRequest,
      body,
    };
  }

  projectResponse(response: ProviderResponse): Promise<ProjectedResponse> {
    return this.delegate(this.requireModel(response.model)).projectResponse({
      ...response,
      providerId: this.delegate(this.requireModel(response.model)).providerId,
    });
  }

  extractUsage(response: ProviderResponse): UsageRecord {
    const delegate = this.delegate(this.requireModel(response.model));
    return delegate.extractUsage({ ...response, providerId: delegate.providerId });
  }

  continuationPolicy(input: ContinuationInput): ContinuationDecision {
    const model = this.requireModel(input.model);
    if (model.protocol === "responses") return this.openAi.continuationPolicy(input);
    if (input.stablePrefixHashChanged) {
      return {
        canContinue: false,
        reason: "gateway client-replay prefix changed",
        requiresRerender: true,
        requiresUserConsent: false,
        newContinuationId: null,
      };
    }
    return {
      canContinue: true,
      reason: "gateway protocol uses client replay",
      requiresRerender: false,
      requiresUserConsent: false,
      newContinuationId: null,
    };
  }

  private requireModel(modelKey: string): GatewayModel {
    const model = this.models.get(modelKey);
    if (model === undefined) throw new Error(`gateway model ${modelKey} is not admitted`);
    return model;
  }

  private delegate(model: GatewayModel): ProviderRenderer {
    return model.protocol === "messages" ? this.anthropic : this.openAi;
  }
}

function toResponsesBody(
  body: Readonly<Record<string, unknown>>,
  promptCacheKey: string,
): Readonly<Record<string, unknown>> {
  // Chat Completions and Responses are different shapes, not the same shape
  // with different names: a tool result is a `function_call_output` item and
  // the prompt-cache marker `cache_control` does not exist here at all. The
  // shared rewrite in `@terminus/provider-openai` owns that translation.
  const messages = Array.isArray(body.messages)
    ? toResponsesInputItems(body.messages as readonly OpenAiChatMessage[])
    : [];
  const tools = Array.isArray(body.tools)
    ? body.tools.map((rawTool) => {
        const tool = asRecord(rawTool);
        const fn = asRecord(tool.function);
        return {
          type: "function" as const,
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
          strict: fn.strict,
        };
      })
    : [];
  return sanitizeResponsesBody({
    model: body.model,
    input: messages,
    stream: true,
    ...(tools.length > 0 ? { tools } : {}),
    ...(body.max_output_tokens !== undefined ? { max_output_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning_effort !== undefined
      ? { reasoning: { effort: body.reasoning_effort, summary: "auto" } }
      : {}),
    ...(body.previous_response_id !== undefined ? { previous_response_id: body.previous_response_id } : {}),
    ...(body.store !== undefined ? { store: body.store } : {}),
    // Every OpenAI-shaped path carries a routing key now, the gateway
    // included: without one, two attempts of the same turn can land on
    // different shards and neither sees the other's prefix.
    prompt_cache_key: promptCacheKey,
  });
}

function toChatCompletionsBody(
  body: Readonly<Record<string, unknown>>,
  promptCacheKey: string,
): Readonly<Record<string, unknown>> {
  const {
    previous_response_id: _previousResponseId,
    max_output_tokens: maxOutputTokens,
    store: _store,
    ...chatBody
  } = body;
  // `prompt_cache_key` is an OpenAI Chat Completions parameter, and the
  // gateway fronts a hundred models that are not OpenAI's. It has been
  // observed to answer 400 rather than ignore a field its upstream does not
  // know, so the key travels only where the upstream is known to read it.
  const openAiUpstream = typeof body.model === "string"
    && resolveModelFamily(body.model) === "gpt-5.6";
  return {
    ...chatBody,
    ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
    ...(openAiUpstream ? { prompt_cache_key: promptCacheKey } : {}),
  };
}

function withoutReasoningControls(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { reasoning_effort: _effort, reasoning: _reasoning, ...rest } = body;
  return rest;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}
