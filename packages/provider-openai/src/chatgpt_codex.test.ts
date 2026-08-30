/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
  CHATGPT_CODEX_FORBIDDEN_BODY_FIELDS,
  CODEX_MODELS_ETAG_HEADER,
  CODEX_TURN_STATE_HEADER,
  ChatGptCodexRenderer,
  CodexTurnState,
  chatGptCodexBody,
  chatGptCodexReasoningLevel,
  chatGptCodexRequestHeaders,
  type ChatGptCodexModelProfile,
} from "./chatgpt_codex.js";
import { toResponsesInputItems, type OpenAiChatMessage } from "./index.js";

/**
 * A builtin tool with an optional parameter, claiming strict mode.
 *
 * This exact pairing 400'd a live Codex turn: "Invalid schema for function
 * 'read': … 'required' is required to be supplied and to be an array
 * including every key in properties. Missing 'max_bytes'."
 */
const READ_TOOL_CLAIMING_STRICT = {
  type: "function",
  name: "read",
  description: "read",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string" },
      max_bytes: { type: "integer", minimum: 1, maximum: 30 * 1_024, default: 28 * 1_024 },
    },
  },
  strict: true,
} as const;

/**
 * The body an ordinary Responses render produces, including every field the
 * Codex endpoint answered 400 for on 2026-08-28.
 */
function responsesBody(): Record<string, unknown> {
  return {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "hello" }],
    stream: true,
    tools: [READ_TOOL_CLAIMING_STRICT],
    max_output_tokens: 4_096,
    temperature: 0.2,
    top_p: 0.9,
    previous_response_id: "resp_123",
    store: true,
    reasoning: { effort: "high", summary: "auto" },
  };
}

const PROFILE: ChatGptCodexModelProfile = {
  slug: "gpt-5.6-sol",
  reasoningLevels: ["low", "medium", "high", "ultra"],
  defaultReasoningLevel: "medium",
  supportsParallelToolCalls: true,
  supportsReasoningSummaries: true,
};

