# Terminus harness and macOS app: current snapshot, executed fixes, and target

**Date:** 2026-08-29
**Scope:** the harness first; the native macOS desktop app second. Website, Windows, and unrelated product surfaces are excluded.
**Observed checkout:** `main` at `76b7a3e734a0ab12f2a77addf710b1073ec16bc6`, 35 commits ahead of `origin/main`, with a large pre-existing dirty Phase-0 implementation. This report does not attribute or commit those existing changes.

## Verdict

Terminus now has the right architectural center: a provider-neutral control plane, a non-bypassable Rust effect boundary, an inspectable Context Compiler, evidence-based completion, and an evaluation system capable of paired analysis. The current dirty Phase-0 implementation also repairs most of the model-facing defects recorded at clean baseline `c2cd9d5`: tiny output/context budgets, disabled reasoning, invalid provider rendering, corrupt episode ordering, missing task contracts, output loss, missing tools, unusable step/time limits, broken macOS Seatbelt policy, buffering/cancellation gaps, and weak eval wiring.

It is not yet defensible to call Terminus the objectively best harness. That is an empirical claim. The remaining blockers are not another broad rewrite; they are exact-path proof, held-out paired evaluation, kernel-boundary hardening, usable governed delegation/computer use, and a macOS client that makes the runtime inspectable without becoming a dense chat wrapper.

## End state

“Best” must mean a reproducible Pareto frontier, not a feature checklist:

- **Coding:** highest held-out completion and verification-admission rate under the same model, task, budget, environment, retries, and tool authority.
- **General work:** typed tools, durable state, safe steering, resumability, and evidence-bearing completion across shell, files, web, documents, and UI work.
- **Computer use:** fresh observation/action receipts, coordinate and viewport identity, prompt-injection resistance, consequence gates, and kernel-enforced authority.
- **Efficiency:** lowest tokens, provider calls, kernel RPCs, DB transactions, wall time, and dollars per verified solve; high stable-prefix cache reuse.
- **Orchestration:** scoped context isolation, explicit ownership, durable child state, bounded fan-out, safe-boundary steering, and independent verification. The parent remains accountable.
- **UX:** one comprehensible task state machine; reversible control; exact approvals; no fake completion, hidden truncation, or lost work.
- **macOS:** a native mission-control client for the typed runtime. It should expose run identity, task contract, conversation, diff, PTY, context manifest, effects, approvals, evidence, and child agents while remaining quiet by default.

## What was observed in the current source

### Strong substrate

- The Electron renderer is isolated behind preload IPC, while runtime supervision, tokens, credentials, and process custody stay in the main process.
- The control plane owns durable task/turn state, model dispatch, context compilation, tools, verification, repair, and SSE projection.
- The Rust kernel owns filesystem, patch, process/job, network, secret, artifact, policy, and sandbox effects over private gRPC/UDS.
- The current macOS backend generates real deny-default Seatbelt profiles, protected Git/credential paths, scratch storage, and fail-closed backend selection.
- Process execution clears ambient environment, uses process groups, bounds captured output, and kills/reaps on timeout or cancellation.
- Provider budgets are family-aware; task contracts and ordered episodes reach the compiler; failed output and explicit truncation continuations are preserved; the loop has adaptive budgets and a 200-step ceiling.
- Verification has typed plans, restart-stable environment identity, repair scheduling, completion admission, and recovery.

### Highest-priority gaps

