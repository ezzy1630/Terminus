/**
 * Terminus Desktop — Design Tokens.
 *
 * Per SPEC §4: "Use a near-monochrome interface." Color is reserved for
 * meaning (Git additions/deletions, errors, warnings, approval risk, agent
 * state, selected state, primary action, success).
 *
 * Per SPEC §4.2: Three surface styles — Codex softness (shell/sidebar/
 * composer), Cursor precision (diff/terminal/tables), native macOS material
 * (title bar/sidebar background/popovers).
 *
 * Per SPEC §21: "SF Pro system font stack for interface text, SF Mono for
 * code and technical metadata."
 *
 * Per SPEC §24: "Support System theme, Light theme, Dark theme, Spacious
 * density, Compact density."
 *
 * Codex reference alignment:
 *   - Warmer charcoal canvas (#1e1e1e range)
 *   - Sidebar darker than canvas (sidebar as grounding surface)
 *   - Distinct card elevation for starter cards
 *   - Green "Full access" accent
 *   - Warm orange text accent for branding
 */

// ────────────────────────── Color tokens ───────────────────────────────────

export const darkTokens = {
  // Main canvas — warm Codex-like charcoal
  "--bg-canvas": "#171717",
  // Elevated surfaces — noticeably distinct from canvas
  "--bg-elevated": "#232323",
  // Sidebar — darker than canvas (Codex pattern: sidebar grounds the layout)
  "--bg-sidebar": "#292929",
  // Inspector — floating card surface
  "--bg-inspector": "#242424",
  // Terminal and diff — slightly cooler and darker
  "--bg-terminal": "#141416",
  "--bg-diff": "#141416",
  // Composer surface
  "--bg-composer": "#2c2c2c",
  // Starter cards — distinct from canvas
  "--bg-card": "#1b1b1b",
  // Hover — subtle lift
  "--bg-hover": "#383838",
  // Nav row hover — slightly warmer
  "--bg-nav-hover": "#343434",
  // Selected (no bright saturated background)
  "--bg-selected": "#343434",

  // Text
  "--text-primary": "#ececed",
  "--text-secondary": "#b5b5b7",
  "--text-tertiary": "#828287",
  "--text-placeholder": "#949499",
  "--text-inverse": "#1a1a1c",
  // Warm accent for branding (Codex uses an orange-tinted icon)
  "--text-accent": "#e8845e",

  // Separators
  "--border-subtle": "#303032",
  "--border-default": "#404043",
  "--border-strong": "#4a4a4e",
  // Sidebar-specific separator
  "--sidebar-separator": "#363638",

  // Semantic colors (color is reserved for meaning)
  "--color-success": "#3fb950",
  "--color-error": "#f85149",
  "--color-warning": "#d29922",
  "--color-info": "#58a6ff",
  "--color-addition": "#3fb950",
  "--color-deletion": "#f85149",
  "--color-primary": "#80aefb",
  "--color-approval-risk": "#d29922",
  "--color-agent-working": "#58a6ff",
  "--color-agent-queued": "#6a6a6e",
  "--color-agent-waiting": "#d29922",
  // Access level — green for full/trusted access (Codex pattern)
  "--color-access-full": "#3fb950",
  "--color-access-limited": "#d29922",

  // Focus
  "--focus-ring": "0 0 0 2px #80aefb44",

  // Shadows — refined for warm theme
  "--shadow-sm": "0 1px 3px rgba(0,0,0,0.28)",
  "--shadow-md": "0 8px 24px rgba(0,0,0,0.34), 0 1px 1px rgba(255,255,255,0.03) inset",
  "--shadow-lg": "0 18px 48px rgba(0,0,0,0.52), 0 1px 1px rgba(255,255,255,0.04) inset",
  // Card-specific shadow (starter cards)
  "--shadow-card": "0 2px 6px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.025)",
  "--shadow-card-hover": "0 4px 8px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.05)",
} as const;

