import type {
  ProviderResponse,
  ProviderToolCallChunk,
  ProjectedResponse,
  RenderedProviderRequest,
} from "@terminus/provider-core";
import { canonicalJson } from "@terminus/context-ir";
import {
  buildOperationObservation,
  classifyLoopError,
  type LoopErrorEnvelope,
  type OperationObservation,
  type OperationStatus,
} from "./loop-contracts.js";
import {
  planToolExecution,
  TurnBudget,
  type OperationEffectMetadata,
  type TurnBudgetOptions,
} from "./turn-budget.js";

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
    /** Artifact containing the exact provider response, when available. */
    readonly responseArtifactUri?: string | null | undefined;
    /** Provider usage is fed into the durable turn budget when supplied. */
      readonly usage?: {
        readonly inputTokens?: bigint | undefined;
        readonly cachedInputTokens?: bigint | undefined;
        readonly cacheWriteTokens?: bigint | undefined;
        readonly outputTokens?: bigint | undefined;
      readonly reasoningTokens?: bigint | undefined;
      readonly toolSchemaTokens?: bigint | undefined;
      readonly costMicros?: bigint | undefined;
    } | undefined;
    /** Explicitly distinguishes an answer from a completion proposal. */
    readonly completion?: CompletionSignal | undefined;
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
  }) => Promise<EngineToolSettlement | void>;
  /** Move the durable turn back to context compilation after all calls settle. */
  readonly afterToolsSettled?: () => Promise<void>;
  /** Classify a tool name's side-effect class ("read" = parallel-safe). */
  readonly sideEffectClassOf: (toolName: string) => string;
  /**
   * Return the complete effect contract for one call. When supplied, this
   * governs batching and observation mutation classification; the legacy
   * sideEffectClassOf callback remains required for compatibility.
   */
  readonly effectMetadataOf?: (
    call: ProviderToolCallChunk,
  ) => OperationEffectMetadata;
  /** Generate an opaque unique id for attempts. */
  readonly newId: () => string;
  readonly budget?: TurnBudgetOptions;
  /** Durable turn cancellation is represented by the caller's signal. */
  readonly signal?: AbortSignal | null;
  /** Invoked when a tool call was refused by policy; aborts the loop. */
  readonly onPolicyDenied?: (message: string) => void | Promise<void>;
  /** Optional task identity used in operation observations. */
  readonly taskId?: string | null | undefined;
  readonly contractVersion?: number | null | undefined;
  /** Supplies current repair hypothesis/objective state without provider coupling. */
  readonly operationContext?: (input: {
    readonly call: ProviderToolCallChunk;
    readonly attemptId: string;
    readonly attemptNumber: number;
  }) => {
    readonly toolVersion?: string | null | undefined;
    readonly workspaceRevisionBefore?: string | null | undefined;
    readonly workspaceRevisionAfter?: string | null | undefined;
    readonly verificationDelta?: string | null | undefined;
    readonly hypothesisId?: string | null | undefined;
    readonly criterionIds?: readonly string[] | undefined;
    readonly objectiveStep?: string | null | undefined;
  };
  /** Receives the exact observation after it is added to the budget ledger. */
  readonly onOperationObserved?: (observation: OperationObservation) => void | Promise<void>;
}

export interface EngineToolSettlement {
  readonly status?: OperationStatus | undefined;
  readonly resultHash?: string | null | undefined;
  readonly errorCode?: string | null | undefined;
  readonly errorClass?: string | null | undefined;
  readonly workspaceRevisionBefore?: string | null | undefined;
  readonly workspaceRevisionAfter?: string | null | undefined;
  readonly verificationDelta?: string | null | undefined;
  readonly hypothesisId?: string | null | undefined;
  readonly criterionIds?: readonly string[] | undefined;
  readonly objectiveStep?: string | null | undefined;
}

export interface CompletionClaim {
  readonly criterionId: string;
  readonly evidenceRefs: readonly string[];
  readonly changedArtifactRefs: readonly string[];
}

export type CompletionSignal =
  | { readonly kind: "assistant_message" }
  | { readonly kind: "completion_proposal"; readonly claims: readonly CompletionClaim[] };

interface ToolSettlementObservation {
  readonly observation: OperationObservation;
  readonly failed: boolean;
  readonly error: unknown;
}

export interface CompletionProposal {
  readonly status: "PROPOSED";
  readonly attemptId: string;
  readonly text: string;
  readonly responseArtifactUri: string | null;
  readonly claims: readonly CompletionClaim[];
}

