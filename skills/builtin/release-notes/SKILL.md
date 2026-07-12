# release-notes

Generate release notes from the git history between two refs.

## When to use

Use this skill when preparing a release. It walks the git log between the
provided refs, classifies each commit, and emits a structured draft for the
`CHANGELOG.md`. The model reviews and edits the draft; the skill does not
publish anything.

## Inputs

- `from_ref` — starting git ref (exclusive). Typically the previous release tag.
- `to_ref` — ending git ref (inclusive). Typically `main` or the new tag.
- Optional `scope_filter` — only include commits touching the given path prefix.

## Procedure

1. Call the kernel `GIT_LOG` with `from_ref..to_ref`. The kernel returns
   commits with author, message, and changed-file list (no diffs).
2. Classify each commit:
   - `feat:` → Features
   - `fix:` → Bug Fixes
   - `perf:` → Performance
   - `refactor:` → Refactors (internal)
   - `docs:`, `test:`, `chore:`, `build:`, `ci:` → Internal (suppressed by default)
   - `sec:`, `security!` → Security (always surfaced, even if internal-looking)
   - `BREAKING CHANGE` footer or `!:` suffix → Breaking Changes
3. Group commits by classification. Within each group, order by impact
  (files touched × lines changed), then by commit date.
4. Render Markdown. Each entry links to the commit short SHA and the
   primary changed path.
5. Write the rendered draft to `workspace://CHANGELOG.md.draft` (NOT to the
   final `CHANGELOG.md` — the model or user merges it explicitly).

## Important rules

- Never include commit bodies verbatim — they may contain untrusted content
  (issue references, contributor names that may be spoofed). The skill only
  emits the subject line, sanitized.
- Never auto-bump the version. Version selection is a user decision.
- Mark security entries as `**Security**` and require a reviewer sign-off in
  the draft.
- If a commit touches `migrations/` or `prisma/schema.prisma`, add a
  **Database Changes** subsection regardless of conventional-commit type.
- If the range contains zero commits, emit a clear empty-state draft, do not
  fabricate notes.

## Failure modes

- `GIT_LOG_FAILED` — surface the kernel error verbatim; do not retry silently.
- `UNPARSEABLE_MESSAGE` — place the commit under a "Misc" group with the raw
  subject; flag it for review.

## Output

A draft `CHANGELOG.md` fragment written to `workspace://CHANGELOG.md.draft`,
plus a structured record of the classification for observability. The skill
never marks the task complete on its own; the model reviews the draft and
either requests edits or declares acceptance.
