# Forge Desktop — Reference-Pattern Matrix

This matrix records the patterns observed in the reference products
listed in SPEC §3 (Codex, Cursor, Apple macOS, T3 Code, OpenCode,
Omnigent, OpenChamber, AiderDesk, Goose, and other open-source
coding-agent desktop apps) and the disposition chosen for Forge.

The dispositions are:

- **Adopt** — copy the pattern essentially as-is.
- **Modify** — keep the core idea but adapt it to Forge's visual
  direction or architecture.
- **Reject** — do not implement; the pattern conflicts with Forge's
  constraints (SPEC §4.1 forbidden visual patterns, near-monochrome
  mandate, or the "calm" personality in SPEC §23).

Each row also notes where in the app the pattern belongs.

## 1. Layout

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Three-region shell (sidebar / main / inspector) | Codex, Cursor | Works: scales from full-width down to a focused writing column. Fails when inspector is always-visible (cluttered at narrow widths). | Adopt + modify: inspector becomes a floating overlay at < 900px (SPEC §6) | `Layout.tsx` |
| Hidden-inset title bar with traffic lights at (16, 18) | macOS, Cursor | Works: maximizes draggable area; lets the title bar feel native. | Adopt | `electron/main.ts`, `Layout.tsx` |
| Resizable bottom terminal drawer (hidden by default) | Codex, VS Code | Works: keeps terminal one keystroke away without claiming screen real estate. Fails when it can't be dismissed to "no height" cleanly. | Adopt | `Layout.tsx` + `TerminalDrawer.tsx` |
| Always-visible command bar at the top           | Linear, Raycast | Works for search-first apps; fails for conversation-first apps because it competes for vertical space. | Reject — use ⌘K palette instead (SPEC §18) | — |
| Dashboard with metric tiles                     | Vercel, Datadog | Fails: SPEC §4.1 forbids "dashboard-style metric grids" and "unnecessary charts". | Reject | — |

## 2. Sidebar

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Pinned tasks at the top, projects below         | Slack, Codex | Works: pinning is the most common power-user action. | Adopt | `Sidebar.tsx` |
| Nested tasks under projects (no worktree level) | Codex        | Works: keeps the hierarchy shallow; worktrees are an implementation detail. | Adopt (SPEC §7.1) | `Sidebar.tsx` |
| Selected state via muted background (no saturated fill) | macOS Finder | Works: visible without distracting. | Adopt | `SidebarItem.tsx` |
| Hover-revealed pin button on the right          | Linear       | Works: keeps the row clean by default; pinning is a deliberate action. | Adopt + modify: reserve 60px right column so hover never causes layout shift (SPEC §7.1) | `SidebarItem.tsx` |
| Truncate long titles with `title` attribute tooltip | Every modern app | Works: native tooltip, no custom code. | Adopt | `SidebarItem.tsx` |
| Compact rail (icons only) at < 700px            | VS Code, Slack | Works: preserves navigation in narrow windows. | Adopt (SPEC §6) | `Sidebar.tsx` |
| Live status dot on every task row               | Codex        | Works: glanceable activity. Fails when dots are colorful (visual noise). | Adopt + modify: minimal semantic glyphs per SPEC §7.2 (spinner / dot / clock / check) | `StatusIndicator.tsx` |

## 3. Conversation

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Document-style feed (no chat bubbles)           | Codex, iA Writer | Works: reads like a document; agent output is the focus. | Adopt (SPEC §9) | `Conversation.tsx` |
| User messages in low-contrast rounded surfaces  | Codex        | Works: distinguishes user input without competing with agent output. | Adopt | `Message.tsx` |
| Grouped execution blocks ("Explored codebase (12 files)") | Codex, Cursor | Works: compresses tool-call noise into scannable summaries. | Adopt (SPEC §9.3) | `ActivityBlock.tsx` |
| Streaming cursor (animated pulse block)         | ChatGPT, Codex | Works: signals "agent is typing" without status text. | Adopt + modify: respects prefers-reduced-motion | `Message.tsx` |
| Token-by-token re-render of the whole feed      | naive chat UIs | Fails: jank on long feeds. | Reject — use `React.memo` + `useMemo` keyed on event count (SPEC §25.1) | — |
| Auto-scroll always pinned to bottom             | naive chat UIs | Fails: yanks the user away from history they're reading. | Reject — stick-to-bottom only if user is already near the bottom (80px threshold) | `Conversation.tsx` |
| Reading-column max width (720px spacious / 680px compact) | Codex, Substack | Works: optimal line length for prose. | Adopt (SPEC §9) | `tokens.ts` |

