import type {
  ProviderResponse,
  ProviderResponseChunk,
  RenderedProviderRequest,
} from "@terminus/provider-core";
import type { GatewayModel } from "@terminus/provider-zen";
import type { LocalProviderCommand } from "../provider-command.js";
import type { RequestContext } from "../../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { MutationRunner, ServiceEventAppender } from "./service-types.js";

export class ProviderExecutionUnavailableError extends Error {
  constructor(providerId: string) {
    super(`no kernel-brokered provider transport is configured for '${providerId}'; provider execution did not occur`);
    this.name = "ProviderExecutionUnavailableError";
  }
}

export interface ProviderGatewayConfig {
  readonly model: GatewayModel;
  readonly secretUri: string;
  /**
   * Connector/host/paths for a connected provider account. Absent means the
   * OpenCode Zen/Go gateway, whose endpoint is fixed.
   */
  readonly endpoint?: {
    readonly connectorId: string;
    readonly anonymousConnectorId?: string | undefined;
    readonly host: string;
    readonly port?: number | undefined;
    readonly allowedPaths?: readonly string[] | undefined;
    readonly allowedPathPrefixes?: readonly string[] | undefined;
    readonly label?: string | undefined;
  } | undefined;
  /**
   * Non-credential headers the account's connector admits (the ChatGPT
   * account id, originator, session id). The bearer is injected in the kernel.
   */
  readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
  /** Per-turn continuity returned by the ChatGPT Codex endpoint. */
  readonly codexTurnState?: import("@terminus/provider-openai").CodexTurnState | undefined;
  /** Connected account receiving provider quota receipts. */
  readonly accountId?: string | undefined;
}

/** Vendor-direct dispatch target resolved by the caller (ADR-0039 §10). */
export interface ProviderDirectConfig {
  readonly vendor: "anthropic" | "openai";
}

export interface ProviderExecutionInput {
  readonly rendered: RenderedProviderRequest;
  readonly command: LocalProviderCommand | null;
  readonly gateway: ProviderGatewayConfig | null;
  readonly direct?: ProviderDirectConfig | null;
  /** Per-turn kernel-brokered executor for the direct transport. Bound by the
   * caller so it can capture turn-scoped state (context epoch, workspace);
   * required whenever `direct` is set.
   */
  readonly executeDirectRequest?: (input: ProviderExecutionInput) => Promise<ProviderResponse>;
  /**
   * Observe provider stream chunks as they arrive (client streaming).
   * Invoked inline with the stream; errors propagate to the caller.
   */
  readonly onChunk?: (chunk: ProviderResponseChunk) => void | Promise<void>;
  readonly context: RequestContext;
  readonly workspaceId: string;
  /** Caller-owned cancellation signal for the current turn/request. */
  readonly signal?: AbortSignal | null;
}

export interface ProviderAttemptStartInput {
  readonly attemptId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly providerId: string;
  readonly modelKey: string;
  readonly capabilitySnapshotHash: string;
  readonly contextManifestId: string;
  readonly requestArtifact: string;
  readonly requestFingerprint: string;
  readonly providerIdempotencyKey: string;
}

export interface ProviderAttemptResponseInput {
  readonly attemptId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly responseArtifact: string;
  readonly messageArtifact: string | null;
  readonly messageHash: string | null;
  readonly usage: unknown;
  readonly finishReason: string | null;
  readonly continuationId: string | null;
  readonly providerRequestId: string | null;
  readonly cost: ProviderAttemptCostObservation;
  /**
   * Provider-opaque reasoning chain, keyed by the call each item must be
   * replayed before. Persisted so a renderer rebuilt after a restart can
   * still lead every replayed `tool_use`/`function_call` with the reasoning
   * that produced it; both vendors reject the alternative.
   */
  readonly reasoningReplayJson?: string | null | undefined;
}

export type ProviderAttemptCostSource =
  | "provider_reported"
  | "admitted_economics"
  | "free_model_contract"
  | "unavailable";

export interface ProviderAttemptCostObservation {
  /** Exact provider-reported amount, when the adapter exposes one. */
  readonly providerReportedCostMicros: bigint | null;
  /** Exact amount computed from the admitted capability snapshot. */
  readonly computedCostMicros: bigint | null;
  /** Why the values are or are not available. */
  readonly source: ProviderAttemptCostSource;
}

