/**
 * Terminus Desktop — Electron preload script.
 *
 * Per SPEC §2: "The renderer must consume the harness through the repository's
 * existing typed interfaces. Do not move harness logic into React components
 * or Electron renderer code."
 *
 * The preload exposes one constrained presentation bridge so the renderer can:
 *
 *   1. `terminusDesktop` — read the Terminus API base URL, platform info, send
 *      native notifications, control the window, and read/set the theme.
 *
 *
 * Process execution, workspace filesystem access, and computer-use capture
 * are intentionally absent. Those effects require kernel-backed contracts.
 *
 * All harness logic stays in the Rust kernel + TS control plane. The renderer
 * uses @terminus/public-client to talk to the control plane over HTTP/SSE.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

function requireLocalOrigin(value: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid URL`);
  }
  const port = Number(url.port);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    url.protocol !== "http:"
    || !loopback
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.port.length === 0
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || url.origin !== value.replace(/\/$/, "")
  ) {
    throw new Error(`${variable} must name an approved local Terminus origin`);
  }
  return url.origin;
}

const TERMINUS_API_BASE = requireLocalOrigin(
  process.env.TERMINUS_API_BASE ?? "http://127.0.0.1:3050",
  "TERMINUS_API_BASE",
);
const PLATFORM = process.platform;

type WindowBounds = { x: number; y: number; width: number; height: number };
type DesktopCommandId =
  | "command-palette"
  | "open-project"
  | "settings"
  | "shortcut-reference"
  | "new-task"
  | "show-changes"
  | "toggle-inspector"
  | "toggle-sidebar";

// ────────────────────────── terminusDesktop ─────────────────────────────────────

contextBridge.exposeInMainWorld("terminusDesktop", {
  apiBase: TERMINUS_API_BASE,
  platform: PLATFORM,
  isMac: PLATFORM === "darwin",
  // Native notification bridge (SPEC §5: "Use native notifications only when
  // the app is unfocused or a task requires attention")
  notify: (title: string, body: string): Promise<unknown> =>
    ipcRenderer.invoke("notify", { title, body }),
  // Window controls
  windowMinimize: (): Promise<unknown> => ipcRenderer.invoke("window:minimize"),
  windowMaximize: (): Promise<unknown> => ipcRenderer.invoke("window:maximize"),
  windowClose: (): Promise<unknown> => ipcRenderer.invoke("window:close"),
  // Theme
  getTheme: (): Promise<"system" | "light" | "dark"> => ipcRenderer.invoke("theme:get"),
  setTheme: (theme: "system" | "light" | "dark"): Promise<"system" | "light" | "dark"> =>
    ipcRenderer.invoke("theme:set", theme),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("desktop:pickDirectory"),
  validateDirectoryDrop: (path: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:validateDirectoryDrop", path),
  onDirectoryDrop: (callback: (path: string) => void): (() => void) => {
    const allowDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const listener = (event: DragEvent): void => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const candidate = files[0] as (File & { path?: unknown }) | undefined;
      if (files.length !== 1 || typeof candidate?.path !== "string") return;
      event.preventDefault();
      void ipcRenderer.invoke("desktop:validateDirectoryDrop", candidate.path).then((path: unknown) => {
        if (typeof path === "string") callback(path);
      });
    };
    document.addEventListener("dragover", allowDrop, true);
    document.addEventListener("drop", listener, true);
    return () => {
      document.removeEventListener("dragover", allowDrop, true);
      document.removeEventListener("drop", listener, true);
    };
  },
  onCommand: (callback: (commandId: DesktopCommandId) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, commandId: DesktopCommandId): void => callback(commandId);
    ipcRenderer.on("terminus:command", listener);
    return () => ipcRenderer.removeListener("terminus:command", listener);
  },
  setWindowTitle: (title: string): Promise<string> => ipcRenderer.invoke("window:setTitle", title),
  getWindowBounds: (): Promise<WindowBounds | null> => ipcRenderer.invoke("window:getBounds"),
  setWindowBounds: (bounds: WindowBounds): Promise<WindowBounds> => ipcRenderer.invoke("window:setBounds", bounds),
  onWindowBoundsChange: (callback: (bounds: WindowBounds) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, bounds: WindowBounds): void => callback(bounds);
    ipcRenderer.on("terminus:window-bounds", listener);
    return () => ipcRenderer.removeListener("terminus:window-bounds", listener);
  },
});
