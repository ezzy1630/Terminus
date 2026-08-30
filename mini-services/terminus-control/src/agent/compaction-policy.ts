import type { ContextBudget } from "@terminus/context-ir";

export const COMPACTION_POLICY_VERSION = "terminus.adaptive-compaction.v1" as const;

/**
 * A byte-level tokenizer cannot emit more tokens than input bytes. The live
 * metadata preflight uses this conservative bound, then rechecks materialized
 * text with the selected model tokenizer estimator before compacting.
 */
export const METADATA_PREFLIGHT_BYTES_PER_TOKEN = 1;

/** Character bound used only to accelerate splitting; estimator fit is enforced. */
const SUMMARY_CHARS_PER_TOKEN_ESTIMATE = 3;

/** Explicit fallback for providers that publish no usable context budget. */
export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 96_000;
export const DEFAULT_KEEP_RECENT_TOKENS = 24_000;

/** Upper bound on one source chunk sent to the summary model. */
export const MAX_COMPACTION_TRANSCRIPT_CHARS = 400_000;

const DEFAULT_SUMMARY_HARD_INPUT_TOKENS = 400_000;
const DEFAULT_SUMMARY_RESERVED_INPUT_TOKENS = 2_000;
const TRIGGER_NUMERATOR = 3;
const TRIGGER_DENOMINATOR = 4;
const RETAIN_NUMERATOR = 1;
const RETAIN_DENOMINATOR = 4;
const MIN_KEEP_RECENT_TOKENS = 2_000;
const MAX_KEEP_RECENT_TOKENS = 32_000;

export interface CompactionPolicyDecision {
  readonly policyVersion: typeof COMPACTION_POLICY_VERSION;
  readonly source:
    | "provider_budget"
    | "provider_budget_exhausted"
    | "provider_summary_budget_exhausted"
    | "fallback_unverified_tokenizer"
    | "fallback_unavailable_budget";
  readonly compactionEnabled: boolean;
  readonly compactThresholdTokens: number;
  readonly keepRecentTokens: number;
  readonly summaryHardInputLimitTokens: number;
  readonly summaryReservedInputTokens: number;
  readonly maxTranscriptChunkTokens: number;
  readonly maxTranscriptChunkChars: number;
}

export interface CompactionPolicyOptions {
  /** Selected-model estimate for non-transcript summary input. */
  readonly summaryReservedInputTokens?: number | undefined;
  /** Adaptive compaction is fail-closed until token estimates are calibrated. */
  readonly tokenizerStatus?: "calibrated" | "degraded" | undefined;
}

export interface CompactionTokenEstimator {
  readonly estimateTextTokens: (text: string) => number;
  readonly calibration: {
    readonly source: "verified_binding" | "observed_usage" | "explicit_fallback";
    readonly status: "calibrated" | "degraded";
    readonly maximumAbsolutePercentageError: number | null;
  };
}

/** Per-turn circuit breaker keyed by the exact source/anchor/policy state. */
export class TurnCompactionFailureGuard {
  private readonly failedFingerprints = new Set<string>();

  shouldSuppress(fingerprint: string): boolean {
    return this.failedFingerprints.has(fingerprint);
  }

  recordFailure(fingerprint: string): void {
    this.failedFingerprints.add(fingerprint);
  }
}

/**
 * Compaction is a provider-input safety boundary, not just a ranking signal.
 * A verified binding may use its model count directly. Observed calibration
 * keeps a floor of 15% headroom; a degraded fallback uses the UTF-8 byte count
 * as the conservative upper bound for byte-level tokenizers.
 */
export function conservativeCompactionTextTokens(
  tokenizer: CompactionTokenEstimator,
  text: string,
): number {
  const estimate = tokenizer.estimateTextTokens(text);
  if (!Number.isSafeInteger(estimate) || estimate < 0) {
    throw new Error("compaction tokenizer must return a non-negative safe integer");
  }
  if (tokenizer.calibration.source === "verified_binding") return estimate;
  if (tokenizer.calibration.status === "calibrated") {
    const observedError = (tokenizer.calibration.maximumAbsolutePercentageError ?? 0) / 100;
    return Math.ceil(estimate * (1 + Math.max(0.15, observedError)));
  }
  return Math.max(estimate, new TextEncoder().encode(text).byteLength);
}

/**
 * Size compaction from the same provider-aware budget used by the Context
 * Compiler. Episode history gets at most 75% of optional context, leaving the
 * rest for retrieved code, current working state, and complete recent tool
 * results. A retained 25% tail creates hysteresis after compaction.
 */
