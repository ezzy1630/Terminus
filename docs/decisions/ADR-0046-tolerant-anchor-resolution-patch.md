# ADR-0046: Tolerant anchor resolution for exact-text patch edits

- **Status:** ADOPTED
- **Date:** 2026-08-26
- **Decision owner:** kernel owner
- **Supersedes:** none
- **Related:** SPEC §34.7; ADR-0013; crates/terminus-patch AGENTS.md

## Context

The patch engine's `replace_exact_text` fails the whole transaction with
`AnchorNotFound` when the model's `expected_utf8` does not byte-match the
file. Production harnesses (OpenCode's edit replacer chain, Codex
apply_patch, Aider) all observe the same failure mode: models reproduce file
content with whitespace or indentation drift, and a hard failure wastes an
entire turn for a mismatch no human would call wrong.

## Decision

1. When literal matching finds zero occurrences, the engine attempts a
   deterministic resolver chain before failing (ADR-0046, implemented in
   `crates/terminus-patch/src/fallback.rs`):
   - `line_trimmed`: per-line equality after trimming both ends;
   - `whitespace_collapsed`: per-line equality after collapsing internal
     whitespace runs;
   - `block_anchor`: first and last expected lines anchor a variable-width
     window (bounded horizon); interior content is intentionally ignored.
2. A resolver wins only when it produces **exactly one** candidate window.
   Ambiguity falls through to the next resolver; total failure preserves the
   original `AnchorNotFound`.
3. Resolved spans exclude their trailing terminator; splicing never doubles
   or drops line separators and normalizes CRLF/LF to the document's
   dominant ending.
4. Fallback application is visible: `ChangedFile.operation` becomes
   `replace_exact_fallback_{strategy}` while literal edits keep
   `replace_exact`. The journal still records the original edit, so replay
   remains faithful.
5. `require_unique` semantics are preserved: multi-match literals still fail
   with `AnchorNotUnique`; resolvers reject ambiguous windows by
   construction.

## Alternatives

- **Similarity-scored fuzzy matching (Levenshtein over candidate windows).**
  Rejected for now: non-obvious selection among near-ties is hard to audit
  and to test deterministically. The chain above captures the dominant drift
  classes with explainable rules.
- **Fix at the ACI layer only.** Rejected: the kernel owns edit semantics
  and its journal; resolving in TS would fork the source-of-truth.

## Consequences

- Pure string algebra with unit tests; no I/O, clock, or globals.
- Behavior changes only on the previously-hard-failure path (`occurrences
  == 0`); existing golden behavior of successful literal edits is untouched.
