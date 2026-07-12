/**
 * @forge/testkit — fixtures and builders for Forge tests.
 *
 * Provides:
 * - `fakeProvider` (scripted streaming text, tool calls, errors, rate limits,
 *   continuation IDs, cache usage, malicious args).
 * - `fakeKernel` (in-memory artifact store, mock sandbox).
 * - Builders for `RequestContext`, `EffectIntent`, `CommandSpec`, `Task`,
 *   `TaskContract`, `ContextFragment`, etc.
 */
import { z } from "zod";
import type {
  Uuid7,
  ContentHash,
  ArtifactUri,
  Rfc3339Timestamp,
  Micros,
  TokenCount,
  ByteCount,
  ModelKey,
  PrincipalId,
  TraceId,
  ResourceUri,
  Task,
  TaskContract,
  AcceptanceCriterion,
  AllowedScope,
  TaskBudget,
  RiskClass,
  ArtifactRef,
  ContextFragment,
  ContextKind,
  ContextScope,
  Freshness,
  SourceDescriptor,
  SelectionFeatures,
  ActorKind,
} from "@forge/domain";
import { asContentHash, artifactUriFromHex, nowTimestamp } from "@forge/domain";
import type { AnyTypedEvent, EventSink, EventPayloadMap, EventType } from "@forge/runtime-protocol";

// ────────────────────────── ID generation ────────────────────────────────────

let counter = 0;
function nextId(prefix = "018f"): string {
  counter += 1;
  const tail = counter.toString(16).padStart(8, "0");
  return `${prefix}0000-0000-7000-8000-${tail}000000`;
}

/** Returns a deterministic UUIDv7-shaped string. Not a real UUIDv7. */
export function fakeUuid7(seed = 0): Uuid7 {
  return nextId(`seed${seed.toString(16).slice(0, 4)}`) as Uuid7;
}

/** Returns a fake content hash. */
export function fakeContentHash(seed = "deadbeef"): ContentHash {
  const hex = (seed + "0".repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, "0");
  return asContentHash(`sha256:${hex}`);
}

/** Returns a fake artifact URI. */
export function fakeArtifactUri(seed = "deadbeef"): ArtifactUri {
  const hex = (seed + "0".repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, "0");
  return artifactUriFromHex(hex);
}

/** Returns a fake artifact ref. */
export function fakeArtifactRef(seed = "deadbeef"): ArtifactRef {
  return {
    hash: fakeContentHash(seed),
    uri: fakeArtifactUri(seed),
    mediaType: "text/plain",
    bytes: 0n as ByteCount,
  };
}

/** Returns a fake RFC3339 timestamp (UTC now). */
export function fakeTimestamp(): Rfc3339Timestamp {
  return nowTimestamp();
}

/** Returns a fake trace ID. */
export function fakeTraceId(): TraceId {
  return `trace-${nextId()}` as TraceId;
}

/** Returns a fake principal ID. */
export function fakePrincipal(name = "user"): PrincipalId {
  return `principal:${name}:${counter}` as PrincipalId;
}

/** Returns a fake model key. */
export function fakeModelKey(provider: string, model = "default"): ModelKey {
  return `${provider}/${model}` as ModelKey;
}

// ────────────────────────── Deterministic ID source ──────────────────────────

export interface IdSource {
  uuid7(): Uuid7;
  contentHash(seed?: string): ContentHash;
  artifactUri(seed?: string): ArtifactUri;
  timestamp(): Rfc3339Timestamp;
}

/** Deterministic ID source for reproducible tests. */
export function deterministicIds(prefix = "seed"): IdSource {
  let n = 0;
  return {
    uuid7: () => fakeUuid7(n++),
    contentHash: (seed = "x") => fakeContentHash(`${prefix}${n++}${seed}`),
    artifactUri: (seed = "x") => fakeArtifactUri(`${prefix}${n++}${seed}`),
    timestamp: () => fakeTimestamp(),
  };
}

// ────────────────────────── RequestContext builder ───────────────────────────

