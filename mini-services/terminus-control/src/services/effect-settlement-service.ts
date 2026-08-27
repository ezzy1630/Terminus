import type { ToolResultStatus } from "@terminus/aci";
import type { MutationRunner, ServiceEventAppender } from "./service-types.js";

export type EffectToolState = "SETTLED" | "DENIED" | "FAILED";

export interface EffectAuthorizationInput {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly sideEffectId: string;
  readonly policyDecisionId: string;
  readonly effectType: string;
  readonly argumentsArtifactUri: string;
  readonly resourceUri: string;
  readonly reversibility: string;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
}

export interface EffectSettlementInput {
  readonly taskId: string;
  readonly turnId: string;
  readonly providerAttemptId: string;
  readonly toolCallId: string;
  readonly sideEffectId: string | null;
  readonly providerCallId: string;
  readonly status: ToolResultStatus;
  readonly resultStatus: ToolResultStatus;
  readonly toolState: EffectToolState;
  readonly summary: string;
  readonly callTranscriptArtifactUri: string;
  readonly resultArtifactUri: string;
  readonly resultTranscriptArtifactUri: string;
  readonly resultTranscriptHash: string;
  readonly errorJson: string | null;
  readonly truncation: unknown;
}

export interface EffectUnknownInput {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly sideEffectId: string;
  readonly error: string;
  readonly idempotencyKey?: string | null;
}

/**
 * The effect reached a terminal state before this recovery attempt acquired
 * the writer transaction. The enclosing event transaction must be rolled
 * back so recovery does not append a false unknown-settlement event.
 */
export class EffectSettlementAlreadyResolvedError extends Error {
  constructor(readonly sideEffectId: string) {
    super(`side effect ${sideEffectId} was already resolved before recovery`);
    this.name = "EffectSettlementAlreadyResolvedError";
  }
}

export interface EffectCancellationInput {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly sideEffectId: string;
  readonly reason: string;
}

export interface EffectSettlementTransaction {
  readonly authorize: (input: EffectAuthorizationInput) => Promise<void>;
  readonly start: (input: EffectAuthorizationInput) => Promise<void>;
  readonly settle: (input: EffectSettlementInput) => Promise<void>;
  readonly markUnknown: (input: EffectUnknownInput) => Promise<void>;
  readonly cancel?: (input: EffectCancellationInput) => Promise<void>;
}

export interface EffectSettlementDependencies<TTransaction> {
  readonly appendEvent: ServiceEventAppender<TTransaction>;
  readonly transaction: (transaction: TTransaction) => EffectSettlementTransaction;
  readonly mutate: MutationRunner;
}

/**
 * Owns the control-plane half of effect settlement. The kernel remains the
 * authority for dispatch and receipt truth.
 *
 * Transaction boundary: each lifecycle transition appends its semantic event
 * with the corresponding tool/effect row update. Kernel dispatch is always
 * outside this transaction, so an uncertain receipt becomes durable UNKNOWN
 * and is never silently retried.
 */
export class EffectSettlementService<TTransaction> {
  constructor(
    private readonly dependencies: EffectSettlementDependencies<TTransaction>,
  ) {}

  async authorize(input: EffectAuthorizationInput): Promise<void> {
    await this.run("tool.authorized", input.taskId, input.toolCallId, {
      policy_decision_id: input.policyDecisionId,
      side_effect_id: input.sideEffectId,
      effect_type: input.effectType,
      constraints: ["task-contract-scope", "kernel-policy", "no-ambient-authority"],
    }, (transaction) => this.dependencies.transaction(transaction).authorize(input), [input.argumentsArtifactUri]);
  }

  async start(input: EffectAuthorizationInput): Promise<void> {
    await this.run("tool.started", input.taskId, input.toolCallId, {
      side_effect_id: input.sideEffectId,
      effect_type: input.effectType,
    }, (transaction) => this.dependencies.transaction(transaction).start(input));
  }

  async markUnknown(input: EffectUnknownInput): Promise<boolean> {
    return this.markUnknownInternal(input, true);
  }

  /** Run recovery while the caller already owns the control mutation lock. */
  async markUnknownUnderMutation(input: EffectUnknownInput): Promise<boolean> {
    return this.markUnknownInternal(input, false);
  }

  private async markUnknownInternal(
    input: EffectUnknownInput,
    acquireMutationLock: boolean,
  ): Promise<boolean> {
    try {
      await this.run("tool.settlement_unknown", input.taskId, input.toolCallId, {
        tool_call_id: input.toolCallId,
        side_effect_id: input.sideEffectId,
        error: input.error,
        reconciliation_required: true,
      }, (transaction) => this.dependencies.transaction(transaction).markUnknown(input), [], input.idempotencyKey, acquireMutationLock);
      return true;
    } catch (error: unknown) {
      if (error instanceof EffectSettlementAlreadyResolvedError) return false;
      throw error;
    }
  }

  async settle(input: EffectSettlementInput): Promise<void> {
    await this.run(
      input.status === "success" || input.status === "partial" ? "tool.settled" : "tool.failed",
      input.taskId,
      input.toolCallId,
      {
        provider_call_id: input.providerCallId,
        status: input.status,
        summary: input.summary,
        truncation: input.truncation,
      },
      (transaction) => this.dependencies.transaction(transaction).settle(input),
      [input.resultArtifactUri, input.resultTranscriptArtifactUri],
    );
  }

  /** Cancel an admitted tool before dispatch when the turn signal wins. */
  async cancel(input: EffectCancellationInput): Promise<void> {
    await this.run(
      "tool.cancelled",
      input.taskId,
      input.toolCallId,
      { side_effect_id: input.sideEffectId, reason: input.reason },
      (transaction) => {
        const mutation = this.dependencies.transaction(transaction).cancel;
        if (mutation === undefined) {
          throw new Error("effect cancellation persistence is not configured");
        }
        return mutation(input);
      },
    );
  }

  private async run(
    eventType: string,
    taskId: string,
    toolCallId: string,
    payload: Readonly<Record<string, unknown>>,
    mutation: (transaction: TTransaction) => Promise<void>,
    artifactRefs: readonly string[] = [],
    idempotencyKey: string | null | undefined = null,
    acquireMutationLock = true,
  ): Promise<void> {
    const operation = async (): Promise<void> => {
      await this.dependencies.appendEvent(
        {
          eventType,
          aggregateType: "tool_call",
          aggregateId: toolCallId,
          correlationId: taskId,
          idempotencyKey,
          payload,
          artifactRefs,
        },
        mutation,
      );
    };
    if (acquireMutationLock) await this.dependencies.mutate(operation);
    else await operation();
  }
}
