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
  /**
   * Turn-scoped Codex continuity. The endpoint returns `x-codex-turn-state`
   * on one response and expects it echoed on the next request of the same
   * turn, so the token cannot live in the per-attempt header record built at
   * turn start — it is read and refreshed on every dispatch.
   */
  readonly codexTurnState?: import("@terminus/provider-openai").CodexTurnState | undefined;
  /** The connected account, so its rate-limit receipt can be recorded. */
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
}

export interface ProviderSessionDependencies<TTransaction> {
  readonly readTurnState: (turnId: string) => Promise<string | null>;
  readonly appendEvent: ServiceEventAppender<TTransaction>;
  readonly transaction: (transaction: TTransaction) => ProviderSessionTransaction;
  readonly mutate: MutationRunner;
  readonly executeLocal: (input: ProviderExecutionInput) => Promise<ProviderResponse>;
  readonly executeGateway: (input: ProviderExecutionInput) => Promise<ProviderResponse>;
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
}
