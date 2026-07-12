import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, "src"),
  base: "./",
  // Don't inherit the parent monorepo's PostCSS config (Next.js uses
  // @tailwindcss/postcss; the desktop app uses @tailwindcss/vite).
  css: {
    postcss: { plugins: [] },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/index.html"),
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@forge/public-api": resolve(__dirname, "../../packages/public-api/src/index.ts"),
      "@forge/public-client": resolve(__dirname, "../../packages/public-client/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
