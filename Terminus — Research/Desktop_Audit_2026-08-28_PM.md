# Terminus Desktop — Audit Report (2026-08-28 PM, static + live)

Baseline: `npx vitest run` 38 files / 499 pass / 11 skipped; `tsc --noEmit` clean. The suite asserts the client's own (wrong) assumptions — `tests/conversation.test.tsx` and `src/lib/dev-mock.ts:386` feed `turn.provider_running`, an event the control plane never emits.

## Blockers
1. **Streamed text discarded.** Control plane emits `turn.provider_text_delta` `{text}` (`mini-services/terminus-control/src/index.ts:10472`); renderer handles only `turn.provider_running` (`Conversation.tsx:626`). Nothing streams; the reply lands in one lump at `turn.completed` or never. Fix: add the case, add to `TURN_RUNNING_EVENTS` (`turn-activity.ts:21`), fix dev-mock.
2. **Failed turn shows `agent_loop_error` only.** Server payload `{code, category, message, reason, retryable, details}` (`index.ts:15204`); client reads `p.reason` + `p.error` (`Conversation.tsx:597`); `p.message` read nowhere. Block collapsed by default (`ActivityBlock.tsx:80`); `ErrorState` unreachable (`Conversation.tsx:1323` gate on `items.length === 0`).
3. **Enter does not send.** `Composer.tsx:466-473`, `shortcuts.ts:28` only `⌘↵`. Add `sendPlain` (Enter, modifier none); `matchesShortcut` already rejects Shift/meta so Shift+Enter = newline for free; guard `keyCode === 229` (IME) before `preventDefault`. Same `Composer` on home, task, review — one fix.
4. **Every `ACTIVE` task renders as Working + spinner forever.** `task-lifecycle.ts:57,84`; `ACTIVE` is the steady state (`index.ts:5751` accepts turns on ACTIVE). `taskRunIsActive` used only in `Composer.tsx`. Add `displayLifecycle(task, events)` with an `idle` state; route Sidebar/App title/Inspector/Board/native-attention through it; re-fetch `GET /v1/tasks/:id` for ACTIVE rows.
5. **Selected model never reaches the turn.** `StartTurnInput` = `{thread_id, task_id, user_input}` (`types/index.ts:317`, `index.ts:5707`). Picker writes localStorage + `PUT /v1/gateway-provider-config` (global row, no provider field). Effort menu inert (`TurnSettings.tsx:104`; server hardcodes `reasoning_effort: "medium"` in `provider-openai/src/index.ts:146`). Initial selection = `models[0]`, not the server's.
6. **No project switcher.** "Change project" chip opens the sidebar *task filter* (`NewTaskScreen.tsx:175-178`); `+` gated on `filteredSessions.length > 0` (`Sidebar.tsx:383`); rail unreachable (`compact` never passed); title bar is a span; palette lists tasks only; `Session` has no root path (`GET /v1/sessions` omits it, `index.ts:4545`); switching session lands on blank "Start a conversation" (`use-terminus.ts:1269` + `App.tsx:515`).
7. **Steering not wired.** `POST /v1/turns/:id/steer` exists (`index.ts:5909`); `api.ts` has no method; `Composer.tsx:429` parks the text in a queue flushed only when `runIsActive` goes false and `healthReady` — with a stuck `active_turn` the prompt vanishes into "Queued." forever.

## Major
8. `healthReady` hard-gates sending (`Composer.tsx:502`), probed once in `refreshSessions` (`use-terminus.ts:668`) + window focus; 5s timeout → false; no interval.
9. `ConnectionBanner.tsx` (151 lines) never mounted; `Layout.banner` never passed (`App.tsx:545-691`); `lastError` never rendered.
10. Board "View details" opens the wrong task (`App.tsx:275` sets `selectedCanonicalTaskId`, conversation reads `selectedTaskId`).
11. Board status filter emits `running`/`waiting_for_review` (`MissionBoardView.tsx:772`); columns are `working`/`review` → empties the board.
12. Attention badge counts v1 lifecycle; modal reads `/v2/attention/questions` whose writer is a hard 503 (`index.ts:9059`) → always "Nothing needs attention".
13. Agents destination permanently empty (`orgDirectory` has zero writers).
14. Re-opening a project duplicates the session (`POST /v1/sessions` no dedupe on workspace_id, `index.ts:4377`); client hardcodes `kind: "local_directory"` (`Onboarding.tsx:272`); 409 on identity conflict surfaces raw.
15. Fabricated data: Inspector "Runtime: Local UDS", "Access: Full access" (relabels `secure-local-default`), "Contract v1", "Risk: Standard"; board branch chip and "PR ready"/"Pull request" filter with no backend concept.

