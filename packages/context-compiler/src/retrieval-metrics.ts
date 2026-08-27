/**
 * Provider-neutral retrieval measurements and offline outcome reduction.
 *
 * The compiler records selection facts during every run. Outcome labels are
 * optional because production runs do not have an oracle until evaluation or
 * verification supplies one. Missing labels stay null rather than becoming
 * false or zero-shaped evidence.
 */

export const RETRIEVAL_METRICS_VERSION = "terminus.retrieval-metrics.v1" as const;

export interface RetrievalMetricSymbol {
  readonly path: string;
  readonly name: string;
}

export interface RetrievalMetricCandidate {
  readonly fragmentId: string;
  readonly path: string | null;
  readonly symbols: readonly RetrievalMetricSymbol[];
  readonly method: string;
  readonly estimatedTokens: number;
  readonly finalScore: number | null;
  readonly hardRequired: boolean;
  readonly selected: boolean;
  readonly selectionReason: string;
}

export interface RetrievalSelectionMetricInput {
  readonly queryCount: number;
  readonly candidates: readonly RetrievalMetricCandidate[];
  readonly stablePrefixTokens: number;
  readonly predictedCachedTokens: number;
}

export interface RetrievalSelectionMetrics {
  readonly version: typeof RETRIEVAL_METRICS_VERSION;
  readonly queryCount: number;
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly omittedCount: number;
  readonly candidateTokens: number;
  readonly selectedTokens: number;
  readonly stablePrefixTokens: number;
  readonly predictedCachedTokens: number;
  readonly methodCounts: Readonly<Record<string, number>>;
  readonly selectedMethodCounts: Readonly<Record<string, number>>;
  readonly omissionReasonCounts: Readonly<Record<string, number>>;
}

export interface RetrievalOracle {
  readonly filePaths?: readonly string[] | undefined;
  readonly symbols?: readonly RetrievalMetricSymbol[] | undefined;
  readonly relevantFragmentIds?: readonly string[] | undefined;
}

export interface RetrievalOutcomeInput {
  readonly selection: RetrievalSelectionMetrics;
  readonly candidates: readonly RetrievalMetricCandidate[];
  readonly oracle?: RetrievalOracle | undefined;
  readonly verifiedSuccess?: boolean | null | undefined;
  readonly firstAttemptLocalizationCorrect?: boolean | null | undefined;
  readonly firstAttemptEditCorrect?: boolean | null | undefined;
  readonly repeatedReads?: number | null | undefined;
  readonly repeatedSearches?: number | null | undefined;
  readonly observedCachedTokens?: number | null | undefined;
  readonly unseenMonorepoQuality?: number | null | undefined;
}

export interface RetrievalOutcomeMetrics {
  readonly oracleFileRecall: number | null;
  readonly oracleSymbolRecall: number | null;
  readonly irrelevantFragmentRate: number | null;
  readonly contextTokensPerVerifiedSuccess: number | null;
  readonly firstAttemptLocalizationCorrect: boolean | null;
  readonly firstAttemptEditCorrect: boolean | null;
  readonly repeatedReads: number | null;
  readonly repeatedSearches: number | null;
  readonly cacheStablePrefixReuse: number | null;
  readonly unseenMonorepoQuality: number | null;
}

export interface RetrievalRunMetrics {
  readonly selection: RetrievalSelectionMetrics;
  readonly outcome: RetrievalOutcomeMetrics;
}

