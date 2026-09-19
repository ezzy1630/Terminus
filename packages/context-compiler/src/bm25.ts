/**
 * Canonical BM25 scoring with token-based document length normalization.
 * Re-exported from @terminus/context-ir.
 */
export type { Bm25Options, Bm25ScoredItem } from "@terminus/context-ir";
export {
  tokenizeForBm25,
  countTokensForBm25,
  computeTermFrequencies,
  computeDocumentFrequencies,
  computeAvgDocTokens,
  scoreDocumentBm25,
  calculateBm25Score,
  rankDocumentsBm25,
} from "@terminus/context-ir";