export interface RequestContext {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly sessionId: Uuid7;
  readonly taskId: Uuid7 | null;
  readonly turnId: Uuid7 | null;
  readonly actorId: PrincipalId;
  readonly traceparent: TraceId;
  readonly capabilityToken: string | null;
}

export function buildRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: nextId(),
    idempotencyKey: `idem-${counter}`,
    sessionId: fakeUuid7(),
    taskId: null,
    turnId: null,
    actorId: fakePrincipal(),
    traceparent: fakeTraceId(),
    capabilityToken: null,
    ...overrides,
  };
}

// ────────────────────────── EffectIntent builder ─────────────────────────────

export interface EffectIntent {
  readonly userIntentRef: string;
  readonly taskContractHash: ContentHash;
  readonly trustLabel: "trusted" | "derived" | "untrusted";
  readonly confidentialityLabel: "public" | "workspace" | "secret_adjacent" | "secret";
  readonly taintSources: readonly string[];
  readonly requestedPolicyProfile: string;
}

export function buildEffectIntent(overrides: Partial<EffectIntent> = {}): EffectIntent {
  return {
    userIntentRef: nextId(),
    taskContractHash: fakeContentHash("contract"),
    trustLabel: "trusted",
    confidentialityLabel: "workspace",
    taintSources: [],
    requestedPolicyProfile: "secure-local-default",
    ...overrides,
  };
}

// ────────────────────────── CommandSpec builder ──────────────────────────────

export interface CommandSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwdWorkspacePath: string;
  readonly publicEnv: Readonly<Record<string, string>>;
  readonly secretCapabilityUris: readonly string[];
  readonly timeoutMs: number;
  readonly allocatePty: boolean;
  readonly shell: { readonly enabled: boolean; readonly script: string; readonly dialect: string };
}

export function buildCommandSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    program: "echo",
    args: ["hello"],
    cwdWorkspacePath: ".",
    publicEnv: {},
    secretCapabilityUris: [],
    timeoutMs: 30_000,
    allocatePty: false,
    shell: { enabled: false, script: "", dialect: "sh" },
    ...overrides,
  };
}

// ────────────────────────── AcceptanceCriterion / scope / budget ─────────────

export function buildAcceptanceCriterion(
  overrides: Partial<AcceptanceCriterion> = {},
): AcceptanceCriterion {
  return {
    id: `ac-${counter++}`,
    statement: "acceptance criterion",
    verificationHint: null,
    required: true,
    ...overrides,
  };
}

export function buildAllowedScope(overrides: Partial<AllowedScope> = {}): AllowedScope {
  return {
    readPaths: ["workspace://**"],
    writePaths: ["workspace://src/**"],
    externalSystems: [],
    ...overrides,
  };
}

export function buildTaskBudget(overrides: Partial<TaskBudget> = {}): TaskBudget {
  return {
    modelMicros: 5_000_000n as Micros,
    computeSeconds: 600,
    wallClockSeconds: 3600,
    humanApprovals: 20,
    ...overrides,
  };
}

// ────────────────────────── TaskContract / Task builders ─────────────────────

export function buildTaskContract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: fakeUuid7(),
    version: 1,
    objective: "test objective",
    userOutcome: null,
    nonGoals: [],
    acceptanceCriteria: [buildAcceptanceCriterion()],
    constraints: [],
    assumptions: [],
    unknowns: [],
    allowedScope: buildAllowedScope(),
    riskClass: "normal" as RiskClass,
    budget: buildTaskBudget(),
    changePolicy: { mayExpandScope: false, scopeExpansionRequiresUser: true },
    ...overrides,
  };
}

export function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: fakeUuid7(),
    sessionId: fakeUuid7(),
    threadId: fakeUuid7(),
    contract: buildTaskContract(),
    status: "DRAFT",
    phase: "INTAKE",
    scopeLedgerId: null,
    verificationPlanId: null,
    createdAt: fakeTimestamp(),
    completedAt: null,
    ...overrides,
  };
}

// ────────────────────────── ContextFragment builder ──────────────────────────

