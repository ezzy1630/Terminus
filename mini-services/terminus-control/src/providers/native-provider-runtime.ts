import { CacheRecorder, usageToCacheEvents } from "@terminus/provider-cache";
import {
  BudgetGuard,
  CostReconciler,
  estimateCostMicros,
  checkBudget,
  settlePartialStream,
  type BudgetLimits,
  type BudgetState,
} from "@terminus/provider-economics";
import type {
  ContentHash,
  Micros,
  ModelKey,
  TokenCount,
} from "@terminus/domain";
import type {
  ProviderEconomics,
  ProviderResponseChunk,
  RenderedProviderRequest,
  PartialStreamResult,
  UsageRecord,
} from "@terminus/provider-core";

/**
 * NativeProviderRuntime (deep-audit Rank 4 / PR6–PR7).
 *
 * The historical live loop reached models only through a gateway or a local
 * command: provider-native continuation ids were dropped, prompt-cache reads
 * and writes were never reconciled against predictions, and cost decisions
 * could not close the loop. This runtime is the reference path:
 *
 * - renders through the model-native renderer in packages/provider-*;
 * - streams over a caller-supplied HTTP-byte transport (kernel-brokered
 *   egress stays in charge of the network);
 * - decodes SSE with the provider package decoders;
 * - reconciles predicted vs actual cache behaviour (CacheRecorder);
 * - checks budgets BEFORE dispatch and reconciles cost AFTER usage;
 * - recovers partial streams explicitly instead of silently retrying.
 */

export interface NativeRuntimeConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  /** Path appended to baseUrl for the streaming request. */
  readonly endpointPath: string;
}

export interface NativeStreamResult {
  readonly chunks: readonly ProviderResponseChunk[];
  readonly usage: UsageRecord | null;
  readonly continuationId: string | null;
  readonly cacheObservation: {
    readonly manifestId: string;
    readonly predictedCachedTokens: TokenCount;
    readonly cacheReads: TokenCount;
    readonly cacheWrites: TokenCount;
    readonly eventCount: number;
  } | null;
  readonly costReconciliationMicros: Micros | null;
  readonly budgetStateAfter: BudgetState | null;
  /** Present when the stream ended in an explicit error (partial settlement). */
  readonly partialSettlement?: PartialStreamResult;
}

export interface NativeDispatchInput {
  readonly rendered: RenderedProviderRequest;
  /** Stable id linking request/response/cache observation for this call. */
  readonly manifestId: string;
  readonly economics: ProviderEconomics;
  readonly budgetLimits: BudgetLimits;
  readonly budgetState?: BudgetState;
  readonly signal?: AbortSignal | null;
}

export type ByteStream = AsyncIterable<Uint8Array>;

export interface NativeTransportDeps {
  /**
   * Issue one streaming POST. Implementations MUST route through the
   * kernel-brokered egress boundary; the runtime never opens sockets.
   */
  readonly postSse: (input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal | null;
  }) => Promise<ByteStream>;
  readonly decode: (chunks: ByteStream) => AsyncIterable<ProviderResponseChunk>;
  readonly now?: () => number;
}

/** Collect an SSE byte stream into decoded provider chunks. */
export async function collectChunks(
  stream: ByteStream,
  decode: NativeTransportDeps["decode"],
): Promise<{ readonly chunks: ProviderResponseChunk[]; readonly errorChunks: ProviderResponseChunk[] }> {
  const chunks: ProviderResponseChunk[] = [];
  const errorChunks: ProviderResponseChunk[] = [];
  for await (const chunk of decode(stream)) {
    if (chunk.kind === "error") errorChunks.push(chunk);
    else chunks.push(chunk);
  }
  return { chunks, errorChunks };
}

/**
 * One native, budget-checked, cache-reconciled provider dispatch.
 *
 * Fails closed: when the pre-flight budget check refuses, no network call is
 * made. When the stream errors mid-flight, the partial result is settled via
 * `settlePartialStream` and reported — never silently retried here; retry
 * policy belongs to the recovery layer above.
 */
