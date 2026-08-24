# Terminus Desktop — VoiceOver Test Plan

This plan is an execution checklist, not a test report. It is intentionally
limited to surfaces present in the standalone desktop harness. No scenario
assumes a local shell, pseudo-terminal, display capture, or provider-specific
extension.

## Setup

1. Build and launch the fresh packaged `.app` described in `packaging.md`.
2. Enable VoiceOver with `⌘F5`; set VoiceOver Utility's announcement level to
   High and enable Speak status.
3. Prepare one project with an empty task list, one task with conversation
   events, one task with patch evidence, and one pending approval when the
   control plane can provide them.
4. Use `VO` for Control-Option. Verify both direct keyboard focus and VoiceOver
   navigation; record the macOS version, build identity, and result for each
   scenario.

## Scenarios

### 1. Shell and sidebar

Move through the title bar, workspace navigation, project list, pinned tasks,
and task rows with `VO` arrows and Tab. Confirm that each control has a useful
name, task rows expose status and selected state, and the empty project/task
states announce their recovery action.

### 2. Roving task focus

In a project with more tasks than fit in the sidebar, focus a task row and use
`ArrowUp`, `ArrowDown`, `Home`, and `End`. Confirm that focus follows the
selected row even when virtualization mounts it after the key event.

### 3. Conversation and activity

Navigate the conversation as a document. Confirm that user and agent content
has distinguishable accessible context, activity blocks expose their summary
and expanded details, and streaming updates do not cause token-by-token
announcements or steal focus.

### 4. Composer

Focus the message composer, type a multiline draft, and use `⌘Enter` (or
`Ctrl+Enter`) to send or steer. Confirm the field and button names communicate
the current action. Confirm that `Enter` inserts a newline and that no queue,
stop, or interrupt shortcut is announced.

### 5. Command palette

Open the palette with `⌘K`, inspect its dialog and search field, navigate with
arrows/Home/End, invoke with Enter, and close with Esc. Confirm result labels,
groups, selected state, and shortcut hints are announced. Confirm Tab and
Shift+Tab wrap inside the modal palette and Escape closes it.

### 6. Settings and onboarding

Open Settings with `⌘,` and shortcut reference with `⌘/`. Traverse categories,
search results, controls, and reset actions. If onboarding is available,
complete it with keyboard only. Confirm dialogs move focus in, wrap Tab and
Shift+Tab, close on Esc, and restore the launching control.

### 7. Changes review

Open Changes with `⌘D` for a task with patch evidence. Navigate the diff with
`J`, `K`, `[`, `]`, and `U`; inspect file and hunk labels, line additions and
deletions, comment fields, and accept/reject/restore controls. Confirm that
virtualized rows remain reachable and that focus is not lost after a view
change.

### 8. Approval and intervention dialogs

With a real pending approval, move through the inline Allow once, Allow for
this task, and Deny actions. Confirm the action, risk, scope, and resolved
state are announced and that Esc does not silently deny. Repeat with a
structured intervention dialog and verify its review/apply boundary is clear.

### 9. Inspector and cockpit views

Open the inspector at wide, medium, and the 900px minimum window width.
Confirm section headings, expanded state, stale/error state, the docked resize
separator, and the dismiss control remain reachable. Open each grouped product
destination and verify its tabs plus loading, empty, unavailable, and
decoded-data states are announced without fabricated success content.

### 10. Connection and error recovery

With the control plane unavailable or a request rejected, verify the connection
banner and error state use alert/status semantics, expose the actual error
category, and offer a reachable retry or recovery action. Restore the service
and confirm stale data is identified as stale rather than silently refreshed.

### 11. Computer-use boundary

If a task exposes the computer-use placeholder, confirm VoiceOver explains
that a kernel-backed lease and trusted preview are required. It must not claim
that this Mac is being captured or offer take-over/hand-back controls when no
such lease exists.

### 12. Preferences and visual state

Cycle system/light/dark theme and spacious/compact density from their exposed
controls. Repeat with Reduce Motion and Reduce Transparency enabled. Confirm
focus remains visible, status is not communicated by color alone, and no
continuous animation interferes with reading.

## Result record

For each scenario record `pass`, `fail`, or `blocked`, plus the exact
announcement and a short reproduction note. A source inspection, unit test,
or development-renderer run is not a VoiceOver result. Leave the result as
`blocked` when the required control-plane fixture or macOS permission is not
available.
