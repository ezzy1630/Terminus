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
import { app, BrowserWindow, globalShortcut, Menu, nativeTheme, screen, ipcMain, dialog, Notification, session, net, protocol, shell, type IpcMainInvokeEvent } from "electron";
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
let settingsWindow: BrowserWindow | null = null;
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
    // Settings reads and writes provider configuration, so it needs the same
    // control capability the main window has — and nothing else does.
    const terminusWindow = details.webContentsId === mainWindow?.webContents.id
      || details.webContentsId === settingsWindow?.webContents.id;
    if (!terminusWindow) {
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
  for (const window of [settingsWindow, mainWindow]) {
    if (window && !window.isDestroyed()) {
      window.hide();
      window.destroy();
    }
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

/**
 * macOS keeps preferences in their own window, not in a sheet over the
 * document. Both windows load the identical renderer entry; which root gets
 * mounted is carried by a preload argument rather than the URL, because the
 * packaged `terminus://` protocol handler refuses any entry URL with a query
 * or a fragment — a rule worth keeping.
 */
type RendererView = "main" | "settings";

const RENDERER_VIEW_ARGUMENT = "--terminus-view=";
const RENDERER_VIBRANCY_ARGUMENT = "--terminus-vibrancy=";

function rendererEntryUrl(): string {
  if (!isDev) return PACKAGED_RENDERER_ENTRY;
  // `?mock=true` populates the renderer's design fixtures (src/lib/dev-mock.ts).
  // Dev only, and opt-in through the environment, so no fabricated session can
  // reach a real install.
  const mock = process.env.TERMINUS_DESKTOP_MOCK === "1" ? "&mock=true" : "";
  return `http://localhost:5173/?app=terminus${mock}`;
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

function isTerminusWindow(contents: Electron.WebContents | undefined): boolean {
  if (!contents) return false;
  return contents === mainWindow?.webContents || contents === settingsWindow?.webContents;
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
  if (!isTerminusWindow(event.sender) || !senderFrameUrl || !isTrustedRendererUrl(senderFrameUrl)) {
    throw new Error("desktop IPC rejected an untrusted renderer");
  }
}

/** Task identifiers are UUIDs; nothing else may be routed from a notification. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTINGS_CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * System-wide "start a task without finding the window first".
 *
 * Registration can fail — another application may already own the
 * combination — and that is not an error worth interrupting startup for. The
 * in-app shortcut keeps working either way.
 */
const GLOBAL_NEW_TASK_ACCELERATOR = "Alt+Command+Space";

function registerGlobalShortcuts(): void {
  if (process.platform !== "darwin") return;
  const registered = globalShortcut.register(GLOBAL_NEW_TASK_ACCELERATOR, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendDesktopCommand("new-task");
  });
  if (!registered) {
    console.log(`[terminus-desktop] global shortcut ${GLOBAL_NEW_TASK_ACCELERATOR} is already claimed; skipping`);
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
        // macOS puts preferences under the app menu, at ⌘,. It was under View,
        // which is not where anyone looks for it.
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => openSettingsWindow() },
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
      // Every macOS app has a File menu. Its absence was one of the clearest
      // signals that this window was not a native application.
      label: "File",
      submenu: [
        command("New task", "new-task", "CommandOrControl+N"),
        command("Open project…", "open-project", "CommandOrControl+O"),
        { type: "separator" },
        { role: "close" },
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
        { label: "Terminus", accelerator: "CommandOrControl+1", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { label: "Settings", click: () => openSettingsWindow() },
        { type: "separator" },
        { role: "front" },
      ],
    },
    {
      label: "Help",
      role: "help",
      submenu: [
        command("Keyboard shortcuts", "shortcut-reference", "CommandOrControl+/"),
        { type: "separator" },
        {
          label: "Terminus documentation",
          click: () => { void shell.openExternal("https://github.com/terminus-dev/terminus#readme"); },
        },
        {
          label: "Report an issue",
          click: () => { void shell.openExternal("https://github.com/terminus-dev/terminus/issues/new"); },
        },
      ],
    },
  ]));
}

/**
 * Renderer privileges. Identical for every window this app opens: context
 * isolation on, node integration off, sandbox on. `view` selects which root
 * the shared bundle mounts and travels as a preload argument, because the
 * packaged protocol handler refuses an entry URL carrying a query.
 */
function rendererPreferences(view: RendererView): Electron.WebPreferences {
  return {
    preload: join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [
      `${RENDERER_VIEW_ARGUMENT}${view}`,
      `${RENDERER_VIBRANCY_ARGUMENT}${vibrancyEnabled(view) ? "on" : "off"}`,
    ],
  };
}

