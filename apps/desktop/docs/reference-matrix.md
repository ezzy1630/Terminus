# Terminus Desktop — Reference-Pattern Matrix

This matrix records patterns considered for the standalone harness. “Adopt”
means the current renderer uses the pattern; “modify” means the product
contract narrows it; “reject” means it does not belong in Terminus.

## Shell and navigation

| Pattern | Reference | Decision | Current surface |
| --- | --- | --- | --- |
| Three-region shell | macOS, Codex | Adopt; sidebar and inspector remain docked at supported widths | `Layout.tsx` |
| Shallow project → task hierarchy | Finder, Codex | Adopt; no worktree or provider tree in the UI | `Sidebar.tsx` |
| Pinned tasks and command search | Slack, Linear | Adopt | `Sidebar.tsx`, `CommandPalette.tsx` |
| Projects and Activity modes | macOS, Codex | Adopt as a visible labeled switch | `Sidebar.tsx` |
| Dashboard metric grid | Datadog | Reject; cockpit pages expose task-scoped resources instead | Cockpit views |
| Always-visible command bar | Linear | Reject; use the command palette | `CommandPalette.tsx` |

## Conversation and composer

| Pattern | Reference | Decision | Current surface |
| --- | --- | --- | --- |
| Document-style feed | iA Writer, Codex | Adopt; no chat bubbles for agent output | `Conversation.tsx` |
| Grouped execution blocks | Codex, Cursor | Adopt; summaries expand to bounded details | `ActivityBlock.tsx` |
| Stick-to-bottom only when already at bottom | Modern chat clients | Adopt; reading history must not jump | `Conversation.tsx` |
| Virtualized long feed | Browser data grids | Adopt with measured rows and bounded overscan | `Conversation.tsx` |
| Per-task draft persistence | Codex | Adopt; drafts are isolated from event updates | `useTerminusStore` |
| Always-visible send/steer composer | Coding agents | Adopt; Return sends or queues and `⌘Enter` steers | `Composer.tsx` |
| Queue and stop controls in the composer | Coding agents | Adopt when backed by the active run; stop remains explicit | `Composer.tsx` |

## Review and evidence

| Pattern | Reference | Decision | Current surface |
| --- | --- | --- | --- |
| On-demand review split | GitHub, Cursor | Adopt; `⌘D` opens Changes | `ReviewPane.tsx` |
| Unified and split diff modes | GitHub | Adopt; persisted view preference | `DiffViewer.tsx` |
| Virtualized diff rows | Code review tools | Adopt; dynamic measurement and focus-aware navigation | `DiffViewer.tsx` |
| Inline line comments | GitHub | Adopt; draft returns focus to its trigger | `DiffViewer.tsx` |
| Per-hunk accept/reject/restore | GitLens | Adopt when the task exposes review authority | `DiffViewer.tsx` |
| Automatic diff inferred from a filename | Naive code UIs | Reject; only explicit patch evidence renders | `ReviewPane.tsx` |

## Inspector and approvals

| Pattern | Reference | Decision | Current surface |
| --- | --- | --- | --- |
| Dynamic contextual sections | Xcode Inspector | Adopt; empty sections are omitted | `Inspector.tsx` |
| Floating inspector card | macOS | Reject; the supported desktop shell uses a dismissible, resizable dock | `Layout.tsx` |
| Inline approval request | Codex | Adopt; action, scope, and risk remain visible | `ApprovalCard.tsx` |
| Auto-deny on Escape | Some permission UIs | Reject; denial is explicit | `ApprovalCard.tsx` |
| Modal intervention review | Transactional systems | Adopt for structured proposals; apply remains explicit | `StructuredInterventionModal` |

## Command, settings, and onboarding

| Pattern | Reference | Decision | Current surface |
| --- | --- | --- | --- |
| Fixed keyboard registry rendered in Settings | macOS, Raycast | Adopt; one source in `lib/shortcuts.ts` | `Settings.tsx` |
| Fuzzy command search with groups | Raycast | Adopt | `CommandPalette.tsx` |
| Modal palette focus | WAI-ARIA dialog practices | Adopt; Tab wraps and Escape closes | `CommandPalette.tsx` |
| Focus-trapped settings/onboarding dialogs | WAI-ARIA practices | Adopt with focus restoration | `useDialogFocus.ts` |
| Four-step first-run setup | Modern desktop apps | Adopt when onboarding is shown | `Onboarding.tsx` |
| Forced settings tour | Enterprise tools | Reject; defaults are usable without setup | `Onboarding.tsx` |

## Standalone boundary

| Pattern | Reference | Decision | Current surface |
| --- | --- | --- | --- |
| Native Electron shell with sandboxed renderer | Electron security guidance | Adopt; preload is a narrow trusted bridge | `electron/main.ts`, `preload.ts` |
| Rust kernel as effect authority | Terminus architecture | Adopt; UI sends typed control-plane requests | `packages/`, `services/` |
| Embedded external harness runtime | Provider-specific clients | Reject; first-party code is provider-neutral | Repository-wide |
| Local PTY drawer or shell fallback | IDEs | Reject; process execution belongs behind kernel contracts | Repository-wide |
| Local display capture fallback | Remote-control tools | Reject; availability is explicit until a trusted lease exists | `ComputerUsePiP.tsx` |

The resulting character is calm, keyboard-first, evidence-oriented, and
progressive: a surface appears when it has authoritative data, and an
unavailable capability stays visibly unavailable.
