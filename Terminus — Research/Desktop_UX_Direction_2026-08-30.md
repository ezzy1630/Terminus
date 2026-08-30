# Terminus Desktop — UX direction and what to do next

2026-08-30. Written after capturing the live Codex macOS app, capturing Terminus's own mock states, and a read-only pass over `apps/desktop`. This is a direction document, not a code review: it says what the app should feel like, where it falls short today, and the order to fix it.

Reference screenshots: `~/Downloads/terminus-ux-reference-2026-08-30/` (`codex/` = live Codex captures, `terminus-mock/` = Terminus at 1440×900 in mock mode). Prior material this builds on: `Desktop_Audit_2026-08-28_PM.md`, `~/Downloads/uiuxresearch.md`, and the recorded decisions (stay on Electron, Apple system blue, three permission levels on the composer chip, settings in-app, inbox as the sidebar default, worktree as an option not a default).

---

## 0. The verdict, in ten lines

1. The bones are right — three regions, calm dark chrome, one status vocabulary, a disciplined token file. The execution still reads as a web admin panel: a three-line thread header, boxes inside boxes, grey buttons, raw prompt text as thread titles, engineering vocabulary on every settings row, and nothing that moves.
2. Codex wins on quietness, not features: one 44pt header row, typography-only hierarchy, one-line activity summaries, a side panel of actionable rows, and a composer that is the control centre. Steal that structure. Do not copy the skin.
3. Terminus's first opening is attention. Codex spins a ring and tells you nothing until you open the thread. Terminus already has the lifecycle and evidence model to say "this needs you, because X". Make that the signature.
4. Second opening: verification. Tests, checks, and evidence as first-class UI — in the run bar, the details panel, and on board cards. No competitor shows this well.
5. Third: multi-provider model UX with honest cost and quota. Codex has one model family; Terminus has eight providers and presents them as two-letter monograms and truncated slugs.
6. The single biggest "it looks frozen" bug is one CSS rule: `.spinner` has no animation and the skeleton shimmer is disabled (`globals.css:861`, `:892`). Every working state in the app is a static broken ring.
7. The single biggest "it's a website" bug is also small: `cursor-pointer` on every `bare` button (`ui/Button.tsx:51`, 57 call sites) and a window drag region that covers only the sidebar (`Layout.tsx:229`).
8. Vocabulary: thread, task, mission, session, and space all appear in the UI for the same object. Pick five nouns and use them everywhere: **Thread, Project, Run, Changes, Board.**
9. Order of work: fix the frame first (header, sidebar rows, composer, details panel, motion, tokens — about two weeks), then the transcript, then review, then board and home, then the native extras.
10. Don't add chrome (no permanent file tree or terminal), don't build fork/checkpoint UI until the backend can honour it, keep Apple blue, keep settings in the window.

---

## 1. What Codex does that Terminus should learn from (structure, not skin)

Observed live, not from marketing:

- **One header row.** Sidebar: `[toggle] [◀] [▶]` next to the traffic lights. Content: folder glyph + thread title + `…`, and on the right `Share`, side-panel toggle, bottom-panel toggle. 44pt tall. That is the whole top of the window.
- **Sidebar rows carry three facts and nothing else:** an auto-generated 3–6 word title, the project name as a 12px subtitle with a folder glyph, and a status glyph on the trailing edge (a slowly rotating ring while working). Hover reveals pin and archive. Groups are `Priority` (pinned) and dates. A workspace switcher (`Codex ▾`) sits at the top; there is no Threads/Projects mode switch.
- **The transcript is prose.** Assistant text at ~15px/23px in a ~735pt measure, no bubbles, no borders. Tool activity collapses to one tertiary line with a leading glyph: "Read files, ran commands", "Edited a file, read files, ran commands", or the literal command when there is only one. Sub-agents appear as small pills ("Audit gate1 proof path · finished"). While working, the last line is the model's current step in tertiary text ("Preparing clean worktree for build"). System events read the same way ("Context automatically compacted").
- **A sticky run pill above the composer:** `○ Step 6 / 6 · 28 files changed +3,569 −826`. One glance answers "how far along, how big".
- **The composer is the control centre.** `+` opens a menu (Files and folders, Attach appshot, Goal, Plan mode, Record a skill, then Plugins with logos). The permission level is a labelled chip in warning colour ("Full access"). The model chip reads `5.6 Sol Ultra` and opens a three-row menu (Model ›, Effort ›, Speed ›, Advanced). The primary control is a filled blue circle: arrow when there is text, square when running, waveform when empty. On the home screen a context strip sits above the field: `[Terminus] [Local] [main]`.
- **The side panel is a card of actionable rows**, not metadata: Changes `+18,918 −3,792` (opens review), Local ▾ (environment), main ▾ (branch), Commit or push, Compare branch ↗, Subagents `1 working · 10 done`, Computer Use, Sources. Each row is glyph + label + value/chevron. No tabs.
- **Review is a pane with tabs** (`Review`, `+`) that can sit beside the transcript or take the whole content area; in takeover the composer collapses to a single-row pill docked over the diff so you can keep talking. Header: `Branch ▾ +18,918 −3,792 · main → origin/main`, a small icon toolbar, `Commit or push ▾`. Large diffs page one file at a time with a banner; unmodified runs collapse to a "229 unmodified lines" bar.
- **Settings take over the window.** The sidebar becomes the settings nav (Back to app, Search settings, grouped sections). Content is grouped rounded cards; each row is title + one-sentence description on the left, control on the right. Copy is user language ("Keep your computer awake while ChatGPT is running a task").
- **Master–detail for lists** (Pull requests: list left, "Select pull request to view" right; segmented `All / Reviewing / Authored` in the header row; skeleton rows while loading).

What *not* to take from Codex: consumer chrome (Pets, a plugins marketplace, Explore), the perpetually-skeleton PR list, the over-clever "Pursuing goal" bar, a sidebar with no attention grouping at all, and a model picker that hides context/quota entirely.

---

## 2. Where Terminus is today, surface by surface

Read against the mock captures and the live screenshots you sent.

