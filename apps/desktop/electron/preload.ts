/**
 * Forge Desktop — Electron preload script.
 *
 * Per SPEC §2: "The renderer must consume the harness through the repository's
 * existing typed interfaces. Do not move harness logic into React components
 * or Electron renderer code."
 *
 * The preload exposes a minimal, safe IPC bridge so the renderer can:
 * - Read the Forge API base URL (configured in main process or env)
 * - Get the platform info for macOS-specific UI decisions
 * - Request native notifications
 *
 * All harness logic stays in the Rust kernel + TS control plane. The renderer
 * uses @forge/public-client to talk to the control plane over HTTP/SSE.
 */
import { contextBridge, ipcRenderer } from "electron";

const FORGE_API_BASE = process.env.FORGE_API_BASE ?? "http://127.0.0.1:3050";
const FORGE_GATEWAY = process.env.FORGE_GATEWAY ?? "http://127.0.0.1:81";
const FORGE_TOKEN = process.env.FORGE_TOKEN ?? "forge-control-dev-token";
const PLATFORM = process.platform;

contextBridge.exposeInMainWorld("forgeDesktop", {
  apiBase: FORGE_API_BASE,
  gateway: FORGE_GATEWAY,
  token: FORGE_TOKEN,
  platform: PLATFORM,
  isMac: PLATFORM === "darwin",
  // Native notification bridge (SPEC §5: "Use native notifications only when
  // the app is unfocused or a task requires attention")
  notify: (title: string, body: string) =>
    ipcRenderer.invoke("notify", { title, body }),
  // Window controls
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  // Theme
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (theme: "system" | "light" | "dark") =>
    ipcRenderer.invoke("theme:set", theme),
});
