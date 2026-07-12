"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Terminus Desktop — Electron main process.
 *
 * Per SPEC §2: "Electron is the application shell, not the execution
 * authority. The renderer must consume the harness through the repository's
 * existing typed interfaces."
 *
 * The main process creates the native macOS window with integrated title bar,
 * native traffic lights, and correct draggable regions. It does NOT run any
 * harness logic — all cognition, effects, and execution happen in the Terminus
 * kernel (port 3040) and control plane (port 3050).
 *
 * It DOES own two native bridges the renderer cannot reach on its own:
 *
 *   1. `forgeTerminal` — `node-pty` PTY sessions (SPEC §15). The renderer
 *      asks to spawn a shell, sends input, receives output, resizes, and
 *      kills. Each session is identified by an opaque id. We pipe PTY
 *      stdout/stderr to the renderer via `webContents.send` and route
 *      renderer input back into the PTY's stdin.
 *
 *      `node-pty` is a native module compiled at install time. On macOS
 *      (the supported platform) it builds cleanly. On Linux sandboxes
 *      it sometimes cannot be rebuilt against the system Node ABI — we
 *      `try/catch` the require so the main process still boots; the
 *      renderer falls back to the StubTerminalSessionFactory in that case.
 *
 *   2. `forgeDesktop.getScreenSources` — `desktopCapturer.getSources()`
 *      (SPEC §16). The renderer needs a screen-source id to feed into
 *      `navigator.mediaDevices.getUserMedia({ video: { chromeMediaSource:
 *      'desktop', chromeMediaSourceId } })` for the computer-use PiP.
 *
 *   3. `forgeDesktop` notifications + window controls + theme — same as
 *      before.
 */
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const isDev = !electron_1.app.isPackaged;
electron_1.app.setName("Terminus");
let mainWindow = null;
// ────────────────────────── node-pty (graceful) ───────────────────────────────
/**
 * Lazily-loaded `node-pty` module. Native compilation can fail on Linux
 * sandboxes without the right toolchain; we tolerate that and let the
 * renderer fall back to a stub terminal.
 */
