# search-symbol

Search the workspace for symbols and references using the code-intelligence layer.

## When to use

Use this skill whenever you need to locate a definition, find callers, or
enumerate references. It composes lexical, structural (Tree-sitter), and LSP
channels and reranks results by intent, path proximity, freshness, authority,
and graph centrality.

## Inputs

- A symbol name or qualified path.
- An intent: `definition`, `references`, `call_hierarchy`, `implementation`.
- Optional file/path scope filter.

## Procedure

1. Ask the kernel `CODE_INTEL_FIND_REFERENCES` and `CODE_INTEL_INSPECT_SYMBOL`
   for the requested symbol.
2. If the LSP for the workspace language is unavailable, the kernel falls back
   to Tree-sitter structural search and reports this in the result envelope's
   `diagnostics` field.
3. Merge lexical (ripgrep) hits with structural hits, deduplicate by
   `(path, range)`, and rerank.
4. Return up to `aci.search.default_limit` (default 20) results; never exceed
   `aci.search.hard_limit` (default 100).
5. Each result includes: path, range, source hash, snippet (compact), match
   channel, and related tests if known.

## Important rules

- Never re-implement ripgrep in the model; the skill is the canonical search
  path.
- Always include the source hash so downstream edits can anchor against it.
- If a result is recoverable-by-reference (large file), return the artifact
  URI; do not paste the full file into the transcript.
- Prefer symbol anchors over raw line numbers when possible; symbols survive
  reformatting.

## Failure modes

- `LSP_UNAVAILABLE` — fall back to structural search; surface the degradation.
- `SYMBOL_NOT_FOUND` — return empty result with the matched channel list so
  the model can retry with a broader selector.
- `TOO_MANY_RESULTS` — return the top-K and a continuation token.

## Output

A search-result fragment with ranked hits, facets (file types, directories,
symbol kinds), and a continuation token if truncated. The model never sees
more than `hard_limit` items per call.
