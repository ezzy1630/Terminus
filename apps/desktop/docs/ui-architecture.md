# Terminus Desktop — UI Architecture

This document describes the application routes, layout states, component
hierarchy, state management, API client architecture, SSE event
handling, progressive disclosure strategy, and responsive breakpoints
for the Terminus desktop app at `apps/desktop/`.

## 1. Application routes and layout states

The desktop app is a single-window Electron shell. There is no router
library (no React Router, no Next.js). The main surface is routed by a
plain conditional in `App.tsx` based on `selectedTaskId`:

```
selectedTaskId === null + new_task → <NewTaskScreen />
selectedTaskId === null + secondary destination → <DestinationSurface />
selectedTaskId !== null → <Conversation /> + <Composer />
selectedTaskId !== null + changesOpen → <ResizableReviewLayout />
```

Overlays that can appear above the main surface at any time:

| Overlay         | Trigger                | SPEC § |
| --------------- | ---------------------- | ------ |
| CommandPalette  | ⌘K                     | 18     |
| Settings        | ⌘,                     | 20     |
| Onboarding      | First launch (localStorage flag) | 19 |
| TerminalDrawer  | ⌘` (Layout-owned)      | 15     |

Layout states (driven by `useViewport`):

| Width        | narrowSidebar | inspectorOverlay | sidebarRail |
| ------------ | -------------- | ---------------- | ----------- |
| ≥ 1100px     | false          | false            | false       |
| 900–1099px   | true           | false            | false       |
| 700–899px    | true           | true             | false       |
| < 700px      | true           | true             | true        |

## 2. Component hierarchy

```
App
├── Layout                                  (SPEC §6 — three-region shell)
│   ├── TitleBar
│   │   ├── center slot (active task objective, when useful)
│   │   └── right slot (theme, inspector, terminal, health dot)
│   ├── Sidebar                             (SPEC §7)
│   │   ├── Workspace navigation (New task, Scheduled, Plugins, Pull requests, Chat)
│   │   ├── SidebarItem (Pinned tasks)
│   │   └── SidebarItem (Projects → Tasks, nested)
│   ├── main
│   │   ├── NewTaskScreen OR
│   │   │   Conversation + Composer
│   │   │     ├── Message (user / agent)
│   │   │     ├── ActivityBlock (collapsed/expanded)
│   │   │     ├── ApprovalCard (inline, SPEC §17)
│   │   │     └── Composer (send/steer/queue/stop)
│   │   └── ReviewPane (on demand, alongside conversation)
│   │       └── DiffViewer (patch evidence from task events)
│   └── Inspector                           (SPEC §11 — contextual sections)
│   └── LayoutTerminalDrawer
│       └── TerminalDrawer                  (SPEC §15 — tabs, search, copy, clear)
├── CommandPalette (overlay)                (SPEC §18)
├── Settings (overlay)                      (SPEC §20)
└── Onboarding (overlay, first launch)      (SPEC §19)
```

`ReviewPane` mounts when the user invokes **Show changes** (⌘D). It hides the
inspector unless the user has pinned it, so a 13-inch window retains useful
space for both the conversation and review panes. The current control-plane
event protocol has no standalone diff-artifact event; the pane only renders
files when a patch tool event carries explicit unified diff evidence. It never
fabricates a diff from file names or summaries.

## 3. State management (Zustand stores)

Three stores hold all app state. Each is created with the `zustand`
factory and persisted to `localStorage` where appropriate.

### `useThemeStore` (`hooks/use-theme.ts`)

- State: `theme: "system" | "light" | "dark"`, `density: "spacious" |
  "compact"`, `resolved: "light" | "dark"`.
- Side effects: applies CSS variables from `styles/tokens.ts` to
  `document.documentElement.style` on every setter call, and at module
  load so first paint is correct.
- Persistence key: `terminus-desktop.theme.v1`.
- Listens to `prefers-color-scheme` changes when `theme === "system"`.
- Actions: `setTheme`, `setDensity`, `toggleDensity`, `cycleTheme`,
  `refresh`.

### `useTerminusStore` (`hooks/use-terminus.ts`)

- State: `sessions`, `tasksBySession`, `taskById`, `selectedSessionId`,
  `selectedTaskId`, `pinnedTaskIds`, `draftsByTask`,
  `queuedInstructionsByTask`, `eventsByTask`
  (capped at 2000 per task), `_stream` (the live SSE stream).
- Actions: `refreshAll`, `refreshSessions`, `refreshTasks`,
  `selectSession`, `selectTask`, `togglePin`, `setDraft`, `clearDraft`,
  `queueInstruction`, `_flushQueuedInstruction`, `_attachStream`,
  `_appendEvent`, `_updateTaskFromEvent`.
- Persistence keys: `terminus-desktop.pinned-tasks.v1`.
- The `_attachStream(taskId)` action opens a `TerminusEventStream` (see
  §5) and resumes from the last-seen event id (SPEC §30.6 — durable
  cursor).
- Selection hooks: `useSelectedSessionTasks`, `usePinnedTasks`,
  `useSelectedTask`, `useSelectedTaskEvents` (each is a thin Zustand
  selector that subscribes to the relevant slice).

### `useSettingsStore` (`components/Settings.tsx`)

- State: a flat `Record<string, string | number | boolean>` of setting
  values keyed by `id` (e.g. `"appearance.theme"`,
  `"terminal.shell"`, `"editor.tab-size"`).
- Actions: `get(id, fallback)`, `set(id, value)`, `reset(id)`,
  `resetCategory(cat)`, `resetAll()`.
- Persistence key: `terminus-desktop.settings.v1`.
- The `Settings` component reads setting descriptors (id, label,
  control kind, default value, validation, restart-required) and
  renders the appropriate control. Appearance settings call into
  `useThemeStore.setTheme/setDensity` for immediate preview.

## 4. API client architecture

`lib/api.ts` exports a single `TerminusApiClient` class and a `TerminusApiError`
error envelope. A singleton `api` instance is also exported.

```
TerminusApiClient(baseUrl, token)
  ├── health()                        GET  /v1/system/health
  ├── listSessions()                  GET  /v1/sessions
  ├── createSession(input)            POST /v1/sessions
  ├── listTasks(sessionId)            GET  /v1/sessions/:id/tasks
  ├── createTask(input)               POST /v1/tasks
  ├── startTask(taskId)               POST /v1/tasks/:id/start
  ├── getTask(taskId)                 GET  /v1/tasks/:id
  ├── cancelTask(taskId, reason)      POST /v1/tasks/:id/cancel
  ├── startTurn(input)                POST /v1/turns
  ├── interruptTurn(turnId, reason)   POST /v1/turns/:id/interrupt
  ├── resolveApproval(id, decision)   POST /v1/approvals/:id/resolve
  └── buildHeaders(extra)             (public; used by the SSE stream)
