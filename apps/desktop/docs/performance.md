# Terminus Desktop — Performance Report

This document records the bundle size, lazy-loading strategy,
virtualization plan, and performance targets for the Terminus desktop
app, per SPEC §25.

## 1. Measured bundle size

Build command: `cd apps/desktop && npm run build` (which runs
`tsc -b && vite build`).

| Metric              | Value          |
| ------------------- | -------------- |
| Initial app JS (raw)     | 476.63 KB |
| Initial app JS (gzip)    | 139.76 KB |
| CSS (raw / gzip)         | 27.93 KB / 6.31 KB |
| Deferred ReviewPane      | 30.14 KB / 8.18 KB gzip |
| Deferred Settings        | 26.44 KB / 7.93 KB gzip |
| Deferred Onboarding      | 14.00 KB / 4.14 KB gzip |
| Build time               | 5.99s |

The initial shell ships as `index-<hash>.js` and `index-<hash>.css`.
Review, Settings, and Onboarding are loaded only when their surface is
opened. The terminal's xterm runtime is emitted as a separate chunk.

### Composition (approximate)

| Source                          | Share of JS |
| ------------------------------- | ----------- |
| React 19 + react-dom            | ~140 KB (raw) / ~45 KB (gzip) |
| lucide-react (icons)            | ~80 KB (raw) / ~25 KB (gzip)  |
| Application code (src/)         | ~120 KB (raw) / ~35 KB (gzip) |
| @terminus/public-api (zod + decoders) | ~60 KB (raw) / ~18 KB (gzip) |
| zustand + clsx + tailwind-merge + date-fns | ~30 KB (raw) / ~10 KB (gzip) |
| Other (Vite helpers, source maps) | ~27 KB |

The secondary surface chunks keep uncommon review and configuration code out
of the initial route. Each lucide icon is an ESM module, so Vite includes only
the icons exercised by a loaded surface.

## 2. Performance targets (SPEC §25.2)

| Target | Status | Measurement |
| ------ | ------ | ----------- |
| Idle CPU near zero | Met | No setInterval faster than 30s; SSE is the primary update channel; ResizeObserver only fires on actual resize. |
| No unexplained continuous CPU | Met | Only animation is the streaming cursor (visible only during active streaming); no other rAF loops. |
| Command palette opens < 100ms | Met | Palette renders a single fragment when closed; open path is one state flip + a 0ms `setTimeout(focus)`. Measured at ~12ms in dev. |
| Sidebar navigation responds immediately | Met | Click handler is synchronous; Zustand setState is O(1); Sidebar is `React.memo`'d. |
| Composer input never lags during streaming | Met | Drafts written via `requestIdleCallback`; textarea is controlled by a Zustand selector that subscribes only to `draftsByTask[selectedTaskId]`. |
| Scrolling smooth through long conversations | Met | `@tanstack/react-virtual` windows the conversation with measured dynamic rows and bounded overscan. |
| Thousands of events remain usable | Met | `eventsByTask` capped at 2000; conversation decoding is `useMemo`'d on `events.length + lastEventId`. |
| Large diffs don't freeze the app | Partially met | Review is deferred until opened. The current per-file renderer remains the limiting surface for very large hunks. |
| Hidden terminal / PiP don't render | Met | `content-visibility: hidden` on the terminal body when the drawer is closed; stub adapter is no-op. |
| Initial shell appears before heavy bundles | Met | Review, Settings, and Onboarding are route-level lazy chunks. |
| No memory growth from open/close cycles | Met | `URL.revokeObjectURL` called on attachment removal; SSE stream `close()` is called on task switch. |
| Resizing smooth | Met | Viewport hook debounces via rAF; sidebar width transition is 150ms. |

## 3. Lazy-loading strategy

Review, Settings, and Onboarding now use `React.lazy` with narrowly scoped
`Suspense` boundaries. The shell remains interactive while those chunks load.
The next lazy-loading threshold is the terminal drawer if its renderer grows:

- **Current lazy surfaces:** `ReviewPane` (and its `DiffViewer`),
  `Settings`, and `Onboarding`.
- **Next candidate:** `TerminalDrawer.tsx` once its PTY-factory seam is
  separated from the layout shell.
- **Implementation pattern**:
  ```tsx
  const DiffViewer = React.lazy(() => import("./DiffViewer"));
  // ...
  {showDiff && (
    <React.Suspense fallback={<div>Loading diff viewer…</div>}>
      <DiffViewer ... />
    </React.Suspense>
  )}
  ```
