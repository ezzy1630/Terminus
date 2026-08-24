/**
 * kernel_mock.ts — in-memory mock kernel client and effect transcript replayer.
 *
 * Implements the `terminus.kernel.v1` RPC surface in pure TypeScript without
 * requiring the Rust effect kernel daemon or UDS sockets, enabling ultra-fast
 * package unit and integration testing with full policy assertion and replay.
 */
import type {
  ContentHash,
  ArtifactUri,
  Rfc3339Timestamp,
  PrincipalId,
} from "@terminus/domain";
import { nowTimestamp } from "@terminus/domain";
import { canonicalJson } from "@terminus/context-ir";

export interface MockEffectIntent {
  readonly taskId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly riskClass?: string;
  readonly justification?: string;
  readonly approvedPolicyIds?: readonly string[];
}

export interface MockProcessExecRequest {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly intent?: MockEffectIntent;
}

export interface MockProcessExecResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface MockFsReadRequest {
  readonly path: string;
  readonly offset?: number;
  readonly length?: number;
  readonly intent?: MockEffectIntent;
}

export interface MockFsReadResponse {
  readonly content: Uint8Array;
  readonly truncated: boolean;
}

export interface MockFsWriteRequest {
  readonly path: string;
  readonly content: Uint8Array;
  readonly createParentDirs?: boolean;
  readonly intent?: MockEffectIntent;
}

export interface MockFsWriteResponse {
  readonly bytesWritten: number;
}

export type MockSecretCapabilityUri = `secret://${string}`;
export type MockSecretHandle = `secret-handle://${string}`;
export type MockCapabilityHandle = `capability-handle://${string}`;

export interface MockFetchSecretRequest {
  readonly capabilityUri: MockSecretCapabilityUri;
  readonly requestedBy: string;
  readonly intent?: MockEffectIntent;
}

export interface MockSecretBrokerReceipt {
  readonly receiptId: string;
  readonly capabilityUri: MockSecretCapabilityUri;
  readonly handle: MockSecretHandle;
  readonly requestedBy: string;
  readonly issuedAt: Rfc3339Timestamp;
  readonly expiresAt: Rfc3339Timestamp;
}

export interface MockFetchSecretResponse {
  readonly brokerReceipt: MockSecretBrokerReceipt;
}

export interface MockCapabilityTokenRequest {
  readonly capabilityId: string;
  readonly principal: PrincipalId | string;
  readonly scope: string;
}

export interface MockCapabilityTokenResponse {
  readonly handle: MockCapabilityHandle;
  readonly brokerReceipt: {
    readonly receiptId: string;
    readonly capabilityId: string;
    readonly principal: PrincipalId | string;
    readonly scope: string;
    readonly issuedAt: Rfc3339Timestamp;
    readonly validUntil: Rfc3339Timestamp;
  };
}

