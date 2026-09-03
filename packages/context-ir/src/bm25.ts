/**
 * Canonical BM25 scoring with token-based document length normalization.
 *
 * Implements Okapi BM25 ranking (SPEC §8.4, §34.6) where document lengths (dl)
 * and average document lengths (avgdl) are computed in TOKENS, not characters.
 */

export interface Bm25Options {
  /** Term frequency saturation parameter. Default is 1.5. */
  readonly k1?: number;
  /** Length normalization parameter in [0, 1]. Default is 0.75. */
  readonly b?: number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/** Tokenize a string into alphanumeric terms for lexical BM25 matching. */
export function tokenizeForBm25(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
}

/** Compute the document length in tokens. */
export function countTokensForBm25(text: string): number {
  return Math.max(1, tokenizeForBm25(text).length);
}

/** Compute term frequencies for a single document. */
export function computeTermFrequencies(tokens: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

/** Compute document frequencies across a corpus of documents. */
export function computeDocumentFrequencies(
  tokenizedDocs: ReadonlyArray<readonly string[]>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const tokens of tokenizedDocs) {
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      map.set(token, (map.get(token) ?? 0) + 1);
    }
  }
  return map;
}

/** Compute average document length in tokens across tokenized documents. */
export function computeAvgDocTokens(tokenizedDocs: ReadonlyArray<readonly string[]>): number {
  if (tokenizedDocs.length === 0) return 1;
  const totalTokens = tokenizedDocs.reduce((sum, doc) => sum + doc.length, 0);
  return Math.max(1, totalTokens / tokenizedDocs.length);
}

/**
 * Score a single document against query tokens using BM25 with token length normalization.
 */
export function scoreDocumentBm25(input: {
  readonly queryTokens: readonly string[];
  readonly docTokens: readonly string[];
  readonly docFrequencies: ReadonlyMap<string, number>;
  readonly corpusSize: number;
  readonly avgDocTokens: number;
  readonly options?: Bm25Options | undefined;
}): number {
  const { queryTokens, docTokens, docFrequencies, corpusSize, avgDocTokens, options } = input;
  if (queryTokens.length === 0 || docTokens.length === 0 || corpusSize <= 0) return 0;

  const k1 = options?.k1 ?? DEFAULT_K1;
  const b = options?.b ?? DEFAULT_B;
  const N = Math.max(1, corpusSize);
  const dl = Math.max(1, docTokens.length);
  const avgdl = Math.max(1, avgDocTokens);
  const tfMap = computeTermFrequencies(docTokens);

  let totalScore = 0;
  for (const term of queryTokens) {
    const tf = tfMap.get(term) ?? 0;
    if (tf === 0) continue;
    const df = docFrequencies.get(term) ?? 0;
    // Standard Robertson-Spärck Jones IDF
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (dl / avgdl));
    totalScore += idf * ((tf * (k1 + 1)) / Math.max(1e-6, denom));
  }

  return Math.max(0, totalScore);
}

/**
 * Standalone BM25 scoring for an isolated (query, text) pair.
 * Used by ACI search and single-document ranking where full-corpus DF is absent.
 * Uses token-based length normalization.
 */
export function calculateBm25Score(
  query: string,
  text: string,
  options?: Bm25Options,
): number {
  const qTokens = tokenizeForBm25(query);
  const dTokens = tokenizeForBm25(text);
  if (qTokens.length === 0 || dTokens.length === 0) return 0;

  const k1 = options?.k1 ?? DEFAULT_K1;
  const b = options?.b ?? DEFAULT_B;
  const dl = Math.max(1, dTokens.length);
  // Default expected line/snippet length baseline: 40 tokens
  const avgdl = 40;
  const tfMap = computeTermFrequencies(dTokens);

  let score = 0;
  for (const term of qTokens) {
    const tf = tfMap.get(term) ?? 0;
    if (tf === 0) continue;
    // Token-normalized term-frequency contribution
    const denom = tf + k1 * (1 - b + b * (dl / avgdl));
    score += (tf * (k1 + 1)) / Math.max(1e-6, denom);
  }

  return score;
}

export interface Bm25ScoredItem<T> {
  readonly item: T;
  readonly score: number;
  readonly docTokens: readonly string[];
}

/**
 * Rank a list of documents against a query string using token-normalized BM25.
 */
export function rankDocumentsBm25<T>(input: {
  readonly query: string;
  readonly documents: readonly T[];
  readonly getText: (doc: T) => string;
  readonly limit?: number;
  readonly options?: Bm25Options;
}): readonly Bm25ScoredItem<T>[] {
  const { query, documents, getText, limit, options } = input;
  const queryTokens = tokenizeForBm25(query);
  if (queryTokens.length === 0 || documents.length === 0) return [];

  const tokenizedDocs = documents.map((doc) => tokenizeForBm25(getText(doc)));
  const df = computeDocumentFrequencies(tokenizedDocs);
  const avgDocLength = computeAvgDocTokens(tokenizedDocs);
  const corpusSize = documents.length;

  const scored: Bm25ScoredItem<T>[] = [];
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i]!;
    const docTokens = tokenizedDocs[i]!;
    const score = scoreDocumentBm25({
      queryTokens,
      docTokens,
      docFrequencies: df,
      corpusSize,
      avgDocTokens: avgDocLength,
      options,
    });
    if (score > 0) {
      scored.push({ item: doc, score, docTokens });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return limit !== undefined && limit > 0 ? scored.slice(0, limit) : scored;
}
