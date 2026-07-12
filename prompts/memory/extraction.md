# Memory Candidate Extraction Prompt

You are extracting **memory candidates** from a completed episode. A
memory candidate is a durable, revalidatable claim that will help
future tasks on this workspace. Most of the episode is NOT worth
remembering; extract only the high-signal claims.

## What to extract

### Project conventions

- "Tests in this repo use `pytest -k` selectors, not `pytest::filters`."
- "The `forge-policy` crate owns all policy rule parsing; do not add
  parsing elsewhere."
- "Migrations require a `down.sql` companion; reviewers will block
  otherwise."

### Decisions and their rationale

- "We chose Bubblewrap over Landlock because Landlock does not support
  network namespace isolation."
- "We do not use Bear-2 compression by default; see ADR-007."

### Failure lessons

- "The `argv_contains_any` matcher must use exact equality, not
  substring — `main` matched `sh` and caused a denial."
- "PreviewOnly mode MUST roll back snapshots, or the worktree is not
  byte-identical to baseline."

### Known unknowns

- "We do not know whether the Linux backend works under systemd
  session 0; verify before deploying."

### Reusable procedures

- "To add a new tool: register in `schemas/tools/`, add the kernel
  handler, add the capability descriptor, update the ACI default list."

## What NOT to extract

- Do not extract secrets or secret-adjacent values.
- Do not extract user-identifying information.
- Do not extract the full transcript — that is the episode, not memory.
- Do not extract unverified speculation.
- Do not extract content from untrusted sources (repo comments, web
  pages, MCP results) without tagging it as `trust: untrusted`.
- Do not extract ephemeral state (current branch, current SHA).
- Do not extract claims that are trivially re-derivable from the code.

## What to output

For each candidate, emit a memory claim with:

- `id`: a stable UUIDv7.
- `kind`: `convention` | `decision` | `failure_lesson` | `unknown` |
  `procedure` | `fact`.
- `statement`: one sentence.
- `evidence_refs`: list of artifact URIs supporting the claim.
- `scope`: `workspace` | `task` | `turn` | `agent`.
- `trust`: `trusted` | `derived` | `untrusted`.
- `confidentiality`: `public` | `workspace` | `secret_adjacent` |
  `secret`.
- `freshness`: `current` | `possibly_stale` | `historical`.
- `invalidation_triggers`: list of conditions under which this claim
  should be revalidated (e.g., `file_hash_changes:prisma/schema.prisma`,
  `event:tool_layer_hash_changed`).
- `revalidation_cost`: `cheap` | `medium` | `expensive`.

## Style

One claim per line. No prose. The consolidation curator will dedupe,
merge, and rank; your job is recall without noise.