| Surface | Terminus today | Gap |
|---|---|---|
| Header | 82pt three-line block (project · title · state/detail/elapsed · metrics) with its own border; `…` alone on the right; no back/forward although `use-nav-history.ts` implements a 50-entry stack | Collapse to one 44–52pt row; move state into the run bar and project into the sidebar row |
| Sidebar | `Threads / Projects` segmented control, `New thread`, `Search`, then `NEEDS YOU 7 / READY TO REVIEW 2 / RECENT` with coloured dots on the left; titles are the raw prompt ("Reply with exactly ZEN_FREE_OK…"); no project subtitle; Projects mode lists ten `eval:terminal-bench/…` sessions; `Settings` alone at the bottom; no context menu on rows; board unreachable from the sidebar | Row model (title + project + trailing status), auto-titles, hide eval/system sessions, project switcher instead of the mode switch, context menus, a Board entry |
| Home | "What should we build in Tiny?" then ~100–150px of air then the composer; nothing else on the canvas; composer strip shows only the folder chip | A project front door: context strip `[Project ▾][Local / Worktree][branch]`, and the three lists a returning user wants |
| Transcript | Right-aligned user bubble (fine); `Run details · 1m 46s` disclosure; assistant prose; a stray `ox-alpha` model label; a vertical rail with bullets for activity; streaming caret rendered on its own empty line; no timestamps; code fences unhighlighted; no tables | Flatten activity to one-line summaries, add the live step line, fix the caret, highlight code, add day separators |
| Above composer | "Decision needed" card docked above the field (good pattern) | Add the run bar; render approvals into the transcript once resolved |
| Composer | `+` (paste clipboard, insert folder path), grey stop circle + grey arrow, `After current turn ▾` dropdown, model chip `OZ Nemotron Lightning`; permission chip and project chip render only on the start screen (`Composer.tsx:1032`, `:1146`); no attachments, drop, @-mention, slash, or worktree option; `spellCheck={false}` | One primary button, chips always visible, short model names with logos, a real `+` menu, drop and paste |
| Details (Inspector) | Tabs `Overview / Environment / Evidence`; Overview shows Status and Changes and blank space | Replace with a card of actionable rows; keep Evidence as Verification |
| Review | Split pane; `Working tree · 1 file ▾` + `Artifacts`; file dropdown + ↑↓ + `Browse lines`; unified/split; local comments; `Mark reviewed locally` / `Draft change request`; one file at a time; no git actions | Takeover layout, file rail, commit/push, per-file continuous scroll, syntax colour |
| Board | Header `All Tasks Reconnecting · Status ▾ · Space: … ▾ · Clear · Search · Kanban/List · Needs you 1 · ⟳`; five columns; cards = title + truncated project + relative time | Calmer header, cards that show step / ± / checks, an entry point in the sidebar |
| Palette | Groups Navigation / Task / Changes / Appearance; plain rows; recents ranking is destroyed by regrouping (`CommandPalette.tsx:217`) | Recents first with status glyphs, glyphs on commands, content search later |
| Settings | Three columns (app sidebar + category rail + content); plain hairline rows; copy like "Wire protocol: OpenAI Chat Completions", "Marks this exact model as zero-cost for routing records" | Takeover layout, grouped cards, rewrite copy, move plumbing under Advanced |
| Model picker | Back-arrow "Model" header, search, provider chips wrapping to two lines, `OZ`/`CG`/`CH` monograms, subtitles repeating the provider, `400K…` truncation, popover not portaled (`ModelPicker.tsx:418`) | Short display names, provider logos, Favourites/Recents, one-line subtitle, Radix Popover |
| Motion | `.spinner` has no `animation`; `.skeleton::after { content: none }` | Rings spin, skeletons shimmer, panes slide |
| Browser tells | `cursor-pointer` on 57 bare buttons; drag region = sidebar only; 13 raw `title=` attributes (`Inspector.tsx`, `DiffViewer.tsx:1255`); two tooltip systems with 0ms vs 450ms delay; `"✓"` text as the menu checkmark (`ui/Menu.tsx:26`); 55% dialog scrim; `<details>` disclosures; `hover:underline` recovery links; 11 icon sizes and 9 stroke widths; 24-hour timestamps with seconds regardless of locale | See §5 |

Already good and not to be rebuilt: `theme.css` tokens, `TaskRow.tsx`, `task-lifecycle.ts` + `attention.ts`, `native-scrollbars.ts`, `keyboard-focus.ts`, the failure copy in `Conversation.tsx` (`TURN_OUTCOMES`, `humanizeProviderFailure`), the composer's turn machinery (idempotency, steer/queue/stop), `ConnectionBanner`, the diff parser and virtualiser, vibrancy and traffic-light handling in `electron/main.ts`.

---

## 3. Principles — the feel contract

Eight rules. Every screen and every PR should be checkable against them.

1. **Typography carries the hierarchy.** Borders are for exactly two surfaces: the composer and the details card. Popovers get a shadow. Nothing else gets a box. No boxes inside boxes.
2. **One row of chrome at the top.** 44–52pt, draggable edge to edge, aligned across sidebar, content, and panel. Everything else is content.
3. **What the user reads is a sentence; what the user scans is a row.** No JSON, no slugs, no hashes, no "wire protocol". Status is a verb phrase ("Waiting for your approval to run `bun test`"), never a code.
4. **Quiet by default.** Colour has three jobs: amber = needs you, red = failed or destructive, blue = you can act (primary button, selection, links, toggles). Everything else is grey ramps.
5. **Motion is state, not decoration.** Rings spin while working. Panes slide 200ms ease-out. Cards glide between board columns. Status glyphs morph (ring → check). Nothing bounces, nothing fades in on scroll, everything respects Reduce Motion.
6. **Every list has three extra states** — skeleton, empty, error — and they use the same rows as real content. No dashed placeholder boxes, no centred grey sentence in an otherwise blank canvas.
7. **Every action is reachable four ways:** visible control, context menu, menu bar, ⌘K. Every icon button has a 400ms tooltip. Every row has a right-click menu.
8. **The app never lies about state, and never decides for the user silently.** Idle is not Working. Failed says why in one sentence with a Retry. Queued says when it will send. A count in the sidebar equals the number of rows in the group. An approval or question waits until answered; a countdown that answers on the user's behalf is a bug (Codex's 60-second auto-resolve drew 200+ upvotes asking for it to go away).

