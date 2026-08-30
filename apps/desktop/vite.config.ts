import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import {
  buildContentSecurityPolicy,
  devConnectSources,
  packagedConnectSources,
  PACKAGED_CSP_API_PLACEHOLDER,
} from "./electron/csp";
import { requireLocalTerminusOrigin } from "./electron/shell-guards";

/**
 * The meta-tag policy comes from the same builder the Electron main process
 * uses for the response header (electron/csp.ts). A build whose meta tag and
 * header disagree is a policy nobody can reason about, so there is one source.
 *
 * The dev document additionally allows inline scripts because Vite injects its
 * React-refresh preamble inline; packaged documents never do.
 */
function contentSecurityPolicy(
  command: "build" | "serve",
  developmentApiOrigin: string,
): Plugin {
  const policy = command === "serve"
    ? buildContentSecurityPolicy({
        connectSources: devConnectSources(developmentApiOrigin),
        allowInlineScripts: true,
        allowBlobWorkers: true,
      })
    : buildContentSecurityPolicy({ connectSources: packagedConnectSources(PACKAGED_CSP_API_PLACEHOLDER) });
  return {
    name: "terminus-content-security-policy",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const marker = "__TERMINUS_CSP__";
        if (!html.includes(marker)) throw new Error(`desktop index omitted ${marker}`);
        return html.replace(marker, policy);
      },
    },
  };
}

export default defineConfig(({ command }) => {
  const developmentApiOrigin = command === "serve"
    ? requireLocalTerminusOrigin(
        process.env.VITE_TERMINUS_API_BASE ?? PACKAGED_CSP_API_PLACEHOLDER,
        "VITE_TERMINUS_API_BASE",
      )
    : PACKAGED_CSP_API_PLACEHOLDER;
  return {
    plugins: [contentSecurityPolicy(command, developmentApiOrigin), react(), tailwindcss()],
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
      // This bundle only ever runs in the Chromium we ship with, so there is no
      // older engine to down-level for. Vite's default target assumes an unknown
      // browser and transpiles modern syntax it does not have to: naming the
      // engine keeps async/await, class fields and optional chaining native
      // instead of shipping regenerator-shaped rewrites of the hot paths.
      // Electron 43 is Chromium 150.
      target: "chrome150",
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
  };
});