export interface MockArtifactIngestRequest {
  readonly bytes: Uint8Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MockArtifactIngestResponse {
  readonly hash: ContentHash;
  readonly uri: ArtifactUri;
}

interface MockKernelMethodMap {
  readonly executeProcess: {
    readonly request: MockProcessExecRequest;
    readonly response: MockProcessExecResponse;
  };
  readonly readFile: {
    readonly request: MockFsReadRequest;
    readonly response: MockFsReadResponse;
  };
  readonly writeFile: {
    readonly request: MockFsWriteRequest;
    readonly response: MockFsWriteResponse;
  };
  readonly fetchSecret: {
    readonly request: MockFetchSecretRequest;
    readonly response: MockFetchSecretResponse;
  };
  readonly acquireCapabilityToken: {
    readonly request: MockCapabilityTokenRequest;
    readonly response: MockCapabilityTokenResponse;
  };
  readonly ingestArtifact: {
    readonly request: MockArtifactIngestRequest;
    readonly response: MockArtifactIngestResponse;
  };
}

export type MockKernelMethod = keyof MockKernelMethodMap;

type MockMethodRequest<Name extends MockKernelMethod> = MockKernelMethodMap[Name]["request"];
type MockMethodResponse<Name extends MockKernelMethod> = MockKernelMethodMap[Name]["response"];

function fixtureHandleSegment(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return encodeURIComponent(value);
}

function fixtureExpiryTimestamp(): Rfc3339Timestamp {
  return new Date(Date.now() + 5 * 60 * 1000).toISOString() as Rfc3339Timestamp;
}

export function mockSecretBrokerReceipt(input: {
  readonly capabilityUri: MockSecretCapabilityUri;
  readonly requestedBy: string;
  readonly handleId?: string;
}): MockFetchSecretResponse {
  const issuedAt = nowTimestamp();
  const handleId = fixtureHandleSegment(input.handleId ?? "fixture", "handleId");
  return {
    brokerReceipt: {
      receiptId: `secret-receipt:${handleId}`,
      capabilityUri: input.capabilityUri,
      handle: `secret-handle://${handleId}`,
      requestedBy: input.requestedBy,
      issuedAt,
      expiresAt: fixtureExpiryTimestamp(),
    },
  };
}

export function mockCapabilityBrokerReceipt(
  request: MockCapabilityTokenRequest,
  handleId = "fixture",
): MockCapabilityTokenResponse {
  const issuedAt = nowTimestamp();
  const encodedHandleId = fixtureHandleSegment(handleId, "handleId");
  return {
    handle: `capability-handle://${encodedHandleId}`,
    brokerReceipt: {
      receiptId: `capability-receipt:${encodedHandleId}`,
      capabilityId: request.capabilityId,
      principal: request.principal,
      scope: request.scope,
      issuedAt,
      validUntil: fixtureExpiryTimestamp(),
    },
  };
}

export interface MockRecordedCall<TReq = unknown, TRes = unknown> {
  readonly id: string;
  readonly method: string;
  readonly timestamp: Rfc3339Timestamp;
  readonly request: TReq;
  readonly response?: TRes;
  readonly error?: Error;
}

export class MockKernelError extends Error {
  constructor(
    public readonly code:
      | "POLICY_DENIED"
      | "CAPABILITY_REVOKED"
      | "NOT_FOUND"
      | "TIMEOUT"
      | "INTERNAL"
      | "UNSCRIPTED_CALL",
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(`[MockKernelError:${code}] ${message}`);
    this.name = "MockKernelError";
  }
}

/**
 * In-memory Mock Kernel Client for Terminus TypeScript tests.
 */
export class MockKernelClient {
  private callCounter = 0;
  private readonly history: MockRecordedCall[] = [];
  private readonly scriptedResponses = new Map<MockKernelMethod, unknown[]>();
  private readonly scriptedHandlers = new Map<
    MockKernelMethod,
    (request: unknown) => Promise<unknown> | unknown
  >();

  /** All recorded RPC calls across the lifetime of the mock client. */
  get recordedCalls(): readonly MockRecordedCall[] {
    return this.history;
  }

  /** Clear all recorded call history and reset state. */
  clear(): void {
    this.history.length = 0;
    this.scriptedResponses.clear();
    this.scriptedHandlers.clear();
    this.callCounter = 0;
  }

  /** Push a one-shot or repeated scripted response for a given method. */
  scriptResponse<Name extends MockKernelMethod>(
    method: Name,
    response: MockMethodResponse<Name> | Error,
  ): this {
    const queue = this.scriptedResponses.get(method) ?? [];
    queue.push(response);
    this.scriptedResponses.set(method, queue);
    return this;
  }

  /** Set a custom handler function for a given method. */
  setHandler<Name extends MockKernelMethod>(
    method: Name,
    handler: (
      request: MockMethodRequest<Name>,
    ) => Promise<MockMethodResponse<Name>> | MockMethodResponse<Name>,
  ): this {
    this.scriptedHandlers.set(
      method,
      handler as (request: unknown) => Promise<unknown> | unknown,
    );
    return this;
  }

  /** Inject a policy denial on the next call to `method`. */
  injectPolicyDenial(method: MockKernelMethod, reason: string): this {
    return this.scriptResponse(
      method,
      new MockKernelError("POLICY_DENIED", reason),
    );
  }

