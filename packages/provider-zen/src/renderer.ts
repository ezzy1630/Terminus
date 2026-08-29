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
import type { GatewayModel } from "./catalog.js";

export interface GatewayRendererOptions {
  /** Per-turn reasoning depth (H7); ignored by models that do not reason. */
  readonly reasoningEffort?: ReasoningEffort | null | undefined;
}

export class GatewayRenderer implements ProviderRenderer {
  readonly providerId: string;
  readonly version = "1.0.0";

  private readonly models: ReadonlyMap<string, GatewayModel>;
  private readonly openAi: OpenAiRenderer;
  private readonly anthropic = new AnthropicRenderer();

  constructor(models: readonly GatewayModel[], options: GatewayRendererOptions = {}) {
    const first = models[0];
    if (first === undefined) throw new Error("gateway renderer requires at least one admitted model");
    if (models.some((model) => model.providerId !== first.providerId)) {
      throw new Error("one gateway renderer cannot mix models from different accounts");
    }
    this.providerId = first.providerId;
    this.models = new Map(models.map((model) => [model.id, model]));
    this.openAi = new OpenAiRenderer({ reasoningEffort: options.reasoningEffort ?? null });
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
    const body = model.protocol === "responses"
      ? toResponsesBody(delegateBody)
      : model.protocol === "chat_completions"
        ? toChatCompletionsBody(delegateBody)
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

function toResponsesBody(body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
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
  });
}

function toChatCompletionsBody(body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const {
    previous_response_id: _previousResponseId,
    max_output_tokens: maxOutputTokens,
    store: _store,
    ...chatBody
  } = body;
  return {
    ...chatBody,
    ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
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
