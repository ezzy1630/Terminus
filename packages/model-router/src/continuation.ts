/**
 * @terminus/model-router — Provider Failure Classification & Resumable Continuation.
 *
 * Per SPEC §26.3 and §40: Failures are classified into typed error categories;
 * model attempts are restartable units preserving input manifest, tool state epoch,
 * and continuation handle.
 */
import type { ProviderContinuation, Rfc3339Timestamp } from "@terminus/domain";
import { providerContinuationSchema, nowTimestamp } from "@terminus/domain";

export type ProviderFailureKind =
  | "timeout"
  | "rate_limit"
  | "quota_exhausted"
  | "model_refusal"
  | "invalid_format"
  | "service_unavailable"
  | "context_length_exceeded"
  | "network_error";

export interface FailureClassification {
  readonly kind: ProviderFailureKind;
  readonly retryable: boolean;
  readonly suggestedBackoffMs: number;
  readonly fallbackRecommended: boolean;
  readonly reason: string;
}

export class ProviderContinuationManager {
  private readonly continuations = new Map<string, ProviderContinuation>();

  /**
   * Classify an error or HTTP response into a typed failure classification.
   */
  classifyFailure(error: unknown, status?: number): FailureClassification {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
      return {
        kind: "rate_limit",
        retryable: true,
        suggestedBackoffMs: 2000,
        fallbackRecommended: false,
        reason: "Provider rate limit encountered; backoff and retry or fallback",
      };
    }
    if (status === 402 || lower.includes("quota") || lower.includes("insufficient balance") || lower.includes("credit")) {
      return {
        kind: "quota_exhausted",
        retryable: false,
        suggestedBackoffMs: 0,
        fallbackRecommended: true,
        reason: "Provider quota exhausted; fallback to secondary provider required",
      };
    }
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline exceeded")) {
      return {
        kind: "timeout",
        retryable: true,
        suggestedBackoffMs: 1000,
        fallbackRecommended: false,
        reason: "Request timed out; retry or reconcile",
      };
    }
    if (lower.includes("refusal") || lower.includes("content filter") || lower.includes("safety policy")) {
      return {
        kind: "model_refusal",
        retryable: false,
        suggestedBackoffMs: 0,
        fallbackRecommended: true,
        reason: "Model refusal triggered; fallback to alternate model family",
      };
    }
    if (lower.includes("context length") || lower.includes("maximum context") || lower.includes("token limit")) {
      return {
        kind: "context_length_exceeded",
        retryable: false,
        suggestedBackoffMs: 0,
        fallbackRecommended: true,
        reason: "Context length exceeded; semantic compaction or large-context profile required",
      };
    }
    if (lower.includes("json") || lower.includes("unparseable") || lower.includes("invalid format") || lower.includes("schema")) {
      return {
        kind: "invalid_format",
        retryable: true,
        suggestedBackoffMs: 100,
        fallbackRecommended: false,
        reason: "Invalid output format; attempt structured repair",
      };
    }
    if ((status && status >= 500) || lower.includes("500") || lower.includes("502") || lower.includes("503") || lower.includes("service unavailable")) {
      return {
        kind: "service_unavailable",
        retryable: true,
        suggestedBackoffMs: 1500,
        fallbackRecommended: true,
        reason: "Provider 5xx error; retry with backoff or fallback",
      };
    }

    return {
      kind: "network_error",
      retryable: true,
      suggestedBackoffMs: 1000,
      fallbackRecommended: false,
      reason: message,
    };
  }

  /**
   * Create or update a continuation record for a task attempt.
   */
  recordContinuation(input: {
    readonly id: string;
    readonly taskId: string;
    readonly modelKey: string;
    readonly inputManifestHash: string;
    readonly toolStateEpoch: number;
    readonly continuationToken?: string | null;
    readonly lastFailureKind?: string | null;
    readonly timestamp?: Rfc3339Timestamp;
  }): ProviderContinuation {
    const existing = this.continuations.get(input.id);
    const retryCount = existing ? existing.retryCount + 1 : 0;

    const continuation: ProviderContinuation = {
      id: input.id,
      taskId: input.taskId,
      modelKey: input.modelKey,
      inputManifestHash: input.inputManifestHash,
      toolStateEpoch: input.toolStateEpoch,
      continuationToken: input.continuationToken ?? null,
      retryCount,
      lastFailureKind: input.lastFailureKind ?? null,
      createdAt: input.timestamp ?? nowTimestamp(),
    };

    const validated = providerContinuationSchema.parse(continuation) as unknown as ProviderContinuation;
    this.continuations.set(input.id, validated);
    return validated;
  }

  /**
   * Retrieve an existing continuation record.
   */
  getContinuation(id: string): ProviderContinuation | null {
    return this.continuations.get(id) ?? null;
  }
}