let pty = null;
let ptyLoadError = null;
function loadPty() {
    if (pty !== null || ptyLoadError !== null)
        return;
    try {
        // Electron's main process is compiled to CommonJS (see
        // electron/tsconfig.json), so `require` is available directly. We
        // use a dynamic `require()` so node-pty (a native module) is loaded
        // lazily — if it failed to compile on this platform, we catch and
        // fall back to a stub terminal in the renderer.
        pty = require("node-pty");
    }
    catch (err) {
        ptyLoadError = err instanceof Error ? err.message : String(err);
        console.warn(`[terminus] node-pty unavailable — terminal drawer will use stub. ${ptyLoadError}`);
    }
}
const ptySessions = new Map();
function resolveShell() {
    // Prefer $SHELL, then `/bin/zsh` (macOS default since 10.15), then bash.
    return process.env.SHELL ?? "/bin/zsh";
}
function handleTerminalSpawn(event, opts) {
    loadPty();
    if (!pty) {
        return { id: "", label: "", cwd: opts.cwd, error: ptyLoadError ?? "node-pty unavailable" };
    }
    try {
        const id = (0, node_crypto_1.randomUUID)();
        const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : process.env.HOME ?? process.cwd();
        const shell = resolveShell();
        const args = opts.command ? ["-c", opts.command] : [];
        const term = pty.spawn(shell, args, {
            name: "xterm-256color",
            cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
            rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
            cwd,
            env: { ...process.env, TERM: "xterm-256color", TERMINUS_SHELL: "1" },
        });
        const session = {
            id,
            pty: term,
            senderId: event.sender.id,
            disposed: false,
        };
        term.onData((data) => {
            if (session.disposed)
                return;
            // Forward stdout/stderr to the renderer that owns this session.
            const wc = electron_1.BrowserWindow.fromId(session.senderId)?.webContents;
            wc?.send(`forgeTerminal:data:${id}`, data);
        });
        term.onExit(({ exitCode }) => {
            if (session.disposed)
                return;
            const wc = electron_1.BrowserWindow.fromId(session.senderId)?.webContents;
            wc?.send(`forgeTerminal:exit:${id}`, exitCode);
            ptySessions.delete(id);
        });
        ptySessions.set(id, session);
        const label = opts.command ? opts.command.split(" ")[0] ?? "shell" : shell.split("/").pop() ?? "shell";
        return { id, label, cwd };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { id: "", label: "", cwd: opts.cwd, error: msg };
    }
}
function handleTerminalWrite(_event, id, data) {
    const s = ptySessions.get(id);
    if (!s || s.disposed)
        return;
    try {
        s.pty.write(data);
    }
    catch {
        // Swallow — broken pipe just means the PTY died between calls.
    }
}
function handleTerminalResize(_event, id, cols, rows) {
    const s = ptySessions.get(id);
    if (!s || s.disposed)
        return;
    try {
        s.pty.resize(Math.max(1, cols), Math.max(1, rows));
    }
    catch {
        // ignore — pty may not yet be ready
    }
}
function handleTerminalKill(_event, id) {
    const s = ptySessions.get(id);
    if (!s)
        return;
    s.disposed = true;
    ptySessions.delete(id);
    try {
        s.pty.kill();
    }
    catch {
        // ignore — already dead
    }
}
// ────────────────────────── Screen capture (desktopCapturer) ──────────────────
async function handleGetScreenSources() {
    try {
        const sources = await electron_1.desktopCapturer.getSources({
            types: ["screen", "window"],
            fetchWindowIcons: false,
            thumbnailSize: { width: 0, height: 0 },
        });
        return sources.map((s) => ({
            id: s.id,
            name: s.name,
            display_id: s.display_id,
        }));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[terminus] desktopCapturer.getSources failed: ${msg}`);
        return [];
    }
}
// ────────────────────────── Window lifecycle ─────────────────────────────────
function createWindow() {
    // SPEC §5: "The default window should open large and centered, occupying
    // approximately 85–90% of the available work area while leaving a visible
    // desktop margin."
    const { width: screenWidth, height: screenHeight } = electron_1.screen.getPrimaryDisplay().workAreaSize;
    const width = Math.min(Math.round(screenWidth * 0.88), 1600);
    const height = Math.min(Math.round(screenHeight * 0.88), 1000);
    mainWindow = new electron_1.BrowserWindow({
        width,
        height,
        title: "Terminus",
        minWidth: 900,
        minHeight: 600,
        center: true,
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 16, y: 18 },
        backgroundColor: electron_1.nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#f7f7f8",
        show: false,
        vibrancy: "under-window",
        visualEffectState: "active",
        webPreferences: {
            preload: (0, node_path_1.join)(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false, // required for contextBridge + preload with IPC
        },
    });
    // SPEC §5: "Remember previous window size and position"
    // TODO: persist bounds to electron-store.
    mainWindow.once("ready-to-show", () => {
        mainWindow?.show();
    });
    // SPEC §5: "Support multiple application windows if existing product
    // behavior allows it"
    // For now, single window. Multiple windows can be added later.
    // Open external links in the default browser, not in Electron.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
            void electron_1.shell.openExternal(url);
            return { action: "deny" };
        }
        return { action: "allow" };
    });
    if (isDev) {
        // Keep the dev renderer from reusing a pre-migration Forge document from
        // Electron's HTTP cache after the app rename.
        void mainWindow.loadURL("http://localhost:5173/?app=terminus");
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    else {
        void mainWindow.loadFile((0, node_path_1.join)(__dirname, "../dist/index.html"));
    }
}
// SPEC §24: "Theme and density changes should not require restart."
// Respect the system theme.
electron_1.nativeTheme.themeSource = "system";
// ────────────────────────── IPC registration ─────────────────────────────────
function registerIpc() {
    // ── Terminus desktop bridge ──
    electron_1.ipcMain.handle("notify", (_e, { title, body }) => {
        const { Notification } = require("electron");
        if (Notification.isSupported()) {
            new Notification({ title, body }).show();
        }
        return null;
    });
    electron_1.ipcMain.handle("window:minimize", () => {
        mainWindow?.minimize();
        return null;
    });
    electron_1.ipcMain.handle("window:maximize", () => {
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        }
        else {
            mainWindow?.maximize();
        }
        return null;
    });
    electron_1.ipcMain.handle("window:close", () => {
        mainWindow?.close();
        return null;
    });
    electron_1.ipcMain.handle("theme:get", () => electron_1.nativeTheme.themeSource);
    electron_1.ipcMain.handle("theme:set", (_e, theme) => {
        electron_1.nativeTheme.themeSource = theme;
        return electron_1.nativeTheme.themeSource;
    });
    electron_1.ipcMain.handle("desktop:getScreenSources", handleGetScreenSources);
    // ── Terminal (node-pty) ──
    electron_1.ipcMain.handle("forgeTerminal:spawn", handleTerminalSpawn);
    electron_1.ipcMain.handle("forgeTerminal:write", handleTerminalWrite);
    electron_1.ipcMain.handle("forgeTerminal:resize", handleTerminalResize);
    electron_1.ipcMain.handle("forgeTerminal:kill", handleTerminalKill);
}
electron_1.app.whenReady().then(() => {
    registerIpc();
    createWindow();
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on("window-all-closed", () => {
    // Kill any lingering PTYs before we quit.
    for (const session of ptySessions.values()) {
        session.disposed = true;
        try {
            session.pty.kill();
        }
        catch {
            // ignore
        }
    }
    ptySessions.clear();
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