## Minor
16. `turn.failed` reason never reaches `task.terminal_reason` (`public-client/src/projection.ts:426`). 17. SSE failures drop status, retry forever (`api.ts:1428`). 18. Composer error truncated to 12rem (`Composer.tsx:609`). 19. 15/18 `ErrorState` presets dead. 20. No crash reporting / `render-process-gone`. 21. No deep links; no notification on completion (`use-native-attention.ts:34`). 22. Menu: no Stop run, no Open Recent; Help links placeholder; bridge orphans (`getTheme`, `getWindowBounds`, …); CSP meta-only.

## Recommended project-switch flow
Sidebar header → Menu of sessions (title + workspace root) + "Add repository…"; `+` unconditional; title bar = same menu; palette `project.switch.*` commands; File ▸ Open Recent; "Change project" chip opens the same menu; land on `new_task` after switch; persist last session; dedupe on open; expose `workspace_root_uri` on `GET /v1/sessions`.

## Phantom running — causes
(1) ACTIVE rendered as Working; (2) `active_turn` never cleared on turn terminal events (`projectTaskEvent` ignores `turn.*`, `reconcileTask` carries it forward); (3) event tail empties (LRU eviction 32 MB, `cursor_expired`, transcript replay 6s timeout → null cursor, list-only tasks have no stream); (4) window focus doesn't refresh the selected task (`App.tsx:382`); (5) control-plane restart leaves tasks ACTIVE (`index.ts:7467`); (6) send button says "Steer" for idle ACTIVE tasks. Plan: displayLifecycle; debounced `refreshTask` on `TURN_SETTLED_EVENTS`; detail fetch for ACTIVE rows; refresh on focus; bound the steer queue; poll `GET /v1/turns/:id` after 60s silence.

## Dead / placeholder UI
Board "Display" menu (no onClick); DiffViewer accept/reject/restore + open-in-editor gated on props `ReviewPane` never passes (~200 lines); Settings shortcut recording unreachable; `StructuredInterventionModal` (640 lines) unreachable and its backend is a 503; `api-v2.ts` 15 unused methods; ~40 authored settings discarded by the `CATALOG` allowlist; Settings ▸ Agents disappears from settings search; every `open-settings` dispatch hardcodes appearance/shortcuts.

## Native shell (Electron 43.4.1; `electron/main.ts` 746 lines, zero test coverage)
- **Blocker:** every `window:*` IPC handler targets module-level `mainWindow` (`main.ts:595`), so Preferences' Close/Escape closes the main window. Fix: `BrowserWindow.fromWebContents(event.sender)`.
- **Blocker:** ⌘W on main while Preferences is open is unrecoverable — `activate` checks `getAllWindows().length === 0` (`main.ts:705`); Window ▸ Terminus and ⌥⌘Space early-return on null `mainWindow`.
- Folder drag-and-drop dead: `preload.ts:124` reads `File.path` (removed in Electron 32) → use `webUtils.getPathForFile`.
- ⌘1 eaten by Window menu (`main.ts:333`); Help ▸ Keyboard shortcuts opens Appearance (category sent on `ready-to-show` before React mounts, `main.ts:472`; pass via `additionalArguments`).
- Window bounds persisted in the renderer (`Layout.tsx:288-304`): visible reposition on launch, no maximized/fullscreen capture, offscreen restore possible (`shell-guards.ts:72` validates shape not visibility).
- No crash handling (`crashReporter`, `render-process-gone`, `child-process-gone`, `unhandledRejection` absent); `reload` role dev-only → production renderer crash = blank window.
- CSP meta-only (`src/index.html:6`): no `base-uri`, `form-action`, `frame-ancestors`, `object-src`; no response header; Vite refresh preamble lands before the meta in dev.
- Launch theme: `main.ts:543` resets `themeSource = "system"`; stored Light choice flashes dark; `nativeTheme.on("updated")` unwired.
- `terminus://` deep links unregistered (no `setAsDefaultProtocolClient`/`open-url`/`CFBundleURLTypes`; `second-instance` ignores argv).
- Sound: `contextIsolation`/`sandbox`/`nodeIntegration:false` on both windows; `shell-guards` wired; `setWindowOpenHandler` + `will-navigate`; single-instance lock; packaged CSP placeholder tracks the supervisor port.
- Minors: 5 orphan bridge methods + 3 dead `ipcMain` handlers; no menu item ever `enabled:false`; ⌥⌘Space collides with Finder search; preload `apiBase` fallback fails open to :3050; `types/index.ts:604` second bridge type 12 members stale; no `setAboutPanelOptions`, no auto-updater.
- Also: skipping first-run onboarding permanently suppresses it (`App.tsx:518-521` ignores `result.skipped`); >100 projects → server pages by `id asc`, client sorts per page by `updated_at`; task completion never notifies; truncated responses show a raw `artifact://` URI (`Conversation.tsx:529`); workspace kind hardcoded `local_directory` (`Onboarding.tsx:270`) → permanent 409 if registered as `local_git` elsewhere.