describe("chatGptCodexBody", () => {
  test("golden body for a tool-carrying turn", () => {
    expect(chatGptCodexBody(responsesBody(), {
      reasoningEffort: "high",
      promptCacheKey: "thread-1",
      profile: PROFILE,
    })).toEqual({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "thread-1",
      reasoning: { effort: "high", summary: "auto" },
      // Verified accepted by the live endpoint; the desktop wants short prose.
      text: { verbosity: "low" },
      // Two opaque correlation ids; no credential, no user content.
      client_metadata: { session_id: "thread-1", thread_id: "thread-1" },
      // Same schema, verbatim — only the strict claim is withdrawn.
      tools: [{ ...READ_TOOL_CLAIMING_STRICT, strict: false }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
  });

  test("carries the caller's own session and thread ids when it has both", () => {
    const body = chatGptCodexBody(responsesBody(), {
      promptCacheKey: "session-9",
      sessionId: "session-9",
      threadId: "thread-4",
      profile: PROFILE,
    });
    expect(body.client_metadata).toEqual({ session_id: "session-9", thread_id: "thread-4" });
  });

  test("keeps text.verbosity the caller asked for", () => {
    const body = chatGptCodexBody(responsesBody(), { textVerbosity: "medium", profile: PROFILE });
    expect(body.text).toEqual({ verbosity: "medium" });
  });

  test("strips fields the live endpoint has never been observed to accept", () => {
    // `truncation` is a legitimate Responses parameter and is absent from the
    // measured Codex body; this endpoint 400s the whole request on one
    // unknown key, so it does not travel here.
    const body = chatGptCodexBody({ ...responsesBody(), truncation: "auto" }, { profile: PROFILE });
    expect(body).not.toHaveProperty("truncation");
  });

  test("withdraws the strict claim from every function tool", () => {
    const body = chatGptCodexBody(
      {
        ...responsesBody(),
        tools: [
          READ_TOOL_CLAIMING_STRICT,
          { type: "function", name: "glob", description: "glob", parameters: {}, strict: true },
        ],
      },
      { profile: PROFILE },
    );
    const tools = body.tools as Array<{ name: string; strict: boolean; parameters: unknown }>;
    expect(tools.map((tool) => tool.strict)).toEqual([false, false]);
    // Withdrawing the claim must not edit the schema: no property is hoisted
    // into `required` and nothing is made nullable behind the model's back.
    expect(tools[0]!.parameters).toEqual(READ_TOOL_CLAIMING_STRICT.parameters);
    expect(JSON.stringify(body)).not.toContain('"strict":true');
  });

  test("drops every field the endpoint rejects", () => {
    const body = chatGptCodexBody(responsesBody(), { profile: PROFILE });
    for (const field of CHATGPT_CODEX_FORBIDDEN_BODY_FIELDS) {
      expect(body).not.toHaveProperty(field);
    }
  });

  test("forces store:false and stream:true whatever the base body said", () => {
    const body = chatGptCodexBody({ ...responsesBody(), store: true, stream: false }, { profile: PROFILE });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  test("sends no reasoning block for a model that advertises no levels", () => {
    const body = chatGptCodexBody(responsesBody(), {
      reasoningEffort: "high",
      profile: { ...PROFILE, reasoningLevels: [], defaultReasoningLevel: null },
    });
    expect(body).not.toHaveProperty("reasoning");
  });

  test("omits the summary for a model that does not support summaries", () => {
    const body = chatGptCodexBody(responsesBody(), {
      reasoningEffort: "low",
      profile: { ...PROFILE, supportsReasoningSummaries: false },
    });
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  test("omits the prompt cache key when the caller has none", () => {
    expect(chatGptCodexBody(responsesBody(), { profile: PROFILE })).not.toHaveProperty("prompt_cache_key");
  });

  test("adds no tool controls to a turn that carries no tools", () => {
    const body = chatGptCodexBody({ ...responsesBody(), tools: [] }, { profile: PROFILE });
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("reports parallel tool calls exactly as the catalogue does", () => {
    expect(chatGptCodexBody(responsesBody(), {
      profile: { ...PROFILE, supportsParallelToolCalls: false },
    }).parallel_tool_calls).toBe(false);
  });
});

describe("chat-only keys never reach the endpoint", () => {
  /**
   * Regression for the live 400 on 2026-08-29:
   * `Unknown parameter: 'input[4].cache_control'`. The prompt-cache marker the
   * chat renderer stamps on the first cached user block has no meaning in the
   * Responses dialect, and this endpoint rejects the whole request for it.
   */
  test("no cache_control survives anywhere in the serialised body", () => {
    const body = chatGptCodexBody({
      model: "gpt-5.4-mini",
      input: [
        { role: "developer", content: "instructions", cache_control: "ephemeral" },
        { role: "user", content: [{ type: "input_text", text: "hi", cache_control: "ephemeral" }] },
      ],
      tools: [{
        type: "function",
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string", cache_control: "ephemeral" } } },
      }],
      stream: true,
    }, { profile: PROFILE });

    expect(JSON.stringify(body)).not.toContain("cache_control");
    // Stripping a key must not flatten the structure around it.
    const items = body.input as Record<string, unknown>[];
    expect(items[0]).toEqual({ role: "developer", content: "instructions" });
    expect((items[1]?.content as Record<string, unknown>[])[0]).toEqual({ type: "input_text", text: "hi" });
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]?.parameters).toEqual({ type: "object", properties: { path: { type: "string" } } });
  });

  test("chat tool turns become Responses function-call items", () => {
    const messages: OpenAiChatMessage[] = [
      { role: "user", content: "read it", cache_control: "ephemeral" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ];
    expect(toResponsesInputItems(messages)).toEqual([
      { role: "user", content: "read it" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
    ]);
  });

  test("an assistant turn with both prose and a tool call keeps both", () => {
    expect(toResponsesInputItems([{
      role: "assistant",
      content: "let me look",
      tool_calls: [{ id: "call_2", type: "function", function: { name: "grep", arguments: "{}" } }],
    }])).toEqual([
      { role: "assistant", content: "let me look" },
      { type: "function_call", call_id: "call_2", name: "grep", arguments: "{}" },
    ]);
  });

  test("no chat-only key reaches an input item", () => {
    const items = toResponsesInputItems([
      { role: "user", content: "hi", cache_control: "ephemeral", name: "someone" },
    ]);
    expect(items[0]).toEqual({ role: "user", content: "hi" });
  });
});

describe("chatGptCodexReasoningLevel", () => {
  test("keeps ultra distinct when the model advertises it", () => {
    expect(chatGptCodexReasoningLevel("ultra", PROFILE)).toBe("ultra");
  });

  test("max saturates at the strongest level the model advertises", () => {
    expect(chatGptCodexReasoningLevel("max", PROFILE)).toBe("ultra");
    expect(chatGptCodexReasoningLevel("max", { ...PROFILE, reasoningLevels: ["low", "medium", "high"] })).toBe("high");
    expect(chatGptCodexReasoningLevel("max", { ...PROFILE, reasoningLevels: ["low", "xhigh"] })).toBe("xhigh");
  });

  test("passes through a level the model names", () => {
    expect(chatGptCodexReasoningLevel("low", PROFILE)).toBe("low");
    expect(chatGptCodexReasoningLevel("medium", PROFILE)).toBe("medium");
    expect(chatGptCodexReasoningLevel("high", PROFILE)).toBe("high");
  });

  test("falls back to the model's own default rather than guessing", () => {
    expect(chatGptCodexReasoningLevel("low", { ...PROFILE, reasoningLevels: ["medium", "high"] })).toBe("medium");
  });

  test("a model with no advertised levels gets none", () => {
    expect(chatGptCodexReasoningLevel("high", { ...PROFILE, reasoningLevels: [] })).toBeNull();
    expect(chatGptCodexReasoningLevel("high", null)).toBeNull();
  });
});

describe("ChatGptCodexRenderer", () => {
  test("reports the account as its provider and requires one", () => {
    expect(new ChatGptCodexRenderer("account:codex-chatgpt").providerId).toBe("account:codex-chatgpt");
    expect(() => new ChatGptCodexRenderer(" ")).toThrow("provider id");
  });

  test("never continues natively, because the endpoint stores nothing", () => {
    const renderer = new ChatGptCodexRenderer("account:codex-chatgpt");
    const unchanged = renderer.continuationPolicy({
      model: "gpt-5.6-sol",
      continuationId: "resp_123",
      stablePrefixHashChanged: false,
    } as Parameters<typeof renderer.continuationPolicy>[0]);
    expect(unchanged.canContinue).toBe(true);
    expect(unchanged.newContinuationId).toBeNull();

    const changed = renderer.continuationPolicy({
      model: "gpt-5.6-sol",
      continuationId: "resp_123",
      stablePrefixHashChanged: true,
    } as Parameters<typeof renderer.continuationPolicy>[0]);
    expect(changed.canContinue).toBe(false);
    expect(changed.requiresRerender).toBe(true);
  });
});

describe("Codex per-turn continuity headers", () => {
  const identity = {
    originator: "terminus",
    userAgent: "terminus/1.2.3",
    accountId: "acct-9",
    sessionId: "session-9",
    threadId: "thread-9",
  } as const;

  test("nothing is echoed until a response has supplied a token", () => {
    const state = new CodexTurnState();
    expect(state.requestHeaders()).toEqual({});
    expect(state.turnStateToken).toBeNull();
    expect(state.modelsCatalogEtag).toBeNull();
    // The first request of a turn must not carry a stale token.
    expect(chatGptCodexRequestHeaders({ ...identity, turnState: state })[CODEX_TURN_STATE_HEADER])
      .toBeUndefined();
  });

  test("the token from one response is echoed on the next request of the turn", () => {
    const state = new CodexTurnState();
    state.observe({ [CODEX_TURN_STATE_HEADER]: "opaque-a", [CODEX_MODELS_ETAG_HEADER]: 'W/"cat-1"' });
    expect(state.requestHeaders()).toEqual({ [CODEX_TURN_STATE_HEADER]: "opaque-a" });
    expect(state.modelsCatalogEtag).toBe('W/"cat-1"');
    expect(chatGptCodexRequestHeaders({ ...identity, turnState: state })[CODEX_TURN_STATE_HEADER])
      .toBe("opaque-a");
    // A later response replaces it; the newest token is the one to echo.
    state.observe({ [CODEX_TURN_STATE_HEADER]: "opaque-b" });
    expect(state.turnStateToken).toBe("opaque-b");
    // The catalogue token is not cleared by a response that omits it.
    expect(state.modelsCatalogEtag).toBe('W/"cat-1"');
  });

  test("empty, absent, and non-string header values never overwrite a good token", () => {
    const state = new CodexTurnState();
    state.observe({ [CODEX_TURN_STATE_HEADER]: "opaque-a" });
    state.observe({ [CODEX_TURN_STATE_HEADER]: "" });
    state.observe(undefined);
    state.observe(null);
    state.observe({ [CODEX_TURN_STATE_HEADER]: 7 as unknown as string });
    expect(state.turnStateToken).toBe("opaque-a");
  });

  test("headers are read case-insensitively, as the wire delivers them", () => {
    const state = new CodexTurnState();
    state.observe({ "X-Codex-Turn-State": "opaque-c", "X-Models-Etag": "cat-2" });
    expect(state.turnStateToken).toBe("opaque-c");
    expect(state.modelsCatalogEtag).toBe("cat-2");
  });

  test("thread id is sent twice, as thread-id and x-client-request-id", () => {
    const headers = chatGptCodexRequestHeaders(identity);
    expect(headers["thread-id"]).toBe("thread-9");
    expect(headers["x-client-request-id"]).toBe("thread-9");
    expect(headers["session-id"]).toBe("session-9");
    expect(headers["chatgpt-account-id"]).toBe("acct-9");
  });

  test("`version` is never sent and the identity is Terminus's own", () => {
    // `version` names a Codex CLI release; there is no honest value for it
    // here, and the endpoint does not require one.
    const headers = chatGptCodexRequestHeaders(identity);
    expect(headers.version).toBeUndefined();
    expect(headers.originator).toBe("terminus");
    expect(headers["user-agent"]).toBe("terminus/1.2.3");
  });

  test("absent optional identity fields are omitted, not sent blank", () => {
    const headers = chatGptCodexRequestHeaders({
      originator: "terminus",
      userAgent: "terminus/1.2.3",
      accountId: null,
      sessionId: "   ",
    });
    expect(Object.keys(headers).sort()).toEqual(["originator", "user-agent"]);
  });
});
