/**
 * @terminus/provider-openai — Stream decoding and normalization for OpenAI Responses and Chat Completions APIs.
 */
import type { ModelKey, TokenCount } from "@terminus/domain";
import type {
  ProviderReasoningItem,
  ProviderResponseChunk,
  UsageRecord,
} from "@terminus/provider-core";
import { repairToolArgumentsJson } from "@terminus/provider-core";

const MAX_EVENT_BYTES = 1024 * 1024;

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

export async function* decodeSse(
  chunks: AsyncIterable<string | Uint8Array>,
  decoder: TextDecoder = new TextDecoder(),
): AsyncIterable<SseEvent> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_EVENT_BYTES * 2) {
      throw new Error("OpenAI SSE buffer exceeded maximum bound");
    }
    let boundary = nextBoundary(buffer);
    while (boundary !== null) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      if (raw.length > MAX_EVENT_BYTES) {
        throw new Error("OpenAI SSE event exceeded maximum bound");
      }
      const parsed = parseEvent(raw);
      if (parsed !== null) yield parsed;
      boundary = nextBoundary(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    if (buffer.length > MAX_EVENT_BYTES) {
      throw new Error("OpenAI SSE event exceeded maximum bound");
    }
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

interface ToolAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

export async function* decodeOpenAiResponsesStream(
  chunks: AsyncIterable<string | Uint8Array>,
  model: ModelKey = "openai/gpt-4o" as ModelKey,
): AsyncIterable<ProviderResponseChunk> {
  const events = decodeSse(chunks);
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
    if (
      (type === "response.reasoning_text.delta"
        || type === "response.reasoning.delta"
        // Reasoning *summaries* stream under their own event family. Without
        // this the summary a subscription model emits is silently discarded.
        || type === "response.reasoning_summary_text.delta")
      && typeof value.delta === "string"
    ) {
      yield { kind: "text", reasoning: value.delta };
      continue;
    }
    if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_summary_part.added") {
      // Structural markers for a summary whose text already streamed.
      continue;
    }
    // A response the provider ended early (token cap, filtered content). It is
    // not `response.completed`, so without this the stream would look
    // truncated with no reason attached.
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
      // The whole point of `include: ["reasoning.encrypted_content"]`. Without
      // this the blob was requested, paid for and dropped on the floor, and
      // every attempt made the model re-derive the chain it had already built.
      // Emitted in wire order so the consumer can tell which tool call it
      // preceded.
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
    yield { kind: "error", errorCode: "TRUNCATED_STREAM", errorMessage: "Responses stream ended before response.completed" };
  }
}

export async function* decodeOpenAiChatStream(
  chunks: AsyncIterable<string | Uint8Array>,
  model: ModelKey = "openai/gpt-4o" as ModelKey,
): AsyncIterable<ProviderResponseChunk> {
  const events = decodeSse(chunks);
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
    if (Object.keys(usage).length > 0) finalUsage = chatUsage(usage);
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
    yield { kind: "error", errorCode: "TRUNCATED_STREAM", errorMessage: "Chat completions stream ended before [DONE]" };
  }
}

export function decodeOpenAiStream(
  chunks: AsyncIterable<string | Uint8Array>,
  protocol: "responses" | "chat_completions" = "responses",
  model?: ModelKey,
): AsyncIterable<ProviderResponseChunk> {
  return protocol === "responses"
    ? decodeOpenAiResponsesStream(chunks, model)
    : decodeOpenAiChatStream(chunks, model);
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
      yield { kind: "error", errorCode: "INVALID_TOOL_CALL", errorMessage: "OpenAI tool call omitted id or name" };
      continue;
    }
    const rawArgs = tool.argumentsJson || "{}";
    const args: unknown = repairToolArgumentsJson(rawArgs);
    if (args === null) {
      yield { kind: "error", errorCode: "INVALID_TOOL_ARGUMENTS", errorMessage: `OpenAI tool ${tool.name} emitted invalid JSON arguments` };
      continue;
    }
    if (!isRecord(args)) {
      yield { kind: "error", errorCode: "INVALID_TOOL_ARGUMENTS", errorMessage: `OpenAI tool ${tool.name} arguments must be an object` };
      continue;
    }
    yield { kind: "tool_call", toolCall: { toolCallId: tool.id, toolName: tool.name, arguments: args } };
  }
}

