/**
 * Terminus Desktop — PostCSS config.
 *
 * The desktop app uses the `@tailwindcss/vite` plugin (configured in
 * `vite.config.ts`) rather than the legacy `@tailwindcss/postcss` plugin
 * used by the parent Next.js app. Vite walks parent directories looking
 * for a PostCSS config and would otherwise pick up the root
 * `postcss.config.mjs` (which references `@tailwindcss/postcss`), breaking
 * the desktop build.
 *
 * This file is intentionally empty: Vite resolves it for the desktop
 * package and then the explicit `css.postcss.plugins: []` override in
 * `vite.config.ts` takes over. The file is kept so that any tooling that
 * probes `apps/desktop/` for PostCSS config (e.g. stylelint, editor
 * integrations) finds a desktop-local answer rather than walking up to
 * the root.
 *
 * Per Tailwind v4 + Vite: the canonical setup is the Vite plugin, and a
 * PostCSS config is no longer required for Tailwind itself. We still
 * expose a placeholder here for forward compatibility (autoprefixer,
 * nesting, etc. can be added later without touching vite.config.ts).
 */
export default {
  plugins: {
    "@tailwindcss/vite": {},
  },
};
