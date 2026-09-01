import type {
  ProviderResponse,
  ProviderToolCallChunk,
  ProjectedResponse,
  RenderedProviderRequest,
} from "@terminus/provider-core";
import { createHash } from "node:crypto";
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
import type { ToolDenialMetadata } from "../agent-tools.js";

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
    // skipcq: JS-0333
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
  /**
   * Whether this exact call can change workspace bytes. This is deliberately
   * separate from the effect side-effect class: `exec` is a process effect,
   * but `rg`, `git status`, and `pwd` are observations. Treating every process
   * as a mutation erases stagnation history and reports fake progress.
   */
  readonly mutatesWorkspaceOf?: (call: ProviderToolCallChunk) => boolean;
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
  /**
   * Drain queued steering messages (mid-turn user guidance). Returns the
   * messages queued since the previous drain, in order, and consumes them
   * (durability and the cursor live behind the callback). When the drain
   * yields at least one message at a would-be stop point, the loop continues
   * so the next compiled context carries the steering input.
   */
  readonly drainSteering?: () => Promise<readonly string[]>;
  /** Invoked after steering messages were drained, before the loop continues. */
  readonly onSteeringDrained?: (messages: readonly string[]) => void | Promise<void>;
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
  /** Structured provenance for a denied operation. */
  readonly denial?: ToolDenialMetadata | undefined;
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
  readonly denied: boolean;
  readonly terminalDenial: ToolDenialMetadata | null;
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
  | { readonly kind: "no_final_response" }
  /**
   * The provider stopped with finishReason "length" while tool calls were
   * still pending. Executing those calls would run arguments the model never
   * finished emitting, so they are discarded — but the turn is *not* over:
   * the composition root nudges the model to continue and re-runs the loop.
   */
  | { readonly kind: "truncated_tool_calls"; readonly toolCallCount: number; readonly text: string; readonly responseArtifactUri: string | null; readonly attemptId: string }
  /**
   * The provider stopped with finishReason "length" and no tool calls: the
   * answer itself is cut off mid-sentence. Settling on it as the final
   * message published a truncated answer as a completed turn.
   */
  | { readonly kind: "length"; readonly text: string; readonly responseArtifactUri: string | null; readonly attemptId: string };

export const DOOM_LOOP_THRESHOLD = 3;

/**
 * How many times one turn nudges a length-truncated response to continue
 * before settling on whatever text arrived. High enough that a long answer or
 * a large patch finishes; low enough that a provider stuck at its output limit
 * cannot spin. The turn's step/token/wall-clock budgets bound it regardless.
 */
export const TRUNCATION_CONTINUATION_LIMIT = 4;

/**
 * H11 progress guards.
 *
 * `EMPTY_COMPLETION_LIMIT`: a response with neither text nor tool calls is
 * not an answer. The first one is retried — providers do drop a completion
 * under load — and the second stops the turn with `no_final_response` rather
 * than settling it as an empty assistant message the user cannot read.
 *
 * `VERBATIM_REPETITION_*`: a model that re-emits the same substantial block
 * of prose while making no tool calls is stuck. Short texts ("Done.", "OK")
 * legitimately repeat, so only blocks of at least
 * `VERBATIM_REPETITION_MIN_CHARS` count, and only after
 * `VERBATIM_REPETITION_LIMIT` identical emissions.
 */
export const EMPTY_COMPLETION_LIMIT = 2;
export const VERBATIM_REPETITION_MIN_CHARS = 200;
export const VERBATIM_REPETITION_LIMIT = 3;

