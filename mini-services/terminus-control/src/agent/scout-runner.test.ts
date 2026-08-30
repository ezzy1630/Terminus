import { describe, expect, test } from "bun:test";
import {
  SCOUT_MAX_STEPS_DEFAULT,
  ScoutUtilityLedger,
  parseScoutResult,
  resolveScoutEnabled,
  runScoutLoop,
} from "./scout-runner.js";
import { InMemoryDelegationStepAccountant } from "./delegation-runner.js";

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
    const calls: import("./delegation-runner.js").DelegationTranscriptMessage[][] = [];
    let step = 0;
    const result = await runScoutLoop({
      objective: "Find the login guard",
      authority: {
        allowedTools: ["grep"],
        allowedReadPaths: ["**"],
        allowedWritePaths: [],
        deniedEffects: ["write", "execute"],
      },
      callProvider: async (transcript) => {
        calls.push([...transcript]);
        if (step === 0) {
          step += 1;
          return {
            renderedBody: {},
            projectedText: "let me grep",
            toolCalls: [{ toolName: "grep", providerCallId: "call_provider_42", argumentsJson: JSON.stringify({ pattern: "guard" }) }],
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
    // First request carries the scout system prompt AND the objective.
    expect(calls[0]?.map((message) => message.role)).toEqual(["user", "user"]);
    expect(calls[1]?.length).toBe(5); // + assistant text, canonical call, and tool result
    expect(calls[1]?.[3]?.role).toBe("assistant");
    expect(calls[1]?.[3]?.providerCallId).toBe("call_provider_42");
    expect(calls[1]?.[4]?.role).toBe("tool");
    expect(calls[1]?.[3]?.text).toContain('"protocol":"terminus.tool-call.v1"');
    expect(calls[1]?.[4]?.text).toContain('"protocol":"terminus.tool-result.v1"');
    expect(calls[1]?.[4]?.text).toContain('"provider_call_id":"call_provider_42"');
  });

  test("write/exec tools fail closed inside the loop", async () => {
    const seen: string[] = [];
    let step = 0;
    const finalJson = "```json\n" + JSON.stringify({ claims: ["done"], files: [], open_questions: [] }) + "\n```";
    const result = await runScoutLoop({
      objective: "reject unsafe tool",
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
    // No unsafe tool reaches the executor, and a child cannot report success.
    expect(seen).toEqual([]);
    expect(result.status).toBe("failed");
  });

  test("settles every provider step with caller-supplied deterministic ids", async () => {
    const accountant = new InMemoryDelegationStepAccountant();
    const result = await runScoutLoop({
      objective: "Find the login guard",
      identity: {
        parentTaskId: "task-1",
        delegationId: "delegation-1",
        attemptIdForStep: (step) => `delegation-1-attempt-${step}`,
      },
      accountant,
      callProvider: async () => ({
        renderedBody: {},
        projectedText: "```json\n{\"claims\":[\"guard at src/auth.ts:1\"],\"files\":[\"src/auth.ts\"],\"open_questions\":[],\"evidence_refs\":[\"workspace://src/auth.ts\"]}\n```",
        toolCalls: [],
        usage: { inputTokens: 10n, outputTokens: 4n, costMicros: 2n },
      }),
      executeTool: async () => ({ ok: true, resultText: "unused" }),
    });
    expect(result.status).toBe("completed");
    expect(accountant.starts.map((entry) => entry.attemptId)).toEqual(["delegation-1-attempt-0"]);
    expect(accountant.settlements.map((entry) => entry.attemptId)).toEqual(["delegation-1-attempt-0"]);
    expect(result.usage.inputTokens).toBe(10n);
    expect(result.usage.outputTokens).toBe(4n);
    expect(result.usage.costMicros).toBe(2n);
  });

  test("rejects malformed final output instead of returning empty success", async () => {
    const result = await runScoutLoop({
      objective: "obj",
      callProvider: async () => ({ renderedBody: {}, projectedText: "```json\n{\"claims\":[4],\"files\":[],\"open_questions\":[]}\n```", toolCalls: [] }),
      executeTool: async () => ({ ok: true, resultText: "unused" }),
      maxSteps: 1,
    });
    expect(result.status).toBe("budget_exhausted");
    expect(result.claims).toEqual([]);
    expect(result.failureReason).not.toBeNull();
  });

  test("budget exhaustion returns the honest status", async () => {
    const result = await runScoutLoop({
      objective: "obj",
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

  test("default-off enablement with explicit opt-in", () => {
    expect(resolveScoutEnabled(undefined)).toBe(false);
    expect(resolveScoutEnabled(null)).toBe(false);
    expect(resolveScoutEnabled("")).toBe(false);
    expect(resolveScoutEnabled("0")).toBe(false);
    expect(resolveScoutEnabled("false")).toBe(false);
    expect(resolveScoutEnabled("1")).toBe(true);
  });
});
