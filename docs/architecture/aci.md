# Agent–Computer Interface (ACI)

This document is the deep dive for the ACI subsystem (SPEC §11, §34). The ACI is the model-visible operations and observations used to interact with the environment. It is governed by ADR-0012 (seven-operation default ACI, EXPERIMENTAL) and ADR-0013 (snapshot-anchored journaled patch transactions).

## Design objective (SPEC §11, §34.1, §3.4)

The ACI is a first-order performance variable. SWE-agent's experiments showed a large improvement from a purpose-built interface at fixed model in its 2024 setup. The exact magnitude should not be assumed for current models, but the conclusion remains: read, search, edit, and environment-feedback semantics deserve the same evaluation rigor as model selection.

The ACI must:

- be small enough to avoid model confusion (Risk R5);
- be expressive enough for real coding tasks;
- enforce scope, source-version pinning, and confidentiality;
- never silently truncate;
- produce evidence-grade artifacts;
- be provider-dialect-aware (OpenAI/Anthropic/Google/local).

## Default always-visible operations (SPEC §11.1, §34.2, ADR-0012)

| Tool | Purpose | Key features |
|---|---|---|
| `read` | Read files | outline, ranges, symbols, hashes, elisions, artifacts, max_bytes, expected_sha256 |
| `search` | Lexical + structural search | rank, snippets, facets, continuation, freshness |
| `patch` | Edit transactions | snapshot anchor, journal, validation, rollback, multi-file |
| `exec` | Bounded command execution | structured CommandSpec, PTY, timeout, cancellation, output policy |
| `job` | Durable processes | restart-survivable, stream resume, input, signal, stop |
| `inspect` | Diagnostics, symbols, refs | LSP-backed, source versions, diff, test status |
| `capability` | Activate optional tools/skills/MCP/plugins | progressive disclosure, capability-scoped |

Status: EXPERIMENTAL (ADR-0012). The exact default count, `ask` tool, edit dialect, and programmatic tool mode are OPEN (SPEC §49.5).

## Progressive disclosure (SPEC §11.2, §34.2)

Only the 7 default tools are always visible. More tools are activated via `capability`:

- Built-in capability packs (`capability-packs/`: web-browser, github, gitlab, database, cloud-deploy, debugger, notebooks, images).
- Agent Skills (`skills/builtin/`: diff-apply, test-run, search-symbol, verification-plan, release-notes, database-migration-review).
- MCP servers (per-task, descriptor-pinned, ADR-0018).
- Third-party plugins (out-of-process/WASI, ADR-0019).
- External harness adapters (codex, claude-code, pi, oh-my-pi, omnigent, openhands, fixture-agent).

Activated capabilities appear in the context manifest (ADR-0010).

## Universal result envelope (SPEC §11.3, §34.4, Appendix E.3)

Every tool result is wrapped:

```ts
{
  status: "success" | "partial" | "error" | "denied" | "timeout" | "cancelled" | "unknown",
  summary: string,
  data: <typed> | null,
  artifacts: ArtifactRef[],
  sourceVersions: { [path]: sha256 },
  truncation: { occurred: bool, reason: string | null, continuation: string | null },
  diagnostics: Diagnostic[],
  sideEffects: SideEffect[],
  trust: "trusted" | "derived" | "untrusted",
  confidentiality: "public" | "workspace" | "secret_adjacent" | "secret",
  timing: { queuedMs, executionMs, totalMs },
}
```

