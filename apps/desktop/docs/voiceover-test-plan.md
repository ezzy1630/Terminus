# Terminus Desktop — VoiceOver Test Plan

This document defines **20 specific VoiceOver test scenarios** for the Terminus
desktop application, with step-by-step instructions, expected announcements,
and setup notes. VoiceOver only runs on macOS, so this plan must be executed
on a Mac with the Terminus desktop app installed (see `packaging.md`).

Per SPEC §28 ("Accessibility"), Terminus must be **fully usable with VoiceOver**:
every interactive surface must have a sensible accessible name, every dynamic
update must be announced politely, and every keyboard shortcut must have a
screen-reader-friendly description.

---

## 0. Setup

### Enable VoiceOver
- Press **⌘F5** (or **Fn⌘F5** on laptops with function-key lock) to toggle
  VoiceOver on or off.
- Alternatively, open **System Settings → Accessibility → VoiceOver** and
  enable it. The first time you enable VoiceOver, macOS offers an interactive
  tutorial — complete it once to learn the basic gestures.

### VoiceOver Utility
Open **VoiceOver Utility** (**⌘⌥F9** when VoiceOver is on, or
`/System/Applications/Utilities/VoiceOver Utility.app`) and configure:

- **Verbosity → Announcement level**: High (so you can verify exact phrases).
- **Verbosity → Speak status**: ✓ (so status indicators are announced).
- **Navigation → Keyboard navigation**: Allow Quick Nav (**← + →** to toggle).
- **Web → Navigation**: Enable "Group items by type" (this affects list
  navigation in command palette and diff viewer).
- **Sound → Audio ducking**: ✓ (so Terminus audio fades when VoiceOver speaks).

### Terminus launch
1. Launch the Terminus app.
2. If first-run onboarding appears, complete it or skip it.
3. Select a project + task so the conversation surface is populated.

### VoiceOver navigation basics (cheat sheet)
- **VO + ← / →**: Move to the previous / next item.
- **VO + ↑ / ↓**: Move into / out of a group.
- **VO + Space**: Activate the focused item (click).
- **VO + Shift + ↓**: Interact with a container (e.g., a list).
- **VO + Shift + ↑**: Stop interacting with a container.
- **VO + U**: rotor — cycle through navigation modes (headings, links,
  form controls, lists, etc.).
- **VO + M**: Open VoiceOver menu.
- **VO + H**: VoiceOver help.

`VO` = the **Control + Option** keys (held together).

---

## 1. Sidebar — list projects and tasks

**Goal**: The sidebar is announced as a navigation region with projects and
tasks as a list. Each row exposes its title, status, selected state.

**Steps**:
1. Press **VO + ← / →** until you reach the sidebar.
2. VoiceOver should announce: *"Sidebar, navigation region"*.
3. Press **VO + Shift + ↓** to interact with the sidebar.
4. Press **VO + ↓** repeatedly to walk down the list.

**Expected announcements** (one per row):
- *"Terminus, heading"* (app name at the top).
- *"New task, button"*.
- *"Search tasks, search text field"*.
- *"Pinned, group"* then *"Pinned, list"*.
- *"Projects, group"* then *"Projects, list"*.
- For each project row: *"<project title>, button, expanded"* or *"<project
  title>, button, collapsed"*.
- For each task row: *"<task title>, status <status>, button"* (where status
  is one of: working, queued, waiting, needs approval, needs review, failed,
  interrupted, done).
- For the selected task row: append *", selected"*.
- For pinned tasks: append *", pinned"*.

**Pass criteria**: Every row is reachable and announced with a meaningful
label. The selected task's row announces "selected" without visual context.

---

## 2. Read a conversation

**Goal**: The conversation feed reads as a document. User + agent messages
are distinguished, streaming updates are announced politely.

**Steps**:
1. Move focus to the conversation region (**VO + →**).
2. VoiceOver should announce: *"Conversation feed, feed region"*.
3. Interact (**VO + Shift + ↓**) and walk down (**VO + ↓**).