export class CodingTurnEngine {
  private readonly dependencies: EngineDependencies;
  readonly budget: TurnBudget;
  private lastToolSignature: string | null = null;
  private consecutiveIdenticalCalls = 0;
  private consecutiveEmptyCompletions = 0;
  private lastVerbatimText: string | null = null;
  private verbatimRepeats = 0;

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
      // H11: steering is drained at the top of every iteration, not only at a
      // would-be stop. Guidance sent while a tool batch was running used to
      // wait until the model happened to stop calling tools, which on a long
      // batch chain meant it was never applied to the turn it was meant for.
      // The messages become durable steering episodes that the context
      // compiled below carries to the provider.
      const pendingSteering = await this.drainSteering();
      if (pendingSteering.length > 0) {
        await this.dependencies.onSteeringDrained?.(pendingSteering);
        if (this.dependencies.signal?.aborted) return { kind: "interrupted" };
      }
      const decision = this.budget.canStartStep();
      if (!decision.allowed) {
        return {
          kind: "budget_stop",
          reason: decision.reason ?? "steps_exhausted",
          ledger: this.budget.ledger,
        };
      }
      // Stagnation is known only after the last tool result settles. Give the
      // provider one bounded, response-only opportunity to consume that
      // observation and finish. Stopping before compilation stranded useful
      // workspace changes whenever the last few probes failed in the same
      // way. A stagnant turn still cannot execute another tool call below.
      const stagnantAtStart = this.budget.isStagnant();
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

      // H11: verbatim-repetition guard. A model repeating the same
      // substantial block of prose is not making progress; without this the
      // turn burned its whole step budget re-emitting the same paragraph.
      const repetitionStop = this.recordVerbatimText(settled.projected.text);
      if (repetitionStop !== null) return repetitionStop;

      const toolCalls = settled.projected.toolCalls;
      // Length-stop guard: a response truncated by the output limit must not
      // execute tool calls whose arguments were never fully emitted (pi's
      // fail-don't-execute rule, adapted to the durable settlement boundary).
      if (
        settled.projected.finishReason === "length"
        && toolCalls.length > 0
      ) {
        return {
          kind: "truncated_tool_calls",
          toolCallCount: toolCalls.length,
          text: settled.projected.text,
          responseArtifactUri: settled.responseArtifactUri ?? null,
          attemptId,
        };
      }
      if (toolCalls.length === 0) {
        // Steering check at the stop boundary: guidance queued while the
        // final response was in flight keeps the turn alive. The drained
        // messages are durable steering episodes; the next compiled context
        // carries them to the provider.
        const steering = await this.drainSteering();
        if (steering.length > 0) {
          await this.dependencies.onSteeringDrained?.(steering);
          if (this.dependencies.signal?.aborted) return { kind: "interrupted" };
          continue;
        }
        // H11: empty-response guard. A completion with no text and no tool
        // calls says nothing; settling on it produced a "completed" turn with
        // a blank answer. Retry once, then stop with an explicit reason.
        if (
          settled.projected.text.trim().length === 0
          && settled.completion?.kind !== "completion_proposal"
        ) {
          this.consecutiveEmptyCompletions += 1;
          if (this.consecutiveEmptyCompletions >= EMPTY_COMPLETION_LIMIT) {
            return { kind: "no_final_response" };
          }
          continue;
        }
        this.consecutiveEmptyCompletions = 0;
        const responseArtifactUri = settled.responseArtifactUri ?? null;
        // A length-stopped message is not a finished answer. Reporting it as
        // one published half a sentence as the turn's result; the caller
        // nudges the model to continue instead.
        if (settled.projected.finishReason === "length") {
          return {
            kind: "length",
            text: settled.projected.text,
            responseArtifactUri,
            attemptId,
          };
        }
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
        // A response without an explicit completion signal is still an
        // assistant message. Completion is admitted by the verifier later.
        return {
          kind: "assistant_message",
          text: settled.projected.text,
          responseArtifactUri,
          attemptId,
        };
      }

      // The finalization opportunity is response-only. A model that asks for
      // another effect after repeated non-progress stops before that effect is
      // settled, preserving the existing fail-closed stagnation boundary.
      if (stagnantAtStart) {
        return {
          kind: "budget_stop",
          reason: "stagnation_detected",
          ledger: this.budget.ledger,
        };
      }

