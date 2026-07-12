# First forty pull requests (SPEC §49.1)

This document lists the first 40 PRs in the suggested order (SPEC §49.1). The sequence is deliberately narrow — each PR should be independently reviewable. MCP, plugins, external harness adapters, memory, learned compression, and remote multi-user features follow only after these foundations.

## PR sequence

1. **Repository governance and toolchain pinning.** Add root docs, CODEOWNERS, ADR template, `mise`, `just`, CI skeleton. *(This task — Task 10.)*
2. **Pin OpenCode upstream and divergence registry.** Record commit, licenses, sync workflow, parity fixture.
3. **Eval task schema and fake-provider skeleton.** No production behavior change.
4. **Minimal shell baseline runner.** Produce first complete trace and grader result.
5. **OpenCode baseline adapter.** Pin and run the same eval task.
6. **Canonical IDs, URIs, and typed errors.** Unit/property tests.
7. **SQLite migration framework and schema snapshot.** Integrity/startup tests.
8. **Workspace/session/thread/task repositories.** State-machine tests.
9. **Semantic event envelope and generated catalog.** JSONL export.
10. **Content-addressed artifact store.** Atomic ingest and GC dry run.
11. **Public API initialization, health, and generated client.** Reconnect fixture.
12. **Task contract, scope ledger, and terminal states.** API and persistence.
13. **SSE event stream with resumable cursors.** Duplicate/reconnect tests.
14. **Exact provider-attempt recorder around OpenCode.** Capture request block hashes.
15. **Context-manifest skeleton.** Persist before provider send.
16. **Kernel Protobuf v1 and code generation.** Buf compatibility check.
17. **Authenticated UDS kernel server and fake kernel.** Health and capability token.
18. **Structured process start through kernel.** Bounded output and cancellation.
19. **Durable jobs and process-tree ownership.** Restart reconciliation.
20. **Safe path resolver and workspace capability.** Traversal/symlink property tests.
21. **Linux sandbox backend.** Read-only root and writable worktree tests.
22. **Policy engine and normalized command model.** Rule fixtures.
23. **Approval records bound to operation hash.** UI/API flow.
24. **Secret broker v1.** Child injection, revocation, redaction tests.
25. **Proxy-only network broker v1.** Allowlist and private-address denial.
26. **`read` tool v1.** Outlines, ranges, hashes, artifacts.
27. **`search` lexical v1.** Rank, snippets, facets, continuation.
28. **Tree-sitter symbols and structural search.** Incremental index.
29. **Patch transaction journal and exact-text/range anchors.** Crash recovery.
30. **Symbol anchors and parser/formatter validation.** Multi-file tests.
31. **Diagnostics/inspect v1.** LSP wrapper and source versions.
32. **Context IR and world-state registry.** Core producers.
33. **Retrieval query generation and candidate manifest.** Deterministic tests.
34. **Context budget allocator and complete-episode window.** Budget properties.
35. **Structured checkpoint and provenance DAG.** Requirement/failure validator.
36. **First provider-specific renderer behind a flag.** Exactness and cache manifest.
37. **Verification DAG and completion record.** False-completion tests.
38. **Read-only scout with typed delegation.** Worktree not yet required.
39. **Managed writer worktree and integration coordinator.** Conflict tests.
40. **Capability registry and Agent Skill loader.** No third-party execution yet.

## After PR 40

MCP, plugins, external harness adapters, memory, learned compression, and remote multi-user features follow (SPEC §49.1 closing note).

## PR scope guidance (SPEC §45.8)

- Each PR is independently reviewable.
- Recommended maximum scope: one contract or vertical slice with independent tests.
- Follow the development flow in `AGENTS.md`.
- Use the PR template (`.github/pull_request_template.md`).
- High-risk changes (policy, sandbox, secrets, network, plugin, MCP, auth, multi-tenant, public/proto) require two approvals (SPEC §44.8).

## Status (0.1.0 development)

PRs 1 (this task) is in progress. PRs 2–40 are scaffolded at varying levels of completeness across the 19 Rust crates and 26 TS packages built in Tasks 1–9. See `worklog.md` for per-task status.

## Related

- `docs/plans/roadmap.md` — milestones M0–M12.
- `docs/decisions/` — ADRs governing each PR's design.
- `docs/quality/release-gates.md` — release gate.
- SPEC §49.1 (first forty PRs), §45.8 (agent-assisted workflow).
