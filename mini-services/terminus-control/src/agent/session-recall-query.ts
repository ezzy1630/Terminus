interface NormalizedRecallText {
  readonly text: string;
  readonly sourceIndexByCodeUnit: readonly number[];
}

// skipcq: JS-0004
const ASCII_TEXT = /^[\x00-\x7f]*$/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function simpleFoldPrefixMatcher(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const alternatives = [...terms]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(escapeRegex);
  return new RegExp(`^(?:${alternatives.join("|")})`, "iu");
}

function normalizeRecall(value: string, sourceIndexByCodeUnit: number[] | null): string {
  let normalized = "";
  let previousBaseWasLatin = false;
  for (const [sourceIndex, sourceCharacter] of Array.from(value).entries()) {
    const decomposed = sourceCharacter.toLowerCase().normalize("NFD");
    for (const decomposedCharacter of decomposed) {
      const character = decomposedCharacter;
      if (/\p{M}/u.test(character)) {
        // Accent-insensitive matching is useful for Latin text, but stripping
        // every mark changes the identity of Indic, Arabic, and other scripts.
        if (previousBaseWasLatin && /[\u0300-\u036f]/u.test(character)) continue;
      } else {
        previousBaseWasLatin = /\p{Script=Latin}/u.test(character);
      }
      normalized += character;
      if (sourceIndexByCodeUnit !== null) {
        for (let codeUnit = 0; codeUnit < character.length; codeUnit += 1) {
          sourceIndexByCodeUnit.push(sourceIndex);
        }
      }
    }
  }
  return normalized;
}

function normalizeForRecallWithSourceMap(value: string): NormalizedRecallText {
  if (ASCII_TEXT.test(value)) {
    return {
      text: value.toLowerCase(),
      sourceIndexByCodeUnit: Array.from({ length: value.length }, (_, index) => index),
    };
  }
  const sourceIndexByCodeUnit: number[] = [];
  return {
    text: normalizeRecall(value, sourceIndexByCodeUnit),
    sourceIndexByCodeUnit,
  };
}

function normalizeForRecall(value: string): string {
  if (ASCII_TEXT.test(value)) return value.toLowerCase();
  return normalizeRecall(value, null);
}

function tokenBoundedPhraseOffset(text: string, phrase: string): number | null {
  if (phrase.length === 0) return null;
  const tokenCharacter = "[\\p{L}\\p{N}\\p{M}]";
  const matcher = new RegExp(`(?<!${tokenCharacter})${escapeRegex(phrase)}(?!${tokenCharacter})`, "iu");
  return matcher.exec(text)?.index ?? null;
}

/** Tokenization shared by bounded scan scoring and the SQLite FTS query. */
export function sessionRecallQueryTerms(query: string): readonly string[] {
  return [...new Set(normalizeForRecall(query).match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])];
}

/**
 * FTS terms preserve combining marks. SQLite's unicode61 tokenizer decides
 * its own script-specific case and diacritic folding; pre-folding every mark
 * would corrupt Indic, Tamil, and Arabic tokens before they reach SQLite.
 */
export function sessionRecallFtsQueryTerms(query: string): readonly string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])];
}

/**
 * Deterministic lexical reranking over exact hydrated sources.
 *
 * Terms intentionally use prefix matching, like the FTS query. This keeps an
 * indexed hit eligible after hydration instead of dropping it because the
 * discovery and reranking tokenizers disagree.
 */
export function sessionRecallLexicalScore(text: string, query: string): number {
  const haystack = normalizeForRecall(text);
  const phrase = normalizeForRecall(query.trim());
  const terms = sessionRecallQueryTerms(query);
  if (terms.length === 0) return 0;
  let score = tokenBoundedPhraseOffset(haystack, phrase) === null ? 0 : 100;
  const prefixMatcher = simpleFoldPrefixMatcher(terms);
  if (prefixMatcher !== null) {
    let occurrences = 0;
    for (const match of haystack.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
      const token = match[0];
      if (token === undefined || !prefixMatcher.test(token)) continue;
      occurrences += 1;
      if (occurrences === 20) break;
    }
    score += occurrences;
  }
  return score;
}

/** Source-code-point offset of the first phrase or term match. */
export function sessionRecallMatchStart(text: string, query: string): number | null {
  const { text: normalized, sourceIndexByCodeUnit } = normalizeForRecallWithSourceMap(text);
  const phrase = normalizeForRecall(query.trim());
  const phraseOffset = tokenBoundedPhraseOffset(normalized, phrase);
  if (phraseOffset !== null) return sourceIndexByCodeUnit[phraseOffset] ?? 0;
  const terms = sessionRecallQueryTerms(query);
  const prefixMatcher = simpleFoldPrefixMatcher(terms);
  if (prefixMatcher === null) return null;
  for (const match of normalized.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const token = match[0];
    const offset = match.index;
    if (token !== undefined && offset !== undefined && prefixMatcher.test(token)) {
      return sourceIndexByCodeUnit[offset] ?? 0;
    }
  }
  return null;
}