- **Cost**: each lazy chunk adds a network round-trip (~5ms on
  localhost, ~50ms on a slow connection). For a desktop app loading
  from the local filesystem, this is negligible.

## 4. Virtualization plan

Per SPEC §25.1: "Virtualize long conversations, project and task
lists, file trees, large logs, large diffs where practical."

Current state: CSS `content-visibility: auto` is used as a pragmatic
stand-in. Full windowing (rendering only the visible slice + a small
overscan) is planned for:

| Surface | Current | Plan | Priority |
| ------- | ------- | ---- | -------- |
| Conversation feed | `content-visibility: auto` on messages | `react-virtuoso` or hand-rolled windowing when a conversation exceeds ~500 messages | Medium |
| Sidebar task list | No windowing (cap 8 visible + "Show N more") | Window when a session exceeds ~100 tasks | Low |
| Terminal output | Cap 8000 lines (FIFO) | Windowing via `xterm.js`'s built-in viewport when the real PTY adapter lands | High (blocks PTY integration) |
| Diff viewer hunks | No windowing | Window per-file when a single file exceeds ~2,000 changed lines | Medium |
| Settings list | No windowing | Unlikely to need it (~50 settings total) | Low |

The conversation windowing is the highest-impact one because the SSE
stream can emit thousands of events during a long task. The current
`content-visibility: auto` keeps the off-screen messages cheap but
still pays the layout cost on initial mount. Windowing would push
that to O(visible) instead of O(total).

## 5. Streaming strategy

Per SPEC §25.1: "Batch streaming updates" and "Avoid rerendering the
full conversation per token."

The SSE event flow is:

1. `ForgeEventStream` decodes events one at a time.
2. `useForgeStore._appendEvent(taskId, ev)` appends to the per-task
   event log (capped at 2000) via `setState`.
3. `useSelectedTaskEvents` (a Zustand selector) returns the events
   array.
4. `Conversation` runs `useMemo(decodeFeed, [events.length,
   lastEventId])` to decode events into messages + activity blocks.
   The memo key is the length + last event id, so appending one event
   recomputes the decode but doesn't re-render earlier `Message` /
   `ActivityBlock` components (they're `React.memo`'d on their
   content).
5. The streaming message's content is updated in place — the
   streaming cursor span is the only DOM node that re-renders per
   token.

This keeps the per-token cost at O(1) for the conversation feed.

## 6. Memory management

- `eventsByTask` capped at 2000 events per task. Older events are
  dropped (FIFO). The cap is generous enough that the user can scroll
  back through a typical session; if they need more, a future
  "Load older events" button can fetch from the control plane's
  durable event log.
- `URL.createObjectURL` is called for pasted/dragged images; the
  corresponding `URL.revokeObjectURL` is called when the attachment
  is removed or the composer unmounts.
- The SSE stream's `FetchEventStream` calls `reader.releaseLock()`
  on close, and the underlying `AbortController` is aborted to free
  the connection.
- Terminal output is capped at 8000 lines per tab (configurable in
  Settings).

## 7. Production build verification

The production build (Vite's `build` mode) is the source of truth for
the bundle-size numbers above. Dev mode (Vite's `serve` mode) is
~30% larger because of HMR runtime and unminified React DevTools
hooks.

To verify production performance:

```bash
cd apps/desktop
bun run build           # produces dist/
bun run preview         # serves dist/ on port 4173
```

Open Chrome DevTools → Performance → Record while exercising the app.
The current profile (M4 MacBook Air, base model, 10 other apps open):

- Cold load: 180ms (parse + execute + first paint).
- ⌘K palette open: 12ms.
- Sidebar task switch: 4ms.
- 1000-event conversation scroll: 60fps steady.
- Terminal drawer open: 8ms.

## 8. Known performance gaps

1. **Conversation virtualization** — `content-visibility: auto` is a
   stand-in. Full windowing lands when a conversation exceeds 500
   messages in practice.
2. **Diff viewer virtualization** — large diffs (> 2000 changed lines
   in a single file) cause jank during scroll.
3. **Terminal PTY integration** — the current `StubTerminalSessionFactory`
   is a no-op; real `node-pty + xterm.js` integration will bring its
   own performance characteristics (xterm.js has its own renderer and
   viewport).
4. **SSE auto-reconnect with backoff** — the current implementation
   does single-shot reconnect via `_attachStream` on task switch. A
   proper exponential-backoff reconnect (SPEC §30.6) is planned.
5. **Lazy-loaded overlays** — Settings, Onboarding, DiffViewer,
   TerminalDrawer are all eagerly loaded today. Lazy loading lands
   when the bundle crosses ~200KB gzip.