export interface ProviderSessionTransaction {
  readonly startAttempt: (input: ProviderAttemptStartInput) => Promise<void>;
  readonly completeAttempt: (input: ProviderAttemptResponseInput) => Promise<void>;
  /** Read one attempt's current status for the recovery CAS. */
  readonly findAttemptStatus?: (attemptId: string) => Promise<string | null>;
  /** Mark one attempt `interrupted`; returns rows updated. */
  readonly interruptAttempt?: (input: {
    readonly attemptId: string;
    readonly inFlightStates: readonly string[];
    readonly interruptedAt: Date;
    readonly errorJson: string;
  }) => Promise<number>;
  /** Read the owning turn's state and task for recovery decisions. */
  readonly readTurnForRecovery?: (turnId: string) => Promise<{ readonly state: string; readonly taskId: string | null } | null>;
  /** Settle the owning turn as INTERRUPTED while it is still active. */
  readonly interruptTurnForRecovery?: (input: {
    readonly turnId: string;
    readonly expectedState: string;
    readonly interruptedAt: Date;
    readonly errorJson: string;
  }) => Promise<number>;
  /**
   * Block the owning task: a live attempt may have taken effect upstream.
   * Only the given statuses may be written (the original scope: ACTIVE and
   * VERIFYING); a terminal task is left alone.
   */
  readonly blockTaskForRecovery?: (input: {
    readonly taskId: string;
    readonly phase: string;
    readonly expectedStatuses: readonly string[];
    readonly reasonJson: string;
  }) => Promise<void>;
  /** List attempts still in flight on the durable attempt rows. */
  readonly listInFlightAttempts?: () => Promise<readonly {
    readonly id: string;
    readonly turnId: string;
    readonly status: string;
    readonly providerIdempotencyKey: string | null;
    readonly requestFingerprint: string | null;
    readonly requestArtifact: string;
    readonly responseArtifact: string | null;
    readonly turn: { readonly state: string; readonly taskId: string | null };
  }[]>;
}

/** Provider attempt statuses that may still be executing upstream. */
export const IN_FLIGHT_PROVIDER_STATES = ["running", "submitted", "streaming", "starting"] as const;

export class ProviderAttemptAlreadyResolvedError extends Error {
  constructor(readonly attemptId: string) {
    super(`provider attempt ${attemptId} was already resolved before recovery`);
    this.name = "ProviderAttemptAlreadyResolvedError";
  }
}

export interface ProviderAttemptRecoveryRecord {
  readonly id: string;
  readonly turnId: string;
  readonly taskId: string | null;
  readonly previousStatus: string;
  readonly providerIdempotencyKey: string | null;
  readonly requestFingerprint: string | null;
}

export interface ProviderAttemptRecoveryResult {
  readonly scanned: number;
  readonly interrupted: readonly ProviderAttemptRecoveryRecord[];
  readonly alreadyResolved: readonly string[];
  readonly failed: readonly { readonly id: string; readonly error: string }[];
}

export interface ProviderSessionDependencies<TTransaction> {
  readonly readTurnState: (turnId: string) => Promise<string | null>;
  readonly appendEvent: ServiceEventAppender<TTransaction>;
  readonly transaction: (transaction: TTransaction) => ProviderSessionTransaction;
  readonly mutate: MutationRunner;
  readonly executeLocal: (input: ProviderExecutionInput) => Promise<ProviderResponse>;
  readonly executeGateway: (input: ProviderExecutionInput) => Promise<ProviderResponse>;
  /** Durable read of attempts still in flight (restart recovery). */
  readonly listInFlightAttempts?: () => Promise<readonly {
    readonly id: string;
    readonly turnId: string;
    readonly status: string;
    readonly providerIdempotencyKey: string | null;
    readonly requestFingerprint: string | null;
    readonly requestArtifact: string;
    readonly responseArtifact: string | null;
    readonly turn: { readonly state: string; readonly taskId: string | null };
  }[]>;
}

