# Terminus Desktop — UI Performance Report

This report records reproducible production-build evidence and distinguishes
implemented safeguards from targets that still require measurement. It is the
authoritative performance report for the desktop UI.

## Current production build

Measured on 2026-07-12 with:

```bash
cd apps/desktop
bun run build:electron
```

| Artifact | Raw | Gzip |
| --- | ---: | ---: |
| Initial application JavaScript | 488.66 kB | 143.83 kB |
| Application CSS | 27.58 kB | 6.35 kB |
| Deferred ReviewPane | 30.23 kB | 8.21 kB |
| Deferred Settings | 26.44 kB | 7.93 kB |
| Deferred Onboarding | 14.47 kB | 4.31 kB |
| xterm runtime chunk | 332.63 kB | 83.87 kB |

The shell, review surface, settings, onboarding, and xterm runtime are emitted
as separate chunks. Review, settings, and onboarding mount only when opened.

## Implemented safeguards

- Conversation rows use `@tanstack/react-virtual` with dynamic measurement and
  bounded overscan.
- Project/task lists virtualize large collections.
- Event histories are bounded per task and keyed by durable event IDs.
- Task streaming is SSE-driven. There is no constant reconciliation poll;
  sessions refresh when the window regains focus.
- Dropped task streams reconnect from the last event ID with bounded
  exponential backoff.
- Hidden computer-use previews pause their media element.
- Composer object URLs are revoked on removal and unmount.
- Review, Settings, and Onboarding are lazy-loaded.
- The review split and terminal drawer persist only small numeric preferences.
- Motion is disabled through `prefers-reduced-motion` without runtime loops.

## Targets requiring measured evidence

The following remain **unverified**, not “Met”:

| Target | Current evidence needed |
| --- | --- |
| Idle CPU effectively near zero | Packaged-app Activity Monitor or Instruments trace |
| Command palette opens within roughly 100 ms | Production interaction trace with repeated samples |
| Smooth thousand-event conversation | Recorded production trace using a deterministic fixture |
| Large diff remains interactive | Fixture above 2,000 changed lines plus frame/interaction timing |
| No memory growth across repeated surface cycles | Heap snapshots before/after a scripted open-close loop |
| Hidden terminal/PiP perform no expensive rendering | CPU profile while hidden |
| Smooth resize on the target MacBook | Packaged-app frame trace at 13-inch target dimensions |
| Controlled shell-only memory | Packaged-app baseline measurement |

Large-diff virtualization and an automated performance-regression harness are
still required before the full performance completion gate can pass.

## Reproduction

```bash
cd apps/desktop
bun run build:electron
bun run preview
```

Use the production renderer rather than Vite development mode for timing,
memory, CPU, and bundle measurements. Record the machine model, macOS version,
viewport, fixture size, and sampling method with every result.
