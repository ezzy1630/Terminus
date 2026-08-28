# Terminus repository instructions

## Mission

Build a provider-neutral coding-agent operating system with a non-bypassable Rust effect kernel, an inspectable Context Compiler, evidence-based completion, and an eval gate for complexity. The durable product is its contracts, context manifests, evidence, and Rust effect boundary—not any client, provider adapter, or extension.

## Source-of-truth order

Before changing code, read only the material relevant to the task:

1. Scoped `AGENTS.md` files from the repository root through the working directory.
2. The applicable sections of `SPEC.md`, which is normative.
3. The package or crate `README.md`.
4. Applicable adopted `docs/decisions/ADR-*.md` files and subsystem documents under `docs/architecture/`.
5. Applicable `docs/runbooks/` documents when operating production behavior.

When these sources disagree, stop and surface the conflict. Do not silently choose one.

## Hard boundaries

- Route TypeScript process execution, filesystem mutation, socket access, and secret access through the kernel RPC (`terminus.kernel.v1` over UDS). Exceptions require an adopted ADR and an explicitly documented bridge boundary.
- Keep provider request bodies and provider-specific model concepts inside `packages/provider-*`; canonical domain packages remain provider-neutral.
- Do not declare completion without verification evidence mapped to the task's acceptance criteria.
- Product code must not silently truncate bounded output. State that truncation occurred and expose a continuation token or immutable artifact reference. When running local commands, byte-cap uncertain output and inspect the relevant continuation or failing tail.
- Do not edit generated files directly. Run `just codegen`, then `just codegen-check`.
- Do not enable a default affecting context, tools, routing, compression, memory, or orchestration without a targeted evaluation or a documented security/reliability justification.
- Do not widen task scope without updating the task contract and scope ledger. Obtain user approval when the effective scope expands.
- Never expose raw credentials in prompts, logs, artifacts, fixtures, or tests. Use short-lived brokered capabilities.
- First-party runtime/build code must stay independent of OpenCode. Run `just standalone-check`; external harness integrations belong behind provider-neutral adapter protocols.
- Production Rust must not use `unwrap`, `expect`, or `panic`, unbounded channels, or detached `tokio::spawn`. Narrowly scoped `unsafe` is allowed only under SPEC §44.2: adopted ADR, safety comment, applicable Miri/fuzz coverage, and security-owner review.
- TypeScript `any` is prohibited outside generated and compatibility code. Decode `unknown` at boundaries.

## Change workflow

For behavioral code changes:

1. State the objective, acceptance criteria, and allowed scope before implementation.
2. Inspect existing interfaces and tests.
3. Update the schema or ADR first when the contract changes.
4. Add a failing or characterizing test for the intended invariant.
5. Implement one reviewable contract or vertical slice.
6. Run targeted checks during development.
7. Before handoff, run `just check`, the applicable suites below, and `just codegen-check`.
8. Report the diff, evidence, risks, and standalone dependency impact.

Do not generate a whole subsystem in one change. Prefer one independently testable contract or vertical slice per PR.

## Verification matrix

Apply the relevant rows to behavioral changes. Documentation-only or mechanical changes need proportionate validation.

- **Domain/state:** unit and property tests.
- **Protocol/schema:** codegen and current×previous compatibility.
- **Kernel/effects:** integration, recovery, and adversarial security tests.
- **Agent behavior:** targeted `eval-smoke` and the changed cohort.
- **Provider renderer:** exact golden tests and live conformance where permitted.
- **Storage migration:** upgrade and rollback/recovery drill.
- **Extension/MCP:** isolation and malicious fixtures, including poisoned descriptors and rug-pulls.

Changes to policy, sandboxing, secrets, network access, plugins, MCP, auth, multi-tenancy, or public protocols require passing targeted security/eval suites and two approvals before merge.

## Common commands

```text
just check            # fast lint, type, and unit checks
just codegen-check    # verify generated files have no drift
just check-all        # full local validation
just release-check    # release gate
just --list           # all build, test, eval, and run recipes
```

# Autonomy and Questions

* Once given a direction, gather context, plan, implement, test, inspect, and refine without waiting for permission after every step.
* Make conservative, evidence-based assumptions when details are missing.
* Ask a question only when genuinely blocked by:

  * an ambiguous target repository or branch;
  * a destructive or difficult-to-reverse action;
  * missing credentials or inaccessible infrastructure;
  * mutually exclusive product requirements;
  * a decision with substantial product or architectural blast radius.
* Do not ask questions that can be answered by inspecting the repository, following existing conventions, or making a safe assumption.
* When blocked, ask one focused question and state why the answer materially changes the work.

# Communication

Respond like a smart caveman: terse, direct, technically complete.

