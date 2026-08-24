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
 * In packaged builds it also supervises the fixed, manifest-verified kernel
 * and control executables described by ADR-0039. It never implements harness
 * effects itself. Workspace effects and provider commands still cross the
 * Rust kernel, and no process handle is exposed through preload IPC.
 */
import { app, BrowserWindow, Menu, nativeTheme, screen, ipcMain, dialog, Notification, session, net, protocol, type IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeWindowTitle, packagedRendererAssetPath, parseWindowBounds, validateDirectoryPath, type WindowBounds } from "./shell-guards";
import { StandaloneRuntimeSupervisor } from "./runtime-supervisor";
import { requireRuntimeBuildKind, requireRuntimeCommit, requireRuntimeVersion, type DesktopRuntimeBuildKind } from "./runtime-contract";

// __dirname is provided natively by CommonJS (Electron's main process
// is compiled to CommonJS by electron/tsconfig.json). We avoid
// `import.meta.url` so the same source compiles cleanly under both
// CommonJS and ESM module settings.
declare const __dirname: string;

const isDev = !app.isPackaged;
const PACKAGED_RENDERER_SCHEME = "terminus";
const PACKAGED_RENDERER_ENTRY = "terminus://app/index.html";
const PACKAGED_CSP_API_PLACEHOLDER = "http://127.0.0.1:3050";
protocol.registerSchemesAsPrivileged([{
  scheme: PACKAGED_RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);
app.setName("Terminus");

let mainWindow: BrowserWindow | null = null;
let runtimeSupervisor: StandaloneRuntimeSupervisor | null = null;
let runtimeShutdownStarted = false;
let runtimeAcceptingRequests = false;
let desktopFatalReported = false;
const LOCAL_API_ORIGINS = new Set(["http://127.0.0.1:3050", "http://localhost:3050"]);

function requireLocalOrigin(value: string, allowed: ReadonlySet<string>, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid URL`);
  }
  if (url.username || url.password || url.origin !== value.replace(/\/$/, "") || !allowed.has(url.origin)) {
    throw new Error(`${variable} must name an approved local Terminus origin`);
  }
  return url.origin;
}

let terminusApiBase = isDev
  ? requireLocalOrigin(
      process.env.TERMINUS_API_BASE ?? "http://127.0.0.1:3050",
      LOCAL_API_ORIGINS,
      "TERMINUS_API_BASE",
    )
  : "http://127.0.0.1:3050";
let terminusControlToken = isDev
  ? process.env.TERMINUS_TOKEN ?? process.env.TERMINUS_CONTROL_TOKEN ?? ""
  : "";

function configuredOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Attach the control capability only to the two configured Terminus origins. */
function registerAuthenticatedTransport(): void {
  if (!terminusControlToken) return;
  const allowedOrigin = configuredOrigin(terminusApiBase);
  if (allowedOrigin === null) throw new Error("Terminus API base is invalid");
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.webContentsId !== mainWindow?.webContents.id) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const origin = configuredOrigin(details.url);
    const requestHeaders = { ...details.requestHeaders };
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === "authorization") delete requestHeaders[name];
    }
    if (!runtimeAcceptingRequests || origin !== allowedOrigin) {
      callback({ requestHeaders });
      return;
    }
    console.log(`[terminus-desktop] authenticated header injected for renderer request: ${details.method} ${details.url}`);
    callback({
      requestHeaders: {
        ...requestHeaders,
        Authorization: `Bearer ${terminusControlToken}`,
      },
    });
  });
  session.defaultSession.webRequest.onSendHeaders((details) => {
    if (details.webContentsId === mainWindow?.webContents.id && (details.url.includes("/events") || details.url.includes("/v2/events"))) {
      console.log(`[terminus-desktop] renderer opened SSE connection: ${details.url}`);
    }
  });
}

function sealRendererRuntimeBoundary(): void {
  runtimeAcceptingRequests = false;
  terminusControlToken = "";
  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    window.hide();
    window.destroy();
  }
}

function handleDesktopFatal(title: string, error: unknown): void {
  if (desktopFatalReported) return;
  desktopFatalReported = true;
  const failure = error instanceof Error ? error : new Error(String(error));
  const logPath = runtimeSupervisor?.details().logPath;
  sealRendererRuntimeBoundary();
  dialog.showErrorBox(title, logPath ? `${failure.message}\n\nRuntime log: ${logPath}` : failure.message);
  app.quit();
}

function rendererEntryUrl(): string {
  return isDev
    ? "http://localhost:5173/?app=terminus"
    : PACKAGED_RENDERER_ENTRY;
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const candidate = new URL(value);
    const entry = new URL(rendererEntryUrl());
    if (!isDev) return candidate.href === entry.href;
    return candidate.origin === entry.origin
      && candidate.pathname === entry.pathname
      && candidate.search === entry.search;
  } catch {
    return false;
  }
}

async function registerPackagedRendererProtocol(): Promise<void> {
  if (isDev) return;
  await protocol.handle(PACKAGED_RENDERER_SCHEME, (request) => {
    const relativePath = packagedRendererAssetPath(request.url);
    if (relativePath === null) return new Response("Not found", { status: 404 });
    const fileUrl = pathToFileURL(join(__dirname, "../dist", ...relativePath.split("/"))).toString();
    return net.fetch(fileUrl).then(async (response) => {
      if (relativePath !== "index.html") return response;
      const html = await response.text();
      if (!html.includes(PACKAGED_CSP_API_PLACEHOLDER)) {
        throw new Error("packaged renderer omitted the control-origin CSP placeholder");
      }
      const headers = new Headers(response.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      console.log(`[terminus-desktop] packaged renderer loaded under CSP for ${terminusApiBase}`);
      return new Response(html.replaceAll(PACKAGED_CSP_API_PLACEHOLDER, terminusApiBase), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  });
}

function requireTrustedIpc(event: IpcMainInvokeEvent): void {
  const senderFrameUrl = event.senderFrame?.url;
  if (event.sender !== mainWindow?.webContents || !senderFrameUrl || !isTrustedRendererUrl(senderFrameUrl)) {
    throw new Error("desktop IPC rejected an untrusted renderer");
  }
}

// ────────────────────────── Window lifecycle ─────────────────────────────────

type DesktopCommandId =
  | "command-palette"
  | "open-project"
  | "settings"
  | "shortcut-reference"
  | "new-task"
  | "show-changes"
  | "toggle-inspector"
  | "toggle-sidebar";

function sendDesktopCommand(commandId: DesktopCommandId): void {
  mainWindow?.webContents.send("terminus:command", commandId);
}

function emitWindowBounds(): void {
  const bounds = mainWindow?.getBounds();
  if (bounds) mainWindow?.webContents.send("terminus:window-bounds", bounds);
}

function buildApplicationMenu(): void {
  const command = (label: string, commandId: DesktopCommandId, accelerator: string): Electron.MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => sendDesktopCommand(commandId),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about", label: `About ${app.name}` },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        command("Command palette", "command-palette", "CommandOrControl+K"),
        command("New task", "new-task", "CommandOrControl+N"),
        command("Open project", "open-project", "CommandOrControl+O"),
        command("Settings", "settings", "CommandOrControl+,"),
        command("Keyboard shortcuts", "shortcut-reference", "CommandOrControl+/"),
        { type: "separator" },
        command("Show changes", "show-changes", "CommandOrControl+D"),
        command("Toggle inspector", "toggle-inspector", "CommandOrControl+RightBracket"),
        command("Toggle sidebar", "toggle-sidebar", "CommandOrControl+Backslash"),
        ...(isDev ? [
          { type: "separator" as const },
          { role: "toggleDevTools" as const },
          { role: "reload" as const },
        ] : []),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ]));
}

function createWindow(): void {
  // SPEC §5: "The default window should open large and centered, occupying
  // approximately 85–90% of the available work area while leaving a visible
  // desktop margin."
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(Math.round(screenWidth * 0.88), 1600);
  const height = Math.min(Math.round(screenHeight * 0.88), 1000);

  const window = new BrowserWindow({
    width,
    height,
    center: true,
    title: "Terminus",
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181817" : "#f5f5f2",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
    emitWindowBounds();
  });
  window.on("resize", emitWindowBounds);
  window.on("move", emitWindowBounds);
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  // SPEC §5: "Support multiple application windows if existing product
  // behavior allows it"
  // For now, single window. Multiple windows can be added later.

  // No renderer-controlled window or top-level navigation may inherit preload.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[terminus-desktop-renderer] [${level}] ${message} (${sourceId}:${line})`);
  });

  if (isDev) {
    // Keep the dev renderer from reusing a pre-migration Terminus document from
    // Electron's HTTP cache after the app rename.
    void window.loadURL(rendererEntryUrl()).catch((error: unknown) => {
      handleDesktopFatal("Terminus renderer could not load", error);
    });
    if (process.env.TERMINUS_DESKTOP_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void window.loadURL(rendererEntryUrl()).catch((error: unknown) => {
      handleDesktopFatal("Terminus renderer could not load", error);
    });
  }
}