```

Every non-2xx response raises a `TerminusApiError(status, message,
envelope)`. The envelope mirrors SPEC §30.4:

```ts
{
  code: string;
  message: string;
  retryable: boolean;
  category: string;            // "auth" | "not_found" | "validation" | "internal" | ...
  details?: Record<string, unknown>;
  suggested_action?: string | null;
  trace_id?: string | null;
}
```

Network errors (connection refused, DNS failure, CORS) surface as
`TerminusApiError(status=0, "network error: …", null)`. This makes them
distinguishable from 5xx responses without a separate error class.

The client resolves `baseUrl` and `token` in this order:

1. `window.terminusDesktop.apiBase` / `.token` (Electron preload bridge).
2. `import.meta.env.VITE_TERMINUS_API_BASE` / `VITE_TERMINUS_TOKEN` (Vite env).
3. Hard-coded defaults: `http://127.0.0.1:3050` and
   `terminus-control-dev-token`.

## 5. SSE event handling

The control plane's `/v1/events` endpoint requires bearer auth, which
the browser's native `EventSource` cannot send. We therefore use
`fetch` + a `ReadableStream` reader + the SSE decoder from
`@terminus/public-api` (`createSseDecoder`), and surface an
`EventSource`-like object via `subscribeEvents(opts)`:

