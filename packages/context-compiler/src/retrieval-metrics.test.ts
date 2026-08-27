import { describe, expect, test } from "bun:test";
import {
  aggregateRetrievalMetrics,
  evaluateRetrievalOutcome,
  summarizeRetrievalSelection,
  type RetrievalMetricCandidate,
} from "./retrieval-metrics.js";

function candidate(input: Partial<RetrievalMetricCandidate> & Pick<RetrievalMetricCandidate, "fragmentId">): RetrievalMetricCandidate {
  return {
    path: null,
    symbols: [],
    method: "lexical_bm25",
    estimatedTokens: 100,
    finalScore: 0.5,
    hardRequired: false,
    selected: false,
    selectionReason: "token budget exceeded",
    ...input,
  };
}

describe("retrieval metrics", () => {
  test("summarizes deterministic selection facts with stable method counts", () => {
    const candidates = [
      candidate({
        fragmentId: "a",
        path: "src/a.ts",
        method: "exact_path_symbol",
        estimatedTokens: 150,
        selected: true,
        selectionReason: "hard-required",
        hardRequired: true,
        finalScore: null,
      }),
      candidate({ fragmentId: "b", path: "src/b.ts", method: "lexical_bm25" }),
      candidate({
        fragmentId: "c",
        path: "src/c.ts",
        method: "lexical_bm25",
        estimatedTokens: 50,
        selected: true,
        selectionReason: "utility-ranked-within-budget",
      }),
    ];
    const result = summarizeRetrievalSelection({
      queryCount: 4,
      candidates,
      stablePrefixTokens: 150,
      predictedCachedTokens: 150,
    });

    expect(result.candidateCount).toBe(3);
    expect(result.selectedCount).toBe(2);
    expect(result.omittedCount).toBe(1);
    expect(result.candidateTokens).toBe(300);
    expect(result.selectedTokens).toBe(200);
    expect(result.methodCounts).toEqual({ exact_path_symbol: 1, lexical_bm25: 2 });
    expect(result.selectedMethodCounts).toEqual({ exact_path_symbol: 1, lexical_bm25: 1 });
    expect(result.omissionReasonCounts).toEqual({ "token budget exceeded": 1 });
  });

  test("computes labeled recall, irrelevance, cache, and outcome metrics", () => {
    const candidates = [
      candidate({
        fragmentId: "a",
        path: "src/a.ts",
        symbols: [{ path: "src/a.ts", name: "alpha" }],
        selected: true,
        selectionReason: "utility-ranked-within-budget",
      }),
      candidate({
        fragmentId: "c",
        path: "src/c.ts",
        symbols: [{ path: "src/c.ts", name: "gamma" }],
        selected: true,
        selectionReason: "utility-ranked-within-budget",
      }),
    ];
    const selection = summarizeRetrievalSelection({
      queryCount: 2,
      candidates,
      stablePrefixTokens: 200,
      predictedCachedTokens: 200,
    });
    const outcome = evaluateRetrievalOutcome({
      selection,
      candidates,
      oracle: {
        filePaths: ["src/a.ts", "src/missing.ts"],
        symbols: [
          { path: "src/a.ts", name: "alpha" },
          { path: "src/missing.ts", name: "missing" },
        ],
        relevantFragmentIds: ["a", "c"],
      },
      verifiedSuccess: true,
      firstAttemptLocalizationCorrect: true,
      firstAttemptEditCorrect: false,
      repeatedReads: 2,
      repeatedSearches: 1,
      observedCachedTokens: 100,
      unseenMonorepoQuality: 0.75,
    });

    expect(outcome.oracleFileRecall).toBe(0.5);
    expect(outcome.oracleSymbolRecall).toBe(0.5);
    expect(outcome.irrelevantFragmentRate).toBe(0);
    expect(outcome.contextTokensPerVerifiedSuccess).toBe(200);
    expect(outcome.firstAttemptLocalizationCorrect).toBe(true);
    expect(outcome.firstAttemptEditCorrect).toBe(false);
    expect(outcome.repeatedReads).toBe(2);
    expect(outcome.repeatedSearches).toBe(1);
    expect(outcome.cacheStablePrefixReuse).toBe(0.5);
    expect(outcome.unseenMonorepoQuality).toBe(0.75);
  });

  test("aggregates observed outcomes without turning missing labels into failures", () => {
    const emptySelection = summarizeRetrievalSelection({
      queryCount: 0,
      candidates: [],
      stablePrefixTokens: 0,
      predictedCachedTokens: 0,
    });
    const unknown = evaluateRetrievalOutcome({
      selection: emptySelection,
      candidates: [],
      verifiedSuccess: false,
    });
    const aggregate = aggregateRetrievalMetrics([
      {
        selection: emptySelection,
        outcome: unknown,
      },
    ]);

    expect(aggregate.runCount).toBe(1);
    expect(aggregate.verifiedSuccessCount).toBe(0);
    expect(aggregate.verifiedSuccessRate).toBe(0);
    expect(aggregate.oracleFileRecall).toBeNull();
    expect(aggregate.contextTokensPerVerifiedSuccess).toBeNull();
    expect(aggregate.firstAttemptEditAccuracy).toBeNull();
  });
});
