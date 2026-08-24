import { describe, expect, test } from "bun:test";
import {
  decodeProviderChunks,
  parseLocalProviderCommand,
  ProviderCommandConfigurationError,
} from "./provider-command.js";

describe("kernel-brokered local provider command", () => {
  test("parses an explicit argv/model contract without invoking a shell", () => {
    const command = parseLocalProviderCommand(JSON.stringify({
      program: "terminus-provider-fixture",
      args: ["--stdio"],
      model: "local/test-model",
      timeout_seconds: 42,
    }));
    expect(command?.program).toBe("terminus-provider-fixture");
    expect(command?.args).toEqual(["--stdio"]);
    expect(String(command?.model)).toBe("local/test-model");
    expect(command?.timeoutSeconds).toBe(42);
  });

  test("fails closed for malformed or delimiter-bearing configuration", () => {
    expect(() => parseLocalProviderCommand("{"))
      .toThrow(ProviderCommandConfigurationError);
    expect(() => parseLocalProviderCommand(JSON.stringify({
      program: "provider\nsecond-command",
      model: "local/test-model",
    }))).toThrow(/control delimiters/);
  });

  test("strictly decodes bounded NDJSON chunks and converts usage counters", () => {
    const chunks = decodeProviderChunks([
      JSON.stringify({ kind: "text", text: "done" }),
      JSON.stringify({
        kind: "done",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          latency_ms: 12,
        },
      }),
      "",
    ].join("\n"));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ kind: "text", text: "done" });
    expect(BigInt(chunks[1]?.usage?.inputTokens ?? 0n)).toBe(10n);
    expect(BigInt(chunks[1]?.usage?.outputTokens ?? 0n)).toBe(2n);
  });

  test("rejects unknown fields and incomplete streams", () => {
    expect(() => decodeProviderChunks('{"kind":"text","text":"x","extra":true}\n'))
      .toThrow(/invalid/);
    expect(() => decodeProviderChunks('{"kind":"text","text":"x"}\n'))
      .toThrow(/terminate with a done chunk/);
  });
});