/**
 * Owns provider-attempt state and provider selection. Provider-specific
 * request bodies remain in the provider packages and kernel-backed adapters.
 *
 * Transaction boundary: attempt start and response settlement each append the
 * semantic event in the same writer transaction as their durable rows. The
 * network/process call itself is outside that transaction and is recorded as
 * an explicit attempt state.
 */
export class ProviderSessionService<TTransaction> {
  constructor(
    private readonly dependencies: ProviderSessionDependencies<TTransaction>,
  ) {}

  async beginAttempt(input: ProviderAttemptStartInput): Promise<boolean> {
    return this.dependencies.mutate(async () => {
      const state = await this.dependencies.readTurnState(input.turnId);
      if (state !== null && [
        "INTERRUPTED",
        "ABORTED",
        "FAILED",
        "BLOCKED",
        "USER_ACTION_REQUIRED",
        "COMPLETED",
        "BUDGET_EXHAUSTED",
        "POLICY_DENIED",
      ].includes(state)) return false;
      await this.dependencies.appendEvent(
        {
          eventType: "turn.provider_running",
          aggregateType: "turn",
          aggregateId: input.turnId,
          correlationId: input.taskId,
          idempotencyKey: input.providerIdempotencyKey,
          payload: {
            provider_attempt_id: input.attemptId,
            attempt_number: input.attemptNumber,
            provider: input.providerId,
            model: input.modelKey,
            context_manifest_id: input.contextManifestId,
            request_fingerprint: input.requestFingerprint,
            provider_idempotency_key: input.providerIdempotencyKey,
          },
          artifactRefs: [input.requestArtifact],
        },
        async (transaction) => {
          await this.dependencies.transaction(transaction).startAttempt(input);
        },
      );
      return true;
    });
  }

  async execute(input: ProviderExecutionInput): Promise<ProviderResponse> {
    if (input.signal?.aborted) {
      throw new Error("provider execution was aborted before dispatch");
    }
    if (
      input.direct !== undefined
      && input.direct !== null
      && input.executeDirectRequest !== undefined
      && input.rendered.providerId === input.direct.vendor
    ) {
      return input.executeDirectRequest(input);
    }
    if (input.gateway !== null && input.rendered.providerId === input.gateway.model.providerId) {
      return this.dependencies.executeGateway(input);
    }
    if (input.command === null || input.rendered.providerId !== "local") {
      throw new ProviderExecutionUnavailableError(input.rendered.providerId);
    }
    return this.dependencies.executeLocal(input);
  }

  async settleResponse(input: ProviderAttemptResponseInput): Promise<void> {
    await this.dependencies.mutate(async () => {
      const state = await this.dependencies.readTurnState(input.turnId);
      if (state === "INTERRUPTED" || state === "ABORTED") return;
      await this.dependencies.appendEvent(
        {
          eventType: "turn.response_validating",
          aggregateType: "turn",
          aggregateId: input.turnId,
          correlationId: input.taskId,
          payload: {
            provider_attempt_id: input.attemptId,
            status: "completed",
            usage: input.usage,
            finish_reason: input.finishReason,
          },
          artifactRefs: [
            input.responseArtifact,
            ...(input.messageArtifact === null ? [] : [input.messageArtifact]),
          ],
        },
        async (transaction) => {
          await this.dependencies.transaction(transaction).completeAttempt(input);
        },
      );
    });
  }