  private async dispatch<Name extends MockKernelMethod>(
    method: Name,
    req: MockMethodRequest<Name>,
  ): Promise<MockMethodResponse<Name>> {
    this.callCounter += 1;
    const callId = `call-${this.callCounter.toString().padStart(4, "0")}`;
    const timestamp = nowTimestamp();

    const queue = this.scriptedResponses.get(method);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (next instanceof Error) {
        this.history.push({ id: callId, method, timestamp, request: req, error: next });
        throw next;
      }
      const res = next as MockMethodResponse<Name>;
      this.history.push({ id: callId, method, timestamp, request: req, response: res });
      return res;
    }

    const handler = this.scriptedHandlers.get(method);
    if (handler) {
      try {
        const res = (await handler(req)) as MockMethodResponse<Name>;
        this.history.push({ id: callId, method, timestamp, request: req, response: res });
        return res;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.history.push({ id: callId, method, timestamp, request: req, error });
        throw error;
      }
    }

    const error = new MockKernelError(
      "UNSCRIPTED_CALL",
      `No explicit fixture script for privileged method '${method}'`,
    );
    this.history.push({ id: callId, method, timestamp, request: req, error });
    throw error;
  }

  // ── Kernel RPC Methods ──

  async executeProcess(req: MockProcessExecRequest): Promise<MockProcessExecResponse> {
    return this.dispatch("executeProcess", req);
  }

  async readFile(req: MockFsReadRequest): Promise<MockFsReadResponse> {
    return this.dispatch("readFile", req);
  }

  async writeFile(req: MockFsWriteRequest): Promise<MockFsWriteResponse> {
    return this.dispatch("writeFile", req);
  }

  async fetchSecret(req: MockFetchSecretRequest): Promise<MockFetchSecretResponse> {
    return this.dispatch("fetchSecret", req);
  }

  async acquireCapabilityToken(req: MockCapabilityTokenRequest): Promise<MockCapabilityTokenResponse> {
    return this.dispatch("acquireCapabilityToken", req);
  }

  async ingestArtifact(req: MockArtifactIngestRequest): Promise<MockArtifactIngestResponse> {
    return this.dispatch("ingestArtifact", req);
  }

  // ── Assertion Helpers ──

  assertCallCount(method: string, expectedCount: number): void {
    const matching = this.history.filter((c) => c.method === method);
    if (matching.length !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} call(s) to '${method}', but found ${matching.length}`,
      );
    }
  }

  assertCalledWithIntent(method: string): void {
    const matching = this.history.filter(
      (c) => c.method === method && (c.request as { intent?: MockEffectIntent })?.intent !== undefined,
    );
    if (matching.length === 0) {
      throw new Error(`Expected at least one call to '${method}' with a valid EffectIntent`);
    }
  }
}

/**
 * Replays pre-recorded kernel effect transcripts to verify deterministic behavior.
 */
export class EffectTranscriptReplayer {
  private index = 0;
  private readonly transcript: ReadonlyArray<{ method: string; request: unknown; response: unknown }>;

  constructor(transcript: ReadonlyArray<{ method: string; request: unknown; response: unknown }>) {
    this.transcript = transcript;
  }

  get remainingSteps(): number {
    return this.transcript.length - this.index;
  }

  next<TRes = unknown>(method: string, request: unknown): TRes {
    if (this.index >= this.transcript.length) {
      throw new MockKernelError(
        "INTERNAL",
        `Transcript exhausted at step ${this.index}; received unexpected call to '${method}'`,
      );
    }
    const step = this.transcript[this.index]!;
    this.index += 1;

    if (step.method !== method) {
      throw new MockKernelError(
        "INTERNAL",
        `Transcript step mismatch at index ${this.index - 1}: expected '${step.method}', got '${method}'`,
      );
    }
    if (canonicalJson(step.request) !== canonicalJson(request)) {
      throw new MockKernelError(
        "INTERNAL",
        `Transcript request mismatch at index ${this.index - 1} for '${method}'`,
      );
    }

    return step.response as TRes;
  }
}