export function buildSourceDescriptor(
  overrides: Partial<SourceDescriptor> = {},
): SourceDescriptor {
  return {
    uri: "workspace://src/test.ts",
    producer: "test",
    producerVersion: "0.1.0",
    observedAt: fakeTimestamp(),
    observedBy: "kernel",
    evidenceRefs: [],
    ...overrides,
  };
}

export function buildFreshness(overrides: Partial<Freshness> = {}): Freshness {
  return {
    observedAt: fakeTimestamp(),
    sourceVersion: "sha256:0".repeat(64).slice(0, 71),
    stale: false,
    staleReason: null,
    ...overrides,
  };
}

export function buildSelectionFeatures(
  overrides: Partial<SelectionFeatures> = {},
): SelectionFeatures {
  return {
    relevance: 0.5,
    novelty: 0.5,
    coverage: 0.5,
    uncertaintyReduction: 0.5,
    riskReduction: 0.5,
    modelCompatibility: 0.5,
    redundancyPenalty: 0,
    injectionPenalty: 0,
    ...overrides,
  };
}

export function buildContextScope(overrides: Partial<ContextScope> = {}): ContextScope {
  return {
    workspaceId: fakeUuid7(),
    sessionId: null,
    taskId: null,
    pathPatterns: ["src/**"],
    ...overrides,
  };
}

export function buildContextFragment(
  overrides: Partial<ContextFragment> = {},
): ContextFragment {
  const model = fakeModelKey("test", "default");
  return {
    id: `frag-${counter++}`,
    kind: "code" as ContextKind,
    contentRef: fakeArtifactRef("frag"),
    source: buildSourceDescriptor(),
    sourceVersion: "sha256:0".repeat(64).slice(0, 71),
    authority: 50,
    priority: 50,
    trust: "trusted",
    confidentiality: "workspace",
    injectionRisk: "none",
    exactness: "exact",
    scope: buildContextScope(),
    freshness: buildFreshness(),
    dependencies: [],
    invalidation: [],
    estimatedTokens: { [model]: 100 } as Readonly<Record<ModelKey, number>>,
    selectionFeatures: buildSelectionFeatures(),
    ...overrides,
  };
}

// ────────────────────────── Fake event sink ──────────────────────────────────

/** An in-memory `EventSink` that captures all emitted events. */
export class FakeEventSink implements EventSink {
  readonly events: AnyTypedEvent[] = [];

  async emit<T extends EventType>(
    type: T,
    payload: EventPayloadMap[T],
    options: {
      aggregateId: string;
      aggregateSequence: number;
      actor: { kind: ActorKind; id: string };
      occurredAt?: Rfc3339Timestamp | undefined;
      correlationId?: Uuid7 | null | undefined;
      causationId?: Uuid7 | null | undefined;
      idempotencyKey?: string | null | undefined;
      artifactRefs?: readonly ArtifactRef[] | undefined;
      traceId?: TraceId | null | undefined;
    },
  ): Promise<TypedEventCapture<T>> {
    const ev = {
      eventId: fakeUuid7(),
      eventType: type,
      schemaVersion: 1,
      aggregateType: type.split(".")[0] as string,
      aggregateId: options.aggregateId,
      aggregateSequence: options.aggregateSequence,
      occurredAt: options.occurredAt ?? fakeTimestamp(),
      actor: options.actor,
      correlationId: options.correlationId ?? null,
      causationId: options.causationId ?? null,
      idempotencyKey: options.idempotencyKey ?? null,
      payload,
      artifactRefs: options.artifactRefs ?? [],
      traceId: options.traceId ?? null,
    } as TypedEventCapture<T>;
    this.events.push(ev as unknown as AnyTypedEvent);
    return ev;
  }

  reset(): void {
    this.events.length = 0;
  }

  filter(type: EventType): readonly AnyTypedEvent[] {
    return this.events.filter((e) => e.eventType === type);
  }
}

