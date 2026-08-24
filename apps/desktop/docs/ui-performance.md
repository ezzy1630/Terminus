# Terminus Desktop — UI Performance

This document records the performance shape and the checks still required.
It does not claim a benchmark result that has not been run against the fresh
renderer or packaged app.

## Current architecture

- The initial shell keeps Layout, Sidebar, Composer, NewTaskScreen, the command
  catalog, theme, and API wiring available immediately. The Command Palette
  view itself loads only when opened.
- Conversation, Inspector, Settings, Onboarding, ReviewPane, and cockpit
  destinations are loaded behind `React.lazy` boundaries.
- Conversation rows and long task lists use `@tanstack/react-virtual` with
  measured row heights and bounded overscan. Diff rows are virtualized too;
  hunk/change navigation scrolls through the virtualizer rather than mounting
  the entire file.
- SSE event flushes are batched, durable event IDs are deduplicated, and each
  task retains a bounded event window with an explicit continuation boundary.
- Session, task, and approval pages are fetched one page at a time. Load-more
  is explicit, and refresh generations prevent stale page responses from
  merging into a newer snapshot.
- Sidebar and diff keyboard focus mount the requested virtual row before
  focusing it. Resize work is coalesced with `requestAnimationFrame`.
- Computer-use surfaces are static availability/lease boundaries. The desktop
  shell does not capture local media, create preview object URLs, or render a
  hidden media stream.
- Vite assigns stable functional chunk groups for React, validation, icons,
  virtualization, dates, and state. Dependencies outside those groups stay
  with their owning graph instead of being forced into an eager catch-all
  vendor chunk. Destination views remain lazy.

## Build-size check

Generate a production renderer before measuring:

```bash
bun run --cwd apps/desktop build
du -ah apps/desktop/dist | sort -h | tail -n 20
```

Record raw and compressed sizes from that exact build, along with source
revision and machine. The Vite chunk warning is an optimization signal, not a
passed performance gate.

The August 23 working-tree renderer build emits a 349.64 kB raw / 105.55 kB
gzip entry chunk and a 54.82 kB raw / 10.89 kB gzip stylesheet. Mission Board
remains lazy at 24.78 kB raw / 7.47 kB gzip, and the Command Palette is a
6.69 kB raw / 2.91 kB gzip lazy chunk. Vite emitted neither an oversized-chunk
warning nor a circular-chunk warning. These figures are Vite's production-build
output, not packaged-ASAR, interaction-latency, or release evidence.

## Required measurements

These gates remain unverified until measured on the fresh packaged artifact:

| Surface | Evidence |
| --- | --- |
| Idle shell | Activity Monitor or Instruments sample with no active stream |
| Palette | Repeated open-to-first-paint timing |
| Long conversation | Deterministic fixture with at least 1,000 events and scroll/frame timings |
| Large diff | Fixture above 2,000 changed lines with navigation timing |
| Sidebar pagination | Refresh/load-more race fixture and interaction timing |
| Resize | Frame trace at narrow and wide window sizes |
| Memory | Heap snapshots across repeated open/close of review, Settings, and cockpit views |
| Accessibility motion | Reduced-motion packaged-app check with no continuous repaint |

An optimization is complete only when its before/after measurement and fixture
are recorded. Do not turn a development-renderer observation into release
evidence.

## Reproduction baseline

```bash
bun run --cwd apps/desktop build:electron
bun run --cwd apps/desktop lint
bun run --cwd apps/desktop test
bun run --cwd apps/desktop package:dir
```

Launch the exact `.app` from `apps/desktop/release/` for runtime measurements.
Keep the local control plane and kernel state explicit; an offline or empty
resource is a valid state and must not be replaced with synthetic data merely
to make a benchmark look active.