Truncation MUST be reported (SPEC §26.3 #4). Source versions MUST be reported (SPEC §26.3 #5). Trust/confidentiality labels MUST be reported (SPEC §26.3 #6, §36.18).

## Tool definitions (SPEC §34.3, §45.6)

Each tool compiles to:

- canonical input/result validators;
- OpenAI/Anthropic/Google/local tool schema dialects;
- concise and full descriptions;
- provider token estimates;
- docs;
- golden examples;
- policy metadata;
- tool-selection evaluation cases.

Provider-specific constraints MUST be visible. If one provider cannot express a schema exactly, the adapter uses a validated compatible projection and records it (SPEC §45.6).

Tool definitions: `schemas/tools/{read,search,patch,exec,job,inspect,capability}.json`.

## `read` (SPEC §11.5, §34.5)

- Modes: full, outline, ranges, symbols.
- Returns: SourceVersion, rendered_mode, full_content artifact, model_projection_utf8, elisions, diagnostics, truncated flag, continuation_token.
- `expected_sha256` for stale-write protection.
- `max_bytes` hard cap; truncation MUST be reported.
- Full content always artifact-backed (no silent loss).

## `search` (SPEC §11.4, §34.6)

- Lexical (FTS5/BM25) with rank, snippets, facets, continuation.
- Structural (Tree-sitter AST) symbols.
- LSP enrichment (references, definitions).
- Reports: rank, method, freshness (SPEC §50.4).

## `patch` (SPEC §11.6, §34.7–§34.10, ADR-0013)

- Snapshot-anchored (WorkspaceBaseline).
- Edits: ReplaceSymbol, ReplaceRange, ReplaceExactText, InsertContent, DeleteRange, CreateFile, MoveFile, DeleteFile, UnifiedDiff.
- Validation profiles: format-and-parse, parse-only, none.
- Commit modes: PREVIEW_ONLY, STAGE_ONLY, APPLY_TO_WORKTREE.
- Journal with crash recovery.
- Transient-invalid isolated mode for multi-file transactions.
- Path leases prevent concurrent conflicts.
- Response: transaction_id, state, final_repository_revision, changed_files, validations, complete_diff artifact.

## `exec` (SPEC §11.7, §34.11)

- Structured CommandSpec (program, args, cwd, public_env, secret_capability_uris, timeout, allocate_pty, shell).
- ShellSpec with dialect (bash/sh/powershell/cmd) and normalized script.
- Output streaming via ProcessEvent (started, stdout, stderr, exited, policy).
- Bounded output extraction with diagnostic parsers.
- Process-tree ownership and cancellation.
- Sandbox profile and output policy enforced.

## `job` (SPEC §11.7, §34.12)

- Durable (survives control-plane restart).
- Stream resume via `from_sequence` cursor.
- Input, signal, stop, get operations.
- JobReconciled event on restart recovery.

## `inspect` (SPEC §11.8, §34.13)

- Diagnostics (LSP-backed).
- Symbols, references, definitions.
- Diff against repository revision.
- Test status.
- Source versions reported.

## `capability` (SPEC §34.14)

- Search available capabilities (skills, MCP, plugins, packs).
- Activate/deactivate per task.
- Capability-scoped effects enforced by kernel.

## Structured user-decision outcome (SPEC §34.15)

The `ask` tool is OPEN (SPEC §49.5). A structured user-decision outcome may subsume it. The outcome includes: decision (approve/deny/defer), scope, conditions, expiration, audit.

## Tool output extraction (SPEC §34.16)

Bounded output extraction prevents token bloat:

- Truncation with continuation.
- Artifact spill for full output.
- Diagnostic parsers (compiler/linter output → structured diagnostics).
- Redaction (secrets stripped).

## Conformance tests (SPEC §34.17)

- Every tool matches its schema.
- Every result matches the envelope.
- Provider dialects round-trip.
- Tool-selection and argument-error rates meet target (SPEC §50.4).

## Evaluation plan (SPEC §48.8)

- ACI conformance tests.
- Model-selection tests.
- Cohort ablation: default 7-tool palette vs. minimal shell vs. alternate palettes.
- Edit-dialect experiments: exact-text vs. range vs. symbol vs. unified-diff per model.

Exit gate (M5, SPEC §48.8): ACI v1 improves edit-application success or final task success on its target cohort without unacceptable cost/security regression. Patch recovery passes forced-crash tests.
