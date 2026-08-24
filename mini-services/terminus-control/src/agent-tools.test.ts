import { describe, expect, test } from "bun:test";
import {
  MAX_TOOL_CYCLES,
  STANDALONE_TOOL_SCHEMAS,
  normalizedToolOperationHash,
  parseStandaloneToolCall,
  providerToolCallTranscript,
  toolEffectMetadata,
} from "./agent-tools.js";

describe("standalone provider tools", () => {
  test("exposes only the three bounded kernel tools", () => {
    expect(STANDALONE_TOOL_SCHEMAS.map((tool) => tool.id)).toEqual(["read", "patch", "exec"]);
    expect(MAX_TOOL_CYCLES).toBe(4);
  });

  test("strictly validates tool identity and arguments", () => {
    const call = parseStandaloneToolCall({
      toolCallId: "provider-call-1",
      toolName: "read",
      arguments: { path: "src/index.ts" },
    });
    expect(call.arguments).toMatchObject({ path: "src/index.ts", max_bytes: 24 * 1_024 });
    expect(toolEffectMetadata(call).effectType).toBe("READ_LOCAL");
    expect(providerToolCallTranscript(call).provider_call_id).toBe("provider-call-1");
    expect(() => parseStandaloneToolCall({ toolCallId: "x", toolName: "search", arguments: {} })).toThrow(/unknown standalone tool/);
    expect(() => parseStandaloneToolCall({ toolCallId: "x", toolName: "exec", arguments: { program: "sh; exit" } })).toThrow(/invalid/);
  });

  test("semantic idempotency excludes provider attempts and call ids", () => {
    const first = parseStandaloneToolCall({ toolCallId: "call-a", toolName: "read", arguments: { path: "README.md" } });
    const second = parseStandaloneToolCall({ toolCallId: "call-b", toolName: "read", arguments: { path: "README.md" } });
    expect(normalizedToolOperationHash({ taskId: "task", contractVersion: 3, call: first })).toBe(
      normalizedToolOperationHash({ taskId: "task", contractVersion: 3, call: second }),
    );
  });
});