## 4. Composer

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Always-available composer (send + steer + queue + stop) | Codex | Works: user can steer a running agent without losing their draft. | Adopt (SPEC §10) | `Composer.tsx` |
| Reserved-height control row (no layout shift when metadata appears) | Linear, Stripe | Works: prevents the composer from "jumping" as risk class / thread id appear. | Adopt (SPEC §10) | `Composer.tsx` |
| Drag-and-drop + paste of images                 | Slack, Discord | Works: natural attachment model. | Adopt | `Composer.tsx` |
| Draft persistence per task                      | Codex        | Works: switching tasks doesn't lose drafts. | Adopt + modify: write via `requestIdleCallback` so streaming renders never block keystrokes (SPEC §25.1) | `useForgeStore.draftsByTask` |
| Decorative attachment chips with file-type icons | email clients | Fails: visual noise for an app where attachments are rare. | Reject — minimal image thumbnails only | — |
| Hidden send button until text is entered        | some chat apps | Fails: discoverability. | Reject — always show the send button, disabled when empty | `Composer.tsx` |

## 5. Inspector

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Dynamic sections (appear only when relevant)    | Xcode Inspector | Works: surfaces the right info without overwhelming. Fails when sections reorder while you're reading. | Adopt + modify: sections never reorder (SPEC §11) | `Inspector.tsx` |
| Floating rounded card (12px padding, border, shadow-lg) | macOS Inspector | Works: feels lightweight; doesn't claim a permanent column at narrow widths. | Adopt (SPEC §11.1) | `Layout.tsx` |
| Pin / unpin inspector                            | Xcode        | Works: lets power users keep it visible; lets focused writers hide it. | Modify — pinning is implicit (inspector is always pinned by default); future wiring for unpin | `Inspector.tsx` |
| Always-empty sections with "No data"            | naive dashboards | Fails: visual noise. | Reject — render no section at all if its data is empty | — |

## 6. Diff viewer

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Unified + side-by-side view modes (toggle, persisted) | GitHub, Cursor | Works: review-first readers prefer unified; merge-style reviewers prefer split. | Adopt (SPEC §13) | `DiffViewer.tsx` |
| Sticky hunk headers                              | GitHub       | Works: keeps context visible while scrolling a long hunk. | Adopt | `DiffViewer.tsx` |
| Per-hunk Accept / Reject / Restore               | Cursor, GitLens | Works: lets the user approve incrementally without accepting the whole file. | Adopt (SPEC §13) | `DiffViewer.tsx` |
| Inline comments (click a line → textarea)        | GitHub       | Works: anchors feedback to the exact change. | Adopt (SPEC §13) | `DiffViewer.tsx` |
| j / k keyboard navigation between changes        | Vim, GitHub  | Works: keeps hands on the keyboard during review. | Adopt (SPEC §13) | `DiffViewer.tsx` |
| Colorful file-type icons in the file nav         | VS Code      | Fails: visual noise; SPEC §4.1 forbids decorative color. | Reject — use lucide `FileText` / `Plus` / `Minus` / `ArrowUp` status icons only | — |
| Syntax highlighting in the diff                  | GitHub, VS Code | Works for short files; fails for very large diffs (CPU). | Modify — defer to a future `shiki` integration; the primary slice uses monospace without highlighting | `DiffViewer.tsx` (future) |

## 7. Terminal

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Multiple tabs with hover-revealed close          | iTerm2, VS Code | Works: compact; doesn't compete with the terminal body. | Adopt (SPEC §15) | `TerminalDrawer.tsx` |
| Double-click tab to rename                       | Browsers     | Works: discoverable once learned; no extra UI. | Adopt | `TerminalDrawer.tsx` |
| Search (⌘F) with match-count badge               | VS Code      | Works: scoped search without leaving the terminal. | Adopt (SPEC §15) | `TerminalDrawer.tsx` |
| Suspend rendering when hidden (`content-visibility: hidden`) | SPEC §25.1 | Works: zero CPU when the drawer is closed. | Adopt | `TerminalDrawer.tsx` |
| Output cap (8000 lines) to prevent unbounded growth | tmux        | Works: bounds memory; user can clear explicitly. | Adopt | `TerminalDrawer.tsx` |
| Always-on terminal pane (no drawer)              | tmux, VS Code integrated | Fails for Forge: claims vertical space the conversation needs. | Reject — drawer is hidden by default (SPEC §15) | — |

