"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Forge Desktop — Electron preload script.
 *
 * Per SPEC §2: "The renderer must consume the harness through the repository's
 * existing typed interfaces. Do not move harness logic into React components
 * or Electron renderer code."
 *
 * The preload exposes three IPC bridges so the renderer can:
 *
 *   1. `forgeDesktop` — read the Forge API base URL, platform info, send
 *      native notifications, control the window, and read/set the theme.
 *
 *   2. `forgeTerminal` — spawn/write/resize/kill PTY sessions and receive
 *      their output stream (SPEC §15). Backed by `node-pty` in the main
 *      process. The renderer attaches each session to an xterm.js Terminal
 *      instance.
 *
 *   3. `forgeDesktop.getScreenSources` — request desktopCapturer sources for
 *      the computer-use PiP (SPEC §16).
 *
 * All harness logic stays in the Rust kernel + TS control plane. The renderer
 * uses @forge/public-client to talk to the control plane over HTTP/SSE.
 */
const electron_1 = require("electron");
const FORGE_API_BASE = process.env.FORGE_API_BASE ?? "http://127.0.0.1:3050";
const FORGE_GATEWAY = process.env.FORGE_GATEWAY ?? "http://127.0.0.1:81";
const FORGE_TOKEN = process.env.FORGE_TOKEN ?? "forge-control-dev-token";
const PLATFORM = process.platform;
// ────────────────────────── forgeDesktop ─────────────────────────────────────
electron_1.contextBridge.exposeInMainWorld("forgeDesktop", {
    apiBase: FORGE_API_BASE,
    gateway: FORGE_GATEWAY,
    token: FORGE_TOKEN,
    platform: PLATFORM,
    isMac: PLATFORM === "darwin",
    // Native notification bridge (SPEC §5: "Use native notifications only when
    // the app is unfocused or a task requires attention")
    notify: (title, body) => electron_1.ipcRenderer.invoke("notify", { title, body }),
    // Window controls
    windowMinimize: () => electron_1.ipcRenderer.invoke("window:minimize"),
    windowMaximize: () => electron_1.ipcRenderer.invoke("window:maximize"),
    windowClose: () => electron_1.ipcRenderer.invoke("window:close"),
    // Theme
    getTheme: () => electron_1.ipcRenderer.invoke("theme:get"),
    setTheme: (theme) => electron_1.ipcRenderer.invoke("theme:set", theme),
    // Screen capture (SPEC §16 — computer-use PiP).
    getScreenSources: () => electron_1.ipcRenderer.invoke("desktop:getScreenSources"),
});
// ────────────────────────── forgeTerminal ────────────────────────────────────
/**
 * PTY bridge. Each `spawn()` returns an opaque id; the renderer subscribes
 * to per-id `data` and `exit` events.
 *
 * The spawn response carries an `error` field when node-pty could not be
 * loaded (Linux sandbox without the native toolchain, missing prebuilt
 * binary, etc.). In that case the renderer falls back to the
 * StubTerminalSessionFactory so the drawer still renders a banner.
 */
electron_1.contextBridge.exposeInMainWorld("forgeTerminal", {
    spawn: (cwd, command, cols, rows) => electron_1.ipcRenderer.invoke("forgeTerminal:spawn", { cwd, command, cols, rows }),
    write: (termId, data) => electron_1.ipcRenderer.invoke("forgeTerminal:write", termId, data),
    resize: (termId, cols, rows) => electron_1.ipcRenderer.invoke("forgeTerminal:resize", termId, cols, rows),
    kill: (termId) => electron_1.ipcRenderer.invoke("forgeTerminal:kill", termId),
    // Per-id event listeners. Returns an unsubscribe.
    onData: (termId, cb) => {
        const channel = `forgeTerminal:data:${termId}`;
        const listener = (_e, data) => cb(data);
        electron_1.ipcRenderer.on(channel, listener);
        return () => {
            electron_1.ipcRenderer.removeListener(channel, listener);
        };
    },
    onExit: (termId, cb) => {
        const channel = `forgeTerminal:exit:${termId}`;
        const listener = (_e, code) => cb(code);
        electron_1.ipcRenderer.on(channel, listener);
        return () => {
            electron_1.ipcRenderer.removeListener(channel, listener);
        };
    },
});
