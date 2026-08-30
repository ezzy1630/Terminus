# Terminus ACI + kernel exec audit — HEAD c2cd9d5 (2026-08-29)

Subagent: claude-opus-5[1m]. ✔ = lead re-verified at cited lines.

Headline correction to the 2026-08-28 audit: `packages/aci` (~4,400 LOC: read/search/patch/inspect/capability/question/exec_job) and `schemas/tools/*.json` are DEAD — imported by nothing but their own tests; the live server imports only `okResult`/`errorResult`/`ToolResult` types. Real surface = `mini-services/terminus-control/src/agent-tools.ts:379`; the model sees THREE tools.

## (A) Palette actually sent
Rendering `{name, description: summary, input_schema}` (`provider-anthropic/src/index.ts:323-329`; `provider-openai/src/index.ts:440-450`). No per-property descriptions anywhere.

| tool | desc chars | params | est tok | live | familiarity |
|---|---|---|---|---|---|
| read | 227 | 6 | 179 | yes | MED — `path/offset_line/max_lines` vs trained `file_path/offset/limit`; `.strict()` rejects trained spelling |
| patch | 268 | 6 | 239 | yes | LOW — `expected_utf8`/`replacement_utf8` no prior (CC `old_string/new_string`) |
| exec | 258 | 7 | 242 | yes | LOW — `program+args` XOR `shell:{dialect,script}`; no `command`; `expected_exit_codes` load-bearing |
| exec_poll | 177 | 3 | 149 | no | |
| web_fetch | 253 | 2 | 130 | no | |
| grep | 116 | 5 | 131 | no | HIGH |
| glob | 96 | 3 | 100 | no | HIGH |
Live palette 659 tok; all 7 = 1,168. Authority prefix 932 tok. Fixed overhead ≈1,591 tok.
Why three ✔: `index.ts:14810` `declaredToolIds = new Set(TERMINUS_MINIMAL_TOOL_IDS)`; `:14818` filters; `:16271-16280` rejects non-declared calls.
Load-bearing wrong text: exec desc says "await with exec_poll" (not offered ⇒ `background:true` orphans a job); patch desc never names `expected_utf8/replacement_utf8`; system prompt documents grep/glob/exec_poll (`system-prompt.ts:56,58`) rejected at `index.ts:16276`; `system-prompt.test.ts:82` asserts the mismatch; `:56` "Non-zero exits return stdout/stderr verbatim" is FALSE (C1).

## (B) Result envelope
Model receives `JSON.stringify(projectModelVisibleResult(result))` (`agent-tools.ts:858`); ceremony IS stripped. Overhead: read small 336 B; read 500 lines +3.9%; exec success 115 B; exec non-zero exit 79 B with payload DELETED; patch success 614 B (transaction_id, final_repository_revision "no-vcs", 3× sha256 — none actionable). `is_error` never delivered to Anthropic: `provider-anthropic/src/index.ts:246` reads `raw.is_error` but flag lives at `raw.result.is_error`.

