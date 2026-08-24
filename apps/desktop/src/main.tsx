/**
 * Terminus Desktop — React entry point.
 *
 * Mounts <App /> after the CSS-first theme has loaded.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { useThemeStore } from "./hooks/use-theme";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { TooltipLayer, TooltipProvider } from "./ui/Tooltip";
import { setupDevMock } from "./lib/dev-mock";

if (import.meta.env.DEV && (window.location.search.includes("mock") || !window.localStorage.getItem("terminus-desktop.onboarding.completed.v1"))) {
  setupDevMock();
}

// Refresh only the theme and density attributes across HMR reloads.
useThemeStore.getState().refresh();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <TooltipProvider>
      <AppErrorBoundary>
        <App />
        <TooltipLayer />
      </AppErrorBoundary>
    </TooltipProvider>
  </StrictMode>,
);
