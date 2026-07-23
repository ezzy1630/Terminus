import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  OpenCodeBridgeAdapter,
  truncateToolOutput,
  computeDivergence,
} from "./index.js";

describe("OpenCode Parity and Golden Tests", () => {
  it("should match Anthropic messages request golden fixture", async () => {
    const fixturePath = path.resolve(__dirname, "./fixtures/goldens/anthropic-messages.json");
    const content = JSON.parse(await fs.readFile(fixturePath, "utf8"));

    expect(content.provider).toBe("anthropic");
    expect(content.request.model).toBe("claude-3-5-sonnet-20241022");
    expect(content.request.messages).toHaveLength(1);
    expect(content.expected_events.length).toBeGreaterThan(0);
  });

  it("should match OpenAI chat request golden fixture", async () => {
    const fixturePath = path.resolve(__dirname, "./fixtures/goldens/openai-chat.json");
    const content = JSON.parse(await fs.readFile(fixturePath, "utf8"));

    expect(content.provider).toBe("openai");
    expect(content.request.model).toBe("gpt-4o");
    expect(content.request.messages.length).toBe(2);
  });

  it("should match Google Gemini request golden fixture", async () => {
    const fixturePath = path.resolve(__dirname, "./fixtures/goldens/google-gemini.json");
    const content = JSON.parse(await fs.readFile(fixturePath, "utf8"));

    expect(content.provider).toBe("google");
    expect(content.request.contents.length).toBe(1);
  });

  it("should verify session resumption golden contract", async () => {
    const fixturePath = path.resolve(__dirname, "./fixtures/goldens/session-resume.json");
    const content = JSON.parse(await fs.readFile(fixturePath, "utf8"));

    const adapter = new OpenCodeBridgeAdapter();
    const res = await adapter.handle({
      method: "session.resume",
      params: {
        session_id: content.session_id,
        continuation_token: content.continuation_token,
      },
    });

    expect(res.result).toEqual({
      session_id: content.session_id,
      continuation_token: content.continuation_token,
      status: "resumed",
    });
  });

  it("should verify config resolution golden contract", async () => {
    const fixturePath = path.resolve(__dirname, "./fixtures/goldens/config-resolution.json");
    const content = JSON.parse(await fs.readFile(fixturePath, "utf8"));

    const adapter = new OpenCodeBridgeAdapter();
    const res = await adapter.handle({
      method: "config.resolve",
      params: {
        config: content.opencode_config,
      },
    });

    expect((res.result as any).default_model).toBe(content.expected_terminus_config.default_model);
    expect((res.result as any).ui_theme).toBe(content.expected_terminus_config.ui_theme);
  });

  it("should enforce bounded tool output with truncation and continuation tokens", () => {
    const smallOutput = "Hello world";
    const smallResult = truncateToolOutput(smallOutput, 100);
    expect(smallResult.isTruncated).toBe(false);
    expect(smallResult.content).toBe(smallOutput);
    expect(smallResult.continuationToken).toBeUndefined();

    const largeOutput = "X".repeat(5000);
    const largeResult = truncateToolOutput(largeOutput, 1024);
    expect(largeResult.isTruncated).toBe(true);
    expect(largeResult.content.length).toBe(1024);
    expect(largeResult.continuationToken).toBe("cont_tail_3976_bytes");
    expect(largeResult.totalLength).toBe(5000);
  });

  it("should compute divergence budget metrics accurately", () => {
    const report = computeDivergence({
      pinned_upstream_commit: "184da0e42edc12ea480d09c6620512f8b7a0e656",
      modified_files: 1,
      merge_conflict_hours: 0.5,
      budget_max_files: 25,
      budget_max_hours: 8,
    });

    expect(report.within_budget).toBe(true);
    expect(report.modified_files).toBe(1);
  });
});
