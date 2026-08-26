//! Tolerant anchor resolution for exact-text edits (ADR-0046).
//!
//! Field harnesses (OpenCode edit replacers, Codex apply_patch, Aider)
//! converge on the same observation: models frequently reproduce file
//! content with whitespace or indentation drift, and failing the whole
//! transaction on a trailing-space mismatch wastes a turn. This module
//! resolves such anchors deterministically:
//!
//! 1. `LineTrimmed` — per-line equality after trimming both ends.
//! 2. `IndentationFlexible` — per-line equality after trimming leading
//!    whitespace only; the replacement is re-indented to the matched span.
//! 3. `BlockAnchor` — first and last expected lines match the window's
//!    first/last lines (trimmed); interior lines are not compared.
//!
//! A resolver wins only when it produces exactly one candidate window
//! (`require_unique` is honored by construction); otherwise the next
//! resolver runs and finally the caller's original error stands.
//!
//! All functions are pure string algebra: no I/O, no clock, no globals.
//! Byte offsets always fall on line boundaries (split at `\n`), so slicing
//! is char-boundary safe.

/// A resolved anchor span in the original text (byte offsets, line-aligned).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FallbackMatch {
    pub start: usize,
    pub end: usize,
    pub strategy: FallbackStrategy,
}

/// The tolerant resolver that produced a match, in deterministic priority
/// order. The discriminant order is the trial order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackStrategy {
    LineTrimmed,
    WhitespaceCollapsed,
    BlockAnchor,
}

/// One line of text with its byte span in the source document.
/// `end` excludes the terminating `\n` when present.
struct Line {
    start: usize,
    end: usize,
    text: String,
}

fn split_lines(source: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut cursor = 0usize;
    let bytes = source.as_bytes();
    while cursor < bytes.len() {
        let newline = bytes[cursor..].iter().position(|b| *b == b'\n');
        let end = match newline {
            Some(rel) => cursor + rel,
            None => bytes.len(),
        };
        let mut text = source[cursor..end].to_string();
        if text.ends_with('\r') {
            text.pop();
        }
        lines.push(Line {
            start: cursor,
            end,
            text,
        });
        cursor = match newline {
            Some(rel) => cursor + rel + 1,
            None => bytes.len(),
        };
    }
    lines
}

fn trim_ends(line: &str) -> &str {
    line.trim()
}