export type TypedEventCapture<T extends EventType> = {
  readonly eventId: Uuid7;
  readonly eventType: T;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly occurredAt: Rfc3339Timestamp;
  readonly actor: { kind: ActorKind; id: string };
  readonly correlationId: Uuid7 | null;
  readonly causationId: Uuid7 | null;
  readonly idempotencyKey: string | null;
  readonly payload: EventPayloadMap[T];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly traceId: TraceId | null;
};

// ────────────────────────── Fake provider ────────────────────────────────────

export interface FakeProviderScriptStep {
  readonly kind: "text" | "tool_call" | "tool_call_streaming" | "error" | "rate_limited" | "usage" | "cache_usage" | "done";
  readonly text?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolArguments?: Readonly<Record<string, unknown>> | undefined;
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface FakeProviderOptions {
  readonly providerId: string;
  readonly model: ModelKey;
  readonly steps: readonly FakeProviderScriptStep[];
  /** Continuation ID returned if a step sets `continuation=true`. */
  readonly continuationId?: string | undefined;
}

export interface FakeProviderChunk {
  readonly kind: "text" | "tool_call" | "error" | "done";
  readonly text?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolArguments?: Readonly<Record<string, unknown>> | undefined;
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
    readonly reasoningTokens: number;
  } | undefined;
  readonly continuationId?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

/**
 * Scripted provider for tests. Plays back a fixed sequence of steps; supports
 * streaming text, tool calls (including malicious-argument injection), errors,
 * rate limits, continuation IDs, and cache-usage reporting.
 */
export class FakeProvider {
  readonly providerId: string;
  readonly model: ModelKey;
  private readonly steps: readonly FakeProviderScriptStep[];
  private readonly continuationId: string | undefined;
  readonly recordedRequests: unknown[] = [];

  constructor(opts: FakeProviderOptions) {
    this.providerId = opts.providerId;
    this.model = opts.model;
    this.steps = opts.steps;
    this.continuationId = opts.continuationId;
  }

  async *stream(request: unknown, signal?: AbortSignal): AsyncIterable<FakeProviderChunk> {
    this.recordedRequests.push(request);
    if (signal?.aborted) {
      yield { kind: "error", errorCode: "CANCELLED", errorMessage: "aborted" };
      return;
    }
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let reasoningTokens = 0;
    let emittedUsage = false;
    for (const step of this.steps) {
      if (signal?.aborted) {
        yield { kind: "error", errorCode: "CANCELLED", errorMessage: "aborted" };
        return;
      }
      switch (step.kind) {
        case "text":
          yield { kind: "text", text: step.text ?? "" };
          outputTokens += Math.ceil((step.text ?? "").length / 4);
          break;
        case "tool_call":
        case "tool_call_streaming":
          yield {
            kind: "tool_call",
            toolCallId: step.toolCallId ?? `call-${counter++}`,
            toolName: step.toolName ?? "unknown",
            toolArguments: step.toolArguments ?? {},
          };
          outputTokens += 10;
          break;
        case "error":
          yield {
            kind: "error",
            errorCode: step.errorCode ?? "PROVIDER_RESPONSE_INVALID",
            errorMessage: step.errorMessage ?? "unknown",
          };
          return;
        case "rate_limited":
          yield {
            kind: "error",
            errorCode: "PROVIDER_RATE_LIMITED",
            errorMessage: "rate limited",
            retryAfterMs: step.retryAfterMs ?? 1000,
          };
          return;
        case "usage":
          inputTokens = step.inputTokens ?? inputTokens;
          outputTokens = step.outputTokens ?? outputTokens;
          cachedTokens = step.cachedTokens ?? cachedTokens;
          reasoningTokens = step.reasoningTokens ?? reasoningTokens;
          emittedUsage = true;
          break;
        case "cache_usage":
          cachedTokens = step.cachedTokens ?? cachedTokens;
          break;
        case "done":
          if (!emittedUsage) {
            // Auto-emit a usage record at end.
            yield {
              kind: "done",
              usage: { inputTokens, outputTokens, cachedTokens, reasoningTokens },
              continuationId: this.continuationId,
            };
          } else {
            yield {
              kind: "done",
              usage: { inputTokens, outputTokens, cachedTokens, reasoningTokens },
              continuationId: this.continuationId,
            };
          }
          return;
        default: {
          const _exhaustive: never = step.kind;
          void _exhaustive;
          throw new Error(`unexpected step kind: ${JSON.stringify(step)}`);
        }
      }
    }
    // If no explicit "done", emit one.
    yield {
      kind: "done",
      usage: { inputTokens, outputTokens, cachedTokens, reasoningTokens },
      continuationId: this.continuationId,
    };
  }
}

/** Convenience: build a fake provider that streams a single text response. */
export function fakeTextProvider(
  providerId: string,
  model: ModelKey,
  text: string,
): FakeProvider {
  return new FakeProvider({
    providerId,
    model,
    steps: [{ kind: "text", text }, { kind: "done" }],
  });
}

/** Convenience: build a fake provider that returns a single tool call. */
export function fakeToolCallProvider(
  providerId: string,
  model: ModelKey,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): FakeProvider {
  return new FakeProvider({
    providerId,
    model,
    steps: [{ kind: "tool_call", toolName, toolArguments: args }, { kind: "done" }],
  });
}

// ────────────────────────── Fake kernel ──────────────────────────────────────

/** An in-memory fake of the kernel's ArtifactIngestService and SandboxService. */
export class FakeKernel {
  readonly artifacts: Map<string, Uint8Array> = new Map();
  readonly metadata: Map<string, Readonly<Record<string, unknown>>> = new Map();
  readonly links: { hash: string; ownerType: string; ownerId: string; purpose: string }[] = [];
  readonly sandboxCalls: { profile: string; command: CommandSpec }[] = [];

