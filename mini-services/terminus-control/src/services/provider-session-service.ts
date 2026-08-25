import type {
  ProviderResponse,
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
  /**
   * Per-turn kernel-brokered executor for the direct transport. Bound by the
   * caller so it can capture turn-scoped state (context epoch, workspace);
   * required whenever `direct` is set.
   */
  readonly executeDirectRequest?: (input: ProviderExecutionInput) => Promise<ProviderResponse>;
  readonly context: RequestContext;
  readonly workspaceId: string;
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
      if (state === "INTERRUPTED") return false;
      await this.dependencies.appendEvent(
        {
          eventType: "turn.provider_running",
          aggregateType: "turn",
          aggregateId: input.turnId,
          correlationId: input.taskId,
          payload: {
            provider_attempt_id: input.attemptId,
            attempt_number: input.attemptNumber,
            provider: input.providerId,
            model: input.modelKey,
            context_manifest_id: input.contextManifestId,
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