---

## 4. Target anatomy

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  ⧉  ‹ ›     Terminus ▾        │ ▤ Refactor kernel RPC handler  …      ⎘ ⊞ ▯ │  44–52pt, draggable
├─────────────────────────────────────┼─────────────────────────────────────┬──────────┤
│ ✎ New thread                ⌘N     │                                     │ Changes  │
│ ⊞ Board                     ⌘⇧B    │   user turn                          │ +120 −33 │
│ ⌕ Search                    ⌘K     │                                     │ Local ▾  │
│                                     │   assistant prose                    │ main ▾   │
│ NEEDS YOU                           │   ⌁ Read 3 files, ran 2 commands     │ Commit…  │
│  ▍Hyperparameter sweep              │   assistant prose                    │ Open in… │
│    Learning rate tuning · question  │   ⌁ Edited socket.rs  +5 −0          │──────────│
│ TODAY                               │   ◌ Running bun test…                │ Model    │
│  Refactor kernel RPC handler   ◌    │                                     │ 5.6 Luna │
│    Terminus Control Plane           │ ┌ ● Turn 3 · 4 files +120 −33 · ✓12 ┐ │ ▮▮▮▯ 62% │
│  Session cards in sidebar      ✓    │ ├───────────────────────────────────┤ │──────────│
│    Terminus Control Plane           │ │ Ask or describe a task…           │ │ Checks   │
│                                     │ │ + ⚠ Full access ▾   5.6 Luna·High ▾ ⬤│ │ ✓ tests  │
│ ○ Ezzy · ChatGPT Pro           ⚙   │ └───────────────────────────────────┘ │ ✓ tsc    │
└─────────────────────────────────────┴─────────────────────────────────────┴──────────┘
```

### 4.1 Header row
- One row, 48pt (the sidebar toggle, back/forward, and content actions all sit on it). Whole row is `-webkit-app-region: drag`; controls opt out. Double-click zooms.
- Sidebar side: traffic lights, sidebar toggle, `‹ ›` wired to the existing `use-nav-history.ts` (`⌘[` / `⌘]`, plus a Go menu).
- Content side: project/folder glyph + thread title (15px semibold, editable on double-click) + `…` menu (Rename, Pin, Archive, Open in new window, Copy link, Reveal in Finder). Right: `Changes ±` pill (opens Review), details-panel toggle, review-pane toggle. Nothing else.
- Hairline under the header only once the content has scrolled.
- Delete the three-line `ThreadHeader`. Its state line moves to the run bar; its metrics move to the details panel; its project name moves to the sidebar row subtitle.

### 4.2 Sidebar (276pt, vibrancy)
- Top: `Terminus ▾` project switcher (menu: all projects, each project with path and branch, "Open project… ⌘O", "Recent"), then a search glyph. Title of the switcher = current project or "All projects".
- Nav rows (28pt, 13px): New thread ⌘N, Board ⌘⇧B, Search ⌘K. Later: Review queue, Scheduled.
- Groups, sentence case, 11px tertiary, 24pt tall, with counts that match the rows:
  - **Needs you** — only rendered when non-empty. Rows are 2-line: title, then the *reason* in amber ("Waiting to approve `bun install`", "Asked which auth provider to use", "Failed: provider timed out"). A 2px amber rule on the left edge instead of a dot.
  - **Pinned**.
  - **Today / Yesterday / Earlier this week / Older**.
- Row model (from `TaskRow.tsx`, extended): title 14px primary (auto-generated, 3–6 words), subtitle 12px tertiary = project name with folder glyph (only shown when the switcher is on "All projects"), trailing 14px slot = rotating ring (working) · amber dot (needs you) · blue dot (finished, unread) · nothing. Hover reveals pin and archive glyphs in the trailing slot. Right-click = same menu as the header `…`.
- Provenance as a real field: `human`, `eval`, `scheduled`, `subagent`, `cli`. The human list shows only `human` by default; the switcher menu exposes the others as a filter. Codex retrofitted this after CLI and sub-agent sessions flooded its sidebar with no way to narrow it back down.
- Sort the sidebar by what is blocked on you, then finished-and-unreviewed, then running, then everything else. Optimise for three to ten threads; degrade gracefully to fifty. Nobody reviews more than a couple of agents' output at once, and the app should not pretend otherwise.
- Sprawl control from day one: threads whose changes were merged or discarded soft-archive automatically; anything untouched for two weeks folds into "Older"; sections stay user-orderable. Thread sprawl is the sidebar problem Codex is still fighting in public (a dozen open issues, "47 threads", and OpenAI shipping custom sidebar sections in July).
- `⌘⌥A` jumps to the next thread that needs you (Codex's best keyboard idea; cheap to add to `shortcuts.ts` once Shift/Option combinations are allowed).
- Auto-title: derive at first turn from the prompt (model summary if available, otherwise first clause, max 48 chars). Rename inline.
- Footer: account row (avatar, name, plan) + settings gear. Replace the lone "Settings" link.
- Remove the `Threads / Projects` segmented control; "Group by project" becomes an option in the switcher menu.

### 4.3 Home — the project's front door
- Top third: a monochrome Terminus mark, then "What should we build in **Terminus** ▾?" (22px semibold; project underlined dotted and clickable — the same switcher menu).
- Middle: if the project has active threads, a compact list of up to three (`Needs you` first) using the sidebar row style; otherwise four intent chips (Explore the codebase · Build a feature · Review changes · Fix a failure) that only prefill the composer.
- Bottom third: the composer with a context strip above the field: `[▤ Terminus ▾] [⌂ Local ▾ — or — ⑂ Worktree] [⑂ main ▾]`. The strip is where the worktree option lives (recorded decision: option, not default). Use Codex's vocabulary for the mental model — Local is the foreground, a worktree is the background, and **Hand off** moves the thread and its code between them — but pair it with what Codex lacks: a declarative per-project setup script, a unique port per worktree exposed as an environment variable, and copying of gitignored `.env` files, because "reinstall everything per worktree" is the universal complaint about worktree products.
- Cut the top padding: heading at ~18% of window height, composer at ~55%. Nothing should sit below the composer.

### 4.4 Transcript
- Measure 760px, centred; assistant prose 15px/1.55 primary; paragraphs 12px apart; inline code chips on a subtle surface; headings 15px semibold; tables, nested lists, task lists rendered (`Message.tsx` currently stops at headings/lists/quotes).
- User turn: right-aligned soft bubble (keep), max 72% width, 15px, hover reveals time and `Edit & resend`.
- Activity: one tertiary line per group, 14px glyph + verb-first summary ("Read 3 files, ran 2 commands", "Edited `socket.rs` +5 −0", or the command itself when there is exactly one). Click expands inline to rows (`read` path · lines, `exec` command · exit · duration, `patch` file ±). Remove the vertical rail, the bullets, the `ox-alpha` label (model belongs in the details panel), and the second expand path through `ProgressDrawer` (`ActivityBlock.tsx:153`).
- Reasoning: a single line "Thought for 12s ▸", expands inline.
- A transcript density setting — Summary / Normal / Detailed — where Detailed keeps every tool call and edit expanded. Collapsed-by-default is right for most people, but "let me keep everything expanded" is one of the most repeated unanswered requests on Codex's tracker (four independent issues, 12–33 reactions each; "exactly the blocker for me to using the app"). Pair it with an adjustable content width for wide displays (33 reactions there).
- Sub-agents: small pills "Verify migration · finished" with a click-through.
- "Needs you" is sticky: an unread or needs-you mark clears only when the user opens the thread or acts, never merely because the row re-rendered or the window regained focus (Zed's sidebar failed exactly here and users missed finished threads).
- Live step line while running: the last line of the transcript is the current step in tertiary text with a 6px pulsing dot ("Running `bun test`…"). This replaces "Running tools 1m 39s" and the stray caret.
- Streaming caret only at the end of the streaming paragraph, never on an empty line.
- Approvals and decisions: keep the docked card above the composer while pending; when resolved, write a one-line settled row into the transcript ("You approved `bun install` · 14:32") so the history stays honest (`ApprovalCard` is currently mounted only in `InterventionTray`).
- Failures: one sentence, the glyph in red, a `Retry` button. Already the best copy in the app — keep it, just make it reachable (`ErrorState` presets are 15/18 dead).
- Day separators as hairlines with a centred date; per-turn time on hover.
- A `↓ Jump to latest` pill when the user has scrolled up during a run. `⌘F` finds in the thread.
- Virtualise the settled feed (the machinery already exists in `DiffViewer`); keep the tail in flow; delete the inverted "Read all loaded items" two-mode toggle (`Conversation.tsx:1744`). Do not reintroduce `@tanstack/react-virtual` on self-sizing rows — that is what caused the overlap bug on 2026-08-28.

### 4.5 Run bar (Terminus's own element)
A sticky 32pt pill centred above the composer, present whenever the thread has a run or a result:

`● Turn 3 · 4 files +120 −33 · ✓ 12 tests · 1m 38s`

- Left glyph = state (ring while working, check when done, amber when needs you, red when failed). Click segments: files → Review pane; checks → Verification in the details panel; elapsed → Run details.
- When idle after completion: `✓ Done · 4 files +120 −33 · 12 tests passed · 2h ago`.
- This is where "Working · Using read · 1m 38s" and the metric line from the old header go. It is also the natural anchor for a queued follow-up chip ("Queued: also update the docs · Send now ✕").

### 4.6 Composer
- Surface: 12px radius, 1px hairline, `--bg-composer`; placeholder "Ask or describe a task…" on the home screen, "Message this thread…" inside a thread.
- Left: `+` menu — Files and folders…, Screenshot of a window…, Paste from clipboard, Plan mode (toggle), Use a worktree (toggle, home only). Then the permission chip, always visible, always labelled: `⚠ Full access ▾` in warning colour, `Auto ▾`, `Ask ▾` in secondary. (Today both chips render only on the start screen — `Composer.tsx:1032`, `:1146` — which contradicts the recorded decision.)
- Right: a thin **usage ring** around (or a 3px bar under) the model chip showing context used, with the provider quota window on hover — quota and context invisibility is the single loudest Codex complaint (a 650-post forum thread; users had to point out the *mobile* app shows context and the desktop app does not). Then the model chip `5.6 Luna · High ▾` → compact menu (Model ›, Effort ›, Advanced ▾ with account, context, and quota), then one 28pt filled-accent circle: `↑` when there is text, `■` when running, 40% alpha when disabled. Delete the second grey stop button and the `After current turn ▾` dropdown; replace with a one-line hint under the field while a run is active: "Return queues for after this turn · ⌘Return steers now".
- Model naming: display names, not slugs (`GPT-5.6 Luna` → "5.6 Luna", `nemotron-3-ultra-free` → "Nemotron 3 Ultra"). Provider logos as 16px SVGs (ChatGPT, OpenCode, Baseten, Cloudflare, Hugging Face, NVIDIA, Ollama, Zenmux) with a rounded-square monogram fallback. Picker: Favourites, Recent, then by account; one-line subtitle (`ChatGPT · 272K · Free` — pick the two facts that matter); a details footer for the selected model. Portal the popover (Radix Popover) so it cannot clip.
- Drag-and-drop files and folders onto the composer (fix `preload.ts` `File.path` → `webUtils.getPathForFile`), paste images, native spell-check on.
- Enter sends, Shift+Enter newlines, ⌘Enter steers (already so in `shortcuts.ts`; keep).

### 4.7 Details panel (replaces the Inspector)
- A 300pt inset card, ⌘] to toggle, closed by default on windows under 1200pt. No tabs; sections are groups of 32pt rows (glyph · label · value or chevron):
  - **Changes** `+120 −33` → Review pane.
  - **Environment** `Local` / `Worktree: feat-auth` ▾, **Branch** `main` ▾.
  - **Actions** — Commit or push ▾, Open in editor, Open in terminal, Reveal in Finder.
  - **Model** — `5.6 Luna · High`, context meter (thin bar + "62% of 272K"), cost or quota window when known.
  - **Verification** — one row per check with ✓/✗ and duration; expand for evidence (this is the `Evidence` tab, promoted).
  - **Sub-agents** — `1 working · 3 done`.
  - **Processes** — dev servers and long-running commands this thread started, with port and a Stop button (Codex users describe "whack-a-mole" finding which thread owns the running server).
  - **Pull request** — once one exists: number, CI state, merged/closed, so the app knows when the work landed and can archive the thread (Codex "asked me to go to GitHub and click merge, and when I came back it had no idea the PR was merged").
  - **Approvals** — what was allowed for this task, with revoke.
- Everything here is a fact the user can act on. Anything that is only metadata ("Contract v1", "Risk: Standard", "Runtime: Local UDS") is gone.

### 4.8 Review pane
- A pane with a tab strip (`Review`, later `Terminal`, `Browser`), two layouts: **split** beside the transcript (default; transcript keeps ≥ 560pt) and **takeover** (`⌘⇧D`, or the expand glyph) where the composer collapses to a single 40pt row docked over the diff.
- Scope control first: **Last turn** (default — "what did the agent just do"), Working tree, Branch vs base. Codex's most-read troubleshooting entry is "files appear in the side panel that Codex didn't edit" because its pane defaults to repo state; default to the agent's own output.
- Header: `Last turn ▾  +120 −33  ·  main → origin/main`, toolbar (unified/split, whitespace, search, refresh), and `Commit or push ▾` (Commit…, Push, Create pull request…, Discard changes… with a native confirm sheet).
- File rail on the left (collapsible; 200pt) with ± per file and a "being edited now" glyph during a run; `J/K` next/previous change, `[ ]` files (already mapped).
- Added and removed lines carry a `+`/`−` gutter glyph and a left-edge bar, not colour alone (red–green colour blindness is a filed Codex accessibility gap).
- Per-file header sticky; unmodified runs collapse to "N unmodified lines" bars; word-level intra-line highlight; syntax colour (share `syntax-highlight.tsx` with `Message.tsx`, which currently renders code fences raw).
- Comments stay (local is honest) and `Send N comments` puts them in the composer as the next turn — already the design; give it the primary button.
- Large diffs page one file at a time with a banner, as Codex does, until continuous virtualised scroll lands.

### 4.9 Board
- Same thread list as the sidebar, five columns (`Queued · Working · Needs you · Review · Done`), reachable from the sidebar nav and `⌘⇧B`. Today it is reachable only through ⌘K → "Open all tasks".
- Header: `[Board | List]` segmented on the left, `Needs you N` as a filter chip, search glyph. Project scope comes from the sidebar switcher — drop `Space:` and the standalone Status/Clear/refresh controls; move "Reconnecting" to the global banner.
- Card (12px radius, no border, elevated surface): title (max 2 lines, 14px), project (12px tertiary), current step (one tertiary line while working), footer `+120 −33 · ✓ 12 · 1m 38s`, state glyph top-right, 2px amber left rule for needs-you. Hover reveals Open · Review · Stop.
- Cards glide between columns on state change (FLIP / View Transitions). Done folds after 24h (already).
- Keep the roving-tabindex and context-menu work; delete the board's private SSE subscription, search box, and toast once the store is unified.

### 4.10 Settings
- Takeover: the sidebar becomes the settings nav (`‹ Back to app`, `Search settings`, then General · Appearance · Accounts · Models · Permissions · Notifications · Git & worktrees · Keyboard shortcuts · Advanced). No third column.
- Content: 640pt max, grouped cards (12px radius, hairline dividers, 44pt rows): title + one-sentence description left, control right. Toggles blue, selects as native-looking pop-up buttons.
- Copy rewrite in user language. "Wire protocol", "routing records", "transport for that provider's SDK" go under a per-account `Advanced ▾` disclosure. Accounts = a list of providers with logo, status sentence, model count, and `Set default / Sign out`.
- Keyboard shortcuts page becomes rebindable (searchable, conflict-checked); `matchesShortcut` must stop rejecting Shift (`shortcuts.ts:88`) first.

### 4.11 Palette, search, and quick capture
- ⌘K: `Recent threads` first (row style with status glyph), then `Commands` with glyphs and shortcuts, then `Projects`. Fix the recents ranking (`CommandPalette.tsx:217`). Later: content search across turns.
- The dead `TaskSearch.tsx` has the best "Spotlight glass" styling in the app (`globals.css:267-359`); reuse that treatment for the palette and the ⌥⌘Space quick-capture panel, then delete the component.
- Quick capture (⌥⌘Space, already registered): a floating vibrancy panel with the project switcher, a one-line composer, and "Attach screenshot of frontmost window". Submitting creates a thread and shows a toast with `Open`.

### 4.12 Native layer (the parts that make it feel expensive)
- Dock badge = needs-you count only. Notifications on needs-you, done, failed — with actions (`Approve` / `Deny` / `Open`) and a deep link to the exact turn.
- Menu-bar extra: `◌ 3 · ! 2`; the menu lists needs-you items with inline approve/deny and `Open Terminus`.
- Context menus everywhere a row exists (Radix ContextMenu is already in the tree); Quick Look (space bar) on artifacts and images; drag a folder onto the window or Dock icon to open it as a project.
- Window: full-width drag region, double-click to zoom, state restore in the main process, `⌘W` closes the review pane, then the thread; `⌘⇧[` / `⌘⇧]` walk threads; `⌘1–9` pinned threads; `⌘+ / ⌘− / ⌘0` zoom in the View menu; `⌘.` stop (already).
- Tooltips: one system, 400ms, never `title=`. Cursors: default on chrome, text only in text. Selection: none on chrome (`.selectable` opt-in already exists).
- Light mode as a first-class citizen: warm off-white canvas, vibrancy sidebar, and fix the dark `--bg-terminal` code blocks that currently sit in a light window (`theme.css:312`).
- Menus: real `menuitemradio` with a lucide check, not the `"✓"` character.
- Dialogs: ≤ 30% scrim; window-modal flows as sheets sliding from the header.

---

## 5. Visual system corrections (tokens are good; usage is not)

- **Type**: 11 / 12 / 13 / 14 / 15 / 22 only; weights 400 / 500 / 600. Transcript 15/23, chrome 13/18, meta 12/16, section labels 11/15 sentence case (drop the uppercase tracked labels). No surface shows more than three sizes.
- **Colour**: raise the dark canvas from near-black to a warm charcoal that matches the sidebar material (Codex sits at roughly `#1c1c1c` canvas / `#171717` sidebar / `#232323` card). Hairlines at 8% white. Accent Apple blue exactly where §3.4 says and nowhere else. Amber only on needs-you glyphs/rules and the Full-access chip. Green/red only for ± and pass/fail.
- **Radius**: 6 controls · 8 rows and chips · 10 cards · 12 composer, popovers, panel. Never larger.
- **Icons**: one lucide wrapper with three sizes (12 / 14 / 16) and one stroke (1.75). Replace the 11 sizes and 9 stroke widths in use today. Status glyphs are the only icons that take colour.
- **Spacing**: 4pt grid; rows 28 (nav) / 32 (details) / 48 (2-line sidebar) / 44 (settings); section gaps 20.
- **Elevation**: only popovers, menus, and the overlay panel cast shadows (`--elevation-md/lg`); replace the two `shadow-2xl` usages in `Layout.tsx`.
- **Motion**: 120ms hover, 180ms popover, 200ms pane slide (ease-out), 1s linear ring rotation, 600ms status morph; a single `--motion-*` set; all zero under Reduce Motion. Restore `.spinner` animation and the skeleton shimmer immediately.
- **Timestamps**: locale-aware, no seconds (`lib/time.ts:15`).

