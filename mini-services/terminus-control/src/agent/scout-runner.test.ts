import { describe, expect, test } from "bun:test";
import {
  SCOUT_MAX_STEPS_DEFAULT,
  ScoutUtilityLedger,
  parseScoutResult,
  resolveScoutEnabled,
  runScoutLoop,
} from "./scout-runner.js";

describe("R10 scout result parsing", () => {
  test("parses the fenced json final block with caps", () => {
    const parsed = parseScoutResult([
      "searching…",
      "```json",
      JSON.stringify({
        claims: Array.from({ length: 20 }, (_, i) => `claim-${i}`),
        files: [{ path: "src/a.ts", role: "entry" }, "/lib/b.rs"],
        open_questions: ["which config?"],
      }),
      "```",
    ].join("\n"));
    expect(parsed?.status).toBe("completed");
    expect(parsed?.claims.length).toBe(16); // capped
    expect(parsed?.files).toEqual([{ path: "src/a.ts", role: "entry" }, { path: "/lib/b.rs", role: "" }]);
  });

  test("returns null for missing or empty blocks", () => {
    expect(parseScoutResult("no block here")).toBeNull();
    expect(parseScoutResult("```json\n{}\n```")).toBeNull();
    expect(parseScoutResult("```json\nnot json\n```")).toBeNull();
  });
});

describe("R10 scout loop", () => {
  test("executes tool calls, feeds results back, and returns the typed result", async () => {
    const finalJson = [
      "```json",
      JSON.stringify({ claims: ["auth check lives in guard.ts:42"], files: [{ path: "src/guard.ts", role: "core" }], open_questions: [] }),
      "```",
    ].join("\n");
    const calls: string[][] = [];
    let step = 0;
    const result = await runScoutLoop({
      callProvider: async (transcript) => {
        calls.push(transcript.map((m) => m.role));
        if (step === 0) {
          step += 1;
          return {
            renderedBody: {},
            projectedText: "let me grep",
            toolCalls: [{ toolName: "grep", argumentsJson: JSON.stringify({ pattern: "guard" }) }],
          };
        }
        return { renderedBody: {}, projectedText: finalJson, toolCalls: [] };
      },
      executeTool: async ({ toolName }) => ({
        ok: true,
        resultText: `${toolName} output here`,
      }),
    });
    expect(result.status).toBe("completed");
    expect(result.claims).toEqual(["auth check lives in guard.ts:42"]);
    // First message is the scout system prompt as user role; results fed back after assistant.
    expect(calls[0]?.[0]).toBe("user");
    expect(calls[1]?.length).toBeGreaterThanOrEqual(3);
  });

  test("write/exec tools are rejected by name inside the loop", async () => {
    const seen: string[] = [];
    let step = 0;
    const finalJson = "```json\n" + JSON.stringify({ claims: ["done"], files: [], open_questions: [] }) + "\n```";
    await runScoutLoop({
      callProvider: async () => {
        step += 1;
        if (step === 1) {
          return {
            renderedBody: {},
            projectedText: "trying patch",
            toolCalls: [
              { toolName: "patch", argumentsJson: "{}" },
              { toolName: "exec", argumentsJson: "{}" },
              { toolName: "read", argumentsJson: "{}" },
            ],
          };
        }
        return { renderedBody: {}, projectedText: finalJson, toolCalls: [] };
      },
      executeTool: async ({ toolName }) => {
        seen.push(toolName);
        return { ok: true, resultText: "ok" };
      },
    });
    // patch/exec never reach the executor; only the read does.
    expect(seen).toEqual(["read"]);
  });

  test("budget exhaustion returns the honest status", async () => {
    const result = await runScoutLoop({
      callProvider: async () => ({ renderedBody: {}, projectedText: "still searching", toolCalls: [] }),
      executeTool: async () => ({ ok: true, resultText: "" }),
      maxSteps: 2,
    });
    // No tools + no json → formatting retries then budget stop.
    expect(result.status).toBe("budget_exhausted");
    expect(SCOUT_MAX_STEPS_DEFAULT).toBe(10);
  });
});

describe("R10 scout utility ledger and enablement", () => {
  test("three consecutive zero-yield scouts disable themselves", () => {
    const ledger = new ScoutUtilityLedger();
    expect(ledger.shouldRun()).toBe(true);
    ledger.recordScout("t1", 0);
    ledger.recordScout("t1", 0);
    expect(ledger.shouldRun()).toBe(true);
    ledger.recordScout("t1", 0);
    expect(ledger.shouldRun()).toBe(false);
    expect(ledger.snapshot().totalScouts).toBe(3);
  });

  test("a productive scout resets the zero-yield streak", () => {
    const ledger = new ScoutUtilityLedger();
    ledger.recordScout("t1", 0);
    ledger.recordScout("t1", 0);
    ledger.recordScout("t1", 4);
    ledger.recordCitation("t1");
    expect(ledger.shouldRun()).toBe(true);
    expect(ledger.snapshot().consecutiveZeroYield).toBe(0);
  });

  test("default-on enablement with explicit kill-switch", () => {
    expect(resolveScoutEnabled(undefined)).toBe(true);
    expect(resolveScoutEnabled(null)).toBe(true);
    expect(resolveScoutEnabled("")).toBe(true);
    expect(resolveScoutEnabled("0")).toBe(false);
    expect(resolveScoutEnabled("false")).toBe(false);
    expect(resolveScoutEnabled("1")).toBe(true);
  });
});