```ts
const stream = subscribeEvents({ task_id: "task-1", cursor: lastEventId });
stream.addEventListener("message", (ev) => { … });
stream.addEventListener("open",  () => { … });
stream.addEventListener("error", () => { … });
stream.close();
```

Event flow:

```
/v1/events (HTTP/1.1 chunked, text/event-stream)
  ↓ fetch + ReadableStream reader
createSseDecoder().feed(chunk)  → TerminusSseEvent[] { id, event, data }
  ↓ FetchEventStream.emit("message", ev)
useTerminusStore._appendEvent(taskId, ev)
  ↓
useTerminusStore._updateTaskFromEvent(ev)   (updates task status/phase)
  ↓
Conversation (useSelectedTaskEvents → decodes events into messages + blocks)
Inspector   (useSelectedTaskEvents → renders Activity + Approvals sections)
```

Heartbeat comments (`:heartbeat`) are filtered out by the decoder and
never reach the store.

Reconnection (SPEC §30.6): `_attachStream(taskId)` resumes from the
last-seen event id and retries unexpected drops with bounded exponential
backoff. Stream generations and task ids prevent stale retries from attaching
after the user switches tasks.

## 6. Progressive disclosure strategy

Per SPEC §11: "The inspector must not be a fixed list of empty
sections. Sections appear only after relevant information exists."

The same principle is applied throughout:

| Surface           | Empty state                                  | Progressive reveal |
| ----------------- | -------------------------------------------- | ------------------ |
| Sidebar           | "No projects yet." (search-aware)            | Navigation remains available; Pinned appears only when ≥ 1 task is pinned |
| Inspector         | "No task selected" placeholder               | Environment (always), Changes (patch evidence), Subagents (agent events), Verification (verification events), Approvals (pending approval events) |
| Conversation      | (placeholder before first event)             | Messages + ActivityBlocks emerge as the agent emits events |
| TerminalDrawer    | `EmptyState` ("No terminal session")         | Tabs appear as the user opens terminals |
| DiffViewer        | `EmptyState` ("No changes yet")              | File list collapses/expands per file; hunk actions appear on hover |
| CommandPalette    | `<>` when closed                             | Renders only when `open=true`; closes to nothing |
| ApprovalCard      | (no card until approval arrives)             | Card collapses to one-line summary after resolve |

The composer is the exception: it is always visible while a task is
selected (SPEC §10: "The composer remains fully available while work
is running"). Its contextual controls (Branch/worktree, Computer use,
Queue behavior) are hidden inside a compact "More" dropdown to keep
the always-visible row stable.

## 7. Responsive breakpoints

Defined in `hooks/use-viewport.ts`:

| Breakpoint | Trigger        | Effect |
| ---------- | -------------- | ------ |
| 1100px     | narrowSidebar | Sidebar switches from `--sidebar-width` (260px spacious / 230px compact) to `--sidebar-width-compact` (220px / 190px) |
| 900px      | inspectorOverlay | Inspector stops reserving reading width and becomes a dismissible floating overlay |
| 700px      | sidebarRail   | Sidebar collapses to a 56px icon rail; the full `Sidebar` component re-renders in `compact` mode (icons only, no labels) |

The viewport hook debounces resize via `requestAnimationFrame` so
layout thrash during drag-resize is avoided. The Layout shell applies
a CSS transition (`width var(--duration-fast) var(--easing-default)`)
so the sidebar narrows smoothly rather than jumping.

## 8. Module graph (build-time)

The Vite build keeps the initial shell separate from task-heavy and secondary
surfaces:

```
index.html
  └── main.tsx
       ├── App.tsx
       │    ├── Layout, Sidebar, Composer, NewTaskScreen, CommandPalette
       │    ├── Conversation, Inspector (lazy task surfaces)
       │    ├── Settings, Onboarding, ReviewPane (lazy secondary surfaces)
       │    ├── useTerminusStore, useThemeStore
       │    └── lib/api.ts (singleton)
       ├── styles/globals.css
       └── styles/tokens.ts (applied at first paint by use-theme.ts)
```

See `docs/ui-performance.md` for current raw/gzip measurements and the
remaining production-trace gates.