export async function dispatchNativeRequest(
  config: NativeRuntimeConfig,
  deps: NativeTransportDeps,
  input: NativeDispatchInput,
): Promise<NativeStreamResult> {
  const { rendered, economics } = input;
  const budget = new BudgetGuard(input.budgetLimits, input.budgetState ?? {
    requestSpent: 0n as Micros,
    taskSpent: 0n as Micros,
    sessionSpent: 0n as Micros,
  });

  // Pre-flight: refuse before spending when the prediction exceeds budget.
  const estimated = estimateCostMicros(
    {
      promptTokens: rendered.predictedCachedTokens,
      predictedOutputTokens: 0n as TokenCount,
      predictedReasoningTokens: 0n as TokenCount,
      predictedCachedTokens: rendered.predictedCachedTokens,
    },
    economics,
  );
  const budgetCheck = checkBudget(input.budgetLimits, budget.snapshot(), estimated);
  if (!budgetCheck.allowed) {
    throw new Error(`native dispatch refused by budget guard: ${budgetCheck.reason}`);
  }

  const apiKey = process.env[config.apiKeyEnv] ?? "";
  if (apiKey.length === 0) {
    throw new Error(
      `${config.apiKeyEnv} is not set; refusing to construct an unauthenticated native request`,
    );
  }

  const recorder = new CacheRecorder({
    manifestId: input.manifestId,
    providerId: rendered.providerId,
    model: rendered.request.model,
    predictedCachedTokens: rendered.predictedCachedTokens,
  });
  recorder.recordRead(rendered.predictedCachedTokens);

  const startedAt = deps.now?.() ?? Date.now();
  const byteStream = await deps.postSse({
    url: `${config.baseUrl}${config.endpointPath}`,
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${apiKey}`,
    },
    body: rendered.body,
    signal: input.signal ?? null,
  });
  const { chunks, errorChunks } = await collectChunks(byteStream, deps.decode);
  const wallMs = (deps.now?.() ?? Date.now()) - startedAt;

  // Explicit partial-stream settlement on error chunks.
  if (errorChunks.length > 0) {
    const settled = settlePartialStream(chunks, "error", economics);
    return {
      chunks,
      usage: null,
      continuationId: null,
      cacheObservation: null,
      costReconciliationMicros: null,
      budgetStateAfter: budget.snapshot(),
      partialSettlement: settled,
    };
  }

  const doneChunk = [...chunks].reverse().find((chunk) => chunk.kind === "done");
  const usage = doneChunk?.usage ?? null;
  const continuationId = doneChunk?.continuationId ?? null;

  if (usage !== null) {
    const events = usageToCacheEvents(usage);
    if (events.cacheReads > 0n) recorder.recordHit(events.cacheReads);
    if (events.cacheWrites > 0n) recorder.recordWrite(events.cacheWrites);
    // Actual spend reconciles the prediction.
    const actualCost = estimateCostMicros(
      {
        promptTokens: usage.inputTokens,
        predictedOutputTokens: usage.outputTokens,
        predictedReasoningTokens: usage.reasoningTokens,
        predictedCachedTokens: usage.cachedInputTokens,
      },
      economics,
    );
    budget.recordSpend(actualCost);
    const reconciler = new CostReconciler();
    reconciler.reconcile(
      input.manifestId,
      rendered.providerId,
      rendered.request.model,
      usage,
      economics,
      estimated,
      null,
    );
    return {
      chunks,
      usage: withLatency(usage, wallMs),
      continuationId,
      cacheObservation: {
        manifestId: input.manifestId,
        predictedCachedTokens: rendered.predictedCachedTokens,
        cacheReads: usage.cachedInputTokens,
        cacheWrites: usage.cacheWriteTokens,
        eventCount: recorder.eventCount,
      },
      costReconciliationMicros: actualCost,
      budgetStateAfter: budget.snapshot(),
    };
  }

  // Stream completed without a usage frame: report what we observed with no
  // cost reconciliation and an empty cache observation. This branch previously
  // referenced the block-scoped `actualCost` from above (TDZ crash); it now
  // returns explicitly.
  return {
    chunks,
    usage,
    continuationId,
    cacheObservation: null,
    costReconciliationMicros: null,
    budgetStateAfter: budget.snapshot(),
  };
}

function withLatency(usage: UsageRecord, wallMs: number): UsageRecord {
  return { ...usage, latencyMs: usage.latencyMs + wallMs };
}

export type { BudgetLimits, BudgetState };
export type { ContentHash, ModelKey };
