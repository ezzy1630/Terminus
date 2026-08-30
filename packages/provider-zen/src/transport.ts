import type { ModelKey, TokenCount } from "@terminus/domain";
import type {
  ProviderRequest,
  ProviderResponseChunk,
  ProviderTransport,
  UsageRecord,
} from "@terminus/provider-core";
import { reasoningItemFromOutputItem } from "@terminus/provider-openai";
import type { GatewayModel, GatewayProtocol } from "./catalog.js";

export interface GatewayHttpRequest {
  readonly url: string;
  /** GET is used only for model discovery, which carries no body. */
  readonly method: "POST" | "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly credentialBindingId: string;
  /** `none` is reserved for an explicitly anonymous public gateway binding. */
  readonly authStyle: "bearer" | "none";
  readonly signal: AbortSignal | null;
}

/**
 * Trusted higher layers implement this through the kernel connector. The
 * credential binding is opaque; raw key material never enters this package.
 * An empty binding is the explicit representation of an anonymous public
 * endpoint and is only produced for an admitted free Zen model.
 */
export interface CredentialBoundGatewayClient {
  stream(input: GatewayHttpRequest): AsyncIterable<string | Uint8Array>;
}

interface TransportInput {
  readonly credentialBindingId: string;
  readonly models: readonly GatewayModel[];
  readonly client: CredentialBoundGatewayClient;
  /**
   * Extra request headers a connected provider account's connector admits
   * (e.g. the ChatGPT account id and originator the Codex endpoint expects).
   * They never carry credential material — the bearer is injected inside the
   * kernel from `credentialBindingId`. Reserved header names are rejected so
   * an account cannot smuggle in its own `authorization`.
   */
  readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
}

/**
 * Headers the kernel connector owns. A caller-supplied value here would either
 * be dropped by the connector or, worse, override the brokered credential.
 */
const RESERVED_HEADERS = new Set(["authorization", "content-type", "accept", "host", "content-length"]);

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;