1. **No current release claim is admissible.** The dirty checkout lacks signed, candidate-bound, held-out evidence and a terminal CI/release result. Historical evidence is not evidence for `76b7a3e7`.
2. **The packaged macOS toolchain path is likely wrong.** Packaged runtime supervision narrows `HOME` and `PATH`; control forwards those values to tool execution. A packaged app may therefore be unable to find user `git`, `bun`, `node`, `cargo`, `rg`, or caches even though the development app works.
3. **Kernel-wide authorization is not yet one provable invariant.** Request, token, scope, idempotency, and deadline checks exist, but policy, approval, cancellation, and durable audit behavior remain distributed. Every effect service needs restart/replay and adversarial boundary tests.
4. **macOS `ProxyRequired` is too broad.** Its Seatbelt rule allows all Unix-domain outbound sockets while its report implies only the kernel broker socket.
5. **SSE replay/overlap has a recorded terminal-event timeout.** Losing `task.aborted` or another terminal event violates durable task semantics.
6. **Governed computer use is absent.** The backend is `null`, and UI verification is skipped rather than observed and receipted.
7. **Live evaluation is not promotion-grade.** Existing records include contradictory harness/grader outcomes, missing provider receipts, and an evaluation identity that previously retained the caller's `fake` placeholder.
8. **Model-callable scoped delegation is intentionally unavailable.** Terminus has orchestration substrate but not a safe, usable `spawn/wait/send/close` model surface.
9. **Large-file read paging stops in the control plane.** The kernel still returns a whole bounded file, so content beyond the fetch ceiling is not reliably addressable.
10. **The macOS UI lacks the core inspector.** It can create and list tasks, choose model/effort/access, and display status, but it does not yet make context, effects, evidence, child agents, run freshness, PTY custody, or benchmark cost/cache behavior legible.

## Changes executed in this pass

### Harness correctness

- Permission profiles now cover the new `write` and `capability` tool variants. `write` receives edit authority; capability discovery itself does not create a duplicate approval gate.
- Live eval identity now derives provider/model/API identity from the resolved live model snapshot rather than a CLI placeholder. A real ChatGPT Codex run can no longer be recorded as provider `fake`.
- OpenCode Zen profiles now use the shared model-family context resolver. A discovered 100K model retains 100K tested-safe context; GPT-5.6 gateway variants observe the shared 270K ceiling instead of a stale universal 32K clamp.
- Project-instruction discovery now uses a path-component boundary. `/workspace/foo2` is no longer treated as a child of `/workspace/foo` and cannot inject sibling `AGENTS.md` authority.

### macOS live path

- `dev:electron:live` now starts the release kernel, waits for its private socket, starts and health-checks the control plane, and then launches Electron with the exact API/token environment. The old command only printed environment variables and launched an offline UI.
- The development stack now performs an incremental release build of the current kernel unless an explicit validated binary override is supplied. It no longer silently reuses a stale binary.
- The repaired command was exercised from the exact checkout. The kernel built, migrations and integrity checks passed, the control plane connected over private UDS, Electron rendered, provider/model discovery populated, and the UI reported **Terminus is ready** with GPT-5.6-Luna and effort selection. The temporary stack was stopped cleanly.

## Verification evidence

- TypeScript: repository package/script/app typechecking passed.
- Lint: passed with two warnings in generated protobuf files and no errors.
- Harness/provider/control tests: 826 passed, 0 failed for the central TypeScript cohorts before the two final focused fixes.
- Final focused tests: Zen renderer/profile 12 passed; project-instruction discovery 13 passed; permission-profile 6 passed.
- Desktop: 849 passed, 11 skipped; Electron production renderer build passed; the fresh live macOS development surface was visually and accessibility inspected.
- Eval system: 380 passed after the live-identity repair.
- Rust: 247 targets compiled successfully on the external workspace target. `terminus-connector` library tests passed, but a macOS test binary then stalled before `main` in dyld. Retrying with an internal target directory failed because the system data volume had only about 319 MiB free. Therefore the complete Rust integration matrix is **blocked, not green**.
- Standalone gate: failed because an existing packaged `.app` contains stale retired OpenCode migration strings. Source independence is not disproven; artifact freshness is. The package must be rebuilt and retested rather than treated as current.

## Competitive findings translated into Terminus requirements

