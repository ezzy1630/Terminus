import { describe, expect, test } from "bun:test";
import { CodingTurnEngine } from "./coding-turn-engine.js";
import type { ProviderResponseChunk } from "@terminus/provider-core";

function toolCall(id: string, toolName: string): ProviderResponseChunk {
  return {
    kind: "tool_call",
    toolCallId: id,
    toolName,
    arguments: { path: "a.ts" },
  };
}

interface HarnessOptions {
  readonly responses: ReadonlyArray<{ text?: string; calls?: ReadonlyArray<ProviderResponseChunk> }>;
  readonly sideEffectClassOf?: (toolName: string) => string;
  readonly failOnCallIds?: readonly string[];
  readonly afterToolsSettled?: () => Promise<void>;
  readonly signal?: AbortSignal | null;
}

/**
 * Drive the engine against an in-memory provider/scripted settlement and
 * return the observable execution trace.
 */
async function runHarness(options: HarnessOptions) {
  const trace: string[] = [];
  const settleErrors = new Map<string, Error>(
    (options.failOnCallIds ?? []).map((id) => [id, new Error(`settlement refused ${id}`)]),
  );
  let responseIndex = 0;
  const engine = new CodingTurnEngine({
    budget: {
      maxSteps: options.responses.length + 1,
      hardMaxSteps: options.responses.length + 2,
    },
    newId: (() => {
      let n = 0;
      return () => `attempt-${(n += 1)}`;
    })(),
    sideEffectClassOf: options.sideEffectClassOf ?? ((name) => (name === "read" ? "read" : "workspace_write")),
    signal: options.signal,
    compileContext: async () => ({
      rendered: { providerId: "test", model: "test/model", request: {} as never, predictedCachedTokens: 0n as never, body: {} },
      requestArtifactUri: "artifact://sha256/request",
      contextManifestId: "manifest-1",
      providerCapabilityHash: "cap-1",
    }),
    beginAttempt: async ({ attemptNumber }) => {
      trace.push(`begin:${attemptNumber}`);
      return true;
    },
    executeProvider: async () => ({ raw: responseIndex }) as never,
    settleResponse: async () => {
      const response = options.responses[responseIndex]!;
      responseIndex += 1;
      trace.push(`response:${response.calls?.length ?? 0}calls`);
      return {
        projected: {
          text: response.text ?? "",
          toolCalls: response.calls ?? [],
          reasoning: null,
          continuationId: null,
          finishReason: (response.calls?.length ?? 0) > 0 ? ("tool_use" as const) : ("stop" as const),
        },
        interrupted: false,
      };
    },
    settleToolCall: async ({ call }) => {
      const error = settleErrors.get(call.toolCallId);
      if (error !== undefined) throw error;
      trace.push(`settle:${call.toolName}:${call.toolCallId}`);
    },
    afterToolsSettled: options.afterToolsSettled,
  });
  const stop = await engine.run();
  return { stop, trace, budget: engine.budget };
}

describe("CodingTurnEngine", () => {
  test("final response without tools ends the turn", async () => {
    const { stop, trace } = await runHarness({
      responses: [{ text: "all done" }],
    });
    expect(trace).toEqual(["begin:1", "response:0calls"]);
    expect(stop).toEqual({ kind: "final", text: "all done", responseArtifactUri: null });
  });

  test("multi-call responses are all settled before the next compile", async () => {
    const { stop, trace } = await runHarness({
      responses: [
        { calls: [toolCall("r1", "read"), toolCall("r2", "read")] },
        { text: "done after reads" },
      ],
    });
    expect(trace.filter((t) => t.startsWith("settle:")).length).toBe(2);
    expect(trace).toContain("begin:2");
    expect(stop.kind).toBe("final");
  });

  test("notifies once after the complete tool response settles", async () => {
    let callbacks = 0;
    const { stop } = await runHarness({
      responses: [
        { calls: [toolCall("r1", "read"), toolCall("w1", "patch")] },
        { text: "done" },
      ],
      afterToolsSettled: async () => { callbacks += 1; },
    });
    expect(callbacks).toBe(1);
    expect(stop.kind).toBe("final");
  });

  test("stops before compiling another provider attempt after cancellation", async () => {
    const controller = new AbortController();
    let callbacks = 0;
    const result = await runHarness({
      signal: controller.signal,
      responses: [
        { calls: [toolCall("r1", "read")] },
        { text: "must not be requested" },
      ],
      afterToolsSettled: async () => {
        callbacks += 1;
        controller.abort("user_cancelled");
      },
    });
    expect(callbacks).toBe(1);
    expect(result.stop).toEqual({ kind: "interrupted" });
    expect(result.trace).not.toContain("begin:2");
  });

  test("writes serialize in provider order behind prior reads", async () => {
    const order: string[] = [];
    const { stop } = await runHarness({
      sideEffectClassOf: (name) => (name === "read" ? "read" : "workspace_write"),
      responses: [
        {
          calls: [toolCall("w1", "patch"), toolCall("r3", "read"), toolCall("w2", "patch")],
        },
        { text: "ok" },
      ],
    }).then(async (result) => {
      // Re-derive ordering guarantees from batch planning semantics.
      order.push(result.trace.filter((t) => t.startsWith("settle")).join(","));
      return result;
    });
    expect(order[0]).toBe("settle:patch:w1,settle:read:r3,settle:patch:w2");
    expect(stop.kind).toBe("final");
  });

  test("budget exhaustion is reported, not thrown", async () => {
    const engine = new CodingTurnEngine({
      budget: { maxSteps: 0, hardMaxSteps: 24 },
      newId: () => "x",
      sideEffectClassOf: () => "read",
      compileContext: async () => ({
        rendered: {} as never,
        requestArtifactUri: "",
        contextManifestId: "",
        providerCapabilityHash: "",
      }),
      beginAttempt: async () => true,
      executeProvider: async () => ({}) as never,
      settleResponse: async () => ({
        projected: { text: "", toolCalls: [], reasoning: null, continuationId: null, finishReason: "stop" },
        interrupted: false,
      }),
      settleToolCall: async () => undefined,
    });
    const stop = await engine.run();
    expect(stop.kind).toBe("budget_exhausted");
  });

  test("settlement refusals propagate to the caller", async () => {
    const result = runHarness({
      responses: [
        { calls: [toolCall("bad-call-id", "patch")] },
        { text: "never reached" },
      ],
      failOnCallIds: ["bad-call-id"],
    });
    // A settlement refusal is never converted into a fake stop or final
    // response; it rejects out of run().
    await expect(result.then((r) => r.stop)).rejects.toThrow("settlement refused bad-call-id");
  });

  test("aborts with doom_loop when identical tool calls repeat 3 times", async () => {
    const { stop, trace } = await runHarness({
      responses: [
        { calls: [toolCall("c1", "read")] },
        { calls: [toolCall("c2", "read")] },
        { calls: [toolCall("c3", "read")] },
        { text: "never reached" },
      ],
    });
    expect(stop.kind).toBe("doom_loop");
    if (stop.kind === "doom_loop") {
      expect(stop.count).toBe(3);
      expect(stop.signature).toContain("read:");
    }
  });
});
