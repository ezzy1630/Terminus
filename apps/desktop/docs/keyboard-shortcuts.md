# Forge Desktop — Keyboard Shortcuts

This is the complete keyboard map for the Forge desktop app. All
shortcuts work with either ⌘ (macOS) or Ctrl (Linux/Windows) unless
noted. Where a shortcut has a UI affordance, the affordance is listed.

## Global shortcuts

| Shortcut       | Action                                | Affordance | SPEC § |
| -------------- | ------------------------------------- | ---------- | ------ |
| `⌘K`           | Open / close the command palette      | "Commands ⌘K" button in the title bar | 18 |
| `⌘,`           | Open / close Settings                 | —          | 20     |
| `⌘\``          | Toggle the terminal drawer            | Panel-bottom icon in the title bar | 6, 15 |
| `⌘N`           | New task (clears the selected task → NewTaskScreen) | "New task" button in the sidebar | 7, 8 |
| `⌘]`           | Toggle the inspector                  | —          | 11     |
| `⌘\`           | Toggle the sidebar                    | —          | 7      |
| `⌘1` … `⌘9`    | Switch to task N (1-indexed)          | —          | 7      |
| `⌘Enter`       | Send (or steer if work is running)    | "Send" / "Steer" button in the composer | 10 |
| `⇧⌘Enter`      | Queue a follow-up                     | "Queue" pill in the composer (visible when applicable) | 10 |
| `Esc`          | Interrupt the active turn / close the active overlay | — | 10, 18, 20 |

> ⌘1–⌘9 and ⌘]/⌘\ are reserved in the keyboard map but not yet wired
> in `App.tsx`. They land in a follow-up hardening patch that adds
> per-task navigation. The Command Palette surfaces "Toggle inspector"
> and "Open task" today via fuzzy search.

## Composer-specific shortcuts

These fire only when the composer textarea has focus.

| Shortcut       | Action                                                |
| -------------- | ----------------------------------------------------- |
| `⌘Enter`       | Send (or steer if the active task is running)         |
| `⇧⌘Enter`      | Queue the input as a follow-up turn                   |
| `Esc`          | Interrupt the active turn (calls `cancelTask`)        |
| `Enter`        | Newline (the textarea is multi-line by default)       |

## Command palette shortcuts

Active only while the palette is open.

| Shortcut  | Action                                                |
| --------- | ----------------------------------------------------- |
| `↑` `↓`   | Move selection up / down                              |
| `Enter`   | Invoke the highlighted command                        |
| `Home`    | Jump to the first result                              |
| `End`     | Jump to the last result                               |
| `Esc`     | Close the palette                                     |
| `Tab`     | (Recovery) escape the palette — does NOT close it     |

## Diff viewer shortcuts

Active only while the diff viewer has focus.

| Shortcut  | Action                                                |
| --------- | ----------------------------------------------------- |
| `j`       | Jump to the next change (hunk)                        |
| `k`       | Jump to the previous change (hunk)                    |
| `[`       | Jump to the previous file                             |
| `]`       | Jump to the next file                                 |
| `u`       | Toggle unified / split view mode                      |
| `⌘D`      | Toggle the diff view mode (alias of `u`)              |

## Terminal drawer shortcuts

Active only while the terminal drawer is open. The drawer never
claims `⌘\`` — that shortcut is owned by the Layout so it works
whether the drawer is open or closed.

| Shortcut  | Action                                                |
| --------- | ----------------------------------------------------- |
| `⌘F`      | Focus the search field (does nothing if focus is already in an input) |
| `Enter`   | (in the search field) cycle to the next match         |
| `Esc`     | (in the search field) close the search bar            |
| `⌘K`      | Clear the active terminal's output                    |

## Settings shortcuts

| Shortcut  | Action                                                |
| --------- | ----------------------------------------------------- |
| `⌘,`      | Open / close Settings                                 |
| `Esc`     | Close Settings (when no input has focus)              |

## Onboarding shortcuts

| Shortcut  | Action                                                |
| --------- | ----------------------------------------------------- |
| `Enter`   | Advance to the next step (when a button is focused)   |
| `Esc`     | Skip onboarding                                       |

## Reserved but not yet wired

These shortcuts are documented in the SPEC and listed in the keyboard
map but the host does not yet act on them. They are slated for a
follow-up wiring patch:

| Shortcut       | Action                                |
| -------------- | ------------------------------------- |
| `⌘O`           | Open an existing project              |
| `⌘T`           | Open an existing task                 |
| `⌘D`           | Show changes (diff viewer)            |
| `⌘/`           | View keyboard shortcuts (cheat sheet) |

## Modifier-key conventions

- **macOS-primary.** Every shortcut uses `⌘` on macOS and `Ctrl` on
  Linux/Windows. The Composer, CommandPalette, Settings, Layout, and
  TerminalDrawer all check `e.metaKey || e.ctrlKey` so the same code
  path serves both platforms.
- **No Alt-only shortcuts.** Alt is reserved for menu access keys in
  native macOS menus and is not used as the primary modifier for any
  in-app shortcut.
- **Shift as a modifier for "queue" semantics.** `⇧⌘Enter` queues
  instead of sending, mirroring the convention in chat apps where
  Shift+Enter inserts a newline but Shift+Cmd+Enter sends an alternate
  action.

## Discoverability

Per SPEC §18: "Clear shortcut hints."

- The composer footer shows `⌘↵ send · ⇧⌘↵ queue · esc interrupt` at
  all times.
- The command palette footer shows `↑↓ navigate · ↵ select · esc
  close` while the palette is open.
- The terminal drawer footer shows `⌘F search · ⌘K clear · drag the
  top edge to resize` while the drawer is open.
- Sidebar rows show their full title via the `title` attribute
  (native tooltip) — no custom shortcut hint on rows.
- Icon-only buttons in the title bar (theme cycle, density toggle,
  terminal toggle, command palette) all carry both `aria-label` and
  `title` so hover and screen readers reveal their function.
