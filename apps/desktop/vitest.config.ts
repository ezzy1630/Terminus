import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
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
