# Terminus Desktop — Design Tokens

This document describes the color, typography, spacing/density, motion,
and surface-language tokens used by the Terminus desktop app. Tokens are
defined in `apps/desktop/src/styles/tokens.ts` and applied to
`document.documentElement` at module load by
`apps/desktop/src/hooks/use-theme.ts`.

Per SPEC §4: "Use a near-monochrome interface." Color is reserved for
meaning (Git additions/deletions, errors, warnings, approval risk,
agent state, selected state, primary action, success).

## 1. Color tokens

### Dark theme (`darkTokens`)

| Token                  | Value      | Purpose |
| ---------------------- | ---------- | ------- |
| `--bg-canvas`          | `#1a1a1c`  | Main canvas — neutral Codex-like charcoal |
| `--bg-elevated`        | `#222224`  | Elevated surfaces (cards, dropdowns) |
| `--bg-sidebar`         | `#1e1e20`  | Sidebar — native macOS material (simulated) |
| `--bg-inspector`       | `#2a2a2c`  | Floating inspector card |
| `--bg-terminal`        | `#161618`  | Terminal and diff surfaces (cooler, darker) |
| `--bg-diff`            | `#161618`  | Diff background (matches terminal) |
| `--bg-composer`        | `#262628`  | Composer input surface |
| `--bg-hover`           | `#2e2e30`  | Hover state for rows, buttons |
| `--bg-selected`        | `#2a2a2e`  | Selected row (no bright saturated background per SPEC §7.2) |
| `--text-primary`       | `#e8e8ea`  | Primary text |
| `--text-secondary`     | `#99999e`  | Secondary text |
| `--text-tertiary`      | `#6a6a6e`  | Tertiary / muted text |
| `--text-inverse`       | `#1a1a1c`  | Text on saturated backgrounds (e.g. primary button) |
| `--border-subtle`      | `#2e2e30`  | Subtle separators |
| `--border-default`     | `#38383a`  | Default borders |
| `--border-strong`      | `#48484a`  | Strong borders (focus-within on composer, etc.) |
| `--color-success`      | `#3fb950`  | Success states, additions, "done" status |
| `--color-error`        | `#f85149`  | Errors, deletions, "failed" status, deny actions |
| `--color-warning`      | `#d29922`  | Warnings, approval risk (high), "waiting" status |
| `--color-info`         | `#58a6ff`  | Info, "needs_review" status |
| `--color-addition`     | `#3fb950`  | Diff additions (alias of success) |
| `--color-deletion`     | `#f85149`  | Diff deletions (alias of error) |
| `--color-primary`      | `#58a6ff`  | Primary actions, "working" status |
| `--color-approval-risk`| `#d29922`  | Approval risk accent |
| `--color-agent-working`| `#58a6ff`  | Spinner accent for active tasks |
| `--color-agent-queued` | `#6a6a6e`  | Queued task indicator |
| `--color-agent-waiting`| `#d29922`  | Waiting task indicator |
| `--focus-ring`         | `0 0 0 2px #58a6ff40` | Focus-visible outline |
| `--shadow-sm`          | `0 1px 3px rgba(0,0,0,0.3)` | Subtle elevation |
| `--shadow-md`          | `0 4px 12px rgba(0,0,0,0.4)` | Dropdowns, inspector |
| `--shadow-lg`          | `0 8px 24px rgba(0,0,0,0.5)` | Overlay surfaces (command palette, settings) |

### Light theme (`lightTokens`)

| Token                  | Value      |
| ---------------------- | ---------- |
| `--bg-canvas`          | `#f7f7f8`  |
| `--bg-elevated`        | `#ffffff`  |
| `--bg-sidebar`         | `#f0f0f2`  |
| `--bg-inspector`       | `#ffffff`  |
| `--bg-terminal`        | `#1a1a1c`  (stays dark for terminal contrast) |
| `--bg-diff`            | `#ffffff`  |
| `--bg-composer`        | `#ffffff`  |
| `--bg-hover`           | `#ececee`  |
| `--bg-selected`        | `#e4e4e8`  |
| `--text-primary`       | `#1a1a1c`  |
| `--text-secondary`     | `#5a5a5e`  |
| `--text-tertiary`      | `#8a8a8e`  |
| `--text-inverse`       | `#ffffff`  |
| `--border-subtle`      | `#e4e4e6`  |
| `--border-default`     | `#d4d4d6`  |
| `--border-strong`      | `#a4a4a6`  |
| `--color-success`      | `#1a7f37`  |
| `--color-error`        | `#cf222e`  |
| `--color-warning`      | `#9a6700`  |
| `--color-info`         | `#0969da`  |
| `--color-primary`      | `#0969da`  |
| `--focus-ring`         | `0 0 0 2px #0969da30` |

Light theme uses softer, GitHub-light-inspired hues. The terminal
background stays dark in both themes for readability — this matches
the convention of every modern terminal and keeps syntax-highlight
colors consistent.

## 2. Typography scale

Per SPEC §21: SF Pro system font stack for interface text, SF Mono for
code and technical metadata.

| Token                  | Value |
| ---------------------- | ----- |
| `--font-family`        | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif` |
| `--font-family-mono`   | `"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace` |
| `--font-size-xs`       | `11px` |
| `--font-size-sm`       | `12px` |
| `--font-size-base`     | `13px` |
| `--font-size-md`       | `14px` |
| `--font-size-lg`       | `16px` |
| `--font-size-xl`       | `18px` |
| `--font-size-2xl`      | `22px` |
| `--font-size-3xl`      | `28px` |
| `--line-height-tight`  | `1.25` |
| `--line-height-normal` | `1.5`  |
| `--line-height-relaxed`| `1.7`  |

