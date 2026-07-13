/**
 * Terminus Desktop — React entry point.
 *
 * Mounts <App />, imports global styles, and runs the initial theme
 * refresh so tokens are installed before first paint (the theme store
 * also installs tokens at module load — calling refresh() here is a
 * belt-and-suspenders for HMR).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { useThemeStore } from "./hooks/use-theme";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";

// Re-apply tokens to be safe across HMR reloads.
useThemeStore.getState().refresh();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