// SPEC §24: "Theme and density changes should not require restart."
// Respect the system theme.
nativeTheme.themeSource = "system";

// ────────────────────────── IPC registration ─────────────────────────────────

function registerIpc(): void {
  // ── Terminus desktop bridge ──
  ipcMain.handle("notify", (event, { title, body }: { title: string; body: string }) => {
    requireTrustedIpc(event);
    if (Notification.isSupported() && !mainWindow?.isFocused()) {
      new Notification({ title, body }).show();
    }
    return null;
  });
  ipcMain.handle("window:minimize", (event) => {
    requireTrustedIpc(event);
    mainWindow?.minimize();
    return null;
  });
  ipcMain.handle("window:maximize", (event) => {
    requireTrustedIpc(event);
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
    return null;
  });
  ipcMain.handle("window:close", (event) => {
    requireTrustedIpc(event);
    mainWindow?.close();
    return null;
  });
  ipcMain.handle("window:getBounds", (event): WindowBounds | null => {
    requireTrustedIpc(event);
    const bounds = mainWindow?.getBounds();
    return bounds ? parseWindowBounds(bounds) : null;
  });
  ipcMain.handle("window:setBounds", (event, value: unknown): WindowBounds => {
    requireTrustedIpc(event);
    const bounds = parseWindowBounds(value);
    if (!bounds || !mainWindow) throw new Error("invalid window bounds");
    mainWindow.setBounds(bounds);
    return bounds;
  });
  ipcMain.handle("window:setTitle", (event, value: unknown): string => {
    requireTrustedIpc(event);
    const title = normalizeWindowTitle(value);
    if (!title || !mainWindow) throw new Error("invalid window title");
    mainWindow.setTitle(title);
    return title;
  });
  ipcMain.handle("theme:get", (event) => {
    requireTrustedIpc(event);
    return nativeTheme.themeSource;
  });
  ipcMain.handle("theme:set", (event, theme: "system" | "light" | "dark") => {
    requireTrustedIpc(event);
    nativeTheme.themeSource = theme;
    return nativeTheme.themeSource;
  });
  ipcMain.handle("desktop:pickDirectory", async (event) => {
    requireTrustedIpc(event);
    const options = {
      title: "Open project",
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("desktop:validateDirectoryDrop", (event, value: unknown): string | null => {
    requireTrustedIpc(event);
    return validateDirectoryPath(value);
  });

}

async function readPackagedAppIdentity(): Promise<{
  readonly version: string;
  readonly commit: string;
  readonly buildKind: DesktopRuntimeBuildKind;
}> {
  const packageJsonPath = join(app.getAppPath(), "package.json");
  const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("packaged desktop package.json must be an object");
  }
  const metadata = parsed as Readonly<Record<string, unknown>>;
  if (metadata.name !== "@terminus/desktop") throw new Error("packaged desktop identity is invalid");
  const version = requireRuntimeVersion(metadata.version);
  const commit = requireRuntimeCommit(metadata.terminusCommit);
  const buildKind = requireRuntimeBuildKind(metadata.terminusBuildKind);
  if (app.getVersion() !== version) throw new Error("Electron app version does not match package metadata");
  return { version, commit, buildKind };
}

async function startPackagedRuntime(): Promise<void> {
  if (isDev) return;
  const identity = await readPackagedAppIdentity();
  const providerCommandJson = process.env.TERMINUS_LOCAL_PROVIDER_COMMAND_JSON;
  runtimeSupervisor = await StandaloneRuntimeSupervisor.start({
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    platform: process.platform,
    architecture: process.arch,
    expectedVersion: identity.version,
    expectedCommit: identity.commit,
    expectedBuildKind: identity.buildKind,
    providerCommandJson,
    onFatalError: (error) => {
      handleDesktopFatal("Terminus runtime stopped", error);
    },
  });
  const connection = runtimeSupervisor.details();
  terminusApiBase = connection.apiBase;
  terminusControlToken = connection.controlToken;
  process.env.TERMINUS_API_BASE = terminusApiBase;
  // Ambient and generated capabilities must not be inherited by the renderer.
  delete process.env.TERMINUS_TOKEN;
  delete process.env.TERMINUS_CONTROL_TOKEN;
  delete process.env.TERMINUS_KERNEL_TOKEN;
  delete process.env.TERMINUS_KERNEL_CAP_TOKEN;
  delete process.env.TERMINUS_KERNEL_CAPABILITY_SECRET;
  delete process.env.TERMINUS_KERNEL_CONTROL_BOOTSTRAP_TOKEN;
  delete process.env.TERMINUS_LOCAL_PROVIDER_COMMAND_JSON;
}

async function launchDesktop(): Promise<void> {
  await registerPackagedRendererProtocol();
  await startPackagedRuntime();
  registerAuthenticatedTransport();
  registerIpc();
  runtimeAcceptingRequests = true;
  createWindow();
  buildApplicationMenu();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  void app.whenReady().then(launchDesktop).catch((error: unknown) => {
    handleDesktopFatal("Terminus could not start", error);
  });
}

app.on("before-quit", (event) => {
  if (runtimeShutdownStarted) return;
  sealRendererRuntimeBoundary();
  if (runtimeSupervisor === null) return;
  event.preventDefault();
  runtimeShutdownStarted = true;
  void runtimeSupervisor.stop().catch((error: unknown) => {
    console.error("[terminus-desktop] runtime shutdown failed", error);
  }).finally(() => {
    runtimeSupervisor = null;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