**Expected announcements**:
- *"Task, heading"* — the task objective is read as the page title.
- *"Created <relative time>, risk <class>"* — the metadata below the title.
- *"You, group"* then the user message text.
- *"Terminus, group"* then the agent message text.
- When a new agent message arrives while you're reading: an aria-live
  region politely announces *"Terminus is responding"* (and *"Terminus responded"*
  when the stream completes).

**Pass criteria**:
- Each message is announced with its author first ("You" or "Terminus") so the
  user can follow the turn-taking.
- New streaming messages do NOT interrupt reading; the polite live region
  queues the announcement.

---

## 3. Compose and send a message

**Goal**: The composer is fully operable from the keyboard; send/steer/stop
modes are announced.

**Steps**:
1. Press **VO + →** until focus lands in the composer textarea.
2. VoiceOver should announce: *"Message composer, multi-line text field.
   Press Command Enter to send, Shift Command Enter to queue, Escape to
   interrupt."*
3. Type a message.
4. Press **⌘Enter** to send.

**Expected announcements**:
- The textarea announces its accessible description (the keyboard shortcut
  hint) on focus.
- When the send button changes mode (send → stop while the agent is running):
  *"Stop, button"* (instead of *"Send, button"*).
- After sending: the conversation live region announces *"You sent a
  message"*.

**Pass criteria**: All composer actions (send, steer, queue, stop) are
keyboard-reachable and correctly announced. The mode pill (Steer/Queued)
is announced when active.

---

## 4. Open the command palette

**Goal**: The command palette opens with ⌘K and is navigable with arrow keys.

**Steps**:
1. Press **⌘K** anywhere in the app.
2. VoiceOver should announce: *"Command palette, dialog. Search commands,
   edit text"*.
3. Type a query (e.g., "theme").
4. Press **↓** to move to the first result.
5. Press **Enter** to invoke.

**Expected announcements**:
- On open: *"Command palette, dialog"*.
- On focus into the search input: *"Search commands, edit text"*.
- As you arrow through results: each command's label + group, e.g.,
  *"Toggle theme, command, group Appearance"*.
- On Enter: the dialog closes; if the command triggers a state change
  (e.g., theme switch), the polite live region announces it.

**Pass criteria**: A user can find and invoke any command by name without
mouse interaction. Recent commands are announced first.

---

## 5. Review a diff

**Goal**: The diff viewer is operable with j/k (next/prev change), [/]
(next/prev file), and u (toggle unified/split).

**Steps**:
1. Open the diff viewer (via command palette or by clicking a file change
   in the inspector).
2. VoiceOver should announce: *"Diff viewer, region"*.
3. Interact with the diff body (**VO + Shift + ↓**).
4. Press **j** to move to the next change.
5. Press **k** to move to the previous change.
6. Press **u** to toggle between unified and split view.

**Expected announcements**:
- *"Diff body for <file path>, region"*.
- As you press j/k: the focused change line is announced. Added lines:
  *"Added line <number>: <text>"*. Removed lines: *"Removed line <number>:
  <text>"*.
- Hunk header rows announce: *"<header text>, heading"*.
- When you press **u**: *"Unified view"* or *"Split view"* announced by the
  polite live region.

**Pass criteria**: The user can navigate every change with j/k and every
file with [/]. Large diffs (10k+ lines) remain responsive — VoiceOver only
reads the visible virtual rows.

---

## 6. Approve a permission request

**Goal**: Approval cards are announced when they appear and the three
approval actions are reachable.

**Steps**:
1. Trigger a task that requires approval (e.g., a write to a path outside
   the contract scope).
2. An ApprovalCard appears in the conversation.
3. VoiceOver should announce: *"Approval requested: <operation>, dialog"*.
4. Press **Tab** to cycle through the actions: *Allow once* → *Allow for
   this task* → *Deny*.
5. Press **Enter** on the desired action.

**Expected announcements**:
- On card appearance: *"Approval requested: <operation>, risk <risk class>,
  scope <scope>. Three buttons: Allow once, Allow for this task, Deny."*
- On each button focus: the button label + ", button".
- After resolving: *"Approval resolved: <decision>"* in the live region.

**Pass criteria**: The user can resolve an approval without seeing the
visual card.

