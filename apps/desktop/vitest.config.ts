import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
    // Full-suite jsdom contention can starve interaction-heavy accessibility
    // tests even though their focused runs finish in under two seconds.
    testTimeout: 15_000,
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@terminus/public-api": resolve(__dirname, "../../packages/public-api/src/index.ts"),
      "@terminus/public-client": resolve(__dirname, "../../packages/public-client/src/index.ts"),
    },
  },
});