  async ingest(bytes: Uint8Array, metadata: Record<string, unknown> = {}): Promise<ContentHash> {
    // Simple FNV-1a hash; not real sha256. Used only for tests.
    let h1 = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193) >>> 0;
    }
    const hex = h1.toString(16).padStart(8, "0").repeat(8);
    const hash = asContentHash(`sha256:${hex}`);
    this.artifacts.set(hex, bytes);
    this.metadata.set(hex, metadata);
    return hash;
  }

  async get(hash: ContentHash): Promise<Uint8Array | null> {
    const hex = hash.replace(/^sha256:/, "");
    return this.artifacts.get(hex) ?? null;
  }

  async metadataFor(hash: ContentHash): Promise<Readonly<Record<string, unknown>> | null> {
    const hex = hash.replace(/^sha256:/, "");
    return this.metadata.get(hex) ?? null;
  }

  async link(
    hash: ContentHash,
    ownerType: string,
    ownerId: string,
    purpose: string,
  ): Promise<void> {
    this.links.push({ hash, ownerType, ownerId, purpose });
  }

  async gcDryRun(): Promise<{ deleted: string[]; retained: string[] }> {
    const referenced = new Set(this.links.map((l) => l.hash.replace(/^sha256:/, "")));
    const deleted: string[] = [];
    const retained: string[] = [];
    for (const hex of this.artifacts.keys()) {
      if (referenced.has(hex)) retained.push(hex);
      else deleted.push(hex);
    }
    return { deleted, retained };
  }

  /** Records a sandbox call but does not actually execute anything. */
  async sandboxExec(profile: string, command: CommandSpec): Promise<{ exitCode: number }> {
    this.sandboxCalls.push({ profile, command });
    return { exitCode: 0 };
  }
}

// ────────────────────────── Misc utilities ───────────────────────────────────

/** Reset the global counter used by builders. Call between tests for isolation. */
export function resetTestkitCounter(): void {
  counter = 0;
}

/** Returns a zod schema that accepts any value (useful for round-trip tests). */
export const anyValue = z.unknown();

export type {
  Task,
  TaskContract,
  AcceptanceCriterion,
  AllowedScope,
  TaskBudget,
  ArtifactRef,
  ContextFragment,
  ContextKind,
  ContextScope,
  Freshness,
  SourceDescriptor,
  SelectionFeatures,
  ResourceUri,
};
