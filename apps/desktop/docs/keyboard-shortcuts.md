# Terminus Desktop — Keyboard Shortcuts

This is the complete keyboard map for the Terminus desktop app. All
shortcuts work with either ⌘ (macOS) or Ctrl (Linux/Windows) unless
noted. Where a shortcut has a UI affordance, the affordance is listed.

## Global shortcuts

| Shortcut       | Action                                | Affordance | SPEC § |
| -------------- | ------------------------------------- | ---------- | ------ |
| `⌘K`           | Open / close the command palette      | Command icon in the title bar | 18 |
| `⌘,`           | Open / close Settings                 | —          | 20     |
| `⌘\``          | Toggle the terminal drawer            | Panel-bottom icon in the title bar | 6, 15 |
| `⌘N`           | New task (clears the selected task → NewTaskScreen) | "New task" button in the sidebar | 7, 8 |
| `⌘D`           | Open / close the changes review split | Command palette → Show changes | 13 |
| `⌘]`           | Toggle the inspector                  | Command palette → Toggle inspector | 11 |
| `⌘\`           | Toggle the sidebar                    | —          | 7      |
| `⌘1` … `⌘9`    | Switch to task N (1-indexed)          | —          | 7      |
| `⌘O`           | Open the project onboarding flow      | New project recovery action | 19 |
| `⌘/`           | Open Settings and shortcut reference  | Settings | 18, 20 |
| `⌘Enter`       | Send (or steer if work is running)    | "Send" / "Steer" button in the composer | 10 |
| `⇧⌘Enter`      | Queue a follow-up                     | "Queue" pill in the composer (visible when applicable) | 10 |
| `Esc`          | Interrupt the active turn / close the active overlay | — | 10, 18, 20 |

> Number shortcuts select tasks in the active project. At narrow widths ⌘]
> opens the otherwise-hidden inspector overlay deliberately.

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
| `⌘D`      | Open / close the changes review split                  |

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
