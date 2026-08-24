/**
 * Provider-neutral connector directory and dispatch coordinator.
 * Credential resolution and network I/O remain inside an injected L7 broker.
 */
import { canonicalJson, computeContentHash } from "@terminus/context-ir";
import {
  ConflictError,
  ExternalDependencyError,
  IdempotencyConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationError,
  connectorCallIntentSchema,
  connectorCallResultSchema,
  connectorExecutionObservationSchema,
  externalConnectorSpecSchema,
  type ConnectorCallIntent,
  type ConnectorCallResult,
  type ConnectorExecutionObservation,
  type ContentHash,
  type ExternalConnectorSpec,
} from "@terminus/domain";

export type { ConnectorCallResult } from "@terminus/domain";

export interface ExternalConnectorBroker {
  /**
   * Atomically validate and consume the bound grant, then execute the call.
   * The broker must return an explicit settlement instead of throwing a
   * success-shaped transport fallback.
   */
  readonly execute: (input: {
    readonly connector: ExternalConnectorSpec;
    readonly intent: ConnectorCallIntent;
    readonly requestHash: ContentHash;
  }) => Promise<ConnectorExecutionObservation>;
}

interface CachedCall {
  readonly requestHash: ContentHash;
  readonly result: ConnectorCallResult;
}

interface PendingCall {
  readonly requestHash: ContentHash;
  readonly result: Promise<ConnectorCallResult>;
}

export class ExternalConnectorLibrary {
  private readonly connectors = new Map<string, ExternalConnectorSpec>();
  /** Idempotency keys are task-scoped. The stored hash binds the remaining authority. */
  private readonly executedIntents = new Map<ContentHash, CachedCall>();
  private readonly pendingIntents = new Map<ContentHash, PendingCall>();

  public constructor(
    private readonly broker: ExternalConnectorBroker | null = null,
    initialConnectors: readonly ExternalConnectorSpec[] = [],
  ) {
    for (const connector of initialConnectors) this.registerConnector(connector);
  }

