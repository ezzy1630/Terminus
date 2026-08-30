import { describe, expect, test } from "bun:test";
import type { ModelKey, TokenCount } from "@terminus/domain";
import type { ProviderRequest } from "@terminus/provider-core";
import {
  GatewayTransport,
  type CredentialBoundGatewayClient,
  type GatewayHttpRequest,
} from "./transport.js";
import type { GatewayModel } from "./catalog.js";

function request(model: string): ProviderRequest {
  return {
    providerId: "open_code_zen",
    model: model as ModelKey,
    blocks: [],
    toolSchemas: [],
    continuationId: null,
    cachePlan: { stablePrefixHash: "sha256:test" as ProviderRequest["cachePlan"]["stablePrefixHash"], breakpoints: [] },
    outputProfile: "terse",
    reasoningReserveTokens: 0n as TokenCount,
    outputReserveTokens: 128n as TokenCount,
    hardInputLimit: 1_024n as TokenCount,
    signal: null,
  };
}

function model(protocol: GatewayModel["protocol"]): GatewayModel {
  return {
    id: `model-${protocol}`,
    name: protocol,
    deployment: "zen",
    providerId: "open_code_zen",
    baseUrl: "https://opencode.ai/zen/v1",
    protocol,
    free: false,
    toolCalling: true,
    structuredOutput: true,
    imageInput: false,
    reasoning: false,
    contextTokens: 100_000,
    outputTokens: 8_000,
    inputMicrosPerMillion: 0,
    cachedInputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
    observedAt: "2026-08-24T00:00:00Z",
  };
}

class FakeClient implements CredentialBoundGatewayClient {
  seen: GatewayHttpRequest | null = null;

  constructor(private readonly chunks: readonly string[]) {}

  async *stream(input: GatewayHttpRequest): AsyncIterable<string> {
    this.seen = input;
    for (const chunk of this.chunks) yield chunk;
  }
}