---

## 6. What to do next, in order

Each item has an acceptance check you can eyeball.

### Now — the frame (≈ 2 weeks)
1. **Motion and cursors** (half a day): `.spinner` rotates, skeletons shimmer, `bare` buttons lose `cursor-pointer`, full-width drag region, one tooltip system at 400ms, no `title=` left, lucide check in menus, scrim to 30%. *Check: nothing in the app looks hung; nothing shows a pointing hand except links.*
2. **Header row**: delete `ThreadHeader`; one 48pt row with title + `…` + Changes/panel toggles; `‹ ›` wired to nav history with `⌘[`/`⌘]`. *Check: the top of the window is one row everywhere, including Board and Settings.*
3. **Sidebar**: project switcher replaces `Threads/Projects`; row model with subtitle and trailing status; `Needs you` rows with reasons; hide eval sessions; auto-titles; hover pin/archive; context menu; Board nav row; account footer. *Check: with 40 threads the sidebar reads at a glance; every row says which project it belongs to.*
4. **Composer**: chips always visible and labelled; one primary circle button; queue hint replaces the dropdown; `+` menu with files/screenshot/plan/worktree; model chip with short names and logos; portaled picker; drop and paste. *Check: the composer in a live thread shows access level and model without opening anything.*
5. **Run bar + details panel**: run bar above the composer; details card replaces the Inspector tabs; Verification promoted. *Check: state, size, checks, and elapsed are visible without scrolling; the panel has no empty tab.*
6. **Tokens and vocabulary**: canvas/sidebar/card colours, icon wrapper, type sizes, and a one-pass string sweep to Thread / Project / Run / Changes / Board. *Check: `grep -i "mission\|space:" src` returns nothing user-facing.*
7. **Delete dead UI** before redesigning it: `TaskSearch`, `AgentsView`, `StructuredInterventionModal`, `ComputerUsePiP/Placeholder`, unused `ErrorState` presets, `--alloc-*`, `.sidebar-nav-*`, `.status-dot-*`. *Check: ~1,900 lines gone, bundle smaller, tests green.*

