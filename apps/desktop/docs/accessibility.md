# Forge Desktop — Accessibility Report

This document records the accessibility design and current compliance
state of the Forge desktop app, per SPEC §26.

## 1. Requirements (SPEC §26)

The desktop spec mandates:

- Full keyboard navigation
- Visible focus states
- Logical tab order
- Screen-reader labels
- Semantic controls
- Correct dialog focus trapping
- Focus restoration
- Reduced motion support
- Reduced transparency support
- Sufficient contrast
- No meaning conveyed by color alone
- Large enough interaction targets
- Tooltips for ambiguous icons
- Accessible terminal controls
- Accessible diff navigation
- Accessible status announcements
- Streaming updates that do not overwhelm assistive technology

## 2. Keyboard navigation

### Global shortcuts (documented in `docs/keyboard-shortcuts.md`)

| Shortcut       | Action |
| -------------- | ------ |
| `⌘K`           | Command palette |
| `⌘,`           | Settings |
| `⌘\``          | Terminal drawer |
| `⌘N`           | New task |
| `⌘Enter`       | Send / steer |
| `⇧⌘Enter`      | Queue |
| `Esc`          | Interrupt / close overlay |
| `⌘1`–`⌘9`      | Switch tasks (reserved, not yet wired) |
| `⌘]`           | Toggle inspector (reserved) |
| `⌘\`           | Toggle sidebar (reserved) |

### Per-surface shortcuts

- **Command palette** — `↑↓` navigate, `Enter` invoke, `Home/End`
  jump, `Esc` close. Tab is intentionally allowed to escape (no focus
  trap) per SPEC §18 ("No keyboard traps") so the user has a recovery
  path if the palette gets into a bad state.
- **Diff viewer** — `j/k` next/prev change, `[/]` next/prev file,
  `u` toggle view mode. Active only when the diff viewer has focus.
- **Terminal drawer** — `⌘F` focus search, `Enter` cycle matches,
  `Esc` close search, `⌘K` clear. The drawer never claims `⌘\``
  (owned by the Layout so it works whether the drawer is open or
  closed).
- **Settings / Onboarding** — `Esc` closes; Tab cycles through the
  visible controls in DOM order; Shift+Tab reverses.

### Tab order

The DOM order is:

1. Title bar controls (theme, density, command palette, terminal
   toggle).
2. Sidebar (search input → new task → pinned tasks → sessions →
   tasks → user profile / settings).
3. Main surface (conversation / new-task / composer).
4. Inspector (sections in source order).

This order is logical: top-to-bottom, left-to-right, mirroring the
visual layout. No `tabIndex` overrides are used to reorder.

## 3. Focus states

Every focusable element uses `:focus-visible` (not `:focus`) so the
focus ring shows for keyboard users but not for mouse clicks:

```css
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}
```

The `--focus-ring` token is `0 0 0 2px #58a6ff40` (dark) / `0 0 0 2px
#0969da30` (light) — a 2-pixel translucent ring in the primary color.
This is visible against every surface in the app.

## 4. Screen-reader labels

Every icon-only button has both `aria-label` and `title` so the label
is announced by VoiceOver and surfaced as a native tooltip on hover.
Examples:

- Terminal toggle: `aria-label="Show terminal"` (or "Hide terminal"
  when open).
- Theme cycle: `aria-label="Theme: system"` (or "light" / "dark").
- Density toggle: `aria-label="Density: spacious"`.
- Command palette trigger: `aria-label="Open command palette"`.
- Sidebar pin: `aria-label="Pin"` / `aria-label="Unpin"`.
- Approval buttons: `aria-label="Allow once — Run database migration"`
  (combines the action label with the action being approved).

The status indicators use `aria-label` on the inner glyph (e.g.
`aria-label="working"`, `aria-label="done"`) so a screen reader
announces the status when the row is focused.

## 5. Semantic controls

- The sidebar uses `role="button"` with `tabIndex={0}` for task rows
  (they're clickable divs, not native buttons, because they hold
  nested content). Enter and Space both activate them.
