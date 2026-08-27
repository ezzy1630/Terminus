import type {
  ProviderResponse,
  ProviderToolCallChunk,
  ProjectedResponse,
  RenderedProviderRequest,
} from "@terminus/provider-core";
import { planToolBatches, TurnBudget, type TurnBudgetOptions } from "./turn-budget.js";

/**
 * CodingTurnEngine (deep-audit Rank 1 / PR1 skeleton extraction).
 *
 * Owns the mechanics of the coding loop — compile → provider attempt →
 * batched tool settlement → repeat until a final response or a budget stop —
 * while delegating durable effects to injected callbacks that cross the
 * kernel/artifact boundary. This module stays provider-neutral and free of
 * process-global state so it can be evaluated against alternative loop
 * policies (the audit's minimal-vs-production comparison arms).
 *
 * Batch semantics: read-only calls of one response execute concurrently and
 * results are restored to deterministic provider order; writes serialize in
 * provider order behind prior reads; a cancelled turn stops before starting
 * new batches.
 */

export interface EngineCompiledAttempt {
  readonly rendered: RenderedProviderRequest;
  /** Marker artifact persisted by the context store. */
  readonly requestArtifactUri: string;
  /** Durable context manifest id backing this attempt. */
  readonly contextManifestId: string;
  /** Provider capability snapshot hash recorded with the attempt. */
  readonly providerCapabilityHash: string;
  /** Hash of the exact canonical request artifact. */
  readonly requestArtifactHash: string;
  /** Hash of the selected provider/model capability snapshot. */
  readonly modelSnapshotHash: string;
  /** Exact provider endpoint or kernel transport identity. */
  readonly providerEndpoint: string;
  /** Hash of the canonical tool schemas supplied to the renderer. */
  readonly toolSchemaHash: string;
  /** Immutable context epoch that produced the request. */
  readonly contextEpochId: string;
}

export interface EngineDependencies {
  /** Compile provider context for the current attempt number. */
  readonly compileContext: (
    attemptNumber: number,
  ) => Promise<EngineCompiledAttempt>;
  /** Begin a durable provider attempt; return false when the turn was interrupted. */
  readonly beginAttempt: (input: {
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly compiled: EngineCompiledAttempt;
  }) => Promise<boolean>;
  /** Execute the rendered request through the configured provider transport. */
  readonly executeProvider: (input: {
    readonly attemptId: string;
    readonly compiled: EngineCompiledAttempt;
  }) => Promise<ProviderResponse>;
  /** Project + durably settle the response; returns projection and tool calls. */
  readonly settleResponse: (input: {
    readonly attemptId: string;
    readonly response: ProviderResponse;
  }) => Promise<{
    readonly projected: ProjectedResponse;
    /** Whether the turn was interrupted mid-flight. */
    readonly interrupted: boolean;
  }>;
  /**
   * Settle ONE tool call durably (policy → dispatch → effect settlement).
   * Throws ToolPolicyDeniedError/ToolCycleBudgetExhaustedError subclasses on
   * refusal/exhaustion.
   */
  readonly settleToolCall: (input: {
    readonly call: ProviderToolCallChunk;
    readonly attemptNumber: number;
    readonly attemptId: string;
  }) => Promise<void>;
  /** Move the durable turn back to context compilation after all calls settle. */
  readonly afterToolsSettled?: () => Promise<void>;
  /** Classify a tool name's side-effect class ("read" = parallel-safe). */
  readonly sideEffectClassOf: (toolName: string) => string;
  /** Generate an opaque unique id for attempts. */
  readonly newId: () => string;
  readonly budget?: TurnBudgetOptions;
  /** Durable turn cancellation is represented by the caller's signal. */
  readonly signal?: AbortSignal | null;
  /** Invoked when a tool call was refused by policy; aborts the loop. */
  readonly onPolicyDenied?: (message: string) => void | Promise<void>;
}

export type EngineStop =
  | { readonly kind: "final"; readonly text: string; readonly responseArtifactUri: string | null }
  | { readonly kind: "interrupted" }
  | { readonly kind: "budget_exhausted"; readonly reason: string }
  | { readonly kind: "policy_denied"; readonly message: string }
  | { readonly kind: "doom_loop"; readonly signature: string; readonly count: number }
  | { readonly kind: "no_final_response" };