export type EngineStop =
  | { readonly kind: "assistant_message"; readonly text: string; readonly responseArtifactUri: string | null; readonly attemptId: string }
  | { readonly kind: "completion_proposal"; readonly proposal: CompletionProposal }
  | { readonly kind: "interrupted" }
  | { readonly kind: "budget_stop"; readonly reason: string; readonly ledger: TurnBudget["ledger"] }
  | { readonly kind: "policy_stop"; readonly error: LoopErrorEnvelope }
  | { readonly kind: "blocked"; readonly reason: string; readonly error: LoopErrorEnvelope | null }
  | { readonly kind: "needs_user_input"; readonly question: string; readonly error: LoopErrorEnvelope | null }
  | { readonly kind: "failed_verification"; readonly failures: readonly string[] }
  /** Compatibility variants for the current composition root. */
  | { readonly kind: "final"; readonly text: string; readonly responseArtifactUri: string | null }
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

  /** Run the bounded loop. Never throws typed budget/policy/provider conditions. */
  async run(): Promise<EngineStop> {
    try {
      return await this.runLoop();
    } catch (error: unknown) {
      return this.stopForError(error);
    }
  }

  private async runLoop(): Promise<EngineStop> {
    for (;;) {
      if (this.dependencies.signal?.aborted) {
        return { kind: "interrupted" };
      }
      const decision = this.budget.canStartStep();
      if (!decision.allowed) {
        this.budget.recordStep();
        return {
          kind: "budget_stop",
          reason: decision.reason ?? "steps_exhausted",
          ledger: this.budget.ledger,
        };
      }
      if (this.budget.isStagnant()) {
        return {
          kind: "budget_stop",
          reason: "stagnation_detected",
          ledger: this.budget.ledger,
        };
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
      if (settled.usage !== undefined) {
        this.budget.recordUsage(settled.usage);
        if (settled.usage.inputTokens !== undefined) {
          this.budget.recordContextUsage(settled.usage.inputTokens);
        }
      }

      const toolCalls = settled.projected.toolCalls;
      if (toolCalls.length === 0) {
        const responseArtifactUri = settled.responseArtifactUri ?? null;
        if (settled.completion?.kind === "completion_proposal") {
          return {
            kind: "completion_proposal",
            proposal: {
              status: "PROPOSED",
              attemptId,
              text: settled.projected.text,
              responseArtifactUri,
              claims: settled.completion.claims,
            },
          };
        }
        if (settled.projected.text.trim().length === 0 || settled.completion?.kind === "assistant_message") {
          return {
            kind: "assistant_message",
            text: settled.projected.text,
            responseArtifactUri,
            attemptId,
          };
        }
        // A response without an explicit completion signal is still an
        // assistant message. Completion is admitted by the verifier later.
        return {
          kind: "assistant_message",
          text: settled.projected.text,
          responseArtifactUri,
          attemptId,
        };
      }

      // Doom-loop detection: repeated identical tool signatures across attempts
      const toolSignature = toolCalls
        .map((c) => `${c.toolName}:${canonicalJson(c.arguments)}`)
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

      const effectMetadataOf = (call: ProviderToolCallChunk): OperationEffectMetadata =>
        this.dependencies.effectMetadataOf?.(call) ?? {
          sideEffectClass: this.dependencies.sideEffectClassOf(call.toolName),
          workspaceSnapshot: this.dependencies.sideEffectClassOf(call.toolName) === "read"
            ? "legacy-read"
            : null,
          externalNetwork: false,
          processAffinity: null,
          consistency: this.dependencies.sideEffectClassOf(call.toolName) === "read"
            ? "workspace_snapshot"
            : "live",
          rateLimitGroup: null,
          cacheable: this.dependencies.sideEffectClassOf(call.toolName) === "read",
          expectedLatencyMs: this.dependencies.sideEffectClassOf(call.toolName) === "read" ? 250 : 30_000,
          expectedOutputBytes: 32 * 1_024,
        };
      const batches = planToolExecution(toolCalls, effectMetadataOf);
      let operationIndex = 0;
      for (const batch of batches) {
        if (this.dependencies.signal?.aborted) {
          return { kind: "interrupted" };
        }
        const outcomes: ToolSettlementObservation[] = [];
        if (batch.parallel && batch.calls.length > 1) {
          // Settle concurrently, but record observations in provider order.
          // This keeps the durable stagnation/recovery sequence deterministic
          // even when one read returns faster than another.
          outcomes.push(...await Promise.all(
            batch.calls.map((call) =>
              this.settleToolCallObservation({
                call,
                attemptNumber,
                attemptId,
              }),
            ),
          ));
        } else {
          for (const call of batch.calls) {
            const outcome = await this.settleToolCallObservation({
              call,
              attemptNumber,
              attemptId,
            });
            outcomes.push(outcome);
            // A serial failure stops subsequent calls in provider order.
            if (outcome.failed) break;
          }
        }
        for (const outcome of outcomes) {
          await this.observeOperation(outcome.observation);
          if (!outcome.failed) continue;
          const stop = await this.stopForToolError(outcome.error);
          if (stop !== null) return stop;
          throw outcome.error;
        }
        operationIndex += batch.calls.length;
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

  private stopForError(error: unknown): EngineStop {
    const classified = classifyLoopError(error);
    if (classified.kind === "policy_denied") {
      return { kind: "policy_stop", error: classified.envelope };
    }
    if (classified.kind === "budget_exhausted") {
      return {
        kind: "budget_stop",
        reason: classified.envelope.code,
        ledger: this.budget.ledger,
      };
    }
    if (classified.kind === "needs_user_input") {
      return {
        kind: "needs_user_input",
        question: classified.envelope.message,
        error: classified.envelope,
      };
    }
    if (classified.kind === "cancelled") return { kind: "interrupted" };
    if (classified.kind === "provider") {
      return {
        kind: "blocked",
        reason: classified.envelope.code,
        error: classified.envelope,
      };
    }
    throw error;
  }

  private async stopForToolError(error: unknown): Promise<EngineStop | null> {
    const classified = classifyLoopError(error);
    if (classified.kind === "policy_denied") {
      await this.dependencies.onPolicyDenied?.(classified.envelope.message);
      return { kind: "policy_stop", error: classified.envelope };
    }
    if (classified.kind === "budget_exhausted") {
      return {
        kind: "budget_stop",
        reason: classified.envelope.code,
        ledger: this.budget.ledger,
      };
    }
    if (classified.kind === "needs_user_input") {
      return {
        kind: "needs_user_input",
        question: classified.envelope.message,
        error: classified.envelope,
      };
    }
    if (classified.kind === "cancelled") return { kind: "interrupted" };
    return null;
  }

  private async settleToolCallObservation(input: {
    readonly call: ProviderToolCallChunk;
    readonly attemptNumber: number;
    readonly attemptId: string;
  }): Promise<ToolSettlementObservation> {
    try {
      const settlement = await this.dependencies.settleToolCall(input);
      const metadata = this.dependencies.operationContext?.(input);
      const settlementRecord = settlement ?? null;
      return {
        failed: false,
        error: undefined,
        observation: buildOperationObservation({
          taskId: this.dependencies.taskId,
          contractVersion: this.dependencies.contractVersion,
          attemptId: input.attemptId,
          attemptNumber: input.attemptNumber,
          providerCallId: input.call.toolCallId,
          toolId: input.call.toolName,
          toolVersion: metadata?.toolVersion ?? null,
          status: settlementRecord?.status ?? "success",
          resultHash: settlementRecord?.resultHash ?? null,
          errorCode: settlementRecord?.errorCode ?? null,
          errorClass: settlementRecord?.errorClass ?? null,
          mutatesWorkspace: this.operationMutatesWorkspace(input.call),
          workspaceRevisionBefore: settlementRecord?.workspaceRevisionBefore ?? metadata?.workspaceRevisionBefore ?? null,
          workspaceRevisionAfter: settlementRecord?.workspaceRevisionAfter ?? metadata?.workspaceRevisionAfter ?? null,
          verificationDelta: settlementRecord?.verificationDelta ?? metadata?.verificationDelta ?? null,
          hypothesisId: settlementRecord?.hypothesisId ?? metadata?.hypothesisId ?? null,
          criterionIds: settlementRecord?.criterionIds ?? metadata?.criterionIds,
          objectiveStep: settlementRecord?.objectiveStep ?? metadata?.objectiveStep ?? null,
          arguments: input.call.arguments,
        }),
      };
    } catch (error: unknown) {
      const classified = classifyLoopError(error);
      const metadata = this.dependencies.operationContext?.(input);
      return {
        failed: true,
        error,
        observation: buildOperationObservation({
          taskId: this.dependencies.taskId,
          contractVersion: this.dependencies.contractVersion,
          attemptId: input.attemptId,
          attemptNumber: input.attemptNumber,
          providerCallId: input.call.toolCallId,
          toolId: input.call.toolName,
          toolVersion: metadata?.toolVersion ?? null,
          status: classified.kind === "policy_denied" ? "denied" : "error",
          errorCode: classified.envelope.code,
          errorClass: classified.envelope.category,
          mutatesWorkspace: this.operationMutatesWorkspace(input.call),
          workspaceRevisionBefore: metadata?.workspaceRevisionBefore ?? null,
          workspaceRevisionAfter: metadata?.workspaceRevisionAfter ?? null,
          verificationDelta: metadata?.verificationDelta ?? null,
          hypothesisId: metadata?.hypothesisId ?? null,
          criterionIds: metadata?.criterionIds,
          objectiveStep: metadata?.objectiveStep ?? null,
          arguments: input.call.arguments,
        }),
      };
    }
  }

  private async observeOperation(observation: OperationObservation): Promise<void> {
    this.budget.recordObservation(observation);
    await this.dependencies.onOperationObserved?.(observation);
  }

  private operationMutatesWorkspace(call: ProviderToolCallChunk): boolean {
    const metadata = this.dependencies.effectMetadataOf?.(call);
    return (metadata?.sideEffectClass ?? this.dependencies.sideEffectClassOf(call.toolName)) !== "read";
  }
}