---

## 7. Switch the theme

**Goal**: Theme switching (system / light / dark) is keyboard-reachable and
announced.

**Steps**:
1. Press **⌘K** to open the command palette.
2. Search for "theme".
3. Select "Toggle theme".
4. The theme cycles: system → light → dark → system.

**Expected announcements**:
- After invoking the command: *"Theme: light"* (or dark/system) in the
  polite live region.
- The title-bar theme button's accessible label updates: *"Theme: light,
  button"*.

**Pass criteria**: The user knows the current theme without seeing the
button icon.

---

## 8. Switch density (spacious ↔ compact)

**Goal**: Density switching is reachable and announced.

**Steps**:
1. Press **⌘K**.
2. Search for "density".
3. Select "Toggle density".

**Expected announcements**:
- After invoking: *"Density: compact"* or *"Density: spacious"* in the live
  region.
- The title-bar density button's label updates to match.

**Pass criteria**: The user knows the current density. Sidebar rows
re-render at the new height without losing focus.

---

## 9. Toggle the terminal drawer

**Goal**: The terminal drawer opens/closes with **⌘`** and announces its
state.

**Steps**:
1. Press **⌘`**.
2. VoiceOver should announce: *"Terminal drawer, region"*.
3. Press **⌘`** again.

**Expected announcements**:
- On open: *"Terminal drawer opened, region"*.
- On close: *"Terminal drawer closed"*.
- Inside the drawer: *"Terminal sessions, tab list"* then each tab as
  *"shell 1, tab, selected"*.

**Pass criteria**: The drawer opens/closes without focus loss. Tabs are
reachable with **VO + ← / →**.

---

## 10. Type in the terminal

**Goal**: The terminal is operable as a PTY session. Input is sent; output
is read.

**Steps**:
1. Open the terminal drawer.
2. VoiceOver should focus the xterm container.
3. Type `echo hello` and press **Enter**.
4. The terminal displays the output.

**Expected announcements**:
- On focus: *"Terminal body, region. Type to send input to the shell."*
- VoiceOver does NOT read every character of shell output (this would be
  overwhelming) — instead, the user can press **VO + A** to read the
  current terminal contents on demand.
- The terminal region announces nothing on each output chunk (per SPEC §28
  "Don't announce every token of streaming output").

**Pass criteria**: Input is sent to the PTY. Output appears. The screen
reader is not flooded with character-by-character announcements.

---

## 11. Use the search bar inside the terminal

**Goal**: ⌘F opens the terminal search bar, which is keyboard-focusable.

**Steps**:
1. Open the terminal drawer.
2. Press **⌘F**.
3. VoiceOver should announce: *"Search terminal output, edit text"*.
4. Type a query.
5. Press **Enter** to advance to the next match.
6. Press **Esc** to close.

**Expected announcements**:
- The match counter updates: *"1 of 3 matches"*, *"2 of 3 matches"*, etc.
- On Esc: focus returns to the terminal body.

**Pass criteria**: Search is fully keyboard-operable; match count is
announced.

---

## 12. Open Settings

**Goal**: ⌘, opens Settings; all 14 categories are reachable.

**Steps**:
1. Press **⌘,**.
2. VoiceOver should announce: *"Settings, dialog"*.
3. Use the rotor (**VO + U**) to switch to "headings" navigation.
4. Walk through settings categories.

**Expected announcements**:
- Each category: *"<Category name>, heading"* (General, Appearance, Editor,
  Terminal, Notifications, Privacy, Shortcuts, etc.).
- Each setting control announces its label + current value.

**Pass criteria**: All settings are reachable and operable from the
keyboard.

---

## 13. Complete first-run onboarding

**Goal**: The 4-step onboarding flow (Welcome → Project → Tools → First task)
is fully navigable.

**Steps**:
1. Reset onboarding: delete `terminus-desktop.onboarding.completed.v1` from
   localStorage (via devtools) and restart.
2. The Welcome step appears.
3. Press **Tab** to move between "Continue" and "Skip".
4. Complete the flow.

**Expected announcements**:
- Each step's title: *"Welcome to Terminus, heading"*.
- Step indicator: *"Step 1 of 4"*.
- Buttons: *"Continue, button"*, *"Skip, button"*.

**Pass criteria**: The user can complete onboarding without a mouse.

---

## 14. Read the inspector sections

**Goal**: The inspector's dynamic sections (Environment, Activity, Approvals,
Computer Use) appear/disappear based on context and are announced.

**Steps**:
1. Select a task.
2. Move focus to the inspector (**VO + →**).
3. VoiceOver should announce: *"Inspector, region"*.
4. Walk down through sections.

**Expected announcements**:
- *"Environment, button, expanded"* (or "collapsed").
- After pressing **VO + Space** on the header: *"Environment, collapsed"*
  and the section body disappears.
- *"Activity, button"* (only if events exist).
- *"Computer Use, button"* (only if a session is active — per SPEC §11,
  this section is absent otherwise).

**Pass criteria**: Sections only appear when they have content. Each is
collapsible. The user always knows which section they're in.

---

## 15. Toggle the inspector overlay (narrow viewport)

**Goal**: When the window is narrow (<900px), the inspector becomes a
floating overlay; focus management still works.

**Steps**:
1. Resize the window to <900px wide (or use the title-bar resize grip).
2. The inspector becomes an absolutely-positioned floating card.
3. Press **VO + →** to move focus.

**Expected announcements**:
- The inspector is announced as before — the layout change is transparent
  to VoiceOver.
- Tab order: sidebar → main conversation → inspector overlay.

**Pass criteria**: No focus trap, no lost focus on layout change.

---

## 16. Trigger a computer-use session (⌘⇧C)

**Goal**: The Computer Use PiP appears with a live screen preview and the
"Take over" control is operable.

**Steps**:
1. Press **⌘⇧C**.
2. The Computer Use section appears in the inspector.
3. VoiceOver should announce: *"Computer Use, region. Agent is driving
   your desktop. Use Take over to interrupt."*
4. Press **Tab** to reach the "Take over" button.
5. Press **Enter**.

**Expected announcements**:
- On section open: *"Computer Use, button, expanded"* then *"Computer-use
  preview, region"*.
- On screen-capture failure (Linux sandbox or no permission): *"Live preview
  unavailable. Screen capture requires macOS Screen Recording permission."*
- On Take over: *"You are in control. Hand back to let the agent
  continue."*
- On Hand back: *"Agent is driving your desktop…"*

**Pass criteria**: All PiP controls (pause, expand, hide, stop, take over)
are keyboard-reachable and announced.

---

## 17. Hide and resume the computer-use PiP

**Goal**: The "Hide" control collapses the PiP to a small badge; clicking
the badge resumes the PiP.

**Steps**:
1. With Computer Use active, press **Tab** to the "Hide preview" button.
2. Press **Enter**.
3. VoiceOver should announce: *"Show computer-use preview, button"* (the
   badge is now focused).
4. Press **Enter** to restore the PiP.

**Expected announcements**:
- On hide: *"Computer-use preview hidden. Show computer-use preview,
  button."*
- On restore: *"Computer-use preview, region."*

**Pass criteria**: Hide/restore cycle works without losing the underlying
session.

---

## 18. Stop the agent mid-stream

**Goal**: When the agent is responding, the composer's send button becomes
"Stop"; pressing it interrupts the stream.

**Steps**:
1. Send a message that triggers a long agent response.
2. While the response is streaming, press **Tab** to focus the send button.
3. VoiceOver should announce: *"Stop, button"*.
4. Press **Enter**.

**Expected announcements**:
- The conversation live region announces: *"Terminus stopped"*.
- The send button reverts to *"Send, button"*.
- The streaming cursor (aria-label "streaming") is removed.

**Pass criteria**: The user can interrupt the agent from the keyboard.

---

## 19. Read the activity block expansion

**Goal**: Grouped execution blocks ("Explored codebase", "Ran verification")
expand to show details, and the expanded content is announced.

**Steps**:
1. Trigger a task that emits tool events.
2. An activity block appears in the conversation.
3. VoiceOver should announce: *"Explored codebase, <metric> (e.g. 12 files),
   button, collapsed"*.
4. Press **VO + Space** to expand.
5. VoiceOver should announce: *"Explored codebase, expanded"*.
6. Walk down (**VO + ↓**) through the entries.

**Expected announcements**:
- Each entry: *"<time>, <tool>, <summary>"*.
- If the entry has detail output: *"Detail, group"* then the detail text.

**Pass criteria**: Expanded activity is fully readable; collapsed state
communicates the metric.

---

## 20. Read an error state

**Goal**: When the control plane is unreachable or an operation fails, an
ErrorState appears with a recovery action.

**Steps**:
1. Stop the control plane (`mini-services/terminus-control`).
2. Wait for the next health check, or trigger a refresh.
3. An ErrorState appears.

**Expected announcements**:
- On error appearance: *"Control plane unreachable, alert. <Error message>.
  Retry, button."*
- The polite live region announces the error summary.

**Pass criteria**: Errors are announced assertively (role="alert"), recovery
actions are keyboard-reachable, and the user can dismiss the error.

---

## Appendix A — Keyboard shortcuts (screen-reader descriptions)

Every keyboard shortcut must have a description that VoiceOver can read
when the user opens the Shortcuts help (via the command palette → "View
shortcuts"). The descriptions below are stored in `keyboard-shortcuts.md`
and surfaced in-app via `aria-description` on the relevant controls.

| Shortcut | Description |
| --- | --- |
| ⌘K | Open command palette |
| ⌘, | Open settings |
| ⌘` | Toggle terminal drawer |
| ⌘F (in terminal) | Search terminal output |
| ⌘K (in terminal) | Clear terminal output |
| ⌘Enter (in composer) | Send message |
| ⇧⌘Enter (in composer) | Queue message |
| Esc (in composer) | Interrupt agent |
| ⌘⇧C | Toggle computer-use session (demo) |
| j / k (in diff) | Next / previous change |
| [ / ] (in diff) | Previous / next file |
| u (in diff) | Toggle unified / split view |
| ? (in diff) | Show diff shortcuts help |