### Next — the work surfaces (≈ 3–4 weeks)
8. **Transcript**: flat activity lines with inline expand, live step line, caret fix, code highlighting and tables, day separators, resolved approvals in the feed, jump-to-latest, `⌘F`, virtualised settled feed.
9. **Review pane**: takeover layout with the docked single-row composer, file rail, branch header, Commit/Push/PR, syntax colour, collapsed unmodified runs.
10. **Home**: front door with context strip, active-thread list, intent chips.
11. **Board**: calmer header, richer cards, glide transitions, sidebar entry.
12. **Settings**: takeover layout, grouped cards, copy rewrite, rebindable shortcuts (after the Shift fix).
13. **Palette**: recents first, glyphs, glass treatment; quick-capture panel.

### Later — the native extras and the whitespace
14. Notifications with actions, menu-bar extra, Quick Look, drag-to-open, `⌘⇧[`/`]`, zoom menu items.
15. Terminal and Browser as tabs in the review pane (only when the harness needs them).
16. Content search across threads; best-of-N compare (only with side-by-side comparability, or it multiplies the review burden); sub-agent tree; multi-window.
17. Comments on non-code artifacts — the plan, a screenshot, test output — that the agent incorporates without restarting (Antigravity is the only product doing this; it attacks the review bottleneck directly).
18. Import projects and recent threads from `~/.codex`, `~/.claude`, and Cursor on first run — the cheapest onboarding wedge for a challenger.
19. A hoverable turn rail on the transcript's right edge for previewing and jumping between turns in multi-hour threads (Codex added one in June; it is the right answer to "where in this 3-hour thread am I").

