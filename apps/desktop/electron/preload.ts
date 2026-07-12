/**
 * Terminus Desktop — Electron preload script.
 *
 * Per SPEC §2: "The renderer must consume the harness through the repository's
 * existing typed interfaces. Do not move harness logic into React components
 * or Electron renderer code."
 *
 * The preload exposes three IPC bridges so the renderer can:
 *
 *   1. `terminusDesktop` — read the Terminus API base URL, platform info, send
 *      native notifications, control the window, and read/set the theme.
 *
 *   2. `terminusTerminal` — spawn/write/resize/kill PTY sessions and receive
 *      their output stream (SPEC §15). Backed by `node-pty` in the main
 *      process. The renderer attaches each session to an xterm.js Terminal
 *      instance.
 *
 *   3. `terminusDesktop.getScreenSources` — request desktopCapturer sources for
 *      the computer-use PiP (SPEC §16).
 *
 * All harness logic stays in the Rust kernel + TS control plane. The renderer
 * uses @terminus/public-client to talk to the control plane over HTTP/SSE.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const TERMINUS_API_BASE = process.env.TERMINUS_API_BASE ?? "http://127.0.0.1:3050";
const TERMINUS_GATEWAY = process.env.TERMINUS_GATEWAY ?? "http://127.0.0.1:81";
const TERMINUS_TOKEN = process.env.TERMINUS_TOKEN ?? "terminus-control-dev-token";
const PLATFORM = process.platform;

// ────────────────────────── terminusDesktop ─────────────────────────────────────

contextBridge.exposeInMainWorld("terminusDesktop", {
  apiBase: TERMINUS_API_BASE,
  gateway: TERMINUS_GATEWAY,
  token: TERMINUS_TOKEN,
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
  // Screen capture (SPEC §16 — computer-use PiP).
  getScreenSources: (): Promise<Array<{ id: string; name: string; display_id?: string }>> =>
    ipcRenderer.invoke("desktop:getScreenSources"),
});

// ────────────────────────── terminusTerminal ────────────────────────────────────

/**
 * PTY bridge. Each `spawn()` returns an opaque id; the renderer subscribes
 * to per-id `data` and `exit` events.
 *
 * The spawn response carries an `error` field when node-pty could not be
 * loaded (Linux sandbox without the native toolchain, missing prebuilt
 * binary, etc.). In that case the renderer falls back to the
 * StubTerminalSessionFactory so the drawer still renders a banner.
 */
contextBridge.exposeInMainWorld("terminusTerminal", {
  spawn: (
    cwd?: string,
    command?: string,
    cols?: number,
    rows?: number,
  ): Promise<{ id: string; label: string; cwd?: string; error?: string }> =>
    ipcRenderer.invoke("terminusTerminal:spawn", { cwd, command, cols, rows }),
  write: (termId: string, data: string): Promise<void> =>
    ipcRenderer.invoke("terminusTerminal:write", termId, data),
  resize: (termId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("terminusTerminal:resize", termId, cols, rows),
  kill: (termId: string): Promise<void> =>
    ipcRenderer.invoke("terminusTerminal:kill", termId),
  // Per-id event listeners. Returns an unsubscribe.
  onData: (termId: string, cb: (data: string) => void): (() => void) => {
    const channel = `terminusTerminal:data:${termId}`;
    const listener = (_e: IpcRendererEvent, data: string): void => cb(data);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  onExit: (termId: string, cb: (exitCode: number) => void): (() => void) => {
    const channel = `terminusTerminal:exit:${termId}`;
    const listener = (_e: IpcRendererEvent, code: number): void => cb(code);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});