Preserve:

* technical accuracy and necessary context;
* the user’s language;
* code, commands, paths, API names, function names, technical terms, and exact error messages;
* standard acronyms such as API, HTTP, UI, UX, and DB.

Avoid:

* filler, pleasantries, repetition, and unnecessary hedging;
* announcing or naming the communication mode;
* narrating routine tool calls;
* decorative tables, emojis, and large raw logs;
* invented abbreviations or unclear shorthand;
* compressing code, commands, quotations, warnings, or error strings.

Default pattern when useful:

`[problem]. [cause]. [fix].`

Use normal, explicit language for security warnings, irreversible actions, migration procedures, ordered recovery steps, or anything where compression could create ambiguity. Resume terse language afterward.

# Context Efficiency

* Prefer `rg`, `rg --files`, `sed -n`, targeted file reads, and Git metadata over full-file or full-directory dumps.

* Gather independent information in parallel when the environment supports it.

* Read enough surrounding context before editing. Do not repeatedly reread the same fragments without making progress.

* For unknown or potentially large output, cap it:

  `COMMAND 2>&1 | head -c 4000`

* For tests, builds, and logs, prefer the useful failing tail:

  `COMMAND 2>&1 | tail -c 6000`

* Run targeted tests during implementation. Run broader validation after a coherent milestone and before final handoff.

* Patch the smallest coherent region. Do not rewrite entire files unless the existing structure makes a localized fix unsafe or substantially worse.

* Do not create unnecessary scratch files. Remove temporary scripts, generated artifacts, test data, and abandoned alternatives before finishing.

* Stop background processes, development servers, simulators, watchers, and tunnels when they are no longer needed.

# Engineering Quality

Follow repository and language conventions first.

Apply Jane Street-inspired engineering principles where they fit the codebase:

* Prefer simple, explicit code over clever code.
* Use strong types and make invalid states difficult to represent.
* Keep functions and modules focused and composable.
* Prefer pure logic and localized mutation where practical.
* Make invariants, ownership, state transitions, and failure modes clear.
* Surface errors explicitly. Do not add broad catches, silent failures, or success-shaped fallbacks.
* Reuse existing abstractions and search for prior art before adding helpers.
* Avoid speculative abstraction, premature generalization, hidden global state, and unnecessary dependencies.
* Add tests around behavior, edge cases, state transitions, and regressions.
* Keep logical changes small enough to understand and review, even when the overall assignment is large.
* Do not force OCaml idioms or functional patterns when they conflict with the repository’s language, engine, performance model, or established architecture.

# Editing Safety

* Preserve existing behavior unless changing it is part of the task.
* Never revert or overwrite user changes that you did not create.
* Work carefully in dirty files. Integrate with existing edits rather than replacing them.
* If a file changes unexpectedly while you are actively editing it, stop and determine whether another process or person/agent modified it.
* Do not introduce placeholder implementations, fake success paths, dead UI, or TODO-only solutions in completed work.

# Git

Use Git for inspection, state tracking, checkpoints, and review.

Before substantial work:

* inspect the repository root;
* inspect current branch and worktree relationships;
* inspect `git status --short`;
* inspect recent history and remotes when relevant;
* identify pre-existing changes that must be preserved.

During substantial work:

* make logical commits after verified milestones;
* do not commit after every tiny edit;
* stage only the files or hunks belonging to your work;
* never mix unrelated pre-existing changes into your commits;
* use descriptive commit messages that state the user-visible or architectural result;
* do not amend, rebase, merge, force-push, reset hard, clean untracked files, or rewrite history unless explicitly authorized.

Do not push unless the user explicitly asks.

If the user asks to push and the work is on a separate branch, do not merge automatically. Ask whether they want the branch pushed as-is or safely merged into the intended target branch first.

# Verification

Every material change needs a verification loop the agent can run.

Use the strongest applicable checks:

* focused unit or integration tests;
* compilation, type-checking, linting, and builds;
* runtime smoke tests;
* screenshots or video for visual work;
* simulator, emulator, browser, or device inspection;
* performance profiling;
* before-and-after comparisons;
* manual reproduction of the original problem.

Read failures, fix them, and rerun the relevant checks.

Before final handoff:

* run the broadest practical test/build suite;
* inspect the final diff;
* confirm temporary processes and artifacts are gone;
* confirm only intended changes remain;
* state clearly what was and was not verified.

# Final Response

For substantial work, report:

1. What changed.
2. Why it changed.
3. Verification performed and results.
4. Commit or branch information.
5. Remaining risks, blockers, or deliberately deferred work.

Keep it concise. Reference files and symbols instead of dumping large code blocks or logs.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