Where to spend the craft budget: every independent reviewer praises Codex for affordances ("control room", "it has taste") and none for its chrome; the only *visual* craft anyone singles out is its computer-use cursor and its permission sheet. Keep Terminus's chrome silent and put the craft into four signature moments — the needs-you row and its notification, the run bar, the status-ring-to-checkmark morph, and the approval sheet.

### Defects seen in the mock capture that should ride along with the frame work
- At 1024pt the sidebar and inspector *overlay* the content and cover the composer's model chip and send button (`15b`, `15c`); below the minimum width, shrink or auto-hide, never overlay controls.
- Hiding the sidebar leaves the content column at its old left offset (`17b`); re-centre.
- The review pane's diff overflows horizontally with no scrollbar and no right padding (`07a`, `14c`); diff shortcuts (`J/K/[/]/U`) type into the composer unless the pane was clicked first (`07b`) — focus the pane on open and show the keys in its header.
- The same thread reads "Ready" in List and sits in "Queued" on the board (`09b`) — one lifecycle projection for both.
- Offline is reported three times at once (banner, banner Retry, a second Retry in the rail) and a reconnect shows both a top strip *and* an in-transcript card (`04`, `16a`); one banner, nothing in the transcript.
- Light theme paints "Needs you" mustard rather than the dark theme's amber (`14d`); fix the token, not the component.
- Onboarding renders two fields and two buttons on a bare canvas with no surface or identity (`13a`); make it a sheet with the mark and one sentence.
- Settings → Accounts shows an empty "Model" pop-up with no placeholder; Advanced has two rows labelled "Status" (`12b`, `12e`).
- Dev-mock fixture gaps that make the visual loop lie: material questions ignore `taskId` (the same "Decision needed" card appears under every thread); `turn.completed.summary` is never rendered so no markdown ever appears; the SSE stream is not stubbed so every capture wears a reconnect banner; approvals return `[]`. Fix these first or every screenshot review is wrong.

