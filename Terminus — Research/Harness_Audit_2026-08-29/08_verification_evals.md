# Terminus verification / completion / evals / orchestration / test health — HEAD c2cd9d5 (2026-08-29)

Subagent: claude-opus-5[1m].

## (A) Prior findings
Zero live eval runs STILL TRUE: `python/evals/results/{smoke,full}/runs.jsonl` 84+39 rows, 100% `provider:"fake"`. Memory disabled STILL TRUE. maturity.yaml: 50 experimental / 11 preview / 5 fixture / 3 stub / 0 production. Recuris item-pairing/leakage NOT DONE (`paired_evaluation.py` pairs task+seed; `promotion_gate.py` no leakage/fingerprint). Subagent tool NOT DONE. C2 FIXED (`verification-runtime.ts:232-268` resolves `terminus-predicate <type>` from repo catalog `repository-signals.ts:252-330`; unmatched ⇒ skipped). C3 FIXED (`gateway.ts:20-28` RUNTIME_TRACE when no writePaths; `index.ts:16596-16615` verification_not_applicable ⇒ COMPLETED). C14/C20/C1/C6/C7/C9/C12/C13 FIXED. Steering FIXED. C10 shutdown STILL TRUE (`index.ts:19317-19340`). C16 STILL TRUE (`dev-stack.ts:167-195` closed env).

