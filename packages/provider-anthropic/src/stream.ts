/**
 * @terminus/provider-anthropic — Stream decoding and normalization for Anthropic Messages API.
 */
import type { ModelKey, TokenCount } from "@terminus/domain";
import type {
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
      throw new Error("Anthropic SSE buffer exceeded maximum bound");
    }
    let boundary = nextBoundary(buffer);
    while (boundary !== null) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      if (raw.length > MAX_EVENT_BYTES) {
        throw new Error("Anthropic SSE event exceeded maximum bound");
      }
      const parsed = parseEvent(raw);
      if (parsed !== null) yield parsed;
      boundary = nextBoundary(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    if (buffer.length > MAX_EVENT_BYTES) {
      throw new Error("Anthropic SSE event exceeded maximum bound");
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

export async function* decodeAnthropicMessagesStream(
  chunks: AsyncIterable<string | Uint8Array>,
  model: ModelKey = "anthropic/claude-3-5-sonnet" as ModelKey,
): AsyncIterable<ProviderResponseChunk> {
  const events = decodeSse(chunks);
  const tools = new Map<number, ToolAccumulator>();
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
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
      const usage = optionalRecord(message.usage);
      inputTokens = numberOrZero(usage.input_tokens);
      cacheReadTokens = numberOrZero(usage.cache_read_input_tokens);
      cacheWriteTokens = numberOrZero(usage.cache_creation_input_tokens);
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
      const usage = optionalRecord(value.usage);
      if (usage.output_tokens !== undefined) {
        outputTokens = numberOrZero(usage.output_tokens);
      }
      continue;
    }

    if (type === "message_stop") {
      yield* flushTools(tools);
      yield {
        kind: "done",
        usage: anthropicUsage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens),
        ...(providerRequestId === null ? {} : { providerRequestId }),
      };
      done = true;
    }
  }

  if (!done) {
    yield { kind: "error", errorCode: "TRUNCATED_STREAM", errorMessage: "Anthropic Messages stream ended before message_stop" };
  }
}

export function decodeAnthropicStream(
  chunks: AsyncIterable<string | Uint8Array>,
  model?: ModelKey,
): AsyncIterable<ProviderResponseChunk> {
  return decodeAnthropicMessagesStream(chunks, model);
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
      yield { kind: "error", errorCode: "INVALID_TOOL_CALL", errorMessage: "Anthropic tool call omitted id or name" };
      continue;
    }
    const rawArgs = tool.argumentsJson || "{}";
    const args: unknown = repairToolArgumentsJson(rawArgs);
    if (args === null) {
      yield { kind: "error", errorCode: "INVALID_TOOL_ARGUMENTS", errorMessage: `Anthropic tool ${tool.name} emitted invalid JSON arguments` };
      continue;
    }
    if (!isRecord(args)) {
      yield { kind: "error", errorCode: "INVALID_TOOL_ARGUMENTS", errorMessage: `Anthropic tool ${tool.name} arguments must be an object` };
      continue;
    }
    yield { kind: "tool_call", toolCall: { toolCallId: tool.id, toolName: tool.name, arguments: args } };
  }
}

function errorChunk(input: unknown): ProviderResponseChunk {
  const value = optionalRecord(input);
  return {
    kind: "error",
    errorCode: typeof value.type === "string" ? value.type : typeof value.code === "string" ? value.code : "PROVIDER_ERROR",
    errorMessage: typeof value.message === "string" ? value.message : "Anthropic request failed",
  };
}

export function anthropicUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  reasoningTokens: number = 0,
): UsageRecord {
  return {
    inputTokens: BigInt(inputTokens) as TokenCount,
    cachedInputTokens: BigInt(cacheReadTokens) as TokenCount,
    cacheWriteTokens: BigInt(cacheWriteTokens) as TokenCount,
    outputTokens: BigInt(outputTokens) as TokenCount,
    reasoningTokens: BigInt(reasoningTokens) as TokenCount,
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
    throw new Error("Anthropic emitted invalid JSON in an SSE event");
  }
  if (!isRecord(parsed)) throw new Error("Anthropic SSE event data must be a JSON object");
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