## Appendix B — aria-live regions

The following live regions exist in the app:

| Region | Politeness | Purpose |
| --- | --- | --- |
| Conversation | polite | Announces new user/agent messages. |
| Inspector Computer Use | polite | Announces control-state changes (agent ↔ user). |
| Error banner | assertive | Announces error states when they occur. |
| Health dot (title bar) | off | Visual-only; status is exposed via `aria-label`. |

Per SPEC §28: streaming output (tokens, terminal bytes, diff lines) is NOT
announced character-by-character — only structural changes (new message,
tool completed, approval requested) are surfaced.

## Appendix C — Test result template

For each scenario, record:

```
Scenario #: <number>
Date: <YYYY-MM-DD>
Tester: <name>
VoiceOver version: <version>
macOS version: <version>
Terminus version: <version>
Result: PASS / FAIL / PARTIAL
Notes: <observations, unexpected announcements, suggestions>
```

Submit completed runs as `apps/desktop/test-results/voiceover-<date>.md`.

## Appendix D — Known macOS VoiceOver quirks

- **VoiceOver + absolute positioning**: The virtualized lists in
  Conversation, Sidebar (when >50 items), and DiffViewer use absolute
  positioning. VoiceOver reads them correctly when the parent has
  `role="list"` / `role="feed"` / `role="region"`. If VoiceOver skips rows,
  ensure the parent's `role` is set (we set it in code).
- **VoiceOver + xterm.js**: The terminal canvas is not a normal text
  region — VoiceOver cannot read its contents directly. The user can press
  **VO + A** to read the focused region's text. We expose an `aria-label`
  on the xterm container so the user knows what they're in.
- **VoiceOver + sticky headers**: Virtualized diff hunk headers are not
  sticky (they scroll with content). If VoiceOver focus lands on a header
  that's off-screen, the user can press **VO + F** to find the next heading.
- **VoiceOver + modal dialogs (Command palette, Settings, Onboarding)**:
  Focus must be trapped inside the modal while open. We use `aria-modal`
  and focus management hooks to enforce this.