## (B) "fix this bug" → COMPLETED
workspaces/open → sessions → tasks (DRAFT; default criterion `requested-outcome` `index.ts:5090-5097`) → tasks/:id/start → turns (201 immediately). States PENDING → CONTEXT_COMPILING → PROVIDER_DISPATCH → RESPONSE_VALIDATING → TOOL_SETTLEMENT → … → VERIFYING → FINALIZING → COMPLETED.
- Scout pre-pass only with TERMINUS_ENABLE_SCOUT=1 (and dead anyway).
- On finishReason stop with text, control plane synthesizes `completion_proposal` with `evidenceRefs: []` (`index.ts:16228-16239`) — model never emits it; no submit/plan tool.
- No mutating tool settled ⇒ `verification_not_applicable` ⇒ COMPLETED (chat turns complete at HEAD).
- Else `defaultCriteriaNodes` plan (`index.ts:16757`), kernel-run commands; pass ⇒ `registerCandidateBranch` + `admitBranch` (`:17086-17212`) ⇒ COMPLETED.
Wrong failures:
- F1 **30 s verification timeout** for unit_test/file_parses/static_diagnostics (`packages/verification/src/plan-derivation.ts:188-198,247`); every repo-native recipe becomes a required node (`:310-322`, up to 12) ⇒ `just check-all`/`bun run test`/`cargo test`/`pytest` in 30 s ⇒ guaranteed failure.
- F2 **workspace root not writable — phantom `active-worktree` RW rule, cross-platform** (`crates/terminus-sandbox/src/profile.rs:84-91`; the string appears only at `profile.rs:89` and in the macOS crate's own tests, which `create_dir` it themselves). macOS empirically: EPERM at repo root, ok under `active-worktree/`; `/tmp` write also EPERM, so the `TMPDIR` that verification forwards (`verification-runtime.ts:353-356`) is unusable. Linux by construction: the rule becomes `MountOp::Bind` of a nonexistent source (`terminus-sandbox-linux/src/mounts.rs:283-288`); the Linux backend's own reference plan (`lib.rs:76-105`) shows the intended shape — workspace root RW with `.git`/`.terminus`/`credentials` deny overlays. Linux runtime consequence UNVERIFIED (no bwrap here). Whole-FS read is macOS-only: Linux refuses to bind `/` (`mounts.rs:272-274`).
- F2b **no runnable check ⇒ task never leaves ACTIVE.** `no_runnable_checks` (`index.ts:16893-16943`) completes the turn but `settleWithoutRunnableChecks` sets the task back to `status: "ACTIVE"` (`services/verification-coordinator.ts:232-249`). Correct by design (a skipped check is not proof), but with F1–F3 it turns every coding task into a perpetually-ACTIVE task.
- F3 2 repair turns then FAILED_VERIFICATION (`verification-repair-controller.ts:207`); failing statement lives only in directive artifact.
- F4 predicate chosen from objective words (`plan-derivation.ts:158-184`): "auth/permission/secret" ⇒ SECURITY_SCANNER; "ui/browser" ⇒ UI_E2E unconditionally skipped (`verification-runtime.ts:239-244`) ⇒ no_runnable_checks.
- F5 completion gate hard-fails with no repair after all predicates pass (`index.ts:17126,17145` throw; caught `:17215-17226` ⇒ completion_gate_denied).
- F6 recovery poison: `environmentDigest` includes kernel `instanceId` (`verification-runtime.ts:120-131`); any kernel restart during VERIFYING permanently poisons the plan (`index.ts:16724-16745`).
- F7 **empty `allowed_scope` still accepted** at task creation (`index.ts:5111` `body.allowed_scope ?? {}`) ⇒ a task that can never touch its workspace. It now surfaces as a typed `TaskScopeError` (`index.ts:1483-1550`) instead of an opaque 500, but that maps to HTTP 409 on only two routes (`sendTaskScopeError` call sites); in the turn path it just fails the turn. Desktop sends a full scope (`apps/desktop/tests/task-scope.test.tsx`); the eval harness does too (`python/forge_evals/forge_evals/runners/terminus_harness.py:238`, `read_paths/write_paths: ["**"]`); only raw API callers are exposed. See memory note [[terminus-task-contract-scope]].

## (C) First live eval run
```
bun run scripts/dev-stack.ts
curl -X POST $BASE/v1/provider-accounts/discover -H "authorization: Bearer $TOK"
curl -X PUT  $BASE/v1/provider-accounts/<id>/default -H "authorization: Bearer $TOK"
export TERMINUS_CONTROL_URL=http://127.0.0.1:3050 TERMINUS_CONTROL_TOKEN=$(cat .terminus-dev/control.token)
cd python && uv run terminus-eval run --harness terminus-live --suite terminus-internal --task tiny-bugfix/001 --task-dir ../evals/tasks/tiny-bugfix/001 --seeds 1 --output-dir evals/results/live
```
Router `cli.py:417-431` → `_cmd_run_live` (`cli.py:270`) → `live_runner.run_live_task` → `TerminusHarness.run` (`terminus_harness.py:101-138`).
Missing: no pass/fail (`build_live_run_record` `cli.py:391` hardcodes `grader_results=[]`); no cost (`cli.py:393`); `--model` only labels (`terminus_harness.py:260 del request`); fake env digest (`cli.py:377`); Harbor/TB2 adapter builds argv (`benchmark_adapters.py:605-641`) but `_cmd_run_live` only branches on swe-bench (`cli.py:307-341`) — Harbor never invoked, no Terminus agent plugin registered; SWE-bench Verified returns argv None unless `swebench` importable (`live_runner.py:76-90`). Docker required. macOS blocker F2.

## (D) Test health (this machine)
bun test mini-services/terminus-control src: 421/0 (17.5 s); aci 74/0; context-compiler 51/0; provider-openai 27/0; provider-anthropic 5/0; provider-zen 16/0; verification 58/0; orchestration 88/0 ⇒ TS 740 pass / 0 fail. pytest 274 passed (50 s). boundary-check OK (11). typecheck (`typecheck:packages`/`typecheck:scripts`/`typecheck`) all clean, 0 errors. `bun run lint` (`eslint .`) 0 errors / 2 warnings (unused `eslint-disable` in generated `packages/terminus-kernel-client/src/generated/terminus/kernel/v1/kernel_pb.{d.ts,js}:18`). `cargo test -p terminus-sandbox-macos -p terminus-patch -p terminus-connector -p terminus-process`: **103 passed / 0 failed / 1 ignored** (connector 5 + broker_e2e 22, patch 26 + 18 across 4 integration bins, process 23, sandbox-macos 9). `cargo test -p terminus-kernel`: **123 passed / 0 failed / 0 ignored**, EXIT=0 — lib 32, `non_bypassability` 20, `policy_wiring` 17, `provider_account_discovery` 14, `capability_token_e2e` 12, `workspace_registration` 8, `kernel_protocol_contract_test` 6, `secret_canary_e2e` 5, `provider_account_connectors` 4, `workspace_effect_isolation` 3, `crash_recovery_e2e` 2 (completed after the agent's cutoff; log `/tmp/c_kernel.log`). `bun run test:unit` (`bun test packages/*/src`) from the repo root: **692 pass / 0 fail**, 98 files, 38.5 s. On a quiet machine `terminus-kernel` compiles in 1 m 17 s (the 22 min first observed was contention from parallel audit agents). Every freshly-linked Rust test binary stalls 1–4 min in `dyld4::RemoteNotificationResponder::blockOnSynchronousEvent` → `mach_msg2_trap` (three binaries sampled) — a machine-level dyld notification responder (debugger/EDR), not a repo defect.
**`bun test` from the repo root pays a ~31 s fixed directory-scan cost** (bun walks the CWD tree including `target/`): `bun test packages/provider-zen/src` is 37.7 s from root vs 6.2 s from the package cwd on a quiet machine. Under contention this ballooned into what looked like an indefinite hang (earlier drafts of this audit said "hangs"; corrected). `just check` is usable, just slow. Fix: bunfig test root scoping or exclude `target/`.

## (E) Ranked findings
1. 30 s verification timeout (`plan-derivation.ts:188-198`) → use suite/contract budget ≥600 s.
2. Seatbelt workspace read-only (`profile.rs:84-91`) → RW `workspace://` minus deny list.
3. Seatbelt reads entire FS (`profile.rs:80-83`); `ls ~/.ssh` works inside the sandbox.
4. No macOS conformance fixtures mirroring bwrap job; `tests/security/bypass/` empty; probes return silently without sandbox-exec.
5. **Symlinked workspace roots void every Seatbelt allowance**: `materialize_workspace_profile` (`services.rs:1609-1624`) no `canonicalize` (test does, `lib.rs:519`); `/var/folders/…` root ⇒ all writes denied.
6. Verification plan poisoned by kernel restart (instanceId in digest).
7. Completion gate hard-fail after predicates pass → route through scheduleRepair.
8. No orchestration reachable: `/v2/orchestration/ev-schedule` pure calculator (`index.ts:9638-9670`); `scopedDelegationService` → `unavailableScopedDelegationKernel` always throws (`:767-786`); `ManagedWorktreeLedger` zero call sites; `worktreePath: workspace.rootUri` (`:17195`). No worktree-per-task, no delegation, no subagent tool.
9. Global write serialization (`index.ts:1916-1920`).
10. `bun test` root ~31 s scan cost per invocation.
11. Shutdown abandons in-flight turns.
12. Eval records carry no verdict/cost (`cli.py:391-393`).
13. Harbor unreachable from CLI (`cli.py:307`).
14. Model has no completion affordance (no plan/submit/context_remaining tools).