describe("GatewayTransport", () => {
  test("routes chat-completions and reassembles fragmented tool calls", async () => {
    const gatewayModel = model("chat_completions");
    const client = new FakeClient([
      'data: {"choices":[{"delta":{"content":"hel"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n',
      '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
    ]);
    const transport = new GatewayTransport({
      credentialBindingId: "secret://providers/open-code/zen",
      models: [gatewayModel],
      client,
    });

    const chunks = [];
    for await (const chunk of transport.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) chunks.push(chunk);

    expect(client.seen?.url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(client.seen?.credentialBindingId).toBe("secret://providers/open-code/zen");
    expect(client.seen?.authStyle).toBe("bearer");
    expect(client.seen?.headers).toEqual({ accept: "text/event-stream", "content-type": "application/json" });
    expect(chunks).toContainEqual({ kind: "text", text: "hel" });
    expect(chunks).toContainEqual({
      kind: "tool_call",
      toolCall: { toolCallId: "call-1", toolName: "read", arguments: { path: "README.md" } },
    });
    expect(chunks.at(-1)?.kind).toBe("done");
    expect(chunks.at(-1)?.stopReason).toBe("tool_calls");
  });

  test("preserves reasoning deltas and length stop reasons from chat completions", async () => {
    const gatewayModel = model("chat_completions");
    const client = new FakeClient([
      'data: {"id":"req-1","choices":[{"delta":{"reasoning_content":"inspect first"}}]}\n\n',
      'data: {"id":"req-1","choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":12,"completion_tokens":128}}\n\ndata: [DONE]\n\n',
    ]);
    const transport = new GatewayTransport({ credentialBindingId: "secret://x", models: [gatewayModel], client });

    const chunks = [];
    for await (const chunk of transport.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) chunks.push(chunk);

    expect(chunks).toContainEqual({ kind: "text", reasoning: "inspect first" });
    expect(chunks.at(-1)).toMatchObject({
      kind: "done",
      providerRequestId: "req-1",
      stopReason: "length",
    });
  });

  test("uses an anonymous binding for an admitted free gateway model", async () => {
    const gatewayModel = { ...model("chat_completions"), free: true };
    const client = new FakeClient(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);
    const transport = new GatewayTransport({
      credentialBindingId: "",
      models: [gatewayModel],
      client,
    });

    const chunks = [];
    for await (const chunk of transport.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) chunks.push(chunk);

    expect(client.seen?.credentialBindingId).toBe("");
    expect(client.seen?.authStyle).toBe("none");
    expect(chunks).toContainEqual({ kind: "text", text: "ok" });
    expect(chunks.at(-1)?.kind).toBe("done");
  });

  test("normalizes Responses events", async () => {
    const gatewayModel = model("responses");
    const client = new FakeClient([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
    ]);
    const transport = new GatewayTransport({ credentialBindingId: "secret://x", models: [gatewayModel], client });
    const chunks = [];
    for await (const chunk of transport.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) chunks.push(chunk);
    expect(client.seen?.url).toEndWith("/responses");
    expect(chunks).toContainEqual({ kind: "text", text: "hi" });
    expect(chunks.at(-1)?.continuationId).toBe("resp-1");
  });

  test("surfaces encrypted reasoning items from Responses streams in wire order", async () => {
    // Observed on the wire from the ChatGPT-Codex backend (gpt-5.6-luna,
    // effort medium, include: ["reasoning.encrypted_content"]): the reasoning
    // item completes before the function call it preceded.
    const gatewayModel = model("responses");
    const client = new FakeClient([
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"content":[],"encrypted_content":"gAAAA-opaque"}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Plan: read the file"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"Plan: read the file"}],"content":[],"encrypted_content":"gAAAA-opaque"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read","arguments":"{\\"path\\":\\"src/lib.py\\"}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-2","usage":{"input_tokens":30,"output_tokens":29,"output_tokens_details":{"reasoning_tokens":22}}}}\n\n',
    ]);
    const transport = new GatewayTransport({ credentialBindingId: "secret://x", models: [gatewayModel], client });
    const chunks = [];
    for await (const chunk of transport.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) chunks.push(chunk);
    const replayIndex = chunks.findIndex((chunk) => chunk.kind === "text" && chunk.reasoningItem !== undefined);
    const toolIndex = chunks.findIndex((chunk) => chunk.kind === "tool_call");
    expect(replayIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(replayIndex);
    expect(chunks[replayIndex]).toEqual({
      kind: "text",
      reasoningItem: { id: "rs_1", encryptedContent: "gAAAA-opaque", summary: ["Plan: read the file"] },
    });
    // The summary text still streams as reasoning deltas; the item is additive.
    expect(chunks).toContainEqual({ kind: "text", reasoning: "Plan: read the file" });
    // An item without the blob (the request did not ask for it) is not a replay item.
    const withoutBlob = new FakeClient([
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_2","summary":[]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-3","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ]);
    const bare = new GatewayTransport({ credentialBindingId: "secret://x", models: [gatewayModel], client: withoutBlob });
    const bareChunks = [];
    for await (const chunk of bare.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) bareChunks.push(chunk);
    expect(bareChunks.some((chunk) => chunk.kind === "text" && chunk.reasoningItem !== undefined)).toBe(false);
  });

  test("normalizes Anthropic Messages events", async () => {
    const gatewayModel = model("messages");
    const client = new FakeClient([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"read","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const transport = new GatewayTransport({ credentialBindingId: "secret://x", models: [gatewayModel], client });
    const chunks = [];
    for await (const chunk of transport.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) chunks.push(chunk);
    expect(client.seen?.url).toEndWith("/messages");
    expect(client.seen?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(chunks).toContainEqual({
      kind: "tool_call",
      toolCall: { toolCallId: "tool-1", toolName: "read", arguments: { path: "a" } },
    });
  });

  test("fails closed for unknown models", async () => {
    const transport = new GatewayTransport({ credentialBindingId: "secret://x", models: [], client: new FakeClient([]) });
    const consume = async () => {
      for await (const _chunk of transport.stream(request("missing"), {}, null)) void _chunk;
    };
    await expect(consume()).rejects.toThrow("is not admitted");
  });

  test("reports a truncated stream instead of manufacturing success", async () => {
    const gatewayModel = model("responses");
    const client = new FakeClient([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    ]);
    const transport = new GatewayTransport({ credentialBindingId: "secret://x", models: [gatewayModel], client });
    const chunks = [];
    for await (const chunk of transport.stream(request(gatewayModel.id), { model: gatewayModel.id }, null)) chunks.push(chunk);
    expect(chunks).toEqual([
      { kind: "text", text: "partial" },
      { kind: "error", errorCode: "TRUNCATED_STREAM", errorMessage: "Responses stream ended before response.completed" },
    ]);
  });
});