export function deriveCompactionPolicy(
  budget: ContextBudget,
  options: CompactionPolicyOptions = {},
): CompactionPolicyDecision {
  const hardInputLimitTokens = safeTokenNumber(
    budget.hardInputLimit,
    "hardInputLimit",
  );
  const optionalContextTargetTokens = safeTokenNumber(
    budget.optionalContextTarget,
    "optionalContextTarget",
  );
  const summaryReservedInputTokens = Math.max(
    DEFAULT_SUMMARY_RESERVED_INPUT_TOKENS,
    safeNonNegativeInteger(
      options.summaryReservedInputTokens ?? DEFAULT_SUMMARY_RESERVED_INPUT_TOKENS,
      "summaryReservedInputTokens",
    ),
  );

  if (options.tokenizerStatus === "degraded") {
    const summaryHardInputLimitTokens = hardInputLimitTokens === 0
      ? DEFAULT_SUMMARY_HARD_INPUT_TOKENS
      : hardInputLimitTokens;
    const transcriptTokenBudget = Math.max(
      1,
      summaryHardInputLimitTokens - summaryReservedInputTokens,
    );
    return {
      policyVersion: COMPACTION_POLICY_VERSION,
      source: "fallback_unverified_tokenizer",
      compactionEnabled: false,
      compactThresholdTokens: DEFAULT_COMPACT_THRESHOLD_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      summaryHardInputLimitTokens,
      summaryReservedInputTokens,
      maxTranscriptChunkTokens: transcriptTokenBudget,
      maxTranscriptChunkChars: Math.min(
        MAX_COMPACTION_TRANSCRIPT_CHARS,
        transcriptTokenBudget * SUMMARY_CHARS_PER_TOKEN_ESTIMATE,
      ),
    };
  }

  if (hardInputLimitTokens === 0) {
    const transcriptTokenBudget = Math.max(
      1,
      DEFAULT_SUMMARY_HARD_INPUT_TOKENS - summaryReservedInputTokens,
    );
    return {
      policyVersion: COMPACTION_POLICY_VERSION,
      source: "fallback_unavailable_budget",
      compactionEnabled: true,
      compactThresholdTokens: DEFAULT_COMPACT_THRESHOLD_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      summaryHardInputLimitTokens: DEFAULT_SUMMARY_HARD_INPUT_TOKENS,
      summaryReservedInputTokens,
      maxTranscriptChunkTokens: transcriptTokenBudget,
      maxTranscriptChunkChars: Math.min(
        MAX_COMPACTION_TRANSCRIPT_CHARS,
        transcriptTokenBudget * SUMMARY_CHARS_PER_TOKEN_ESTIMATE,
      ),
    };
  }

  const transcriptTokenBudget = Math.max(
    1,
    hardInputLimitTokens - summaryReservedInputTokens,
  );
  if (summaryReservedInputTokens >= hardInputLimitTokens) {
    return {
      policyVersion: COMPACTION_POLICY_VERSION,
      source: "provider_summary_budget_exhausted",
      compactionEnabled: false,
      compactThresholdTokens: 0,
      keepRecentTokens: 0,
      summaryHardInputLimitTokens: hardInputLimitTokens,
      summaryReservedInputTokens,
      maxTranscriptChunkTokens: transcriptTokenBudget,
      maxTranscriptChunkChars: Math.min(
        MAX_COMPACTION_TRANSCRIPT_CHARS,
        transcriptTokenBudget * SUMMARY_CHARS_PER_TOKEN_ESTIMATE,
      ),
    };
  }
  if (optionalContextTargetTokens === 0) {
    return {
      policyVersion: COMPACTION_POLICY_VERSION,
      source: "provider_budget_exhausted",
      compactionEnabled: false,
      compactThresholdTokens: 0,
      keepRecentTokens: 0,
      summaryHardInputLimitTokens: hardInputLimitTokens,
      summaryReservedInputTokens,
      maxTranscriptChunkTokens: transcriptTokenBudget,
      maxTranscriptChunkChars: Math.min(
        MAX_COMPACTION_TRANSCRIPT_CHARS,
        transcriptTokenBudget * SUMMARY_CHARS_PER_TOKEN_ESTIMATE,
      ),
    };
  }

  const compactThresholdTokens = Math.max(
    1,
    Math.floor(optionalContextTargetTokens * TRIGGER_NUMERATOR / TRIGGER_DENOMINATOR),
  );
  const recentCeiling = Math.max(0, compactThresholdTokens - 1);
  const desiredRecentTokens = Math.floor(
    optionalContextTargetTokens * RETAIN_NUMERATOR / RETAIN_DENOMINATOR,
  );
  const keepRecentTokens = recentCeiling === 0
    ? 0
    : Math.min(
        recentCeiling,
        MAX_KEEP_RECENT_TOKENS,
        Math.max(Math.min(MIN_KEEP_RECENT_TOKENS, recentCeiling), desiredRecentTokens),
      );
  return {
    policyVersion: COMPACTION_POLICY_VERSION,
    source: "provider_budget",
    compactionEnabled: true,
    compactThresholdTokens,
    keepRecentTokens,
    summaryHardInputLimitTokens: hardInputLimitTokens,
    summaryReservedInputTokens,
    maxTranscriptChunkTokens: transcriptTokenBudget,
    maxTranscriptChunkChars: Math.min(
      MAX_COMPACTION_TRANSCRIPT_CHARS,
      transcriptTokenBudget * SUMMARY_CHARS_PER_TOKEN_ESTIMATE,
    ),
  };
}

function safeTokenNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be a non-negative safe integer token count`);
  }
  return Number(value);
}

function safeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer token count`);
  }
  return value;
}
