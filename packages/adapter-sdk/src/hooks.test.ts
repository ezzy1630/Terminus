import { describe, expect, test } from "bun:test";
import {
  HookDispatcher,
  MAX_HOOK_PAYLOAD_BYTES,
  type HookRegistration,
} from "./hooks.js";

describe("HookDispatcher", () => {
  test("executes hooks in priority order", async () => {
    const dispatcher = new HookDispatcher();
    const order: number[] = [];

    dispatcher.register({
      id: "h2",
      name: "Second Hook",
      hookPoint: "turn.started",
      priority: 20,
      handler: async () => {
        order.push(20);
      },
    });

    dispatcher.register({
      id: "h1",
      name: "First Hook",
      hookPoint: "turn.started",
      priority: 10,
      handler: async () => {
        order.push(10);
      },
    });

    const report = await dispatcher.dispatch("turn.started", { turnId: "turn-1" });
    expect(report.status).toBe("completed");
    expect(order).toEqual([10, 20]);
  });

  test("rejects oversized payloads exceeding 128KB", async () => {
    const dispatcher = new HookDispatcher();
    const bigPayload = { data: "x".repeat(MAX_HOOK_PAYLOAD_BYTES) };

    await expect(
      dispatcher.dispatch("tool.execute.before", bigPayload),
    ).rejects.toThrow(RangeError);
  });

  test("supports modifying payloads in chain", async () => {
    const dispatcher = new HookDispatcher();

    dispatcher.register({
      id: "modifier",
      name: "Modifier",
      hookPoint: "tool.execute.before",
      priority: 10,
      handler: async (payload) => {
        const typed = payload as { command: string };
        return {
          status: "modify",
          modifiedPayload: { command: typed.command + " --quiet" },
        };
      },
    });

    const report = await dispatcher.dispatch("tool.execute.before", { command: "npm test" });
    expect(report.status).toBe("completed");
    expect(report.finalPayload).toEqual({ command: "npm test --quiet" });
  });

  test("supports aborting pipeline execution", async () => {
    const dispatcher = new HookDispatcher();

    dispatcher.register({
      id: "gatekeeper",
      name: "Gatekeeper",
      hookPoint: "permission.ask",
      priority: 10,
      handler: async () => {
        return {
          status: "abort",
          reason: "Unauthorized access blocked by hook",
        };
      },
    });

    const report = await dispatcher.dispatch("permission.ask", { tool: "rm" });
    expect(report.status).toBe("aborted");
    expect(report.abortReason).toContain("Unauthorized access");
  });
});
