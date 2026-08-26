/**
 * @terminus/adapter-sdk — Lifecycle Hooks Contract and Dispatcher (ADR-0050).
 *
 * Implements bounded, ordered lifecycle hooks across tool execution,
 * turn boundaries, permissions, and compaction.
 */
import { z } from "zod";

export const MAX_HOOK_PAYLOAD_BYTES = 128 * 1024; // 128 KB
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export const hookPointSchema = z.enum([
  "tool.execute.before",
  "tool.execute.after",
  "turn.started",
  "turn.completed",
  "permission.ask",
  "session.compacting",
  "provider.attempt",
]);

export type HookPoint = z.infer<typeof hookPointSchema>;

export interface HookContext {
  readonly hookPoint: HookPoint;
  readonly timestamp: string;
  readonly correlationId?: string | undefined;
}

export interface HookResult {
  readonly status: "allow" | "modify" | "abort";
  readonly modifiedPayload?: unknown;
  readonly reason?: string;
}

export interface HookRegistration {
  readonly id: string;
  readonly name: string;
  readonly hookPoint: HookPoint;
  /** Lower number executes first. Default 100. */
  readonly priority?: number;
  readonly handler: (payload: unknown, ctx: HookContext) => Promise<HookResult | void>;
}

export interface HookExecutionReport {
  readonly hookPoint: HookPoint;
  readonly executedCount: number;
  readonly status: "completed" | "aborted" | "error";
  readonly finalPayload: unknown;
  readonly errors: ReadonlyArray<{ hookId: string; error: string }>;
  readonly abortReason?: string;
}

export class HookDispatcher {
  private readonly hooks = new Map<HookPoint, HookRegistration[]>();

  register(registration: HookRegistration): void {
    const list = this.hooks.get(registration.hookPoint) ?? [];
    list.push(registration);
    // Sort stable: priority ascending, then insertion order
    list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.hooks.set(registration.hookPoint, list);
  }

  unregister(hookId: string): boolean {
    let removed = false;
    for (const [point, list] of this.hooks.entries()) {
      const filtered = list.filter((h) => h.id !== hookId);
      if (filtered.length !== list.length) {
        this.hooks.set(point, filtered);
        removed = true;
      }
    }
    return removed;
  }

  async dispatch(
    hookPoint: HookPoint,
    payload: unknown,
    options?: { timeoutMs?: number; correlationId?: string },
  ): Promise<HookExecutionReport> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > MAX_HOOK_PAYLOAD_BYTES) {
      throw new RangeError(
        `Hook payload for ${hookPoint} exceeds MAX_HOOK_PAYLOAD_BYTES (${MAX_HOOK_PAYLOAD_BYTES})`,
      );
    }

    const registered = this.hooks.get(hookPoint) ?? [];
    let currentPayload = payload;
    const errors: Array<{ hookId: string; error: string }> = [];
    const ctx: HookContext = {
      hookPoint,
      timestamp: new Date().toISOString(),
      correlationId: options?.correlationId,
    };

    let executedCount = 0;
    for (const hook of registered) {
      executedCount++;
      try {
        const promise = hook.handler(currentPayload, ctx);
        const result = await Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Hook ${hook.id} timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);

        if (result && typeof result === "object") {
          if (result.status === "abort") {
            return {
              hookPoint,
              executedCount,
              status: "aborted",
              finalPayload: currentPayload,
              errors,
              abortReason: result.reason ?? `Aborted by hook ${hook.id}`,
            };
          }
          if (result.status === "modify" && result.modifiedPayload !== undefined) {
            currentPayload = result.modifiedPayload;
          }
        }
      } catch (err) {
        errors.push({
          hookId: hook.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      hookPoint,
      executedCount,
      status: errors.length > 0 ? "error" : "completed",
      finalPayload: currentPayload,
      errors,
    };
  }
}