/**
 * Native window material.
 *
 * On macOS the window is vibrant and the renderer paints its chrome
 * translucently over it, which is the single largest difference between "an
 * app" and "a web page in a frame". Elsewhere vibrancy does not exist and a
 * transparent background colour would produce a see-through window, so those
 * platforms keep the opaque colour they had.
 */
function vibrancyEnabled(view: RendererView): boolean {
  // Preferences are an ordinary opaque window; only the document window
  // paints its chrome for a vibrant material. And macOS's "Reduce
  // transparency" is an accessibility request, not a preference to override.
  if (view !== "main" || process.platform !== "darwin") return false;
  return !nativeTheme.prefersReducedTransparency;
}

function macChrome(view: RendererView): Pick<Electron.BrowserWindowConstructorOptions, "vibrancy" | "visualEffectState" | "backgroundColor"> {
  if (!vibrancyEnabled(view)) {
    return { backgroundColor: nativeTheme.shouldUseDarkColors ? "#181817" : "#f5f5f2" };
  }
  return {
    vibrancy: "sidebar",
    // Keep the material lit while the window is in the background; a chrome
    // that greys out whenever focus moves reads as an inactive screenshot.
    visualEffectState: "active",
    backgroundColor: "#00000000",
  };
}

/**
 * Never open a renderer window. An http(s) link the user clicked goes to the
 * system browser instead — a link in an agent's answer previously did nothing
 * at all, because every window-open request was denied and there was no other
 * path out. Every other scheme (file:, javascript:, custom handlers) is still
 * refused outright: this content comes from a model, so the allowed set is
 * stated positively rather than as a blocklist.
 */
function openExternalLink(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
  void shell.openExternal(parsed.toString());
}

/** Deny renderer-opened windows and untrusted navigation on every window. */
function hardenWebContents(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[terminus-desktop-renderer] [${level}] ${message} (${sourceId}:${line})`);
  });
}

/**
 * Open (or focus) the preferences window.
 *
 * Preferences used to be a full-window overlay inside the document window,
 * which meant they could not be left open beside the work they describe and
 * did not behave like anything else on the system: no ⌘W, no separate entry
 * in Window, no independent position.
 */
function openSettingsWindow(category?: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (category) settingsWindow.webContents.send("terminus:settings-category", category);
    return;
  }
  const window = new BrowserWindow({
    width: 760,
    height: 580,
    minWidth: 620,
    minHeight: 440,
    title: "Terminus Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    ...macChrome("settings"),
    show: false,
    // Deliberately not a child window: a Preferences window on macOS is
    // independent — it can be sent behind the document window and carries
    // its own entry in Window. `parent` would pin it permanently on top.
    webPreferences: rendererPreferences("settings"),
  });
  settingsWindow = window;
  hardenWebContents(window);
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.show();
    if (category) window.webContents.send("terminus:settings-category", category);
  });
  window.once("closed", () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  void window.loadURL(rendererEntryUrl()).catch((error: unknown) => {
    handleDesktopFatal("Terminus settings could not load", error);
  });
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
    ...macChrome("main"),
    show: false,
    webPreferences: rendererPreferences("main"),
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
  hardenWebContents(window);

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
  ipcMain.handle("notify", (event, payload: { title: string; body: string; taskId?: unknown }) => {
    requireTrustedIpc(event);
    if (!Notification.isSupported() || mainWindow?.isFocused()) return null;
    const notification = new Notification({ title: payload.title, body: payload.body });
    const taskId = typeof payload.taskId === "string" && TASK_ID_PATTERN.test(payload.taskId)
      ? payload.taskId
      : null;
    // A notification that only makes noise is a worse version of a badge.
    // Clicking one raises the window and opens the task it is about.
    notification.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (taskId) mainWindow.webContents.send("terminus:open-task", taskId);
    });
    notification.show();
    return null;
  });
  ipcMain.handle("desktop:openSettings", (event, category: unknown) => {
    requireTrustedIpc(event);
    openSettingsWindow(typeof category === "string" && SETTINGS_CATEGORY_PATTERN.test(category) ? category : undefined);
    return null;
  });
  ipcMain.handle("desktop:setAttentionCount", (event, value: unknown) => {
    requireTrustedIpc(event);
    // The Dock badge is the only part of this app visible when the window is
    // not. Anything that needs a person should reach them there.
    const count = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    app.setBadgeCount(count);
    return count;
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
  registerGlobalShortcuts();
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

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

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