## (C) Ranked findings
C1 ✔ exec deletes ALL output on non-zero exit: `agent-tools.ts:1837` status error when exit ∉ expected_exit_codes ([0]); `projectModelVisibleResult:861-870` drops `data` for non-success; no diagnostics ⇒ model gets `{"status":"error","summary":"bash script exited 1; expected 0","is_error":true}`. Every failing test/tsc/rg-no-match invisible. Fix: always project data for process-class results.
C2 ✔ read ignores offset_line: kernel `services.rs:1252 read(ctx,intent,path)` no range; `grpc.rs:857-864` whole file, `take(max_bytes)` prefix, `ranges` discarded; `agent-tools.ts:1153-1159` labels prefix with `startLine: offset_line`. Files >28 KiB unreadable past head. Zero tests. Fix: implement ranges in kernel or slice in grpc.rs.
C3 No file creation: patch only `replaceExactText` (`:1282`), `PATCH_REQUIRES_OBSERVED_SOURCE` (`:1246`); kernel already has CreateFile/MoveFile/DeleteFile (`kernel.proto:176,178,231,245`; `engine.rs:317-331`). Fix: `write` tool ~30 lines.
C4 Prompt advertises rejected tools. grep/glob reachable only from scout loop (`index.ts:15804`) which is dead (`minimal-profile.ts:74`).
C5 ✔ Every exec capped at 60s: `services.rs:2314-2318` clamps to `profile.resources.wall_clock_ms` = `Some(60_000)` (`terminus-sandbox/src/profile.rs:58`), never overridden. Tool advertises 120s/600s.
C6 exec output head-only 20 KiB shared stdout+stderr (`agent-tools.ts:1938,1955-1963`); no elision marker; `exec_poll` pure tail (`:1613`). `output_policy_id` read by nothing (`grpc.rs:2009-2040`).
C7 ✔ Turn budget 24 steps: `HARD_MAX_STEPS=24` (`turn-budget.ts:18`) clamps configured 64 (`index.ts:15914-15915`; `:312-315`). ADR-0039 claim false.
C8 Observed-hash tracker per-turn, never updated by patch: `ObservedSourceTracker` (`agent-tools.ts:1077`) fresh per turn (`index.ts:14945`), `record()` only from read (`:1163`) ⇒ first edit after prior-turn read ⇒ PATCH_REQUIRES_OBSERVED_SOURCE; second patch to same file in a turn ⇒ PATCH_STALE_SOURCE. Fix: record new_sha256 post-apply; seed from episode log.
C9 Truncation continuations dead: `grpc.rs:890-894` literal `"artifact:full"`; read schema has no continuation param; artifact URIs unreadable by any tool.
C10 Idempotency gate for reads FIXED; residual: denial guidance text discarded (`index.ts:13871-13878`).
C11 ✔ macOS Seatbelt real (`sandbox-macos/src/lib.rs:286-360`; `services.rs:148-175`) but: `(allow file-read* (subpath "/"))` from `profile.rs:80-83` ⇒ entire FS readable (~/.ssh, ~/.aws); only writable path `<workspace>/active-worktree` which nothing creates; `mach-lookup` unqualified (`lib.rs:123`); `env -i` with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `HOME=/var/empty` (`lib.rs:305-315`; `services.rs:163` never `.with_workspace_root`) ⇒ bun/node/cargo/rg unreachable; caller `public_env` PATH overrides; `disallowed_env` bypassed (`services.rs:1924,2194`).
C12 No network from exec on macOS: no HTTP_PROXY injection anywhere; `TERMINUS_EGRESS_BROKER_SOCKET` wiped by env -i, hardcodes Linux guest dir (`services.rs:1703-1709`); `proxy-required` fails closed (`:2230-2252`); curl/wget policy-denied pre-spawn (`rules_yaml.rs:158-165`); git fetch dies on `.git` deny (`lib.rs:159`); `web_fetch` filtered out. Model has zero network.
C13 `TERMINUS_DEV=1` set by every launcher ⇒ `sandboxProfileId:"degraded-local"` on every exec (`index.ts:659`); on hosts without sandbox-exec = unsandboxed spawn (`services.rs:2401`).
C14 macOS enforcement no CI evidence: live tests (`lib.rs:492,514`) never assert network verdict; kernel integration tests only run on ubuntu (`ci.yml:218-247`); `platform-probes.json` hand-generated.
C15 Computer use: nothing. `resolveTrustedComputerUseBackend()` returns null (`index.ts:1955-1957`); `/v2/computer/*` 503; no playwright/puppeteer; no screenshot tool.
C16 MCP + skills unreachable: `mcp_relay.ts` instantiated nowhere; `@terminus/capability-registry` not imported by control; 185 SKILL.md, no loader; `capability` tool not in palette; `TERMINUS_ACTIVE_TOOL_CAPABILITIES` set by nothing and no-op.
Minor: `toolSchemaTokens` hardcoded 0n both providers; `prompts/authority/*.md` drifted and unloaded; `schemas/tools/*.json` third nonexistent surface; `TERMINUS_STRICT_SANDBOX` never read; shell mode ON by default (`agent-tools.ts:54`) contra ADR-0039.
Verified good: ADR-0046 tolerant anchors wired (`engine.rs:563-594`, `fallback.rs`); gutter stripping; absolute-path relativization; InvalidToolCallError settles as result; steering; identity-fenced kill (`manager.rs:470-561`).