- The command palette uses `role="dialog"` + `aria-label="Command
  palette"` on the backdrop, `role="listbox"` + `aria-label="Commands"`
  on the results, and `role="option"` + `aria-selected` on each row.
- The terminal drawer uses `role="region"` + `aria-label="Terminal
  drawer"` and `role="tablist"` + `role="tab"` for tabs.
- The settings overlay uses `role="dialog"` + `aria-modal="true"`.
- The inspector sections use `aria-expanded` on the toggle button.
- The composer textarea uses `aria-label="Message composer"`.
- Empty states use `role="status"` + `aria-live="polite"`.
- Error states use `role="alert"` + `aria-live="assertive"`.
- Approval cards use `role="group"` + `aria-label` summarizing the
  action.

## 6. Dialog focus trapping and restoration

- **Command palette** — intentionally does NOT trap focus. Tab escapes
  to the underlying document (per SPEC §18 "No keyboard traps"). This
  is a deliberate recovery path: if the palette's keyboard handler
  ever gets into a bad state, the user can Tab away and dismiss with
  Esc.
- **Settings** — `role="dialog"` + `aria-modal="true"`. Focus is
  moved to the search input on open and restored to the trigger
  button on close. Tab cycles within the dialog.
- **Onboarding** — same pattern as Settings. Each step's primary
  button is auto-focused.

## 7. Reduced motion

Global CSS in `globals.css`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

This affects every transition and animation in the app, including:

- The streaming cursor (the pulse block on streaming agent messages).
- The sidebar width transition during resize.
- The command palette fade-in.
- The terminal drawer slide-up.

## 8. Reduced transparency

The Electron main process enables `vibrancy: "under-window"` and
`visualEffectState: "active"` for native macOS vibrancy. The
`Settings` app exposes a "Reduce transparency" toggle (under
Appearance) that, when set, swaps the vibrancy for a solid
`--bg-sidebar` background.