      // Tool calls are progress: the empty-response counter resets.
      this.consecutiveEmptyCompletions = 0;

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
      let policyDenied = false;
      let terminalPolicyDenial: ToolDenialMetadata | null = null;
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
            if (outcome.failed || outcome.denied) break;
          }
        }
        let deferredFailure: unknown = null;
        for (const outcome of outcomes) {
          await this.observeOperation(outcome.observation);
          if (outcome.denied) policyDenied = true;
          if (outcome.terminalDenial !== null) terminalPolicyDenial = outcome.terminalDenial;
          if (outcome.failed && deferredFailure === null) deferredFailure = outcome.error;
        }
        if (terminalPolicyDenial !== null) {
          // The kernel has already made the authoritative decision. The
          // observation above is durable; do not recompile or make another
          // provider request without a new admission.
          await this.dependencies.onPolicyDenied?.(terminalPolicyDenial.explanation);
          return this.policyStopForDenial(terminalPolicyDenial);
        }
        if (deferredFailure !== null) {
          const stop = await this.stopForToolError(deferredFailure);
          if (stop !== null) return stop;
          throw deferredFailure;
        }
        operationIndex += outcomes.length;
        // A policy denial is already a complete model-visible result. Do not
        // execute the rest of a speculative batch. Recompile once so the
        // provider can report the denial or answer without that tool.
        if (policyDenied) break;
      }
      if (operationIndex !== toolCalls.length && !policyDenied) {
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

  /**
   * Track verbatim repetition of substantial response text (H11).
   *
   * Returns a doom-loop stop once the same block has been emitted
   * `VERBATIM_REPETITION_LIMIT` times. Anything shorter than
   * `VERBATIM_REPETITION_MIN_CHARS` resets the counter, so brief
   * acknowledgements between tool batches never trip it.
   */
  private recordVerbatimText(text: string): EngineStop | null {
    const normalized = text.trim();
    if (normalized.length < VERBATIM_REPETITION_MIN_CHARS) {
      this.lastVerbatimText = null;
      this.verbatimRepeats = 0;
      return null;
    }
    if (normalized === this.lastVerbatimText) {
      this.verbatimRepeats += 1;
    } else {
      this.lastVerbatimText = normalized;
      this.verbatimRepeats = 1;
    }
    if (this.verbatimRepeats < VERBATIM_REPETITION_LIMIT) return null;
    // The signature identifies the repeated block without copying it into
    // the durable stop record.
    const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
    return {
      kind: "doom_loop",
      signature: `verbatim:${normalized.length}:${digest}`,
      count: this.verbatimRepeats,
    };
  }

  private async drainSteering(): Promise<readonly string[]> {
    if (this.dependencies.drainSteering === undefined) return [];
    return this.dependencies.drainSteering();
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

  private policyStopForDenial(denial: ToolDenialMetadata): EngineStop {
    return {
      kind: "policy_stop",
      error: {
        code: "KERNEL_POLICY_DENIED",
        category: "policy_denied",
        message: denial.explanation,
        retryable: false,
        suggestedAction: "request a policy exception or change the operation",
        details: {
          origin: denial.origin,
          disposition: denial.disposition,
          decision: denial.decision,
          decision_id: denial.decisionId,
          explanation: denial.explanation,
        },
      },
    };
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
        denied: settlementRecord?.status === "denied" || settlementRecord?.errorClass === "policy_denied",
        terminalDenial: settlementRecord?.status === "denied" && settlementRecord.denial?.disposition === "terminal"
          ? settlementRecord.denial
          : null,
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
        denied: classified.kind === "policy_denied",
        terminalDenial: null,
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
    if (this.dependencies.mutatesWorkspaceOf !== undefined) {
      return this.dependencies.mutatesWorkspaceOf(call);
    }
    const metadata = this.dependencies.effectMetadataOf?.(call);
    return (metadata?.sideEffectClass ?? this.dependencies.sideEffectClassOf(call.toolName)) !== "read";
  }
}
