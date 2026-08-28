import { describe, expect, test } from "bun:test";
import {
  CodingTurnEngine,
  EMPTY_COMPLETION_LIMIT,
  VERBATIM_REPETITION_LIMIT,
  VERBATIM_REPETITION_MIN_CHARS,
} from "./coding-turn-engine.js";
import { PolicyDeniedError } from "@terminus/domain";
import type { ProviderToolCallChunk } from "@terminus/provider-core";
import type { OperationObservation } from "./loop-contracts.js";
import type { OperationEffectMetadata } from "./turn-budget.js";

function toolCall(id: string, toolName: string, path = "a.ts"): ProviderToolCallChunk {
  return {
    toolCallId: id,
    toolName,
    arguments: { path },
  };
}

interface HarnessOptions {
  readonly responses: ReadonlyArray<{ text?: string; calls?: ReadonlyArray<ProviderToolCallChunk>; finishReason?: string }>;
  readonly sideEffectClassOf?: (toolName: string) => string;
  readonly effectMetadataOf?: (call: ProviderToolCallChunk) => OperationEffectMetadata;
  readonly failOnCallIds?: readonly string[];
  readonly afterToolsSettled?: () => Promise<void>;
  readonly onOperationObserved?: (observation: OperationObservation) => void | Promise<void>;
  readonly omitCompletionSignal?: boolean;
  readonly signal?: AbortSignal | null;
  readonly drainSteering?: () => Promise<readonly string[]>;
  readonly onSteeringDrained?: (messages: readonly string[]) => void | Promise<void>;
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
    ...(options.effectMetadataOf === undefined ? {} : { effectMetadataOf: options.effectMetadataOf }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    compileContext: async () => ({
      rendered: { providerId: "test", model: "test/model" as never, request: {} as never, predictedCachedTokens: 0n as never, body: {} },
      requestArtifactUri: "artifact://sha256/request",
      requestArtifactHash: "sha256:request",
      contextManifestId: "manifest-1",
      providerCapabilityHash: "cap-1",
      modelSnapshotHash: "sha256:model",
      providerEndpoint: "kernel://test-provider",
      toolSchemaHash: "sha256:tools",
      contextEpochId: "epoch-1",
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
          finishReason: response.finishReason !== undefined
            ? (response.finishReason as never)
            : (response.calls?.length ?? 0) > 0 ? ("tool_use" as const) : ("stop" as const),
        },
        interrupted: false,
        ...(!options.omitCompletionSignal && (response.calls === undefined || response.calls.length === 0)
          ? {
              completion: response.text?.trim().length
                ? { kind: "completion_proposal" as const, claims: [] }
                : { kind: "assistant_message" as const },
            }
          : {}),
      };
    },
    settleToolCall: async ({ call }) => {
      const error = settleErrors.get(call.toolCallId);
      if (error !== undefined) throw error;
      trace.push(`settle:${call.toolName}:${call.toolCallId}`);
    },
    ...(options.afterToolsSettled === undefined ? {} : { afterToolsSettled: options.afterToolsSettled }),
    ...(options.onOperationObserved === undefined ? {} : { onOperationObserved: options.onOperationObserved }),
    ...(options.drainSteering === undefined ? {} : { drainSteering: options.drainSteering }),
    ...(options.onSteeringDrained === undefined ? {} : { onSteeringDrained: options.onSteeringDrained }),
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
    expect(stop).toEqual({
      kind: "completion_proposal",
      proposal: {
        status: "PROPOSED",
        attemptId: "attempt-1",
        text: "all done",
        responseArtifactUri: null,
        claims: [],
      },
    });
  });

  test("text without an explicit completion signal remains an assistant message", async () => {
    const { stop } = await runHarness({
      responses: [{ text: "I need more information before claiming completion." }],
      omitCompletionSignal: true,
    });
    expect(stop).toMatchObject({
      kind: "assistant_message",
      text: "I need more information before claiming completion.",
    });
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
    expect(stop.kind).toBe("completion_proposal");
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
    expect(stop.kind).toBe("completion_proposal");
  });

  test("records a typed observation for every settled operation", async () => {
    const observations: OperationObservation[] = [];
    const { stop } = await runHarness({
      responses: [
        { calls: [toolCall("p1", "patch"), toolCall("p2", "patch")] },
        { text: "done" },
      ],
      onOperationObserved: (observation) => { observations.push(observation); },
    });
    expect(stop.kind).toBe("completion_proposal");
    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.providerCallId)).toEqual(["p1", "p2"]);
    expect(observations.every((entry) => entry.schemaVersion === "terminus.operation-observation.v1")).toBe(true);
    expect(observations.every((entry) => entry.observationHash.startsWith("sha256:") && entry.semanticFingerprint.startsWith("sha256:"))).toBe(true);
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
    expect(stop.kind).toBe("completion_proposal");
  });

  test("effect metadata keeps external and process-affined reads serial", async () => {
    const trace: string[] = [];
    const { stop } = await runHarness({
      responses: [
        { calls: [toolCall("r1", "read"), toolCall("p1", "exec_poll"), toolCall("r2", "read")] },
        { text: "done" },
      ],
      effectMetadataOf: (call) => call.toolName === "read"
        ? {
            sideEffectClass: "read",
            workspaceSnapshot: "rev-a",
            externalNetwork: false,
            processAffinity: null,
            consistency: "workspace_snapshot",
            rateLimitGroup: null,
            cacheable: true,
            expectedLatencyMs: 30_000,
            expectedOutputBytes: 32 * 1_024,
          }
        : {
            sideEffectClass: "read",
            workspaceSnapshot: null,
            externalNetwork: false,
            processAffinity: "job-1",
            consistency: "live",
            rateLimitGroup: null,
            cacheable: false,
            expectedLatencyMs: 30_000,
            expectedOutputBytes: 32 * 1_024,
          },
      onOperationObserved: (observation) => { trace.push(observation.providerCallId); },
    });
    expect(stop.kind).toBe("completion_proposal");
    // r1 is the only snapshot read before the live process poll; r2 cannot
    // be coalesced across the process-affined operation.
    expect(trace).toEqual(["r1", "p1", "r2"]);
  });

  test("budget exhaustion is reported, not thrown", async () => {
    const engine = new CodingTurnEngine({
      budget: { maxSteps: 0, hardMaxSteps: 24 },
      newId: () => "x",
      sideEffectClassOf: () => "read",
      compileContext: async () => ({
        rendered: {} as never,
        requestArtifactUri: "",
        requestArtifactHash: "",
        contextManifestId: "",
        providerCapabilityHash: "",
        modelSnapshotHash: "",
        providerEndpoint: "",
        toolSchemaHash: "",
        contextEpochId: "",
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
    expect(stop.kind).toBe("budget_stop");
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

  test("typed policy errors become a policy stop without message matching", async () => {
    const engine = new CodingTurnEngine({
      newId: () => "attempt-policy",
      sideEffectClassOf: () => "workspace_write",
      compileContext: async () => ({
        rendered: {} as never,
        requestArtifactUri: "",
        requestArtifactHash: "",
        contextManifestId: "",
        providerCapabilityHash: "",
        modelSnapshotHash: "",
        providerEndpoint: "",
        toolSchemaHash: "",
        contextEpochId: "",
      }),
      beginAttempt: async () => true,
      executeProvider: async () => ({}) as never,
      settleResponse: async () => ({
        projected: {
          text: "",
          toolCalls: [{ toolCallId: "policy-call", toolName: "patch", arguments: {} }],
          reasoning: null,
          continuationId: null,
          finishReason: "tool_use",
        },
        interrupted: false,
      }),
      settleToolCall: async () => {
        throw new PolicyDeniedError("provider text mentions policy but this is typed");
      },
    });
    const stop = await engine.run();
    expect(stop.kind).toBe("policy_stop");
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

  test("tool calls from a length-stopped response are never executed", async () => {
    const { stop, trace } = await runHarness({
      responses: [
        { calls: [toolCall("t1", "exec")], finishReason: "length" },
        { text: "never reached" },
      ],
    });
    expect(trace.filter((t) => t.startsWith("settle:"))).toEqual([]);
    expect(stop).toEqual({ kind: "truncated_tool_calls", toolCallCount: 1 });
  });

  test("length stop without pending tool calls still settles normally", async () => {
    const { stop } = await runHarness({
      responses: [{ text: "partial answer", finishReason: "length" }],
    });
    expect(stop.kind).toBe("completion_proposal");
  });

  test("steering drained at the stop boundary keeps the turn alive", async () => {
    let drained = 0;
    const steered: string[] = [];
    const { stop, trace } = await runHarness({
      responses: [
        { calls: [toolCall("r1", "read")] },
        { text: "done" },
        { text: "adjusted after steering" },
      ],
      drainSteering: async () => {
        // H11 drains at the top of every iteration AND again at the stop
        // boundary, so for the three responses above the sequence is:
        //   1 top(iter1)  2 top(iter2)  3 stop-boundary("done")
        //   4 top(iter3)  5 stop-boundary("adjusted after steering")
        // Queuing at 3 is what makes this the stop-boundary case.
        drained += 1;
        if (drained === 3) return ["stop editing config, focus on tests"];
        return [];
      },
      onSteeringDrained: async (messages) => { steered.push(...messages); },
    });
    expect(steered).toEqual(["stop editing config, focus on tests"]);
    expect(trace).toContain("begin:3");
    expect(stop).toMatchObject({ kind: "completion_proposal" });
  });

  test("empty steering drain lets the turn stop", async () => {
    const { stop } = await runHarness({
      responses: [{ text: "all done" }],
      drainSteering: async () => [],
    });
    expect(stop.kind).toBe("completion_proposal");
  });
});

describe("H11 steering arrives between tool batches", () => {
  test("guidance queued during a tool batch is applied to the next attempt", async () => {
    const steered: string[] = [];
    const beforeAttempt: string[][] = [];
    let drained = 0;
    const { stop, trace } = await runHarness({
      responses: [
        { calls: [toolCall("r1", "read")] },
        { calls: [toolCall("w1", "write")] },
        { text: "finished with the new instructions" },
      ],
      drainSteering: async () => {
        drained += 1;
        // Queued while the first tool batch was settling: the drain at the
        // top of the SECOND iteration must pick it up. Before H11 this
        // waited until the model happened to emit no tool calls.
        if (drained === 2) return ["use the fixture, not the live database"];
        return [];
      },
      onSteeringDrained: async (messages) => {
        steered.push(...messages);
        beforeAttempt.push([...messages]);
      },
    });

    expect(steered).toEqual(["use the fixture, not the live database"]);
    // The steering was consumed before the second provider attempt began.
    expect(trace.indexOf("begin:2")).toBeGreaterThan(trace.indexOf("settle:read:r1"));
    expect(trace).toContain("settle:write:w1");
    expect(stop.kind).toBe("completion_proposal");
  });

  test("a mid-batch drain does not skip the attempt it was drained for", async () => {
    const order: string[] = [];
    let drained = 0;
    await runHarness({
      responses: [
        { calls: [toolCall("r1", "read")] },
        { text: "done" },
      ],
      drainSteering: async () => {
        drained += 1;
        order.push(`drain:${drained}`);
        return drained === 2 ? ["keep going"] : [];
      },
      onSteeringDrained: async () => { order.push("steered"); },
    });
    // Draining at the top of the loop must not `continue`; the attempt that
    // carries the steering still runs.
    expect(order).toEqual(["drain:1", "drain:2", "steered", "drain:3"]);
  });
});

describe("H11 the loop stops instead of spinning on nothing", () => {
  test("a single empty completion is retried rather than settled", async () => {
    const { stop, trace } = await runHarness({
      responses: [
        { text: "" },
        { text: "the real answer" },
      ],
    });
    expect(trace).toEqual(["begin:1", "response:0calls", "begin:2", "response:0calls"]);
    expect(stop).toMatchObject({ kind: "completion_proposal" });
  });

  test("two consecutive empty completions stop the turn with a reason", async () => {
    expect(EMPTY_COMPLETION_LIMIT).toBe(2);
    const { stop, trace } = await runHarness({
      responses: [{ text: "" }, { text: "   " }, { text: "unreachable" }],
    });
    expect(stop).toEqual({ kind: "no_final_response" });
    expect(trace).toEqual(["begin:1", "response:0calls", "begin:2", "response:0calls"]);
  });

  test("tool calls between empty completions reset the guard", async () => {
    const { stop } = await runHarness({
      responses: [
        { text: "" },
        { calls: [toolCall("r1", "read")] },
        { text: "" },
        { text: "answered at last" },
      ],
    });
    expect(stop).toMatchObject({ kind: "completion_proposal" });
  });

  test("the same long response three times stops the turn", async () => {
    const repeated = "I will now inspect the configuration and apply the fix. ".repeat(6);
    expect(repeated.length).toBeGreaterThanOrEqual(VERBATIM_REPETITION_MIN_CHARS);
    const { stop } = await runHarness({
      responses: [
        // Distinct arguments so the identical-tool-signature doom loop cannot
        // fire first; only the verbatim text repeats.
        { text: repeated, calls: [toolCall("r1", "read", "a.ts")] },
        { text: repeated, calls: [toolCall("r2", "read", "b.ts")] },
        { text: repeated, calls: [toolCall("r3", "read", "c.ts")] },
        { text: "unreachable" },
      ],
    });
    expect(stop.kind).toBe("doom_loop");
    expect(stop.kind === "doom_loop" ? stop.count : 0).toBe(VERBATIM_REPETITION_LIMIT);
    expect(stop.kind === "doom_loop" ? stop.signature.startsWith("verbatim:") : false).toBe(true);
    // The stop record identifies the block without embedding it.
    expect(stop.kind === "doom_loop" ? stop.signature.includes("I will now inspect") : true).toBe(false);
  });

  test("short repeated acknowledgements never trip the repetition guard", async () => {
    const short = "Working on it.";
    expect(short.length).toBeLessThan(VERBATIM_REPETITION_MIN_CHARS);
    const { stop } = await runHarness({
      responses: [
        // Distinct arguments, so only the repetition guard is under test and
        // not the pre-existing identical-tool-signature doom loop.
        { text: short, calls: [toolCall("r1", "read", "a.ts")] },
        { text: short, calls: [toolCall("r2", "read", "b.ts")] },
        { text: short, calls: [toolCall("r3", "read", "c.ts")] },
        { text: "all done" },
      ],
    });
    expect(stop).toMatchObject({ kind: "completion_proposal" });
  });

  test("a changed long response resets the repetition counter", async () => {
    const first = "A".repeat(250);
    const second = "B".repeat(250);
    const { stop } = await runHarness({
      responses: [
        { text: first, calls: [toolCall("r1", "read", "a.ts")] },
        { text: first, calls: [toolCall("r2", "read", "b.ts")] },
        { text: second, calls: [toolCall("r3", "read", "c.ts")] },
        { text: first, calls: [toolCall("r4", "read", "d.ts")] },
        { text: "finished" },
      ],
    });
    expect(stop).toMatchObject({ kind: "completion_proposal" });
  });
});