export const DOOM_LOOP_THRESHOLD = 3;

export class CodingTurnEngine {
  private readonly dependencies: EngineDependencies;
  readonly budget: TurnBudget;
  private lastToolSignature: string | null = null;
  private consecutiveIdenticalCalls = 0;

  constructor(dependencies: EngineDependencies) {
    this.dependencies = dependencies;
    this.budget = new TurnBudget(dependencies.budget ?? {});
  }

  /** Run the bounded loop. Never throws budget/policy conditions — reports them. */
  async run(): Promise<EngineStop> {
    for (;;) {
      if (this.dependencies.signal?.aborted) {
        return { kind: "interrupted" };
      }
      const decision = this.budget.canStartStep();
      if (!decision.allowed) {
        this.budget.recordStep();
        return { kind: "budget_exhausted", reason: decision.reason ?? "steps_exhausted" };
      }
      if (this.budget.isStagnant()) {
        return { kind: "budget_exhausted", reason: "stagnation_detected" };
      }
      const attemptNumber = this.budget.steps + 1;
      this.budget.recordStep();

      const compiled = await this.dependencies.compileContext(attemptNumber);
      if (this.dependencies.signal?.aborted) {
        return { kind: "interrupted" };
      }
      const attemptId = this.dependencies.newId();
      const started = await this.dependencies.beginAttempt({
        attemptId,
        attemptNumber,
        compiled,
      });
      if (!started) return { kind: "interrupted" };

      const response = await this.dependencies.executeProvider({
        attemptId,
        compiled,
      });
      if (this.dependencies.signal?.aborted) {
        return { kind: "interrupted" };
      }
      const settled = await this.dependencies.settleResponse({
        attemptId,
        response,
      });
      if (settled.interrupted) return { kind: "interrupted" };

      const toolCalls = settled.projected.toolCalls;
      if (toolCalls.length === 0) {
        return {
          kind: "final",
          text: settled.projected.text,
          // The caller already persisted the response artifact during
          // settlement; engine surfaces null because it never touches
          // artifacts directly.
          responseArtifactUri: null,
        };
      }

      // Doom-loop detection: repeated identical tool signatures across attempts
      const toolSignature = toolCalls
        .map((c) => `${c.toolName}:${JSON.stringify(c.arguments)}`)
        .sort()
        .join(";");

      if (toolSignature === this.lastToolSignature) {
        this.consecutiveIdenticalCalls += 1;
        if (this.consecutiveIdenticalCalls >= DOOM_LOOP_THRESHOLD) {
          return {
            kind: "doom_loop",
            signature: toolSignature,
            count: this.consecutiveIdenticalCalls,
          };
        }
      } else {
        this.lastToolSignature = toolSignature;
        this.consecutiveIdenticalCalls = 1;
      }

      const isReadOnly = (call: ProviderToolCallChunk): boolean =>
        this.dependencies.sideEffectClassOf(call.toolName) === "read";
      const batches = planToolBatches(toolCalls, isReadOnly);
      let operationIndex = 0;
      for (const batch of batches) {
        if (this.dependencies.signal?.aborted) {
          return { kind: "interrupted" };
        }
        const allReadOnly = batch.every(isReadOnly);
        try {
          if (allReadOnly && batch.length > 1) {
            // Concurrent reads, deterministic result order.
            await Promise.all(
              batch.map((call) =>
                this.dependencies.settleToolCall({
                  call,
                  attemptNumber,
                  attemptId,
                }),
              ),
            );
          } else {
            for (const call of batch) {
              await this.dependencies.settleToolCall({
                call,
                attemptNumber,
                attemptId,
              });
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (/\b(policy|denied)\b/i.test(message)) {
            await this.dependencies.onPolicyDenied?.(message);
          }
          throw error;
        }
        operationIndex += batch.length;
      }
      if (operationIndex !== toolCalls.length) {
        return {
          kind: "policy_denied",
          message: "tool batch planning lost calls",
        };
      }
      if (this.dependencies.signal?.aborted) {
        return { kind: "interrupted" };
      }
      if (this.dependencies.afterToolsSettled !== undefined) {
        await this.dependencies.afterToolsSettled();
      }
    }
  }
}
