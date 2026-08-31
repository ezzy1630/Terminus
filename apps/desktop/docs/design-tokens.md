# Terminus Desktop design tokens

`src/styles/theme.css` is the source of truth. It is loaded before Tailwind in
`globals.css`, so the renderer has a complete first-paint theme without waiting
for JavaScript. `useThemeStore` only selects `data-theme` and `data-density`.

## Scales

- Interface type: 11, 12, 13, and 14px. Display type: 20 and 28px. Each token
  has a paired line height. Metrics use tabular numerals.
- Spacing: a 4px grid.
- Controls: 24, 28, and 32px.
- Icons: 12, 14, and 16px.
- Radii: 5, 6, 8, and 10px, plus fully round.
- Elevation: three levels mapped to Tailwind's `shadow-sm`, `shadow-md`, and
  `shadow-lg` utilities.
- Motion: 120, 180, and 260ms with standard and emphasized easings. Active
  progress uses a 1s transform-only ring; loading skeletons use a
  transform-only sweep.
- Layers: base, sticky, popover, dialog, and toast.

Compact density is the desktop default. It uses 28px navigation rows, a 224px
default sidebar, and tighter spacing while preserving the same control and
type hierarchy.

## Color and identity

The shell uses cold graphite in dark mode and neutral gray-white in light mode.
Muted blue `#88a9d8` (dark) / `#356fd6` (light) is reserved for primary action and
focus. Other color communicates diffs, status, or warnings; it is never decoration.

Technical surfaces use `--bg-terminal`, `--bg-diff`, and `--text-code`. The
light theme keeps these surfaces dark with a light code foreground, so terminal
content remains readable. Additions, deletions, warnings, errors, and success
retain separate semantic colors.

Semantic CSS variables are mapped into Tailwind v4 through `@theme inline`.
Components should use semantic utilities such as `bg-canvas`, `bg-card`,
`text-primary`, and `border-default`. Do not redeclare Tailwind utility names in
plain CSS, add arbitrary color values in JSX, or install tokens at runtime.

## Interaction

Focus uses one `outline` and inherits each control's own radius. Scrollable
panes use stable thin scrollbars. Progress rings rotate only while work is
active and skeletons sweep only while their loading rows are mounted. Both
animate `transform` only. Finite entrance transitions use the motion scale.
All motion stops under `prefers-reduced-motion` or the app's Reduce Motion
setting.

The Electron window is opaque. The sidebar, canvas, terminal, diff, composer,
and inspector use explicit surfaces; there is no vibrancy layer to paint over.
