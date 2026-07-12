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
 */

// ────────────────────────── Color tokens ───────────────────────────────────

export const darkTokens = {
  // Main canvas — neutral Codex-like charcoal
  "--bg-canvas": "#1b1c1e",
  // Elevated surfaces — barely warmer gray
  "--bg-elevated": "#232427",
  // Sidebar — native macOS material (simulated)
  "--bg-sidebar": "#202124",
  // Inspector — floating card
  "--bg-inspector": "#252629",
  // Terminal and diff — slightly cooler and darker
  "--bg-terminal": "#161618",
  "--bg-diff": "#161618",
  // Composer
  "--bg-composer": "#252629",
  // Hover
  "--bg-hover": "#303136",
  // Selected (no bright saturated background)
  "--bg-selected": "#303238",

  // Text
  "--text-primary": "#f1f1f2",
  "--text-secondary": "#adadb3",
  "--text-tertiary": "#777880",
  "--text-inverse": "#1a1a1c",

  // Separators
  "--border-subtle": "#303136",
  "--border-default": "#3a3b40",
  "--border-strong": "#505158",

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

  // Focus
  "--focus-ring": "0 0 0 2px #80aefb52",

  // Shadows
  "--shadow-sm": "0 1px 3px rgba(0,0,0,0.3)",
  "--shadow-md": "0 4px 12px rgba(0,0,0,0.4)",
  "--shadow-lg": "0 8px 24px rgba(0,0,0,0.5)",
} as const;

export const lightTokens = {
  // Main canvas — soft neutral
  "--bg-canvas": "#f6f6f7",
  // Elevated surfaces
  "--bg-elevated": "#ffffff",
  // Sidebar
  "--bg-sidebar": "#f1f1f3",
  // Inspector
  "--bg-inspector": "#ffffff",
  // Terminal and diff
  "--bg-terminal": "#1a1a1c",
  "--bg-diff": "#ffffff",
  // Composer
  "--bg-composer": "#ffffff",
  // Hover
  "--bg-hover": "#e9e9ec",
  // Selected
  "--bg-selected": "#e3e4e8",

  // Text
  "--text-primary": "#1a1a1c",
  "--text-secondary": "#5a5a5e",
  "--text-tertiary": "#8a8a8e",
  "--text-inverse": "#ffffff",

  // Separators
  "--border-subtle": "#e4e4e6",
  "--border-default": "#d4d4d6",
  "--border-strong": "#a4a4a6",

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

  // Focus
  "--focus-ring": "0 0 0 2px #316fca3d",

  // Shadows
  "--shadow-sm": "0 1px 3px rgba(0,0,0,0.08)",
  "--shadow-md": "0 4px 12px rgba(0,0,0,0.12)",
  "--shadow-lg": "0 8px 24px rgba(0,0,0,0.16)",
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
  fontSizeXs: "11px",
  fontSizeSm: "12px",
  fontSizeBase: "14px",
  fontSizeMd: "15px",
  fontSizeLg: "17px",
  fontSizeXl: "20px",
  fontSize2xl: "28px",
  fontSize3xl: "34px",

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
  "--sidebar-width": "272px",
  "--sidebar-width-compact": "216px",
  "--inspector-width": "320px",
  "--composer-max-height": "280px",
  "--conversation-max-width": "740px",
  "--row-height": "38px",
  "--radius-sm": "6px",
  "--radius-md": "10px",
  "--radius-lg": "14px",
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
  "--inspector-width": "288px",
  "--composer-max-height": "220px",
  "--conversation-max-width": "700px",
  "--row-height": "30px",
  "--radius-sm": "5px",
  "--radius-md": "8px",
  "--radius-lg": "12px",
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
