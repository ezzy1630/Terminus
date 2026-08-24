/**
 * Boundary-C stdio JSON-RPC adapter transport.
 */
import type {
  Rfc3339Timestamp,
  ContentHash,
} from "@terminus/domain";
import { ValidationError, PermissionError } from "@terminus/domain";
import type {
  AdapterCapabilityProfile,
  AdapterContract,
  AdapterEvent,
  AdapterResult,
  ExternalAdapter,
} from "./types.js";
import { validateAdapterResult } from "./validate.js";

export interface AdapterProcessPort {
  spawn(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<AdapterChildSession>;
}

export interface AdapterChildSession {
  writeLine(line: string): Promise<void>;
  readLine(deadlineMs: number): Promise<string | null>;
  kill(): Promise<void>;
}

export class StdioJsonRpcAdapter implements ExternalAdapter {
  readonly enabled = true;
  private session: AdapterChildSession | null = null;
  private events: AdapterEvent[] = [];
  private result: AdapterResult | null = null;
  private cancelled = false;

  constructor(
    readonly adapterId: string,
    readonly version: string,
    readonly capabilityProfile: AdapterCapabilityProfile,
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly port: AdapterProcessPort,
    private readonly clock: () => Rfc3339Timestamp,
  ) {}

  async launch(contract: AdapterContract, signal: AbortSignal | null): Promise<void> {
    if (!this.enabled) {
      throw new PermissionError("adapter disabled", { adapterId: this.adapterId });
    }
    this.session = await this.port.spawn(this.command, this.args, {
      TERMINUS_NO_AMBIENT: "1",
      TERMINUS_ADAPTER_ID: this.adapterId,
      TERMINUS_WORKTREE_ID: contract.worktreeId,
    });
    await this.rpc("initialize", {});
    // The abort listener must not outlive launch(): a later abort of a shared
    // signal would otherwise mutate completed adapter state (kill a dead
    // session, append a spurious cancelled event).
    const onAbort = (): void => {
      void this.cancel("abort_signal");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.runContract(contract);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  private async runContract(contract: AdapterContract): Promise<void> {
    const runResult = await this.rpc("run", { contract });
    const validated = validateAdapterResult(runResult, true);
    if (!validated.ok) {
      const retry = await this.rpc("run", { contract, correction: validated.reason });
      const second = validateAdapterResult(retry, false);
      if (!second.ok) {
        this.result = {
          status: "failed",
          summary: `schema failure after correction: ${second.reason}`,
          changedFiles: [],
          commit: null,
          tests: [],
          findings: [],
          risks: [],
          unresolved: [second.reason],
          artifacts: [],
          actualBudget: {},
        };
        return;
      }
      this.result = second.result;
      return;
    }
    this.result = validated.result;
  }

  async *streamEvents(_signal: AbortSignal | null): AsyncIterable<AdapterEvent> {
    for (const e of this.events) yield e;
  }

  async cancel(reason: string): Promise<void> {
    this.cancelled = true;
    if (this.session) {
      await this.rpc("cancel", { reason }).catch(() => undefined);
      await this.session.kill();
    }
    this.events.push({ kind: "cancelled", timestamp: this.clock() });
  }

  async collectResult(): Promise<AdapterResult> {
    if (this.cancelled) {
      return {
        status: "failed",
        summary: "cancelled",
        changedFiles: [],
        commit: null,
        tests: [],
        findings: [],
        risks: [],
        unresolved: ["cancelled"],
        artifacts: [],
        actualBudget: {},
      };
    }
    if (!this.result) {
      throw new ValidationError("adapter result not available — launch first");
    }
    return this.result;
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.session) throw new ValidationError("adapter session not started");
    const id = `${method}-${Date.now()}`;
    await this.session.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    for (;;) {
      const line = await this.session.readLine(60_000);
      if (line === null) throw new ValidationError(`adapter closed during ${method}`);
      const msg = JSON.parse(line) as {
        id?: unknown;
        method?: string;
        params?: AdapterEvent;
        result?: unknown;
        error?: { message?: string };
      };
      if (msg.method === "adapter/event" && msg.params) {
        this.events.push(msg.params);
        continue;
      }
      if (msg.id === id) {
        if (msg.error) throw new ValidationError(msg.error.message ?? "adapter rpc error");
        return msg.result;
      }
    }
  }
}

export type { ContentHash };