Prerequisite already recorded: finish the v1/v2 unification (one task model, one client, one SSE stream). The board, inspector, and sidebar all still pay for two models of the same object (`selectedTaskId` vs `selectedCanonicalTaskId` in `App.tsx`), and anything redesigned before that lands gets built twice.

---

## 6a. What the outside evidence says (weighted)

Two web-research passes (Codex specifically; Devin, Conductor, Claude Code desktop, Cursor 3, Zed, Warp Oz, Antigravity, Kiro, Sculptor, Vibe Kanban, Emdash, cmux and others), later joined by four narrower sweeps: independent reviews and X, the Codex GitHub tracker, and HN plus Reddit (r/codex and r/OpenAI via a mirror; ~2,200 HN comments across eight threads). X itself was fetch-blocked, so X quotes come through mirrors and are the thinnest layer. Weighted accordingly.

What HN and Reddit add, in one paragraph: the pre-merge Codex app was liked for exactly the things this document copies — "the typographic hierarchy made it easy to skim", projects → threads in one sidebar, side-by-side diffs, one window supervising many agents. The single most-loved feature on Reddit (405 points) is the in-app browser with click-to-annotate for frontend work, which is why the browser pane sits first among the "Later" items rather than last. The most-repeated grievance on both sites is Electron's RAM, CPU, battery and GPU cost, worse on Windows; the second is the July merge ("give us back the app we had"). Two structural critiques worth carrying: "one window that can only display a single session at a time" was called the wrong abstraction on launch day (Codex shipped ⌘⇧N New Window on 2026-08-04 in response; open-thread-in-new-window should not wait for the Later bucket), and "code hidden behind a black box / tool calls folded away" is the CLI camp's main objection to any GUI — the Detailed density mode in §4.4 is the answer. A 315-point paper cut: show the usage percentage as text, not behind a click.