## 8. Approvals

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Inline approval card (not a modal)               | Codex        | Works: keeps the user in the conversation flow. | Adopt (SPEC §17) | `ApprovalCard.tsx` |
| Three buttons: Allow once / Allow for this task / Deny | Codex | Works: covers the three real intents; "Deny" is explicit (no auto-deny on Esc). | Adopt (SPEC §17) | `ApprovalCard.tsx` |
| Risk-class accent on the left border             | GitHub PR labels | Works: glanceable severity without color overload. | Adopt (SPEC §17) | `ApprovalCard.tsx` |
| Modal approval dialog                            | some enterprise tools | Fails: disrupts the conversation flow; SPEC §17 says avoid unless macOS itself requires it. | Reject | — |
| Auto-deny on Esc                                  | some tools | Fails: too easy to accidentally lose progress. | Reject (SPEC §17) | — |

## 9. Command palette

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| ⌘K opens a Raycast-quality palette               | Linear, Raycast | Works: keyboard-first power surface. | Adopt (SPEC §18) | `CommandPalette.tsx` |
| Fuzzy search with subsequence + scoring           | fzf, Raycast | Works: tolerant of typos and out-of-order chars. | Adopt (hand-written matcher) | `CommandPalette.tsx` |
| Recent-commands bonus                             | Spotlight    | Works: surfaces what the user actually uses. | Adopt (cap 16, persisted) | `CommandPalette.tsx` |
| Grouped results in a fixed order                   | Linear       | Works: predictable scanning. | Adopt (Navigation → Task → Changes → Terminal → Tools → Appearance → Help) | `CommandPalette.tsx` |
| No focus trap (Tab still escapes)                 | Spotlight    | Works: recovery path if the palette gets stuck. | Adopt (SPEC §18: "No keyboard traps") | `CommandPalette.tsx` |
| Loading every command eagerly                     | naive palettes | Fails: 100ms budget blown. | Reject — host passes only the commands it currently supports; icons are not eagerly imported | — |

## 10. Settings

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Categorized settings with a left list            | macOS System Settings, VS Code | Works: predictable; scales to many settings. | Adopt (SPEC §20) | `Settings.tsx` |
| Search across all categories                      | macOS, VS Code | Works: power users skip the hierarchy. | Adopt (SPEC §20) | `Settings.tsx` |
| Reset per setting + reset per category            | macOS        | Works: easy recovery from a bad tweak. | Adopt (SPEC §20) | `Settings.tsx` |
| Restart-required badge only where actually needed | macOS        | Works: avoids crying wolf. | Adopt (SPEC §20) | `Settings.tsx` |
| Immediate preview for appearance settings         | macOS        | Works: theme + density should feel live. | Adopt (SPEC §20) | `Settings.tsx` → `useThemeStore` |
| Enormous undifferentiated form                    | some enterprise apps | Fails: unusable. | Reject (SPEC §20) | — |

## 11. Onboarding

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | ------------ | ----------- | ---------------- |
| 4-step minimal flow (Welcome → Project → Tools → First task) | Codex | Works: gets the user to value in < 60s. | Adopt (SPEC §19) | `Onboarding.tsx` |
| Auto-detect installed tools (git, node, bun, cursor, vscode) | Homebrew | Works: removes friction. | Adopt | `Onboarding.tsx` |
| Starter prompt buttons (Explore / Build / Review / Fix) | Codex | Works: scaffolds the first turn for users who don't know what to ask. | Adopt + modify: pre-fill the composer; not decorative cards | `Onboarding.tsx`, `NewTaskScreen.tsx` |
| Skip button always available                     | modern SaaS  | Works: power users skip. | Adopt | `Onboarding.tsx` |
| Forced settings dump on first launch             | some tools | Fails: friction. | Reject — sensible defaults are baked in (SPEC §19) | — |