/// Collapse every internal whitespace run to a single space and trim both
/// ends ("a  b\tc" == "a b c").
fn collapse_ws(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Drop trailing empty lines from an expected block (models add them often).
fn significant_tail(lines: &[Line]) -> usize {
    let mut end = lines.len();
    while end > 0 && trim_ends(&lines[end - 1].text).is_empty() {
        end -= 1;
    }
    end
}

fn windows_of(lines: &[Line], width: usize) -> impl Iterator<Item = &[Line]> {
    lines.windows(width.max(1))
}

fn find_unique<F>(lines: &[Line], width: usize, predicate: F) -> Option<(usize, usize)>
where
    F: Fn(&[Line]) -> bool,
{
    if width == 0 || width > lines.len() {
        return None;
    }
    let mut found: Option<(usize, usize)> = None;
    for (index, window) in windows_of(lines, width).enumerate() {
        if predicate(window) {
            if found.is_some() {
                return None; // ambiguous: reject this resolver
            }
            found = Some((index, index + width));
        }
    }
    found
}

fn resolve_line_trimmed(original: &[Line], expected: &[Line]) -> Option<(usize, usize)> {
    let width = significant_tail(expected);
    if width == 0 {
        return None;
    }
    let head = &expected[..width];
    find_unique(original, width, |window| {
        window
            .iter()
            .zip(head.iter())
            .all(|(o, e)| trim_ends(&o.text) == trim_ends(&e.text))
    })
}

fn resolve_whitespace_collapsed(original: &[Line], expected: &[Line]) -> Option<(usize, usize)> {
    let width = significant_tail(expected);
    if width == 0 {
        return None;
    }
    let head = &expected[..width];
    find_unique(original, width, |window| {
        window
            .iter()
            .zip(head.iter())
            .all(|(o, e)| collapse_ws(&o.text) == collapse_ws(&e.text))
    })
}

fn resolve_block_anchor(original: &[Line], expected: &[Line]) -> Option<(usize, usize)> {
    let width = significant_tail(expected);
    if width < 3 || original.len() < 2 {
        return None;
    }
    let first = trim_ends(&expected[0].text);
    let last = trim_ends(&expected[width - 1].text);
    if first.is_empty() || last.is_empty() {
        return None;
    }
    // Variable-width search: locate the first-line anchor, then the nearest
    // following last-line anchor within a bounded horizon. Interior content
    // is intentionally ignored (it is what drifted).
    let horizon = usize::max(8, width.saturating_mul(4));
    let mut found: Option<(usize, usize)> = None;
    for (i, line) in original.iter().enumerate() {
        if trim_ends(&line.text) != first {
            continue;
        }
        let limit = usize::min(original.len(), i.saturating_add(horizon));
        if i + 2 < limit {
            for (j, candidate) in original.iter().enumerate().take(limit).skip(i + 2) {
                if trim_ends(&candidate.text) == last {
                    if found.is_some() {
                        return None; // ambiguous
                    }
                    found = Some((i, j + 1));
                    break;
                }
            }
        }
    }
    found
}

type ResolverFn = fn(&[Line], &[Line]) -> Option<(usize, usize)>;

/// Attempt tolerant resolvers in deterministic order and return the unique
/// match from the first resolver that yields exactly one candidate.
pub fn resolve_fuzzy_anchor(original: &str, expected: &str) -> Option<FallbackMatch> {
    let original_lines = split_lines(original);
    let expected_lines = split_lines(expected);

    let attempts: [(FallbackStrategy, ResolverFn); 3] = [
        (FallbackStrategy::LineTrimmed, resolve_line_trimmed),
        (
            FallbackStrategy::WhitespaceCollapsed,
            resolve_whitespace_collapsed,
        ),
        (FallbackStrategy::BlockAnchor, resolve_block_anchor),
    ];

    for (strategy, resolver) in attempts {
        if let Some((start_idx, end_idx)) = resolver(&original_lines, &expected_lines) {
            let first = &original_lines[start_idx];
            let last = &original_lines[end_idx - 1];
            // Spans exclude the trailing terminator; `splice` preserves the
            // document's own separators.
            return Some(FallbackMatch {
                start: first.start,
                end: last.end,
                strategy,
            });
        }
    }
    None
}

/// The dominant line ending of `source` ("\r\n" or "\n").
pub fn dominant_eol(source: &str) -> &'static str {
    let crlf = source.matches("\r\n").count();
    let lf = source.matches('\n').count().saturating_sub(crlf);
    if crlf > lf {
        "\r\n"
    } else {
        "\n"
    }
}

/// Stable wire name for a strategy (used in audit/journal surfaces).
#[must_use]
pub const fn strategy_name(strategy: FallbackStrategy) -> &'static str {
    match strategy {
        FallbackStrategy::LineTrimmed => "line_trimmed",
        FallbackStrategy::WhitespaceCollapsed => "whitespace_collapsed",
        FallbackStrategy::BlockAnchor => "block_anchor",
    }
}