Confirms the direction:
- **The review queue, not the agent, is the bottleneck** (Willison, HN, industry data on PR pickup time; very strong). Everything that shortens "open thread → understand what changed → decide" is worth more than another parallel agent. Hence the run bar, Last-turn scope, verification rows, and comment-to-agent.
- **A board as the default surface is rejected** (two independent Devin Desktop reviews went straight back to the editor; Vibe Kanban shut down; "every task ended up in the needs-review column"; Cursor shipped a board only as a cookbook sample). Terminus's board stays one view behind a button — as already decided.
- **Status must be three sticky states — running / needs you / done-unreviewed — with OS affordances** (Zed discussion #54865 is a free spec; Claude Code desktop's per-session indicator is its best-reviewed feature). This is the attention model in §4.2 and §4.4.
- **Plan-first is universal and liked**; **review must happen in-app with comments that feed the agent**; **be agent- and provider-agnostic**. All consistent with the harness direction.
- **Native credibility matters to exactly this audience** (Gruber's July piece on Anthropic's Electron app, cmux growing 4× in three months as a Swift terminal). Staying on Electron is decided; the answer is that none of the visible defects are Chromium's, and the polish bar has to be higher because of it.

Changes or sharpens something:
- **Quota and context visibility is the loudest Codex complaint by a wide margin** (650 posts / 40k views; "banked resets disappearing"; "the mobile app shows context, the desktop app doesn't"). Added: a usage ring on the model chip and quota in its menu, and a rule that a run degrades rather than hard-stops at a limit (Warp and Antigravity are hated for the cliff).
- **Provenance in the sidebar** (Codex's CLI and sub-agent sessions flooded the list; its own docs have a "why do only some chats appear" entry). Added as a first-class field in §4.2 rather than a one-off eval filter.
- **"Last turn" as the default review scope** (Codex's top troubleshooting entry). Added to §4.8.
- **Never auto-decide** (203 upvotes against Codex's 60-second auto-resolve). Added to the principles.
- **Do not rename the core noun** (Codex went threads → tasks → chats and left stale docs and muscle memory). Reinforces the Thread / Project / Run / Changes / Board sweep.
- **Performance is a product feature, not polish** ("the backend is fast, but the frontend is choking"; 395 upvotes on a CPU-runaway issue; 100-turn threads and 5,000-file diffs are the test cases). Virtualising the settled feed moves from "nice" to "required".
- **Worktree ergonomics are where worktree products die** (dependencies, `.env`, ports; Conductor abandoned local worktrees for cloud VMs within a year). Added the setup-script / port / env recipe to §4.3.

On not being a clone: HN already complains that "every agent workspace has to look like the Codex app" (Antigravity, Cursor 3 and Codex are read as one design). The structure has converged because it works; what nobody has converged on is behaviour — sticky attention, honest verification, quota you can see, a PR lifecycle the app actually tracks, and the four signature moments above. That is where Terminus should look different, not in the chrome. Two small behaviours from the same corpus: an unknown slash command must fail loudly rather than be passed to the model to role-play success, and "thinking" animations must be transform-only and paused when off-screen (Codex's drew a GPU-usage issue).

From Codex's own tracker (8,682 open app issues; upvotes are the roadmap there), the items that translate directly into Terminus decisions:
- **The context meter reversal is the strongest evidence in the corpus.** OpenAI removed the visible context indicator in favour of "infinite context via auto-compaction", drew 251 reactions in days, and shipped it back within eight days. Ship the usage ring from the start and never remove it.
- **Custom/multi-provider models are effectively unusable in Codex's picker** (95 combined reactions). Terminus's eight-provider picker is a real opening — if it is curated (short names, logos, favourites) rather than the slug list it is today.
- **Projects keyed to absolute paths orphan their threads when a folder moves** (52 + 38 reactions). Key projects by repository identity (root + remote) and offer "Re-point this project" instead of "This project folder was deleted or moved".
- **Never silently transform input**: long pastes auto-converted to `.txt` attachments (87 reactions) changed instructions into "reference material" without telling anyone.
- **No hover-revealed panels** (Codex's hover sidebar "covers content, steals focus, makes text selection unreliable"); panels open on click or shortcut only.
- **Never auto-delete a worktree with unmerged work**; Codex's "worktree cleaned up to save disk space" fired on active threads.
- **Auto-scroll must hold the top of a new response when the user is reading**, not chase the stream (a tagged Codex papercut); the `Jump to latest` pill handles the rest.
- **The "thinking" spinner drew a 132-reaction GPU-burn issue.** Transform-only animation, paused when the sidebar is hidden or the window is occluded.
- **History must never silently truncate.** Codex preloads a global recent-50 set and then groups and searches only that subset, so week-old threads vanish from the sidebar while still existing on disk ("unreliable as a working memory for real projects"; six issues, a third-party tool exists purely to resurrect hidden chats). Terminus loads the list from the store, folds old rows into "Older", and shows archived threads as greyed rows in the same list — not in Settings. A stale project row must be deletable, not only archivable.
- **Worktree choice is the largest design gap Codex has left open** (configurable location 74 reactions, seven months without a staff reply; "use an existing worktree" and "use a worktree I made outside the app" a further 27). The `Local / Worktree` control in §4.3 should offer: new worktree, an existing worktree from the repo's list, and a location setting; never a hard-pinned path under the app's data dir.
- **Adjustable transcript width is real demand, not preference**: 33 reactions plus users patching Codex's `app.asar` to widen the column. Confirms the width setting in §4.4.
- **Accessibility has zero open issues on the tracker — an unserved population, not a solved problem.** For a "native" claim it is table stakes: a VoiceOver label on every glyph-only control (the sidebar status slot, the composer circle, hover pin/archive), Reduce Motion honoured everywhere (§5), the `+`/`−` gutter glyphs in §4.8, and full keyboard reach for the sidebar and details rows.
- **One ordered effort scale with one vocabulary.** Codex mixes "Light" with "Minimal" and "Max" with "Extra High" and hides a level between two others; changing effort mid-thread also silently invalidates the prompt cache. The model chip's effort menu uses one named, ordered scale and says when a change costs something.
- **"Don't ask again" must match what the user meant.** Codex's approval matcher ignores env-var-prefixed commands (`FOO=1 cmd` never matches the remembered rule), so users see the same prompt forever and conclude Full access is broken. Match on the command, not the prefixed string, and show the remembered rule in the approval sheet.

The one critique to have an answer for: "why not tmux and four terminals?" (OpenSquirrel's post-mortem, nine days after launch). The defensible answers are persistent attention state across sessions and restarts, review with a feedback loop a TUI cannot do, per-workspace environment management, and provider normalisation. "We made the CLI prettier" is not an answer, and the frame work in §6 is what makes the real answers visible.

---

## 7. Not now, and why

- **Fork-from-turn, checkpoints/restore**: endpoints exist, nothing consumes them. A button would lie.
- **Permanent file tree, terminal, browser panes**: the orchestrator layout wins when those are summoned, not resident.
- **A separate Preferences window, a bell inbox, amber/orange accents, a Tauri/SwiftUI rewrite**: all decided against; none of the defects above are Chromium's fault.
- **Copying Codex's Goal bar, Pets, Plugins marketplace, or Explore**: consumer chrome in a developer tool.
- **A second search box anywhere.** One palette.

---

## 8. How to verify the feel (the loop that caught the overlap bug)

- Visual loop with no backend: `npx vite --port 5183` in `apps/desktop`, headless Chrome with `--remote-debugging-port`, CDP screenshots of `?mock=true` at 1440×900 @2x, dark and light. Keep the mock fixture on real wire shapes.
- Before merging a surface, put its screenshot beside the matching Codex capture in `~/Downloads/terminus-ux-reference-2026-08-30/` and answer: fewer boxes? one header row? same three type sizes? does anything move that should?
- Native checklist per PR: no `title=`, no pointer cursor on chrome, no text selection in chrome, popovers opaque and portaled, every icon button tooltipped, every list with skeleton/empty/error, every destructive action behind a sheet.

---

## Appendix — captures

Codex (`codex/`): `codex-home.png` (home, intent cards, context strip), `codex-thread-bottom.png` (thread + Environment panel + step pill + goal bar), `codex-model-picker.png` (three-row model menu), `codex-plus-menu.png` (+ menu with plugins), `codex-prs.png` (master–detail PR list), `codex-changes2.png` (Review split), `codex-header-icon.png` (Review takeover with docked composer row), `codex-settings.png`.

Terminus mock (`terminus-mock/`): `01-new-task-home`, `03a-conversation-settled-top`, `04-conversation-in-flight`, `05b-activity-groups-expanded`, `07a-review-diff-unified`, `08a-inspector-overview`, `09a-mission-board-kanban`, `10-command-palette`, `11b-model-picker-list`, `12b-settings-accounts`, `14b-light-conversation`, plus the rest listed in `INDEX.md`.