## 12. Empty + error states

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Calm empty states with a single primary action   | Linear, Stripe | Works: tells the user what to do next without scolding. | Adopt (SPEC §27) | `EmptyState.tsx` |
| Curated error catalog with per-error copy        | Stripe, Vercel | Works: every error has a recovery action. | Adopt (SPEC §27 — 13 presets) | `ErrorState.tsx` |
| `role="status"` + `aria-live="polite"` for empty | WAI-ARIA     | Works: screen readers announce changes. | Adopt | `EmptyState.tsx` |
| `role="alert"` + `aria-live="assertive"` for errors | WAI-ARIA  | Works: screen readers interrupt immediately. | Adopt | `ErrorState.tsx` |
| Decorative illustrations on empty states         | some SaaS | Fails: SPEC §4.1 forbids "large decorative illustrations". | Reject — lucide icon in a small rounded tile only | — |
| Generic "Something went wrong" error             | naive apps | Fails: not actionable. | Reject — every error has a category-specific message and suggested_action | — |

## 13. Themes + density

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| System / Light / Dark themes                     | Every modern app | Works: respects user preference. | Adopt (SPEC §24) | `useThemeStore` |
| Spacious / Compact density                       | Slack, Discord | Works: serves both laptop and external-display users. | Adopt (SPEC §24) | `useThemeStore` |
| Theme changes apply without restart              | macOS        | Works: live preview. | Adopt (SPEC §24) | `useThemeStore.applyTokens()` |
| Light theme generated by inverting dark          | naive themes | Fails: looks mechanical; SPEC §4.1 says light theme must receive equal care. | Reject — light tokens are hand-tuned | — |

## 14. Motion

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Restrained Apple-like motion (150–250ms)         | macOS        | Works: feels native; no jank. | Adopt (SPEC §22) | `tokens.ts → motion` |
| Respect Reduce Motion via global CSS             | macOS        | Works: one rule covers everything. | Adopt (SPEC §22) | `globals.css` |
| Continuous pulsing / animated background blobs   | some AI tools | Fails: SPEC §4.1 forbids it. | Reject | — |
| Spring physics for hero transitions              | iOS          | Works in native; risky in web (can feel bouncy). | Modify — `--easing-spring` token defined but reserved for future use | — |

## 15. Accessibility

| Pattern                                         | Product      | Why it works / fails | Disposition | Where it belongs |
| ----------------------------------------------- | ------------ | -------------------- | ----------- | ---------------- |
| Full keyboard navigation (every surface reachable without a mouse) | macOS | Works: power-user requirement; also a screen-reader requirement. | Adopt (SPEC §26) | All components |
| Visible focus ring via `:focus-visible`          | WAI-ARIA     | Works: doesn't show for mouse users; always shows for keyboard users. | Adopt | `globals.css` |
| Screen-reader labels on icon-only buttons        | WAI-ARIA     | Works: invisible text for sighted users, announced for SR users. | Adopt | All icon buttons |
| Dialog focus trapping                            | WAI-ARIA Authoring Practices | Works: prevents Tab from escaping a modal. | Modify — palette intentionally allows Tab to escape (recovery); Settings + Onboarding trap focus correctly | `CommandPalette.tsx`, `Settings.tsx`, `Onboarding.tsx` |
| Color alone conveys meaning                      | some dashboards | Fails: inaccessible to color-blind users. | Reject — every status has both a glyph and a color (SPEC §26) | `StatusIndicator.tsx` |

---

## Synthesis

Forge synthesizes these patterns into one coherent system by holding
to three principles:

1. **Calm by default.** Every adopted pattern is rendered in the
   near-monochrome palette (SPEC §4.1) with restrained motion (SPEC
   §22). No pattern gets to add color, gradient, or animation just
   because the reference product had it.
2. **Keyboard-first.** Every adopted pattern must work without a
   mouse. Patterns that required mouse interaction (decorative chips,
   always-on dashboards) were rejected.
3. **Progressive disclosure.** Surfaces appear only when they have
   something to say. The inspector, the approvals section, the
   pinned-tasks section, the diff hunk actions — all are conditionally
   rendered based on real data, not based on a fixed template.