export const lightTokens = {
  // Main canvas — soft neutral
  "--bg-canvas": "#f6f6f7",
  // Elevated surfaces
  "--bg-elevated": "#ffffff",
  // Sidebar — slightly cooler than canvas
  "--bg-sidebar": "#ededf0",
  // Inspector
  "--bg-inspector": "#ffffff",
  // Terminal and diff
  "--bg-terminal": "#1a1a1c",
  "--bg-diff": "#ffffff",
  // Composer
  "--bg-composer": "#ffffff",
  // Starter cards
  "--bg-card": "#ffffff",
  // Hover
  "--bg-hover": "#e6e6ea",
  // Nav hover
  "--bg-nav-hover": "#e9e9ed",
  // Selected
  "--bg-selected": "#e0e0e5",

  // Text
  "--text-primary": "#1a1a1c",
  "--text-secondary": "#5a5a5e",
  "--text-tertiary": "#707075",
  "--text-placeholder": "#68686d",
  "--text-inverse": "#ffffff",
  // Warm accent
  "--text-accent": "#c96a3e",

  // Separators
  "--border-subtle": "#e2e2e5",
  "--border-default": "#d2d2d5",
  "--border-strong": "#a4a4a6",
  // Sidebar separator
  "--sidebar-separator": "#dcdce0",

  // Semantic colors
  "--color-success": "#1a7f37",
  "--color-error": "#cf222e",
  "--color-warning": "#9a6700",
  "--color-info": "#0969da",
  "--color-addition": "#1a7f37",
  "--color-deletion": "#cf222e",
  "--color-primary": "#316fca",
  "--color-approval-risk": "#9a6700",
  "--color-agent-working": "#0969da",
  "--color-agent-queued": "#8a8a8e",
  "--color-agent-waiting": "#9a6700",
  "--color-access-full": "#1a7f37",
  "--color-access-limited": "#9a6700",

  // Focus
  "--focus-ring": "0 0 0 2px #316fca3d",

  // Shadows
  "--shadow-sm": "0 1px 3px rgba(0,0,0,0.06)",
  "--shadow-md": "0 4px 12px rgba(0,0,0,0.10)",
  "--shadow-lg": "0 8px 28px rgba(0,0,0,0.14)",
  "--shadow-card": "0 1px 3px rgba(0,0,0,0.06)",
  "--shadow-card-hover": "0 4px 12px rgba(0,0,0,0.12)",
} as const;

// ────────────────────────── Typography ─────────────────────────────────────

export const typography = {
  // SPEC §21: SF Pro system font stack
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif',
  // SPEC §21: SF Mono for code
  fontFamilyMono:
    '"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace',

  // Sizes — comfortable body, restrained headings
  fontSizeXs: "12px",
  fontSizeSm: "13px",
  fontSizeBase: "14px",
  fontSizeMd: "15px",
  fontSizeLg: "16px",
  fontSizeXl: "18px",
  fontSize2xl: "26px",
  fontSize3xl: "32px",

  // Line heights — strong line height
  lineHeightTight: 1.25,
  lineHeightNormal: 1.5,
  lineHeightRelaxed: 1.7,

  // Weights
  fontWeightRegular: 400,
  fontWeightMedium: 500,
  fontWeightSemibold: 600,
} as const;

// ────────────────────────── Spacing / density ──────────────────────────────

export const spaciousTokens = {
  "--space-0": "0px",
  "--space-1": "4px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-5": "20px",
  "--space-6": "24px",
  "--space-8": "32px",
  "--space-10": "40px",
  "--space-12": "48px",
  "--sidebar-width": "260px",
  "--sidebar-width-compact": "220px",
  "--inspector-width": "300px",
  "--composer-max-height": "280px",
  "--conversation-max-width": "720px",
  "--row-height": "34px",
  "--nav-row-height": "32px",
  "--radius-sm": "6px",
  "--radius-md": "10px",
  "--radius-lg": "14px",
  "--radius-xl": "18px",
} as const;

export const compactTokens = {
  "--space-0": "0px",
  "--space-1": "3px",
  "--space-2": "6px",
  "--space-3": "9px",
  "--space-4": "12px",
  "--space-5": "15px",
  "--space-6": "18px",
  "--space-8": "24px",
  "--space-10": "30px",
  "--space-12": "36px",
  "--sidebar-width": "230px",
  "--sidebar-width-compact": "190px",
  "--inspector-width": "280px",
  "--composer-max-height": "220px",
  "--conversation-max-width": "680px",
  "--row-height": "28px",
  "--nav-row-height": "28px",
  "--radius-sm": "5px",
  "--radius-md": "8px",
  "--radius-lg": "12px",
  "--radius-xl": "16px",
} as const;

// ────────────────────────── Motion ─────────────────────────────────────────
// SPEC §22: "Use restrained Apple-like motion by default"

export const motion = {
  durationFast: "150ms",
  durationNormal: "250ms",
  durationSlow: "400ms",
  easingDefault: "cubic-bezier(0.25, 0.1, 0.25, 1)",
  easingSpring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

// SPEC §22: "Respect Reduce Motion"
export const reducedMotion = `
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`;