/**
 * Decode one completed `reasoning` output item.
 *
 * An item with no `encrypted_content` is not replayable — the endpoint only
 * emits the blob when `include` asked for it — so it is dropped rather than
 * replayed as an empty shell the API would reject.
 */
/**
 * The replayable reasoning item carried by a Responses `output_item` of type
 * `reasoning`, or `null` when the provider sent no `encrypted_content` (the
 * blob is only present when the request asked for it via `include`).
 * Exported because the gateway transport (provider-zen) normalizes the same
 * wire format for ChatGPT-Codex and OpenAI-compatible endpoints.
 */
export function reasoningItemFromOutputItem(item: Readonly<Record<string, unknown>>): ProviderReasoningItem | null {
  const encryptedContent = stringOrEmpty(item.encrypted_content);
  const id = stringOrEmpty(item.id);
  if (encryptedContent === "" || id === "") return null;
  const summary: string[] = [];
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      const text = stringOrEmpty(optionalRecord(part).text);
      if (text !== "") summary.push(text);
    }
  }
  return { id, encryptedContent, summary };
}

/**
 * Seconds the provider asked the caller to wait, from whichever field the
 * error payload used. Carried structurally so the retry layer never has to
 * find it by parsing the message prose.
 */
function retryAfterMsFromErrorPayload(value: Readonly<Record<string, unknown>>): number | undefined {
  for (const key of ["retry_after_ms", "retryAfterMs"]) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.ceil(raw);
  }
  for (const key of ["retry_after", "retryAfter", "retry_after_seconds"]) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.ceil(raw * 1_000);
    if (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim())) {
      return Math.ceil(Number.parseFloat(raw.trim()) * 1_000);
    }
  }
  return undefined;
}

function errorChunk(input: unknown): ProviderResponseChunk {
  const value = optionalRecord(input);
  const retryAfterMs = retryAfterMsFromErrorPayload(value);
  return {
    kind: "error",
    errorCode: typeof value.code === "string" ? value.code : typeof value.type === "string" ? value.type : "PROVIDER_ERROR",
    errorMessage: typeof value.message === "string" ? value.message : "OpenAI request failed",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

export function responsesUsage(value: Readonly<Record<string, unknown>>): UsageRecord {
  const details = optionalRecord(value.input_tokens_details);
  const outputDetails = optionalRecord(value.output_tokens_details);
  return {
    inputTokens: BigInt(numberOrZero(value.input_tokens)) as TokenCount,
    cachedInputTokens: BigInt(numberOrZero(details.cached_tokens)) as TokenCount,
    cacheWriteTokens: BigInt(numberOrZero(details.cache_write_tokens)) as TokenCount,
    outputTokens: BigInt(numberOrZero(value.output_tokens)) as TokenCount,
    reasoningTokens: BigInt(numberOrZero(outputDetails.reasoning_tokens)) as TokenCount,
    toolSchemaTokens: 0n as TokenCount,
    latencyMs: 0,
    timeToFirstTokenMs: null,
  };
}

export function chatUsage(value: Readonly<Record<string, unknown>>): UsageRecord {
  const details = optionalRecord(value.prompt_tokens_details);
  const completionDetails = optionalRecord(value.completion_tokens_details);
  return {
    inputTokens: BigInt(numberOrZero(value.prompt_tokens)) as TokenCount,
    cachedInputTokens: BigInt(numberOrZero(details.cached_tokens)) as TokenCount,
    cacheWriteTokens: 0n as TokenCount,
    outputTokens: BigInt(numberOrZero(value.completion_tokens)) as TokenCount,
    reasoningTokens: BigInt(numberOrZero(completionDetails.reasoning_tokens)) as TokenCount,
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
    throw new Error("OpenAI emitted invalid JSON in an SSE event");
  }
  if (!isRecord(parsed)) throw new Error("OpenAI SSE event data must be a JSON object");
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
