# Terminus Desktop — UI Architecture

The desktop is a single-window Electron shell and a provider-neutral React
client. It presents control-plane state; it is not an execution authority and
does not embed an external coding-agent harness.

## Shell and destinations

`App.tsx` owns the typed `SidebarDestination` selection and overlay state. It
keeps task selection independent from navigation:

```text
new_task                         → NewTaskScreen
chat + selected task             → Conversation + Composer
chat + Changes                   → Conversation + ReviewPane split
board                            → canonical task board/list + shared inspector
```

The sidebar opens to the attention inbox and recent Threads. A project
switcher owns repository context; the project tree remains a compact secondary
reading rather than a permanent segmented mode. Agents is intentionally not a
destination because the current control plane does not expose a complete,
actionable agent workspace.

The Board projects canonical ARP v2 tasks. An interactive record carries a
server-resolved conversation context backed by the same-ID v1 Task row. The
task-title button uses native button semantics, so click, Return, and Space
open that exact conversation. Show context and admitted transitions live in
the task's accessible actions menu.
Non-interactive operational records may remain unassigned and open their
context in the shared inspector. No client title-matches or fabricates
conversation history.

The shell has a 48px native title bar, a 276px default resizable sidebar,
primary surface, and resizable docked details card, hidden by default,
remembered per task, and automatically closed below 1120px. The task title and
Changes action stay in the title bar; Search lives with New task and Board in
the sidebar. Overlays are Command Palette,
Settings, onboarding, Attention Center, and structured interventions. The
command catalog is a pure startup dependency; the palette renderer is
lazy-loaded after the first open request. There is no renderer terminal
drawer, PTY surface, or OpenCode bridge.

The Electron window enforces the 900px minimum width the layout supports. The
desktop app has no phone breakpoint or floating inspector. Sidebar and
inspector widths persist locally and remain within validated bounds.

## Component boundaries

```text
App
├── Layout
│   ├── TitleBar
│   ├── Sidebar
│   ├── primary destination
│   │   ├── NewTaskScreen → intent shortcuts + Composer
│   │   ├── Conversation → Message, ActivityBlock, ApprovalCard, RunBar, Composer
│   │   ├── ReviewPane → DiffViewer
│   │   └── lazy grouped product view
│   └── Inspector
├── lazy CommandPalette
├── Settings
├── Onboarding
├── AttentionCenterModal
└── StructuredInterventionModal
```

`Conversation` decodes the bounded SSE event projection into messages and
activity blocks. `ReviewPane` only renders explicit patch evidence; it does
not infer a diff from a filename or summary. `ComputerUsePlaceholder` and
`ComputerUsePiP` describe availability boundaries until the kernel supplies a
trusted lease and preview stream; they do not capture this Mac's display.
Interactive controls use shared Radix tabs, menus, and tooltips for keyboard
behavior and accessible names. A delegated tooltip layer serves truncated non-interactive text,
without a DOM mutation observer or continuously repainting animation.

The task inspector is one scan-first details surface rather than three tabs.
An unanswered material question leads, followed by Run, Environment, Model &
access, Activity, Verification, Artifacts, Approvals, and Task details. Empty
groups disappear. It does not manufacture cache hit rates, computer-use state,
or effect receipts when the control plane did not report them. Cache metrics
are shown only when a raw count is available.

## State ownership

`useTerminusStore` (`hooks/use-terminus.ts`) is the source of truth for
sessions, tasks, selected IDs, pins, per-task drafts, event histories,
approvals, collection freshness, and the selected task's SSE stream. It keeps
denormalized task lookup for selection and bounded event history for
presentation. Session, task, and approval pages carry cursor, total, loading,
and truncation metadata so a page boundary is visible and load-more is
explicit.

`theme.css` owns the CSS-first token definitions. `useThemeStore` owns only the
system/light/dark and spacious/compact attributes; compact is the default.
Pins and drafts persist under their renderer-local
versioned storage keys; failed persistence leaves the in-memory value intact.

`useLogicalMutation` owns a bounded, versioned renderer-side journal for
multi-request user actions such as onboarding and task creation. Each semantic
operation has one stable key and durable step receipts. A retry resumes only
missing steps; an ambiguous failure retains the journal lock; a definitive
failure before any receipt may be abandoned; and a reconciled partial result
may be completed explicitly. Journal writes are read back before a step is
treated as durable, and malformed or oversized state fails closed. This
protects the client from duplicate requests but does not replace server-side
idempotency or durable control-plane recovery.

Grouped product pages use `useCockpitResource` for one abortable request per
scope. A refresh failure keeps the last decoded snapshot marked stale;
malformed cache and an empty decoded collection remain distinct from a failed
request. `useTaskV2` provides the same identity-scoped loading, stale, error,
and reconnect behavior for canonical ARP v2 tasks.

## API and effect boundary

`lib/api.ts` decodes the v1 control-plane contract and `lib/api-v2.ts` decodes
the canonical ARP v2 contract. Provider request bodies remain outside the
renderer. Every response is decoded from `unknown`; malformed bodies and
scope mismatches are errors. Network errors are distinct from HTTP errors, and
the UI never turns an unavailable service into local success.

All process, filesystem, socket, secret, and computer-use effects belong to
the Rust kernel and control-plane contracts. The Electron main process owns
only native window presentation, notifications, theme preference, the system
directory picker, validated bounds/title updates, fixed menu commands, and a
validated dropped-directory path through a trusted preload bridge.

Provider account discovery is consent-gated and account rows are read back from
the control plane. OpenCode connections can be used when explicitly connected;
a local ChatGPT/Codex subscription is shown as an unsupported native route and
is available only through the separate external Codex lane. The desktop must
never silently import raw subscription tokens or present that external loop as
a Terminus-native run.

## Live event flow

```text
GET /v1/events (fetch + ReadableStream)
  → typed SSE decoder
  → generation-checked, bounded store event
  → task status / approval reconciliation
  → Conversation, Inspector, Review, and cockpit projections
```

The store batches event flushes, deduplicates durable event IDs, caps retained
events per task, preserves a continuation boundary when events are dropped,
and reconnects with the last cursor using bounded backoff. Oversized payloads
are explicitly rejected in the presentation projection; they are not silently
rendered as complete content.

## Progressive disclosure

The sidebar, inspector, conversation, review pane, approvals, and cockpit
pages render only data that exists. Empty, loading, stale, unavailable, and
error states remain explicit. The composer stays available for the selected
task while it can accept work; terminal-state tasks explain that a new task is
required. Changes, inspector, and modal surfaces are opened on demand.

## Focus architecture

`useDialogFocus` is shared by modal surfaces. It moves focus into a dialog,
wraps Tab/Shift+Tab, handles Escape through the caller, and restores the
launching control. The command palette follows the same modal focus contract.
Long sidebar and diff collections combine virtualization with pending-row
mounting so keyboard focus remains stable.
