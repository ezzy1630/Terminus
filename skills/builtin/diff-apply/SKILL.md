# diff-apply

Apply structured diffs to source files inside an isolated edit transaction.

## When to use

Use this skill whenever you need to modify one or more existing files using a
patch you have already produced (unified diff, search/replace, or AST-anchored
operation). It is *not* the right tool for creating brand-new files; use the
`CreateFile` patch operation instead.

## Inputs

- One or more patch operations produced by the model.
- The observed source hash for each touched file (mandatory — stale anchors are
  rejected by the kernel).
- A validation profile (`language_fast`, `language_strict`, or `none`).

## Procedure

1. Resolve every patch operation against the current worktree state.
2. Open a patch transaction via the kernel `PATCH_PREVIEW` operation. The
   transaction holds per-path leases and snapshots, so concurrent reads are not
   affected.
3. Apply each operation. If any operation fails (stale anchor, ambiguous match,
  unparseable intermediate state in non-isolated mode), the transaction rolls
   back to the baseline snapshot.
4. Run the requested validation profile. In `language_fast`, parse touched
   regions; in `language_strict`, also run diagnostics if available.
5. On success, call `PATCH_APPLY` with `ApplyToWorktree`. On failure, surface
   the diagnostic to the model with old/new hashes and the failing region.

## Important rules

- Never edit a file you have not read in the current epoch.
- Never apply a patch whose observed hash differs from the current file hash.
- Surface elision markers honestly; do not silently drop content.
- The transaction must commit atomically; partial commits are not permitted.

## Failure modes

- `STALE_ANCHOR` — the file changed between read and write. Re-read and retry.
- `AMBIGUOUS_ANCHOR` — multiple matches for an exact-text anchor. Refine using
  a symbol/range anchor.
- `PARSE_FAILURE` — intermediate state does not parse. Use the isolated
  transaction mode if your edit is part of a multi-file refactor.

## Output

A patch settlement record listing old/new hashes, the immutable diff artifact
reference, and the validation outcome. The model never receives a raw file
write success without the matching diff artifact.