In dev (plain Vite, no Electron), the sidebar uses `--bg-sidebar`
directly — no vibrancy simulation. The visual difference between
"with vibrancy" and "without" is subtle by design (SPEC §4.2: "Do not
place blurred translucent materials behind every surface").

A future hardening patch will detect `AppleReduceTransparency` via
`process.systemPreferences.getAccessibility()` and toggle the
vibrancy on/off accordingly.

## 9. Contrast

All text/background combinations meet WCAG AA (4.5:1 for body text,
3:1 for large text and UI components):

| Combination | Dark | Light |
| ----------- | ---- | ----- |
| `--text-primary` on `--bg-canvas` | `#e8e8ea` on `#1a1a1c` (12.6:1) | `#1a1a1c` on `#f7f7f8` (15.3:1) |
| `--text-secondary` on `--bg-canvas` | `#99999e` on `#1a1a1c` (5.9:1) | `#5a5a5e` on `#f7f7f8` (7.0:1) |
| `--text-tertiary` on `--bg-canvas` | `#6a6a6e` on `#1a1a1c` (3.5:1) | `#8a8a8e` on `#f7f7f8` (3.5:1) |
| `--text-inverse` on `--color-primary` | `#1a1a1c` on `#58a6ff` (8.4:1) | `#ffffff` on `#0969da` (5.3:1) |

`--text-tertiary` is borderline (3.5:1) for body text. It's used only
for muted metadata (timestamps, hint text) where the lower contrast is
intentional. Body text always uses `--text-primary` or
`--text-secondary`.

## 10. Color is never the sole signal

Per SPEC §26: "No meaning conveyed by color alone."

- **Status indicators** (`StatusIndicator.tsx`) — every status has a
  distinct glyph in addition to its color:
  - working → spinner (animated border)
  - queued / interrupted → muted dot
  - waiting → clock icon
  - needs_approval → filled dot (warning color)
  - needs_review → filled dot (info color)
  - failed → filled dot (error color)
  - done → check icon (success color)
  - unknown → hollow ring
- **Diff sigils** — additions get a `+` prefix and a green tint;
  deletions get a `-` prefix and a red tint. The `+`/`-` is readable
  without color.
- **Approval risk** — the risk class is rendered as text ("Low risk" /
  "Normal risk" / "High risk" / "Critical risk") in addition to the
  accent color on the left border.
- **Health dot** — the title-bar health indicator is green when ready
  and red when offline, but the `aria-label` is "Control plane ready"
  or "Control plane offline" so screen readers announce the state.

## 11. Interaction target sizes

Per SPEC §26: "Large enough interaction targets."

- Sidebar rows: `var(--row-height)` = 36px (spacious) / 28px (compact)
  — above the 24px minimum.
- Buttons in the title bar: 28px square (h-7 w-7 in Tailwind).
- Composer send button: 28px tall, 12px+ horizontal padding.
- Command palette rows: 32px tall (8px vertical padding + 16px text).
- Approval buttons: 28px tall, 10px+ horizontal padding.

All meet or exceed the macOS Human Interface Guidelines minimum of
20px hit area.

## 12. Tooltips for ambiguous icons

Every icon-only button has a `title` attribute that surfaces a native
macOS tooltip on hover:

- Terminal toggle: "Show terminal" / "Hide terminal".
- Theme cycle: "Theme: system" / "Theme: light" / "Theme: dark".
- Density toggle: "Density: spacious" / "Density: compact".
- Command palette trigger: "Command palette (⌘K)".
- Sidebar pin: "Pin" / "Unpin".
- Approval close (X): "Close".
- Terminal tab close: "Close ${tab.label}".

## 13. VoiceOver considerations

The desktop app has been designed for VoiceOver but not yet manually
audited end-to-end with VoiceOver (SPEC §28 lists "Manual VoiceOver
test" as a required scenario). The following design choices are
VoiceOver-friendly:

- The title bar is a single landmark; the product name is read first.
- Sidebar sessions/tasks use `aria-pressed` to indicate selection.
- The conversation feed is a `role="log"` candidate (not yet
  applied — future patch).
- Streaming messages use `aria-live="polite"` on the streaming cursor
  span (not yet applied — currently the cursor is decorative; a
  future patch will add an `aria-live` region for new messages).
- The terminal body uses `tabIndex={0}` so VoiceOver can focus it and
  read output; the search input uses `aria-label="Search terminal
  output"`.

Known VoiceOver gaps (future work):

- The conversation does not yet announce new messages.
- The terminal output is read as a single pre-formatted block; a
  per-line `role="text"` would improve navigation.
- The diff viewer's per-line actions are hover-revealed; VoiceOver
  users need a keyboard equivalent (currently the `j/k` navigation
  works, but per-line "add comment" requires a focused state).

## 14. Streaming updates and assistive technology

Per SPEC §26: "Streaming updates that do not overwhelm assistive
technology."

- The streaming cursor (the pulse block on a streaming agent message)
  is `aria-hidden` so screen readers don't announce it on every
  frame.
- Token deltas from the SSE stream are appended to the agent message
  in-place; the message's `aria-live` is not yet set. A future
  hardening patch will add a single `aria-live="polite"` region that
  announces "Agent responded" when a turn completes, rather than
  announcing every token.
- The status indicator's `aria-label` updates when a task transitions
  (e.g. working → done), but the indicator itself is not in a live
  region. The Inspector's status row is in a polite live region
  (planned).

## 15. Known gaps

The following accessibility items are not yet implemented and are
slated for a future hardening pass:

1. **VoiceOver manual test** (SPEC §28). The app has been designed for
   VoiceOver but not yet audited end-to-end.
2. **Conversation live region** — new messages should be announced
   via a polite live region, not the streaming cursor.
3. **Diff viewer per-line keyboard actions** — hover-revealed actions
   need keyboard equivalents (currently only `j/k` navigation works).
4. **Reduced transparency detection** — the Electron main process
   should detect `AppleReduceTransparency` and disable vibrancy.
5. **Focus restoration on Conversation scroll** — when the user
   navigates away from the composer and back, the composer should
   re-focus.
6. **`⌘1`–`⌘9` task switching** — documented in the keyboard map but
   not yet wired.
