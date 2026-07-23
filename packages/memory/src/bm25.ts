/**
 * Okapi BM25 lexical scoring for durable-memory retrieval (SPEC §39.6, §7.3).
 *
 * Corpus-aware: IDF uses the candidate set. Pure — no I/O.
 */
export interface Bm25Params {
  readonly k1: number;
  readonly b: number;
}

export const DEFAULT_BM25_PARAMS: Bm25Params = {
  k1: 1.2,
  b: 0.75,
};

export function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./+-]+/)
    .filter((t) => t.length > 0);
}

export interface Bm25Document {
  readonly id: string;
  readonly tokens: readonly string[];
}

/**
 * Score `doc` against `query` given a corpus used for IDF and average length.
 */
export function bm25Score(
  queryTokens: readonly string[],
  doc: Bm25Document,
  corpus: readonly Bm25Document[],
  params: Bm25Params = DEFAULT_BM25_PARAMS,
): number {
  if (queryTokens.length === 0 || corpus.length === 0) return 0;

  const n = corpus.length;
  const avgdl = corpus.reduce((sum, d) => sum + d.tokens.length, 0) / n;
  const dl = doc.tokens.length;
  const tfMap = termFrequency(doc.tokens);

  let score = 0;
  for (const term of unique(queryTokens)) {
    const tf = tfMap.get(term) ?? 0;
    if (tf === 0) continue;
    const df = corpus.filter((d) => d.tokens.includes(term)).length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    const denom = tf + params.k1 * (1 - params.b + (params.b * dl) / Math.max(avgdl, 1e-9));
    score += idf * ((tf * (params.k1 + 1)) / denom);
  }
  return score;
}

function termFrequency(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) {
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

function unique(tokens: readonly string[]): readonly string[] {
  return [...new Set(tokens)];
}