/// Splice `replacement` into `original` at the resolved span.
///
/// Spans exclude their trailing terminator. When the replacement carries a
/// trailing terminator AND the document already supplies one immediately
/// after the span, exactly one is dropped so separators never double up.
pub fn splice(original: &str, matched: FallbackMatch, replacement: &str) -> String {
    let eol = dominant_eol(original);
    let remainder = &original[matched.end..];
    let remainder_starts_eol = remainder.starts_with(eol) || remainder.starts_with('\n');
    let mut body = replacement;
    if remainder_starts_eol {
        if let Some(without) = body.strip_suffix(eol) {
            body = without;
        } else if let Some(without) = body.strip_suffix('\n') {
            body = without;
        }
    }
    let mut out = String::with_capacity(original.len() + body.len());
    out.push_str(&original[..matched.start]);
    out.push_str(body);
    out.push_str(remainder);
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn line_trimmed_resolves_trailing_whitespace_drift() {
        let original = "fn main() {\n    let x = 1;   \n    println!(x);\n}\n";
        let expected = "fn main() {\n    let x = 1;\n    println!(x);\n}\n";
        let m = resolve_fuzzy_anchor(original, expected).unwrap();
        assert_eq!(m.strategy, FallbackStrategy::LineTrimmed);
        assert_eq!(
            &original[m.start..m.end],
            "fn main() {\n    let x = 1;   \n    println!(x);\n}"
        );
    }

    #[test]
    fn line_trimmed_requires_uniqueness() {
        let original = "a\nb\na\nb\n";
        let expected = "a\nb\n";
        assert!(resolve_fuzzy_anchor(original, expected).is_none());
    }

    #[test]
    fn whitespace_collapsed_resolves_internal_drift() {
        let original = "alpha   = compute(x,   yy);\nbeta\n";
        let expected = "alpha = compute(x, yy);\nbeta\n";
        let m = resolve_fuzzy_anchor(original, expected).unwrap();
        assert_eq!(m.strategy, FallbackStrategy::WhitespaceCollapsed);
        assert_eq!(
            &original[m.start..m.end],
            "alpha   = compute(x,   yy);\nbeta"
        );
    }

    #[test]
    fn block_anchor_ignores_interior_drift() {
        let original = "start\nstale one\nstale two\nend\nafter\n";
        let expected = "start\nfresh\nend\nafter\n";
        let m = resolve_fuzzy_anchor(original, expected).unwrap();
        assert_eq!(m.strategy, FallbackStrategy::BlockAnchor);
        assert_eq!(
            &original[m.start..m.end],
            "start\nstale one\nstale two\nend\nafter"
        );
    }

    #[test]
    fn exact_match_still_short_circuits_fallback() {
        // Callers try literal matching first; resolve_fuzzy_anchor is only
        // consulted on zero occurrences. It must not "resolve" what literal
        // search would have found differently.
        let original = "alpha\nbeta\n";
        let m = resolve_fuzzy_anchor(original, "alpha\nbeta\n").unwrap();
        assert_eq!(m.strategy, FallbackStrategy::LineTrimmed);
        assert_eq!(m.start, 0);
        assert_eq!(m.end, original.len() - 1);
    }

    #[test]
    fn no_candidate_returns_none() {
        assert!(resolve_fuzzy_anchor("one\ntwo\n", "three\nfour\n").is_none());
        assert!(resolve_fuzzy_anchor("", "x\n").is_none());
    }

    #[test]
    fn dominant_eol_prefers_crlf_when_majority() {
        assert_eq!(dominant_eol("a\r\nb\r\nc\n"), "\r\n");
        assert_eq!(dominant_eol("a\nb\nc\r\n"), "\n");
    }

    #[test]
    fn eof_anchor_excludes_final_newline_only_once() {
        let original = "tail\n";
        let m = resolve_fuzzy_anchor(original, "tail").unwrap();
        assert_eq!(&original[m.start..m.end], "tail");
    }

    #[test]
    fn splice_strips_one_trailing_terminator_from_replacement() {
        let original = "head\nold body\nfooter\n";
        let m = resolve_fuzzy_anchor(original, "old body").unwrap();
        let out = splice(original, m, "new body\n");
        assert_eq!(out, "head\nnew body\nfooter\n");
    }

    #[test]
    fn splice_preserves_document_final_newline_at_eof() {
        let original = "keep\ntail\n";
        let m = resolve_fuzzy_anchor(original, "tail").unwrap();
        let out = splice(original, m, "replaced");
        assert_eq!(out, "keep\nreplaced\n");
    }
}