export interface RetrievalAggregateMetrics {
  readonly version: typeof RETRIEVAL_METRICS_VERSION;
  readonly runCount: number;
  readonly verifiedSuccessCount: number;
  readonly verifiedSuccessRate: number | null;
  readonly oracleFileRecall: number | null;
  readonly oracleSymbolRecall: number | null;
  readonly irrelevantFragmentRate: number | null;
  readonly contextTokensPerVerifiedSuccess: number | null;
  readonly firstAttemptLocalizationAccuracy: number | null;
  readonly firstAttemptEditAccuracy: number | null;
  readonly averageRepeatedReads: number | null;
  readonly averageRepeatedSearches: number | null;
  readonly cacheStablePrefixReuse: number | null;
  readonly unseenMonorepoQuality: number | null;
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireOptionalCount(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  return requireCount(value, label);
}

function requireQuality(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number in [0, 1]`);
  }
  return value;
}

function sortedCounts(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
}

function validateCandidates(candidates: readonly RetrievalMetricCandidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.fragmentId.length === 0 || seen.has(candidate.fragmentId)) {
      throw new Error("retrieval metric candidates must have unique non-empty fragment IDs");
    }
    seen.add(candidate.fragmentId);
    requireFiniteNonNegative(candidate.estimatedTokens, `estimated tokens for ${candidate.fragmentId}`);
    if (candidate.finalScore !== null) {
      if (!Number.isFinite(candidate.finalScore)) {
        throw new Error(`final score for ${candidate.fragmentId} must be finite or null`);
      }
    }
    if (candidate.selectionReason.length === 0) {
      throw new Error(`selection reason for ${candidate.fragmentId} must not be empty`);
    }
    for (const symbol of candidate.symbols) {
      if (symbol.path.length === 0 || symbol.name.length === 0) {
        throw new Error(`retrieval metric symbols for ${candidate.fragmentId} must be non-empty`);
      }
    }
  }
}

/** Summarize the deterministic candidate decision persisted with a manifest. */
export function summarizeRetrievalSelection(
  input: RetrievalSelectionMetricInput,
): RetrievalSelectionMetrics {
  requireCount(input.queryCount, "retrieval query count");
  requireFiniteNonNegative(input.stablePrefixTokens, "stable prefix tokens");
  requireFiniteNonNegative(input.predictedCachedTokens, "predicted cached tokens");
  validateCandidates(input.candidates);

  const selected = input.candidates.filter((candidate) => candidate.selected);
  const omitted = input.candidates.filter((candidate) => !candidate.selected);
  return {
    version: RETRIEVAL_METRICS_VERSION,
    queryCount: input.queryCount,
    candidateCount: input.candidates.length,
    selectedCount: selected.length,
    omittedCount: omitted.length,
    candidateTokens: input.candidates.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0),
    selectedTokens: selected.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0),
    stablePrefixTokens: input.stablePrefixTokens,
    predictedCachedTokens: input.predictedCachedTokens,
    methodCounts: sortedCounts(input.candidates.map((candidate) => candidate.method)),
    selectedMethodCounts: sortedCounts(selected.map((candidate) => candidate.method)),
    omissionReasonCounts: sortedCounts(omitted.map((candidate) => candidate.selectionReason)),
  };
}

function recall<T>(oracle: readonly T[] | undefined, observed: ReadonlySet<T>): number | null {
  if (oracle === undefined || oracle.length === 0) return null;
  const unique = [...new Set(oracle)];
  if (unique.length === 0) return null;
  return unique.filter((item) => observed.has(item)).length / unique.length;
}

function symbolKey(symbol: RetrievalMetricSymbol): string {
  return `${symbol.path}\u0000${symbol.name}`;
}

function selectedCandidates(candidates: readonly RetrievalMetricCandidate[]): readonly RetrievalMetricCandidate[] {
  return candidates.filter((candidate) => candidate.selected);
}

/** Compute labeled retrieval outcomes without inventing absent ground truth. */
export function evaluateRetrievalOutcome(input: RetrievalOutcomeInput): RetrievalOutcomeMetrics {
  validateCandidates(input.candidates);
  const selected = selectedCandidates(input.candidates);
  const selectedPaths = new Set(
    selected.flatMap((candidate) => candidate.path === null ? [] : [candidate.path]),
  );
  const selectedSymbols = new Set(
    selected.flatMap((candidate) => candidate.symbols.map(symbolKey)),
  );
  const oracle = input.oracle;
  const relevant = oracle?.relevantFragmentIds;
  const irrelevantFragmentRate = relevant === undefined || selected.length === 0
    ? null
    : 1 - selected.filter((candidate) => relevant.includes(candidate.fragmentId)).length / selected.length;
  const observedCachedTokens = input.observedCachedTokens === null || input.observedCachedTokens === undefined
    ? null
    : requireFiniteNonNegative(input.observedCachedTokens, "observed cached tokens");
  const cacheStablePrefixReuse = observedCachedTokens === null || input.selection.predictedCachedTokens <= 0
    ? null
    : observedCachedTokens / input.selection.predictedCachedTokens;

  return {
    oracleFileRecall: recall(oracle?.filePaths, selectedPaths),
    oracleSymbolRecall: recall(
      oracle?.symbols?.map(symbolKey),
      selectedSymbols,
    ),
    irrelevantFragmentRate,
    contextTokensPerVerifiedSuccess: input.verifiedSuccess === true
      ? input.selection.selectedTokens
      : null,
    firstAttemptLocalizationCorrect: input.firstAttemptLocalizationCorrect ?? null,
    firstAttemptEditCorrect: input.firstAttemptEditCorrect ?? null,
    repeatedReads: requireOptionalCount(input.repeatedReads, "repeated reads"),
    repeatedSearches: requireOptionalCount(input.repeatedSearches, "repeated searches"),
    cacheStablePrefixReuse,
    unseenMonorepoQuality: requireQuality(input.unseenMonorepoQuality, "unseen monorepo quality"),
  };
}

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : present.reduce((sum, value) => sum + value, 0) / present.length;
}

function booleanRate(values: readonly (boolean | null)[]): number | null {
  const present = values.filter((value): value is boolean => value !== null);
  return present.length === 0
    ? null
    : present.filter(Boolean).length / present.length;
}

/** Aggregate only observed labels; empty cohorts remain explicitly null. */
export function aggregateRetrievalMetrics(
  runs: readonly RetrievalRunMetrics[],
): RetrievalAggregateMetrics {
  const verifiedSuccesses = runs.filter((run) => run.outcome.contextTokensPerVerifiedSuccess !== null).length;
  return {
    version: RETRIEVAL_METRICS_VERSION,
    runCount: runs.length,
    verifiedSuccessCount: verifiedSuccesses,
    verifiedSuccessRate: runs.length === 0 ? null : verifiedSuccesses / runs.length,
    oracleFileRecall: mean(runs.map((run) => run.outcome.oracleFileRecall)),
    oracleSymbolRecall: mean(runs.map((run) => run.outcome.oracleSymbolRecall)),
    irrelevantFragmentRate: mean(runs.map((run) => run.outcome.irrelevantFragmentRate)),
    contextTokensPerVerifiedSuccess: mean(
      runs.map((run) => run.outcome.contextTokensPerVerifiedSuccess),
    ),
    firstAttemptLocalizationAccuracy: booleanRate(
      runs.map((run) => run.outcome.firstAttemptLocalizationCorrect),
    ),
    firstAttemptEditAccuracy: booleanRate(
      runs.map((run) => run.outcome.firstAttemptEditCorrect),
    ),
    averageRepeatedReads: mean(runs.map((run) => run.outcome.repeatedReads)),
    averageRepeatedSearches: mean(runs.map((run) => run.outcome.repeatedSearches)),
    cacheStablePrefixReuse: mean(runs.map((run) => run.outcome.cacheStablePrefixReuse)),
    unseenMonorepoQuality: mean(runs.map((run) => run.outcome.unseenMonorepoQuality)),
  };
}
