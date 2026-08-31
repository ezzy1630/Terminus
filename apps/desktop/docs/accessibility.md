# Terminus Desktop — Accessibility

This is the implementation checklist for the desktop renderer. It describes
the current source-level guarantees; it is not a VoiceOver certification.
Run the manual scenarios in `voiceover-test-plan.md` on a fresh packaged
application before calling the accessibility gate complete.

## Keyboard access

- The sidebar uses native buttons for navigation and task rows. Long task
  sections use roving focus with `ArrowUp`/`ArrowDown`, `Home`, and `End`.
- The composer is a multiline textarea. `Enter` sends or queues,
  `⌘Enter`/`Ctrl+Enter` sends or steers, and `Shift+Enter` inserts a newline.
- The command palette supports arrows, `Home`, `End`, `Enter`, and `Esc`.
- Diff review supports `J`, `K`, `[`, `]`, and `U` when focus is not in an
  editable or interactive control. See `keyboard-shortcuts.md` for the full
  fixed registry.

## Semantics and names

Interactive surfaces use native buttons, links, inputs, and textareas where
possible. Icon-only controls expose an `aria-label`; shared tooltips replace
browser `title` bubbles on migrated controls.
Task rows expose their title, status, selected state, and pin state. The
command palette uses `role="dialog"`, `role="listbox"`, and
`aria-selected` for its results. Settings and the structured modal surfaces
use labelled modal dialogs. Empty, loading, stale, and error states retain
explicit status or alert semantics instead of disappearing into a blank pane.

Status is not conveyed by color alone: task status includes text and a
semantic glyph, diff lines include `+`/`-` prefixes, and approval risk is
written as a label as well as styled.

## Focus management

`useDialogFocus` is shared by the command palette, Settings, onboarding,
Attention Center, and structured interventions. On open it moves focus into
the dialog; `Tab` and `Shift+Tab` wrap; `Esc` invokes the supplied close action;
and unmount restores the launching element. Diff and sidebar virtualizers mount
the pending focused row before applying focus so keyboard navigation does not
depend on a row already being visible.

## Visual and motion preferences

- `:focus-visible` provides the keyboard focus ring.
- Light and dark token sets are explicit; the theme store supports system,
  light, and dark modes plus spacious and compact density.
- Active progress rings and mounted loading skeletons animate only transform.
  They stop under `prefers-reduced-motion`, which also disables smooth scroll.
- The Electron shell and renderer use solid surfaces. Reduce Transparency does
  not reveal a hidden vibrancy dependency.
- Unit checks hold normal tertiary and placeholder text at WCAG AA contrast on
  canvas, sidebar, card, hover, and selected surfaces in both themes. The
  packaged surface still requires contrast and target-size measurement.

## Dynamic content

Conversation and activity updates are structural rather than token-by-token
announcements. Approval, connection, loading, stale, and error states expose
the current state and recovery action. Event histories and collection pages
are bounded with explicit continuation or rejected-payload messaging; a
bounded presentation is never presented as complete content.

## Open manual gates

- VoiceOver traversal and announcements on macOS.
- Keyboard-only completion of onboarding, task selection, composer, changes,
  Settings, approvals, and cockpit dialogs.
- Contrast, focus visibility, and target-size measurements at wide and narrow
  window sizes.
- Reduced-motion and reduced-transparency checks on the packaged application.

Record results in the test plan. Do not mark an unrun manual scenario as
passing because the source contains the corresponding ARIA attribute.