Font weights (constants, not CSS vars):
- regular: `400`
- medium: `500`
- semibold: `600`

Body text uses `--font-size-base` (13px) with `--line-height-normal`
(1.5). Headings are restrained: page titles use `--font-size-md` (14px)
at weight 600; nothing in the app uses `--font-size-3xl` outside the
onboarding welcome screen.

## 3. Spacing / density tokens

Per SPEC §24: spacious mode is the default; compact mode reduces
vertical padding for power users on smaller displays.

### Spacious (default)

| Token                  | Value |
| ---------------------- | ----- |
| `--space-0`            | `0px` |
| `--space-1`            | `4px` |
| `--space-2`            | `8px` |
| `--space-3`            | `12px` |
| `--space-4`            | `16px` |
| `--space-5`            | `20px` |
| `--space-6`            | `24px` |
| `--space-8`            | `32px` |
| `--space-10`           | `40px` |
| `--space-12`           | `48px` |
| `--sidebar-width`      | `260px` |
| `--sidebar-width-compact` | `200px` |
| `--inspector-width`    | `340px` |
| `--composer-max-height`| `280px` |
| `--conversation-max-width` | `720px` |
| `--row-height`         | `36px` |
| `--radius-sm`          | `6px` |
| `--radius-md`          | `10px` |
| `--radius-lg`          | `14px` |

### Compact

| Token                  | Value |
| ---------------------- | ----- |
| `--space-1`            | `3px` |
| `--space-2`            | `6px` |
| `--space-3`            | `9px` |
| `--space-4`            | `12px` |
| `--space-5`            | `15px` |
| `--space-6`            | `18px` |
| `--space-8`            | `24px` |
| `--space-10`           | `30px` |
| `--space-12`           | `36px` |
| `--sidebar-width`      | `220px` |
| `--sidebar-width-compact` | `180px` |
| `--inspector-width`    | `300px` |
| `--composer-max-height`| `220px` |
| `--conversation-max-width` | `680px` |
| `--row-height`         | `28px` |
| `--radius-sm`          | `5px` |
| `--radius-md`          | `8px` |
| `--radius-lg`          | `12px` |

Density changes apply immediately (no restart required) via
`useThemeStore.setDensity()`. The `dataset.density` attribute on
`<html>` is also set so CSS can target density-specific overrides if
needed.

## 4. Motion tokens

Per SPEC §22: "Use restrained Apple-like motion by default." No
springs except for the easing-spring token (reserved for hero
transitions; not used in the primary slice).

| Token                  | Value |
| ---------------------- | ----- |
| `--duration-fast`      | `150ms` |
| `--duration-normal`    | `250ms` |
| `--duration-slow`      | `400ms` |
| `--easing-default`     | `cubic-bezier(0.25, 0.1, 0.25, 1)` |
| `--easing-spring`      | `cubic-bezier(0.34, 1.56, 0.64, 1)` |

Reduced motion (SPEC §22: "Respect Reduce Motion"):

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

This is wired in `globals.css` and applies to every transition /
animation in the app.

The streaming cursor (the pulse block on a streaming agent message)
is the only continuous animation; it respects `prefers-reduced-motion`
via the global rule.

## 5. Surface language

Per SPEC §4.2, three surface styles are combined:

### Codex softness

Used for: shell, sidebar, composer.

- Soft borders, subtle shadows.
- Backgrounds: `--bg-canvas`, `--bg-sidebar`, `--bg-composer`.
- Borders: `--border-subtle` (1px).
- Padding: generous (`--space-4` to `--space-6`).
- Border radius: `--radius-md` to `--radius-lg`.
- Hover transitions: `background var(--duration-fast) var(--easing-default)`.

### Cursor precision

Used for: diff viewer, terminal, tables.

- Tighter rows, monospace text.
- Backgrounds: `--bg-terminal`, `--bg-diff` (cooler, darker).
- Borders: `--border-default` (1px) for separators; `--border-strong`
  for active focus.
- Padding: tight (`--space-1` to `--space-2`).
- Border radius: `--radius-sm` (5–6px).
- Color use: diff sigils use `--color-addition` and `--color-deletion`
  backgrounds with 12% opacity via `color-mix(in srgb, ... 12%,
  transparent)`.
- The `.diff-line`, `.diff-add`, `.diff-del`, `.diff-context`, and
  `.diff-hunk-header` helpers live in `globals.css`.

### Native macOS material

Used for: title bar, sidebar background, popovers.

- The Electron main process enables `vibrancy: "under-window"` and
  `visualEffectState: "active"` for native macOS vibrancy.
- The title bar uses `WebkitAppRegion: "drag"` so the whole bar is
  draggable; controls opt out with `WebkitAppRegion: "no-drag"`.
- The sidebar background uses `--bg-sidebar` to simulate the vibrancy
  in plain Vite dev mode (Electron's vibrancy takes over in
  production).
- Popovers (command palette, settings) use `backdrop-filter: blur(2px)`
  with `background: rgba(0, 0, 0, 0.35)` on the backdrop and
  `--bg-elevated` on the popover card.

The three styles are visually distinguishable but share the same color
tokens (only the surface, padding, radius, and font choices differ).
This keeps the app coherent while still letting technical surfaces
feel appropriately dense.
