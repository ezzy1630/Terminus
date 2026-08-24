# Terminus Desktop — Keyboard Shortcuts

This is the fixed keyboard map exposed by `src/lib/shortcuts.ts`. The app
accepts the primary modifier as Command on macOS and Control on Linux and
Windows. These bindings are not user-configurable.

## Global

| Shortcut | Action |
| --- | --- |
| `⌘K` | Open or close the command palette |
| `⌘O` | Open a project |
| `⌘,` | Open or close Settings |
| `⌘/` | Open Settings to the shortcut reference |
| `⌘N` | Start a new task |
| `⌘D` | Open or close Changes for the selected task |
| `⌘]` | Toggle the inspector |
| `⌘\\` | Toggle the sidebar |
| `⌘1`–`⌘9` | Select task 1–9 in the active session |

Global actions do not run while a modal overlay owns focus, except for the
palette, Settings, project, and shortcut-reference bindings used to open or
close those surfaces.

## Composer

| Shortcut | Action |
| --- | --- |
| `⌘↵` | Send a new message, or steer the active task |
| `Enter` | Insert a newline |

The composer intentionally has no queue, stop, or interrupt shortcut. Sending
is disabled for terminal-state tasks; create a new task to continue. The composer
accepts only the fixed `⌘↵` send/steer binding while its textarea is focused.

## Command palette

While the palette is open:

- `↑` / `↓` move through the filtered commands.
- `Home` / `End` select the first or last command.
- `Enter` invokes the selected command.
- `Esc` closes the palette.

The palette's dialog has an explicit accessible name and modal semantics. It
uses the shared focus hook, so `Tab` and `Shift+Tab` stay within the palette.

## Board

| Key | Action |
| --- | --- |
| `Return` | Open the focused task title's conversation |
| `Space` | Open the focused task title's conversation |

Preview is an explicit item in each task's actions menu. The menu trigger and
items use their native button/menu keyboard behavior; the card does not
override Space with a second meaning.

## Diff review

These bindings are active while the diff viewer owns the review surface and
focus is not in an input, button, link, or editable control:

| Key | Action |
| --- | --- |
| `J` | Next change |
| `K` | Previous change |
| `[` | Previous file |
| `]` | Next file |
| `U` | Toggle unified or split view |

The diff viewer also exposes the same Changes command as `⌘D`. Review rows are
virtualized and keyboard focus is restored to the selected change when a row
is mounted.

## Focus and discoverability

Settings, onboarding, Attention Center, and structured intervention dialogs
use the shared dialog-focus hook: focus moves into the dialog, `Tab` and
`Shift+Tab` wrap, `Esc` invokes the dialog's close action, and focus returns to
the launching control. The palette participates in the same focus trap.

The live shortcut reference is rendered from `FIXED_SHORTCUTS`; update the
registry and this document together when a fixed binding changes.