  /**
   * Reconcile provider calls that crossed the kernel boundary without a
   * durable response. They cannot be retried safely: the provider may have
   * accepted the request even when control did not receive a response.
   * Recovery therefore records an interrupted attempt, blocks its task, and
   * leaves a deterministic evidence event for provider-side reconciliation.
   *
   * The recovery event, the attempt CAS, the turn settlement, and the task
   * block are one transaction; a re-delivered recovery pass collides with
   * the attempt CAS and reports the attempt as already resolved.
   */
  // skipcq: JS-R1005
  async reconcileInFlightAttempts(
    activeTurnStates: readonly string[],
    alreadyUnderMutationLock = false,
  ): Promise<ProviderAttemptRecoveryResult> {
    const { appendEvent, listInFlightAttempts } = this.dependencies;
    if (listInFlightAttempts === undefined) {
      throw new Error("provider attempt recovery ports are not configured");
    }
    const attempts = await listInFlightAttempts();
    const inFlightStates: readonly string[] = IN_FLIGHT_PROVIDER_STATES;
    const interrupted: ProviderAttemptRecoveryRecord[] = [];
    const alreadyResolved: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const attempt of attempts) {
      const recover = async (): Promise<void> => {
        const interruptedAt = new Date();
        await appendEvent(
          {
            eventType: "turn.recovery_interrupted",
            aggregateType: "turn",
            aggregateId: attempt.turnId,
            correlationId: attempt.turn.taskId ?? attempt.turnId,
            idempotencyKey: `provider-recovery:${attempt.id}`,
            payload: {
              previous_state: attempt.turn.state,
              state: "INTERRUPTED",
              reason: "provider_attempt_in_flight_on_process_restart",
              reconciliation_required: true,
              provider_attempt_id: attempt.id,
              provider_idempotency_key: attempt.providerIdempotencyKey,
              request_fingerprint: attempt.requestFingerprint,
            },
            artifactRefs: [
              attempt.requestArtifact,
              ...(attempt.responseArtifact === null ? [] : [attempt.responseArtifact]),
            ],
          },
          // skipcq: JS-R1005
          async (transaction) => {
            const recovery = this.dependencies.transaction(transaction);
            const {
              findAttemptStatus,
              interruptAttempt,
              readTurnForRecovery,
              interruptTurnForRecovery,
              blockTaskForRecovery,
            } = recovery;
            if (
              findAttemptStatus === undefined
              || interruptAttempt === undefined
              || readTurnForRecovery === undefined
              || interruptTurnForRecovery === undefined
              || blockTaskForRecovery === undefined
            ) {
              throw new Error("provider attempt recovery transaction ports are not configured");
            }
            const current = await findAttemptStatus(attempt.id);
            if (current === null || !inFlightStates.includes(current.toLowerCase())) {
              throw new ProviderAttemptAlreadyResolvedError(attempt.id);
            }
            const attemptUpdate = await interruptAttempt({
              attemptId: attempt.id,
              inFlightStates,
              interruptedAt,
              errorJson: JSON.stringify({
                reason: "process_restart_before_provider_response",
                reconciliation_required: true,
                provider_idempotency_key: attempt.providerIdempotencyKey,
              }),
            });
            if (attemptUpdate !== 1) {
              throw new ProviderAttemptAlreadyResolvedError(attempt.id);
            }
            const turn = await readTurnForRecovery(attempt.turnId);
            if (turn !== null && activeTurnStates.includes(turn.state)) {
              const turnUpdate = await interruptTurnForRecovery({
                turnId: attempt.turnId,
                expectedState: turn.state,
                interruptedAt,
                errorJson: JSON.stringify({
                  reason: "provider_attempt_in_flight_on_process_restart",
                  provider_attempt_id: attempt.id,
                  reconciliation_required: true,
                }),
              });
              if (turnUpdate !== 1) {
                throw new Error(`turn ${attempt.turnId} changed during provider recovery`);
              }
            }
            if (turn?.taskId !== null && turn?.taskId !== undefined) {
              await blockTaskForRecovery({
                taskId: turn.taskId,
                phase: turn.state === "VERIFYING" ? "VERIFY" : "IMPLEMENT",
                expectedStatuses: ["ACTIVE", "VERIFYING"],
                reasonJson: JSON.stringify({
                  reason: "provider_recovery_required",
                  provider_attempt_id: attempt.id,
                  turn_id: attempt.turnId,
                  reconciliation_required: true,
                }),
              });
            }
          },
        );
      };
      try {
        if (alreadyUnderMutationLock) await recover();
        else await this.dependencies.mutate(recover);
        interrupted.push({
          id: attempt.id,
          turnId: attempt.turnId,
          taskId: attempt.turn.taskId,
          previousStatus: attempt.status,
          providerIdempotencyKey: attempt.providerIdempotencyKey,
          requestFingerprint: attempt.requestFingerprint,
        });
      } catch (error: unknown) {
        if (error instanceof ProviderAttemptAlreadyResolvedError) {
          alreadyResolved.push(error.attemptId);
        } else {
          failed.push({
            id: attempt.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return { scanned: attempts.length, interrupted, alreadyResolved, failed };
  }
}