export class GatewayTransport implements ProviderTransport {
  private readonly credentialBindingId: string;
  private readonly models: ReadonlyMap<string, GatewayModel>;
  private readonly client: CredentialBoundGatewayClient;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(input: TransportInput) {
    if (input.credentialBindingId !== "" && !input.credentialBindingId.startsWith("secret://")) {
      throw new Error("gateway credential binding must be a secret capability URI");
    }
    this.credentialBindingId = input.credentialBindingId;
    this.models = new Map(input.models.map((model) => [model.id, model]));
    this.client = input.client;
    const extra: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
      const lower = name.toLowerCase();
      if (RESERVED_HEADERS.has(lower)) {
        throw new Error(`header ${lower} is owned by the kernel connector and may not be supplied`);
      }
      if (/[\0\r\n]/.test(value)) throw new Error(`header ${lower} contains a control delimiter`);
      extra[lower] = value;
    }
    this.extraHeaders = extra;
  }

  async *stream(
    request: ProviderRequest,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal | null,
  ): AsyncIterable<ProviderResponseChunk> {
    const model = this.models.get(request.model);
    if (model === undefined) throw new Error(`gateway model ${request.model} is not admitted`);
    if (request.providerId !== model.providerId) {
      throw new Error(`provider ${request.providerId} does not own gateway model ${request.model}`);
    }
    const serialized = JSON.stringify({ ...body, model: model.id, stream: true });
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
      throw new Error(`gateway request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    const httpRequest: GatewayHttpRequest = {
      url: gatewayEndpoint(model),
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...(model.protocol === "messages" ? { "anthropic-version": "2023-06-01" } : {}),
        ...this.extraHeaders,
      },
      body: serialized,
      credentialBindingId: this.credentialBindingId,
      authStyle: this.credentialBindingId === "" ? "none" : "bearer",
      signal,
    };
    const decoder = new TextDecoder();
    const events = decodeSse(this.client.stream(httpRequest), decoder);
    yield* normalizeEvents(model.protocol, request.model, events);
  }
}

/** Exact HTTPS endpoint selected by the admitted gateway protocol. */
export function gatewayEndpoint(model: Pick<GatewayModel, "baseUrl" | "protocol">): string {
  return `${model.baseUrl}${pathForProtocol(model.protocol)}`;
}

function pathForProtocol(protocol: GatewayProtocol): string {
  switch (protocol) {
    case "chat_completions":
      return "/chat/completions";
    case "responses":
      return "/responses";
    case "messages":
      return "/messages";
  }
}

interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

async function* decodeSse(
  chunks: AsyncIterable<string | Uint8Array>,
  decoder: TextDecoder,
): AsyncIterable<SseEvent> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_EVENT_BYTES * 2) throw new Error("gateway SSE buffer exceeded its bound");
    let boundary = nextBoundary(buffer);
    while (boundary !== null) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      if (raw.length > MAX_EVENT_BYTES) throw new Error("gateway SSE event exceeded its bound");
      const parsed = parseEvent(raw);
      if (parsed !== null) yield parsed;
      boundary = nextBoundary(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    if (buffer.length > MAX_EVENT_BYTES) throw new Error("gateway SSE event exceeded its bound");
    const parsed = parseEvent(buffer);
    if (parsed !== null) yield parsed;
  }
}

function nextBoundary(buffer: string): { readonly index: number; readonly length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseEvent(raw: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}

async function* normalizeEvents(
  protocol: GatewayProtocol,
  model: ModelKey,
  events: AsyncIterable<SseEvent>,
): AsyncIterable<ProviderResponseChunk> {
  switch (protocol) {
    case "chat_completions":
      yield* normalizeChatCompletions(model, events);
      return;
    case "responses":
      yield* normalizeResponses(model, events);
      return;
    case "messages":
      yield* normalizeMessages(model, events);
      return;
  }
}

interface ToolAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

async function* normalizeChatCompletions(
  _model: ModelKey,
  events: AsyncIterable<SseEvent>,
): AsyncIterable<ProviderResponseChunk> {
  const tools = new Map<number, ToolAccumulator>();
  let finalUsage: UsageRecord | undefined;
  let providerRequestId: string | null = null;
  let stopReason: string | null = null;
  let done = false;
  for await (const event of events) {
    if (event.data === "[DONE]") {
      yield* flushTools(tools);
      yield {
        kind: "done",
        ...(finalUsage ? { usage: finalUsage } : {}),
        ...(providerRequestId === null ? {} : { providerRequestId }),
        ...(stopReason === null ? {} : { stopReason }),
      };
      done = true;
      continue;
    }
    const value = jsonRecord(event.data);
    if (typeof value.id === "string" && value.id.trim() !== "") providerRequestId = value.id;
    if (value.error !== undefined) {
      yield errorChunk(value.error);
      continue;
    }
    const usage = optionalRecord(value.usage);
    if (Object.keys(usage).length > 0) finalUsage = openAiUsage(usage);
    if (!Array.isArray(value.choices)) continue;
    for (const rawChoice of value.choices) {
      const choice = optionalRecord(rawChoice);
      const delta = optionalRecord(choice.delta);
      if (typeof delta.content === "string" && delta.content !== "") {
        yield { kind: "text", text: delta.content };
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
        yield { kind: "text", reasoning: delta.reasoning_content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawTool of delta.tool_calls) {
          const tool = optionalRecord(rawTool);
          const index = typeof tool.index === "number" && Number.isInteger(tool.index) ? tool.index : 0;
          const fn = optionalRecord(tool.function);
          const current = tools.get(index) ?? { id: "", name: "", argumentsJson: "" };
          tools.set(index, {
            id: typeof tool.id === "string" ? tool.id : current.id,
            name: typeof fn.name === "string" ? fn.name : current.name,
            argumentsJson: current.argumentsJson + (typeof fn.arguments === "string" ? fn.arguments : ""),
          });
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
        stopReason = choice.finish_reason;
        if (stopReason === "tool_calls") yield* flushTools(tools);
      }
    }
  }
  if (!done) {
    yield truncatedStream("chat-completions stream ended before data: [DONE]");
  }
}

async function* normalizeResponses(
  _model: ModelKey,
  events: AsyncIterable<SseEvent>,
): AsyncIterable<ProviderResponseChunk> {
  const tools = new Map<number, ToolAccumulator>();
  let done = false;
  for await (const event of events) {
    const value = jsonRecord(event.data);
    const type = typeof value.type === "string" ? value.type : event.event;
    if (type === "error" || type === "response.failed") {
      yield errorChunk(value.error ?? value);
      continue;
    }
    if (type === "response.output_text.delta" && typeof value.delta === "string") {
      yield { kind: "text", text: value.delta };
      continue;
    }
    // Reasoning summaries. The Responses API streams them as their own event
    // family; without these the summary text a user paid for is discarded.
    if (
      (type === "response.reasoning_summary_text.delta"
        || type === "response.reasoning_text.delta"
        || type === "response.reasoning.delta")
      && typeof value.delta === "string"
    ) {
      yield { kind: "text", reasoning: value.delta };
      continue;
    }
    if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_summary_part.added") {
      // Terminal/structural markers for a summary whose text already streamed.
      continue;
    }
    if (type === "response.incomplete") {
      const response = optionalRecord(value.response);
      const details = optionalRecord(response.incomplete_details);
      yield {
        kind: "error",
        errorCode: "RESPONSE_INCOMPLETE",
        errorMessage: `response ended incomplete: ${stringOrEmpty(details.reason) || "no reason reported"}`,
      };
      continue;
    }
    if (type === "response.output_item.added") {
      const item = optionalRecord(value.item);
      if (item.type === "function_call") {
        const index = integerOrZero(value.output_index);
        tools.set(index, {
          id: stringOrEmpty(item.call_id) || stringOrEmpty(item.id),
          name: stringOrEmpty(item.name),
          argumentsJson: stringOrEmpty(item.arguments),
        });
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta") {
      const index = integerOrZero(value.output_index);
      const current = tools.get(index) ?? { id: stringOrEmpty(value.item_id), name: "", argumentsJson: "" };
      current.argumentsJson += stringOrEmpty(value.delta);
      tools.set(index, current);
      continue;
    }
    if (type === "response.output_item.done") {
      const item = optionalRecord(value.item);
      if (item.type === "function_call") {
        const index = integerOrZero(value.output_index);
        const current = tools.get(index) ?? { id: "", name: "", argumentsJson: "" };
        tools.set(index, {
          id: stringOrEmpty(item.call_id) || stringOrEmpty(item.id) || current.id,
          name: stringOrEmpty(item.name) || current.name,
          argumentsJson: stringOrEmpty(item.arguments) || current.argumentsJson,
        });
        yield* flushTools(tools, index);
      }
      // `include: ["reasoning.encrypted_content"]` is honoured here or nowhere:
      // the ChatGPT-Codex and OpenAI-compatible accounts stream through this
      // normalizer, and a reasoning item that is not surfaced as a chunk never
      // reaches the replay ledger, so every later attempt of the turn made the
      // model re-derive the chain it had already built (and paid for). Emitted
      // in wire order so the ledger can attach it to the call it preceded.
      if (item.type === "reasoning") {
        const reasoningItem = reasoningItemFromOutputItem(item);
        if (reasoningItem !== null) yield { kind: "text", reasoningItem };
      }
      continue;
    }
    if (type === "response.completed") {
      yield* flushTools(tools);
      const response = optionalRecord(value.response);
      const usage = optionalRecord(response.usage);
      yield {
        kind: "done",
        ...(typeof response.id === "string" ? {
          continuationId: response.id,
          providerRequestId: response.id,
        } : {}),
        ...(Object.keys(usage).length > 0 ? { usage: responsesUsage(usage) } : {}),
      };
      done = true;
    }
  }
  if (!done) {
    yield truncatedStream("Responses stream ended before response.completed");
  }
}

async function* normalizeMessages(
  _model: ModelKey,
  events: AsyncIterable<SseEvent>,
): AsyncIterable<ProviderResponseChunk> {
  const tools = new Map<number, ToolAccumulator>();
  let inputTokens = 0;
  let outputTokens = 0;
  let providerRequestId: string | null = null;
  let done = false;
  for await (const event of events) {
    const value = jsonRecord(event.data);
    const type = typeof value.type === "string" ? value.type : event.event;
    if (type === "error") {
      yield errorChunk(value.error ?? value);
      continue;
    }
    if (type === "message_start") {
      const message = optionalRecord(value.message);
      if (typeof message.id === "string" && message.id.trim() !== "") providerRequestId = message.id;
      inputTokens = numberOrZero(optionalRecord(message.usage).input_tokens);
      continue;
    }
    if (type === "content_block_start") {
      const block = optionalRecord(value.content_block);
      if (block.type === "tool_use") {
        tools.set(integerOrZero(value.index), {
          id: stringOrEmpty(block.id),
          name: stringOrEmpty(block.name),
          argumentsJson: Object.keys(optionalRecord(block.input)).length > 0 ? JSON.stringify(block.input) : "",
        });
      }
      continue;
    }
    if (type === "content_block_delta") {
      const delta = optionalRecord(value.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        yield { kind: "text", text: delta.text };
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        yield { kind: "text", reasoning: delta.thinking };
      } else if (delta.type === "input_json_delta") {
        const index = integerOrZero(value.index);
        const current = tools.get(index) ?? { id: "", name: "", argumentsJson: "" };
        current.argumentsJson += stringOrEmpty(delta.partial_json);
        tools.set(index, current);
      }
      continue;
    }
    if (type === "content_block_stop") {
      yield* flushTools(tools, integerOrZero(value.index));
      continue;
    }
    if (type === "message_delta") {
      outputTokens = numberOrZero(optionalRecord(value.usage).output_tokens);
      continue;
    }
    if (type === "message_stop") {
      yield* flushTools(tools);
      yield {
        kind: "done",
        usage: usage(inputTokens, outputTokens),
        ...(providerRequestId === null ? {} : { providerRequestId }),
      };
      done = true;
    }
  }
  if (!done) {
    yield truncatedStream("Messages stream ended before message_stop");
  }
}

function truncatedStream(message: string): ProviderResponseChunk {
  return { kind: "error", errorCode: "TRUNCATED_STREAM", errorMessage: message };
}

function* flushTools(
  tools: Map<number, ToolAccumulator>,
  onlyIndex?: number,
): Generator<ProviderResponseChunk> {
  const indexes = onlyIndex === undefined ? [...tools.keys()].sort((a, b) => a - b) : [onlyIndex];
  for (const index of indexes) {
    const tool = tools.get(index);
    if (tool === undefined) continue;
    tools.delete(index);
    if (tool.id === "" || tool.name === "") {
      yield { kind: "error", errorCode: "INVALID_TOOL_CALL", errorMessage: "gateway tool call omitted id or name" };
      continue;
    }
    let args: unknown;
    try {
      args = JSON.parse(tool.argumentsJson || "{}");
    } catch {
      yield { kind: "error", errorCode: "INVALID_TOOL_ARGUMENTS", errorMessage: `gateway tool ${tool.name} emitted invalid JSON arguments` };
      continue;
    }
    if (!isRecord(args)) {
      yield { kind: "error", errorCode: "INVALID_TOOL_ARGUMENTS", errorMessage: `gateway tool ${tool.name} arguments must be an object` };
      continue;
    }
    yield { kind: "tool_call", toolCall: { toolCallId: tool.id, toolName: tool.name, arguments: args } };
  }
}

function errorChunk(input: unknown): ProviderResponseChunk {
  const value = optionalRecord(input);
  return {
    kind: "error",
    errorCode: typeof value.code === "string" ? value.code : typeof value.type === "string" ? value.type : "PROVIDER_ERROR",
    errorMessage: typeof value.message === "string" ? value.message : "gateway request failed",
  };
}

function openAiUsage(value: Readonly<Record<string, unknown>>): UsageRecord {
  const details = optionalRecord(value.prompt_tokens_details);
  return {
    ...usage(numberOrZero(value.prompt_tokens), numberOrZero(value.completion_tokens)),
    cachedInputTokens: BigInt(numberOrZero(details.cached_tokens)) as TokenCount,
  };
}

function responsesUsage(value: Readonly<Record<string, unknown>>): UsageRecord {
  const details = optionalRecord(value.input_tokens_details);
  const outputDetails = optionalRecord(value.output_tokens_details);
  return {
    ...usage(numberOrZero(value.input_tokens), numberOrZero(value.output_tokens)),
    cachedInputTokens: BigInt(numberOrZero(details.cached_tokens)) as TokenCount,
    reasoningTokens: BigInt(numberOrZero(outputDetails.reasoning_tokens)) as TokenCount,
  };
}

function usage(inputTokens: number, outputTokens: number): UsageRecord {
  return {
    inputTokens: BigInt(inputTokens) as TokenCount,
    cachedInputTokens: 0n as TokenCount,
    cacheWriteTokens: 0n as TokenCount,
    outputTokens: BigInt(outputTokens) as TokenCount,
    reasoningTokens: 0n as TokenCount,
    toolSchemaTokens: 0n as TokenCount,
    latencyMs: 0,
    timeToFirstTokenMs: null,
  };
}

function jsonRecord(json: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("gateway emitted invalid JSON in an SSE event");
  }
  if (!isRecord(parsed)) throw new Error("gateway SSE event data must be a JSON object");
  return parsed;
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