  public registerConnector(rawSpec: ExternalConnectorSpec): void {
    const spec = externalConnectorSpecSchema.parse(structuredClone(rawSpec));
    const existing = this.connectors.get(spec.connectorId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(spec)) {
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `External connector '${spec.connectorId}' is already registered with different content`,
        { connectorId: spec.connectorId },
      );
    }
    this.connectors.set(spec.connectorId, {
      ...spec,
      allowedMethods: [...spec.allowedMethods],
      effectClasses: [...spec.effectClasses],
    });
  }

  public getConnector(connectorId: string): ExternalConnectorSpec | null {
    const connector = this.connectors.get(connectorId);
    return connector === undefined ? null : this.copyConnector(connector);
  }

  public listConnectors(): readonly ExternalConnectorSpec[] {
    return [...this.connectors.values()]
      .map((connector) => this.copyConnector(connector))
      .sort((left, right) => left.connectorId.localeCompare(right.connectorId));
  }

  public async executeCall(rawIntent: ConnectorCallIntent): Promise<ConnectorCallResult> {
    const intent = connectorCallIntentSchema.parse(structuredClone(rawIntent));
    const connector = this.connectors.get(intent.connectorId);
    if (connector === undefined) throw new NotFoundError("external connector", intent.connectorId);
    if (connector.status !== "active") {
      throw new ExternalDependencyError(
        `connector:${connector.connectorId}`,
        `connector status is ${connector.status}`,
      );
    }
    if (!connector.allowedMethods.includes(intent.method)) {
      throw new PolicyDeniedError("Connector method is outside its declared capability", {
        connectorId: connector.connectorId,
        method: intent.method,
      });
    }
    if (!connector.effectClasses.includes(intent.effectClass)) {
      throw new PolicyDeniedError("Connector effect class is outside its declared capability", {
        connectorId: connector.connectorId,
        effectClass: intent.effectClass,
      });
    }
    if (!intent.path.startsWith("/") || intent.path.startsWith("//")) {
      throw new ValidationError("Connector path must be an origin-relative path", {
        connectorId: connector.connectorId,
        path: intent.path,
      });
    }

    const requestHash = this.hash({
      taskId: intent.taskId,
      intentId: intent.intentId,
      idempotencyKey: intent.idempotencyKey,
      authorizationId: intent.authorizationId,
      connectorId: intent.connectorId,
      credentialBindingId: connector.credentialBindingId,
      operation: intent.operation,
      method: intent.method,
      path: intent.path,
      parameters: intent.parameters,
      effectClass: intent.effectClass,
    });
    const idempotencyScope = this.hash({
      taskId: intent.taskId,
      idempotencyKey: intent.idempotencyKey,
    });
    const cached = this.executedIntents.get(idempotencyScope);
    if (cached !== undefined) {
      if (cached.requestHash !== requestHash) {
        throw new IdempotencyConflictError(intent.idempotencyKey);
      }
      return this.copyResult(cached.result);
    }

    const pending = this.pendingIntents.get(idempotencyScope);
    if (pending !== undefined) {
      if (pending.requestHash !== requestHash) {
        throw new IdempotencyConflictError(intent.idempotencyKey);
      }
      return this.copyResult(await pending.result);
    }
    if (this.broker === null) {
      throw new ExternalDependencyError(
        "connector broker",
        "no trusted L7 connector broker is configured",
        { supportLevel: "coordinator_only", connectorId: connector.connectorId },
      );
    }

    const resultPromise = this.executeUncached(connector, intent, requestHash);
    const pendingCall: PendingCall = { requestHash, result: resultPromise };
    this.pendingIntents.set(idempotencyScope, pendingCall);
    try {
      const result = await resultPromise;
      this.executedIntents.set(idempotencyScope, { requestHash, result });
      return this.copyResult(result);
    } finally {
      if (this.pendingIntents.get(idempotencyScope) === pendingCall) {
        this.pendingIntents.delete(idempotencyScope);
      }
    }
  }

  private async executeUncached(
    connector: ExternalConnectorSpec,
    intent: ConnectorCallIntent,
    requestHash: ContentHash,
  ): Promise<ConnectorCallResult> {
    if (this.broker === null) {
      throw new ExternalDependencyError("connector broker", "broker became unavailable");
    }
    const observation = connectorExecutionObservationSchema.parse(structuredClone(
      await this.broker.execute({
        connector: this.copyConnector(connector),
        intent: connectorCallIntentSchema.parse(structuredClone(intent)),
        requestHash,
      }),
    ));
    return this.toResult(intent, requestHash, observation);
  }

  private toResult(
    intent: ConnectorCallIntent,
    requestHash: ContentHash,
    observation: ConnectorExecutionObservation,
  ): ConnectorCallResult {
    const responseHash = this.hash({
      settlement: observation.settlement,
      httpStatusCode: observation.httpStatusCode,
      responseBody: observation.responseBody,
      failureCode: observation.failureCode,
      failureMessage: observation.failureMessage,
    });
    const result: ConnectorCallResult = {
      receiptId: this.hash({ requestHash, responseHash }),
      intentId: intent.intentId,
      connectorId: intent.connectorId,
      status: observation.settlement,
      httpStatusCode: observation.httpStatusCode,
      responseBody: observation.responseBody,
      requestHash,
      responseHash,
      executedAt: observation.executedAt,
      failureCode: observation.failureCode,
      failureMessage: observation.failureMessage,
    };
    connectorCallResultSchema.parse(result);
    return result;
  }

  private hash(value: unknown): ContentHash {
    return computeContentHash(canonicalJson(value));
  }

  private copyConnector(connector: ExternalConnectorSpec): ExternalConnectorSpec {
    return {
      ...connector,
      allowedMethods: [...connector.allowedMethods],
      effectClasses: [...connector.effectClasses],
    };
  }

  private copyResult(result: ConnectorCallResult): ConnectorCallResult {
    return connectorCallResultSchema.parse(structuredClone(result)) as unknown as ConnectorCallResult;
  }
}