- **Codex:** keep OS-enforced sandbox/policy, local worktree isolation, inspectable subagents, checkpoints, and safe-boundary steering. Sources: <https://openai.com/index/unrolling-the-codex-agent-loop/>, <https://developers.openai.com/codex/app/features>, <https://developers.openai.com/codex/subagents>, <https://github.com/openai/codex/blob/main/docs/sandbox.md>.
- **Claude Code:** adopt scoped fresh-context agents, hooks, skills/memory, and worktree isolation, but persist child liveness across compaction. Source: <https://code.claude.com/docs/en/sub-agents>.
- **Pi:** preserve a small model-facing core and add complexity through explicit extensions rather than permanent prompt surface. Source: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md>.
- **OpenCode:** match multi-provider UX, typed child sessions, and granular permissions without depending on its runtime. Source: <https://opencode.ai/docs/agents/>.
- **Aider:** use task-scoped structural repository maps when measured useful, not alphabetical context dumps. Source: <https://aider.chat/docs/repomap.html>.
- **Devin:** use deterministic workflows, structured outputs, and content-addressed replay/resume for recurring work. Source: <https://docs.devin.ai/work-with-devin/dynamic-workflows>.
- **OpenHands:** retain immutable typed append-only events as the durable truth. Source: <https://docs.openhands.dev/sdk/arch/events.md>.
- **Prime:** keep taskset, environment, verifier, and harness identities separate. Source: <https://docs.primeintellect.ai/verifiers/environments>.
- **Computer use:** make observation/action/freshness/safety part of the effect protocol. Current desktop-agent benchmarks remain weak enough that skipped verification and lost constraints dominate. Source: <https://osworld-v2.xlang.ai/>.

Provider research reinforces one critical design decision: do not flatten models into `messages[]`. Store canonical immutable events and compile late into each provider's native tool, reasoning, state, cache, compaction, async, and computer-use protocol. Pin capability evidence to provider, endpoint, API version, model revision, and observation date. Relevant primary guidance: <https://developers.openai.com/api/docs/guides/function-calling>, <https://developers.openai.com/api/docs/guides/prompt-caching>, <https://developers.openai.com/api/docs/guides/compaction>, <https://developers.openai.com/api/docs/guides/reasoning>, and <https://developers.openai.com/api/docs/guides/tools-computer-use>.

Research volume: 661 returned candidates across 16 search workstreams, with roughly 90 distinct primary or high-signal sources retained; 31 provider/model documents and papers were deep-read in the model-specific pass. Counts are search results reviewed, not unique-source claims.

## Ordered build path

### Gate 1 — Prove the exact macOS product path

1. Give the packaged runtime a validated, explicit user toolchain profile without exposing ambient secrets.
2. Build/package this checkout; launch that exact `.app`.
3. Execute a kernel-mediated task in a fixture worktree, including a failing command whose stdout/stderr must survive.
4. Restart during the task; prove SSE replay, cancellation, verification admission, and evidence recovery.
5. Re-run standalone and packaged integrity gates against the fresh artifact.

### Gate 2 — Prove harness superiority instead of asserting it

1. Freeze model/provider/API/tool/prompt/environment revisions and emit provider receipts.
2. Run paired, randomized, held-out same-model comparisons against Codex, Claude Code, Pi, OpenCode, Aider, and other runnable baselines.
3. Measure verified completion, false completion, policy violations, tokens/solve, dollars/solve, wall time, TTFT, cache read/write, tool errors, approvals, recoveries, RPCs, and transactions.
4. Promote only changes with a predeclared non-inferiority margin and no security/reliability regression.

### Gate 3 — Finish the harness differentiators

1. Centralize and adversarially test every kernel effect invariant.
2. Add durable model-callable scoped delegation with explicit ownership, budgets, depth/concurrency limits, worktree isolation, typed results, and independent validation.
3. Add governed computer use as a first-class effect adapter with hashed screenshots, viewport identity, observation freshness, consequence classes, and receipts.
4. Move read paging into the kernel; batch ingest/link; cache revision per turn; coalesce streamed persistence; target no more than four RPCs and one transaction per tool call.
5. Make cache plans measurable on live provider cohorts and require evidence before changing model/context/orchestration defaults.

### Gate 4 — Build the macOS mission-control UI

Add one inspector with tabs or a compact split view for **Run**, **Diff**, **Terminal**, **Context**, **Effects**, **Evidence**, and **Agents**. Show exact source/build/runtime identity, provider/model/API/effort, cost/cache/TTFT, task acceptance status, pending approvals, and truncation continuations. Use native menus, sheets, notifications, keyboard shortcuts, and safe human takeover. Keep the conversation primary and advanced machinery collapsed until needed.

## Immediate acceptance boundary

This pass improves real correctness and makes the live development app usable. It does not finish the full objective. The next release-defining slice is the packaged macOS kernel-mediated task with restart/evidence proof, followed by paired held-out evaluation. Until those gates pass, “best harness” remains the target, not a verified result.
