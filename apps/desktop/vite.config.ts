import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const PACKAGED_CONNECT_SOURCES = [
  "'self'",
  "http://127.0.0.1:3050",
] as const;

function contentSecurityPolicy(command: "build" | "serve"): Plugin {
  const connectSources = command === "serve"
    ? [...PACKAGED_CONNECT_SOURCES, "http://localhost:3050", "ws://localhost:5173", "http://localhost:5173"]
    : PACKAGED_CONNECT_SOURCES;
  return {
    name: "terminus-content-security-policy",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const marker = "__TERMINUS_CONNECT_SOURCES__";
        if (!html.includes(marker)) throw new Error(`desktop index omitted ${marker}`);
        return html.replace(marker, connectSources.join(" "));
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [contentSecurityPolicy(command), react(), tailwindcss()],
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
      output: {
        manualChunks(moduleId) {
          if (!moduleId.includes("node_modules")) return undefined;
          if (
            moduleId.includes("/node_modules/react/")
            || moduleId.includes("/node_modules/react-dom/")
            || moduleId.includes("/node_modules/scheduler/")
          ) return "react-runtime";
          if (moduleId.includes("/node_modules/zod/")) return "validation";
          if (moduleId.includes("/lucide-react/")) return "icons";
          if (moduleId.includes("/@tanstack/react-virtual/")) return "virtualization";
          if (moduleId.includes("/date-fns/")) return "dates";
          if (moduleId.includes("/zustand/")) return "state";
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@terminus/public-api": resolve(__dirname, "../../packages/public-api/src/index.ts"),
      "@terminus/public-client": resolve(__dirname, "../../packages/public-client/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
