import { describe, expect, it } from "bun:test";
import {
  calculateBm25Score,
  computeAvgDocTokens,
  computeDocumentFrequencies,
  computeTermFrequencies,
  countTokensForBm25,
  rankDocumentsBm25,
  scoreDocumentBm25,
  tokenizeForBm25,
} from "./bm25.js";

describe("BM25 with token-based normalization", () => {
  it("tokenizes text into lowercase tokens filtering single characters", () => {
    const tokens = tokenizeForBm25("function calculateTotal_v2(price, tax, a) { return price + tax; }");
    expect(tokens).toContain("function");
    expect(tokens).toContain("calculatetotal_v2");
    expect(tokens).toContain("price");
    expect(tokens).toContain("tax");
    expect(tokens).toContain("return");
    expect(tokens).not.toContain("a"); // single char filtered
  });

  it("computes document length in tokens", () => {
    const count = countTokensForBm25("hello world foo bar");
    expect(count).toBe(4);
  });

  it("computes term and document frequencies accurately", () => {
    const doc1 = tokenizeForBm25("error in auth handler");
    const doc2 = tokenizeForBm25("success in auth service");
    const doc3 = tokenizeForBm25("database connection error");

    const tf1 = computeTermFrequencies(doc1);
    expect(tf1.get("auth")).toBe(1);
    expect(tf1.get("in")).toBe(1);

    const df = computeDocumentFrequencies([doc1, doc2, doc3]);
    expect(df.get("auth")).toBe(2);
    expect(df.get("error")).toBe(2);
    expect(df.get("database")).toBe(1);
  });

  it("computes average document length in tokens", () => {
    const doc1 = tokenizeForBm25("one two three"); // 3 tokens
    const doc2 = tokenizeForBm25("one two three four five"); // 5 tokens
    const avg = computeAvgDocTokens([doc1, doc2]);
    expect(avg).toBe(4);
  });

  it("penalizes document length using tokens not characters", () => {
    // Both docs contain 'target_term' once.
    // Short doc has few tokens; long doc has many tokens.
    const shortDoc = tokenizeForBm25("target_term some other context");
    const longDoc = tokenizeForBm25("target_term " + "filler word ".repeat(50));
    const corpus = [shortDoc, longDoc];
    const df = computeDocumentFrequencies(corpus);
    const avgdl = computeAvgDocTokens(corpus);

    const shortScore = scoreDocumentBm25({
      queryTokens: ["target_term"],
      docTokens: shortDoc,
      docFrequencies: df,
      corpusSize: 2,
      avgDocTokens: avgdl,
    });

    const longScore = scoreDocumentBm25({
      queryTokens: ["target_term"],
      docTokens: longDoc,
      docFrequencies: df,
      corpusSize: 2,
      avgDocTokens: avgdl,
    });

    expect(shortScore).toBeGreaterThan(longScore);
  });

  it("ranks documents by BM25 relevance", () => {
    const docs = [
      { id: "1", text: "database retry logic and connection pool" },
      { id: "2", text: "user authentication with jwt tokens" },
      { id: "3", text: "database query retry with exponential backoff" },
    ];

    const ranked = rankDocumentsBm25({
      query: "database retry backoff",
      documents: docs,
      getText: (d) => d.text,
    });

    expect(ranked.length).toBeGreaterThan(0);
    // doc 3 matches database, retry, and backoff -> should rank first
    expect(ranked[0]!.item.id).toBe("3");
    expect(ranked[1]!.item.id).toBe("1");
  });

  it("computes standalone single-doc score with token normalization", () => {
    const scoreExact = calculateBm25Score("shipping threshold", "shipping threshold is 75 dollars");
    const scorePartial = calculateBm25Score("shipping threshold", "shipping cost flat rate");
    const scoreZero = calculateBm25Score("shipping threshold", "user password reset");

    expect(scoreExact).toBeGreaterThan(scorePartial);
    expect(scorePartial).toBeGreaterThan(scoreZero);
    expect(scoreZero).toBe(0);
  });
});