## (D) Proposed minimal palette (same kernel boundary; every mapping exists)
| tool | schema | maps to | work |
|---|---|---|---|
| bash | `{command, timeout?, run_in_background?}` | ProcessService.Start shell | accept `command`; ALWAYS return `{exit_code,stdout,stderr}`; 30 KiB 50/50 head/tail with per-stream floor + inline elision marker; drop expected_exit_codes |
| read | `{file_path, offset?, limit?}` | FileService.Read | alias; fix kernel range; plain text not JSON; drop render/max_bytes/expected_sha256 |
| edit | `{file_path, old_string, new_string, replace_all?}` | PatchService ReplaceExactText | alias; hash server-side; update tracker post-apply |
| write | `{file_path, content}` | CreateFile | new, ~30 lines |
| grep | `{pattern, path?, glob?, -i?, output_mode?}` | grepArgv | add to minimal ids; fix PATH |
| glob | `{pattern, path?}` | globArgv | same |
Six tools ≈1,100 tok. Ship `bash_output` for background. Make `web_fetch` declarable. Raise HARD_MAX_STEPS past 24.

## Corrections from the subagent's own verification pass
- C14 overstated: `macos-latest` runs `cargo test --workspace --lib` (`ci.yml:156-161,173-175`) which executes the in-lib Seatbelt live tests; only `non_bypassability` runs ubuntu-only (`ci.yml:229,240`). `live_seatbelt_preserves_workspace_contract` (`lib.rs:535-537`) is a real adversarial fixture (.git/secret, .terminus/credentials). Remaining criticism: `live_seatbelt_blocks_escape_and_ambient_secrets` asserts only FilesystemEscape + AmbientSecretDenial (`lib.rs:507-509`) while `run_probes` measures NetworkEgress (`probe.rs:218`) — network verdict computed, never asserted; both tests `return` silently without sandbox-exec (`lib.rs:495-497,527`).
- C12 cite: OR semantics at `crates/terminus-policy/src/rule.rs:55-62`.
- Cross-platform note (from the verification agent's final pass): the phantom `active-worktree` RW rule also breaks Linux by construction — it becomes `MountOp::Bind` of a nonexistent source (`terminus-sandbox-linux/src/mounts.rs:283-288`), while the Linux crate's reference plan (`lib.rs:76-105`) shows the intended shape (workspace root RW + deny overlays). Whole-FS read is macOS-only; Linux refuses to bind `/` (`mounts.rs:272-274`). `/tmp` is also EPERM under the Seatbelt profile (verified), so forwarded `TMPDIR` is unusable.
- Confirmed: 60 s clamp; `/` ReadOnly (`materialize_workspace_profile` `services.rs:1613-1622` rewrites only `workspace://`; `lib.rs:143` emits `(allow file-read* (subpath "/"))`); `active-worktree` only at `profile.rs:89`, created only in test `lib.rs:518`; PATH `lib.rs:312`; computer use null; capability-registry declared (`package.json:33`) zero imports.
- NEW: policy `match:` blocks are DISJUNCTIONS — `RuleMatch::matches` (`rule.rs:55-138`) returns Positive on the first satisfied predicate. `deny-download-pipe-interpreter` (`rules_yaml.rs:158-165`) reads as "curl/wget AND piped to interpreter" but fires on the basename alone ⇒ every curl/wget denied. Every shipped rule is broader than its YAML in both directions. Fix: AND populated clauses; add near-miss test per rule.
