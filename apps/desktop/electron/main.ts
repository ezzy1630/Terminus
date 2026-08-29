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
 *
 * This file is wiring. The rules it wires — the menu template, window
 * routing, geometry restore, durable shell preferences, the content security
 * policy, deep links, and the crash log — live in pure modules beside it so
 * they can be tested without an Electron runtime.
 */
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isAllowedRendererPermission,
  normalizeWindowTitle,
  packagedRendererAssetPath,
  validateDirectoryPath,
} from "./shell-guards";
import { StandaloneRuntimeSupervisor } from "./runtime-supervisor";
import {
  requireRuntimeBuildKind,
  requireRuntimeCommit,
  requireRuntimeVersion,
  type DesktopRuntimeBuildKind,
} from "./runtime-contract";
import { aboutPanelOptions, buildMenuTemplate, repositoryLinksFrom, type DesktopCommandId } from "./menu";
import { resolveTrustedWindow, routingRequest, type WindowRouter } from "./window-routing";
import { resolveWindowState, type DisplayArea, type WindowState } from "./window-state";
import { ShellStateStore, withRecentProject, type ThemeChoice } from "./shell-store";
import {
  appendCrashLog,
  crashLogDirectory,
  crashLogPath,
  describeFailure,
  type CrashLogKind,
} from "./crash-log";
import { findDeepLink, parseDeepLink, taskDeepLink, type NavigationTarget } from "./deep-links";
import {
  buildContentSecurityPolicy,
  devConnectSources,
  packagedConnectSources,
  shouldApplyPolicyHeader,
  withPolicyHeader,
  DEV_RENDERER_ORIGIN,
  PACKAGED_CSP_API_PLACEHOLDER,
} from "./csp";

// __dirname is provided natively by CommonJS (Electron's main process
// is compiled to CommonJS by electron/tsconfig.json). We avoid
// `import.meta.url` so the same source compiles cleanly under both
// CommonJS and ESM module settings.
declare const __dirname: string;

const isDev = !app.isPackaged;
const APP_USER_MODEL_ID = "dev.terminus.desktop";
const PACKAGED_RENDERER_SCHEME = "terminus";
const PACKAGED_RENDERER_ENTRY = "terminus://app/index.html";
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
app.setAppUserModelId(APP_USER_MODEL_ID);

let mainWindow: BrowserWindow | null = null;
let runtimeSupervisor: StandaloneRuntimeSupervisor | null = null;
let runtimeShutdownStarted = false;
let runtimeAcceptingRequests = false;
let desktopFatalReported = false;
let shellState: ShellStateStore | null = null;
let repositoryLinks: { documentationUrl: string | null; issuesUrl: string | null } = {
  documentationUrl: null,
  issuesUrl: null,
};
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

// ────────────────────────── Crash and fatal-error log ────────────────────────

function recordCrash(kind: CrashLogKind, error: unknown): string {
  const failure = describeFailure(error);
  console.error(`[terminus-desktop] ${kind}: ${failure.message}`);
  const entry = {
    timestamp: new Date().toISOString(),
    kind,
    message: failure.message,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  };
  const logPath = crashLogPath(app.getPath("userData"));
  void appendCrashLog(logPath, entry).catch((writeError: unknown) => {
    console.error("[terminus-desktop] could not append to the crash log", writeError);
  });
  return logPath;
}

/**
 * A crashed renderer is recoverable: reloading rebuilds it from the same
 * control plane state. Offer that before offering to quit, and never leave
 * the user staring at a window that is simply blank.
 */
async function offerCrashRecovery(kind: CrashLogKind, message: string, logPath: string): Promise<void> {
  const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
  const options = {
    type: "error" as const,
    buttons: ["Reload", "Quit"],
    defaultId: 0,
    cancelId: 1,
    title: "Terminus stopped responding",
    message,
    detail: `Details were written to ${logPath}.`,
  };
  const result = parent === null
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(parent, options);
  if (result.response === 1) {
    app.quit();
    return;
  }
  if (parent === null || parent.isDestroyed()) {
    ensureMainWindow();
    return;
  }
  parent.webContents.reloadIgnoringCache();
  void recordCrashRecovery(kind);
}

async function recordCrashRecovery(kind: CrashLogKind): Promise<void> {
  await appendCrashLog(crashLogPath(app.getPath("userData")), {
    timestamp: new Date().toISOString(),
    kind,
    message: "user reloaded the renderer after a crash",
  }).catch(() => undefined);
}

function registerProcessFailureHandlers(): void {
  process.on("uncaughtException", (error: unknown) => {
    const logPath = recordCrash("uncaught-exception", error);
    void offerCrashRecovery("uncaught-exception", "Terminus hit an unexpected error.", logPath)
      .catch(() => undefined);
  });
  // A rejected promise is logged but does not tear the app down: the shell
  // supervises long-lived work whose failures are already surfaced elsewhere,
  // and a modal for every one of them would be its own defect.
  process.on("unhandledRejection", (reason: unknown) => {
    recordCrash("unhandled-rejection", reason);
  });
  app.on("child-process-gone", (_event, details) => {
    const logPath = recordCrash(
      "child-process-gone",
      `${details.type} process gone: ${details.reason} (exit ${details.exitCode})`,
    );
    if (details.reason === "clean-exit") return;
    void offerCrashRecovery("child-process-gone", "A Terminus helper process stopped unexpectedly.", logPath)
      .catch(() => undefined);
  });
}

function sealRendererRuntimeBoundary(): void {
  runtimeAcceptingRequests = false;
  terminusControlToken = "";
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    mainWindow.destroy();
  }
}

function handleDesktopFatal(title: string, error: unknown): void {
  if (desktopFatalReported) return;
  desktopFatalReported = true;
  const failure = error instanceof Error ? error : new Error(String(error));
  const logPath = runtimeSupervisor?.details().logPath;
  recordCrash("fatal", failure);
  sealRendererRuntimeBoundary();
  dialog.showErrorBox(title, logPath ? `${failure.message}\n\nRuntime log: ${logPath}` : failure.message);
  app.quit();
}

/** Attach the control capability only to the two configured Terminus origins. */
function registerAuthenticatedTransport(): void {
  if (!terminusControlToken) {
    // Fail closed: with no capability there is nothing to attach, and a
    // renderer request that reaches the control plane unauthenticated will be
    // refused there rather than silently succeeding here.
    console.warn("[terminus-desktop] no control capability configured; renderer requests will not be authenticated");
    return;
  }
  const allowedOrigin = configuredOrigin(terminusApiBase);
  if (allowedOrigin === null) throw new Error("Terminus API base is invalid");
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Only the document window carries the control capability; settings live
    // inside it now, so nothing else needs one.
    const terminusWindow = details.webContentsId === mainWindow?.webContents.id;
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
    callback({
      requestHeaders: {
        ...requestHeaders,
        Authorization: `Bearer ${terminusControlToken}`,
      },
    });
  });
}

// ────────────────────────── Content security policy ──────────────────────────

function activeContentSecurityPolicy(): string {
  return isDev
    ? buildContentSecurityPolicy({
        // Vite serves its React-refresh preamble as an inline module script,
        // so the development document cannot run under `script-src 'self'`
        // alone. Packaged documents never carry this relaxation.
        connectSources: devConnectSources(terminusApiBase),
        allowInlineScripts: true,
      })
    : buildContentSecurityPolicy({ connectSources: packagedConnectSources(terminusApiBase) });
}

/**
 * Enforce the policy as a response header, not only as a meta tag.
 *
 * The packaged `terminus://` documents get the header from the protocol
 * handler below — `webRequest` filters address http(s) URLs, and the custom
 * scheme is served by this process anyway, so attaching it at the source is
 * both simpler and certain. This filter covers every http(s) document, which
 * in development is the Vite entry and in a packaged build is nothing.
 */
function registerContentSecurityPolicyHeaders(): void {
  const policy = activeContentSecurityPolicy();
  const documentOrigins = isDev ? [DEV_RENDERER_ORIGIN, "http://127.0.0.1:5173"] : [];
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      if (!shouldApplyPolicyHeader(details.url, details.resourceType, documentOrigins)) {
        callback({});
        return;
      }
      callback({ responseHeaders: withPolicyHeader(details.responseHeaders ?? {}, policy) });
    },
  );
}

/**
 * macOS keeps preferences in their own window, not in a sheet over the
 * document. Both windows load the identical renderer entry; which root gets
 * mounted is carried by a preload argument rather than the URL, because the
 * packaged `terminus://` protocol handler refuses any entry URL with a query
 * or a fragment — a rule worth keeping.
 */
const RENDERER_VIEW_ARGUMENT = "--terminus-view=";
const RENDERER_VIBRANCY_ARGUMENT = "--terminus-vibrancy=";
const RENDERER_API_BASE_ARGUMENT = "--terminus-api-base=";

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

function isOwnedWindow(window: BrowserWindow): boolean {
  return window === mainWindow;
}

const ipcWindowRouter: WindowRouter<BrowserWindow, WebContents> = {
  windowForSender: (sender) => BrowserWindow.fromWebContents(sender),
  isOwnedWindow,
  isTrustedUrl: isTrustedRendererUrl,
};

/** The window that sent this message — never a module-level default. */
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  return resolveTrustedWindow(routingRequest(event), ipcWindowRouter);
}

async function registerPackagedRendererProtocol(): Promise<void> {
  if (isDev) return;
  const policy = activeContentSecurityPolicy();
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
      headers.set("content-security-policy", policy);
      return new Response(html.replaceAll(PACKAGED_CSP_API_PLACEHOLDER, terminusApiBase), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  });
}

/** Task identifiers are UUIDs; nothing else may be routed from a notification. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * System-wide "start a task without finding the window first".
 *
 * ⌥⌘Space used to be the combination, which is Finder's "search this Mac";
 * ⌃⌘Space is the system character picker. ⌥⌘T is claimed by nothing global.
 * Registration can still fail — another application may already own it — and
 * that is not an error worth interrupting startup for. The in-app shortcut
 * keeps working either way.
 */
const GLOBAL_NEW_TASK_ACCELERATOR = "Alt+Command+T";

function registerGlobalShortcuts(): void {
  if (process.platform !== "darwin") return;
  const registered = globalShortcut.register(GLOBAL_NEW_TASK_ACCELERATOR, () => {
    // The main window may have been closed with ⌘W while Preferences stayed
    // open; the shortcut has to be able to bring it back, not early-return.
    showMainWindow();
    sendDesktopCommand("new-task");
  });
  if (!registered) {
    console.log(`[terminus-desktop] global shortcut ${GLOBAL_NEW_TASK_ACCELERATOR} is already claimed; skipping`);
  }
}

// ────────────────────────── Window lifecycle ─────────────────────────────────

/**
 * Messages addressed to the main window before its renderer has loaded.
 *
 * A deep link, a menu command, or the global shortcut can all arrive while the
 * window is being recreated. Dropping them would make the feature look broken
 * exactly when it was most needed, so they queue and flush on load.
 */
const pendingMainWindowMessages: Array<{ channel: string; payload: unknown }> = [];
let mainRendererLoaded = false;

function sendToMainWindow(channel: string, payload: unknown): void {
  const window = ensureMainWindow();
  if (!mainRendererLoaded) {
    pendingMainWindowMessages.push({ channel, payload });
    return;
  }
  window.webContents.send(channel, payload);
}

function flushPendingMainWindowMessages(window: BrowserWindow): void {
  mainRendererLoaded = true;
  for (const message of pendingMainWindowMessages.splice(0)) {
    if (window.isDestroyed()) return;
    window.webContents.send(message.channel, message.payload);
  }
}

function sendDesktopCommand(commandId: DesktopCommandId): void {
  sendToMainWindow("terminus:command", commandId);
}

/** Show the main window, recreating it when ⌘W has closed it. */
function showMainWindow(): BrowserWindow {
  const window = ensureMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

function ensureMainWindow(): BrowserWindow {
  if (mainWindow !== null && !mainWindow.isDestroyed()) return mainWindow;
  return createMainWindow();
}

// ────────────────────────── Navigation and deep links ────────────────────────

function routeNavigation(target: NavigationTarget): void {
  showMainWindow();
  sendToMainWindow("desktop:navigate", target);
}

function handleDeepLink(value: unknown): void {
  const target = parseDeepLink(value);
  if (target === null) {
    console.warn(`[terminus-desktop] ignoring an unroutable deep link: ${String(value)}`);
    return;
  }
  routeNavigation(target);
}

// ────────────────────────── Durable shell preferences ────────────────────────

function requireShellState(): ShellStateStore {
  if (shellState === null) throw new Error("shell preferences were read before they were loaded");
  return shellState;
}

function displayWorkAreas(): { areas: DisplayArea[]; primary: DisplayArea } {
  const areas = screen.getAllDisplays().map((display) => display.workArea);
  return { areas, primary: screen.getPrimaryDisplay().workArea };
}

function captureWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // `getNormalBounds` is the pre-maximize geometry, which is the only one
  // worth restoring: restoring a maximized window's outer bounds and then
  // un-maximizing it would leave the window filling the screen forever.
  const bounds = window.getNormalBounds();
  requireShellState().update((state) => ({
    ...state,
    window: {
      bounds,
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    },
  }));
}

function noteRecentProject(path: string): void {
  const store = requireShellState();
  const before = store.state.recentProjects;
  const after = store.update((state) => withRecentProject(state, path)).recentProjects;
  if (after === before) return;
  app.addRecentDocument(path);
  refreshApplicationMenu();
}

// ────────────────────────── Application menu ─────────────────────────────────

function refreshApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    appName: app.name,
    isDev,
    recentProjects: shellState?.state.recentProjects ?? [],
    documentationUrl: repositoryLinks.documentationUrl,
    issuesUrl: repositoryLinks.issuesUrl,
    actions: {
      sendCommand: sendDesktopCommand,
      // Settings are a sheet inside the document window, so the menu asks the
      // renderer to open them rather than raising a second window.
      openSettings: (category) => sendDesktopCommand(category === "shortcuts" ? "shortcut-reference" : "settings"),
      showMainWindow: () => { showMainWindow(); },
      openRecentProject: (path) => {
        noteRecentProject(path);
        routeNavigation({ kind: "project-path", path });
      },
      clearRecentProjects: () => {
        app.clearRecentDocuments();
        requireShellState().update((state) => ({ ...state, recentProjects: [] }));
        refreshApplicationMenu();
      },
      openLogsFolder: () => {
        void shell.openPath(crashLogDirectory(app.getPath("userData"))).then((failure) => {
          if (failure.length > 0) console.error(`[terminus-desktop] could not open the logs folder: ${failure}`);
        });
      },
      openExternal: openExternalLink,
    },
  })));
}

/**
 * Renderer privileges. Identical for every window this app opens: context
 * isolation on, node integration off, sandbox on. `view` selects which root
 * the shared bundle mounts and travels as a preload argument, because the
 * packaged protocol handler refuses an entry URL carrying a query. The
 * control origin and the initial settings category travel the same way — the
 * category in particular cannot be sent on `ready-to-show`, which fires
 * before React has mounted a listener.
 */
function rendererPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [
      `${RENDERER_VIEW_ARGUMENT}main`,
      `${RENDERER_VIBRANCY_ARGUMENT}${vibrancyEnabled() ? "on" : "off"}`,
      `${RENDERER_API_BASE_ARGUMENT}${terminusApiBase}`,
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
function vibrancyEnabled(): boolean {
  // macOS's "Reduce transparency" is an accessibility request, not a
  // preference to override.
  if (process.platform !== "darwin") return false;
  return !nativeTheme.prefersReducedTransparency;
}

function macChrome(): Pick<Electron.BrowserWindowConstructorOptions, "vibrancy" | "visualEffectState" | "backgroundColor"> {
  if (!vibrancyEnabled()) {
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
function hardenWebContents(window: BrowserWindow, label: string): void {
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
  window.webContents.on("render-process-gone", (_event, details) => {
    const logPath = recordCrash(
      "render-process-gone",
      `${label} renderer gone: ${details.reason} (exit ${details.exitCode})`,
    );
    if (details.reason === "clean-exit") return;
    void offerCrashRecovery("render-process-gone", `The ${label} window stopped responding.`, logPath)
      .catch(() => undefined);
  });
}

function createMainWindow(): BrowserWindow {
  const { areas, primary } = displayWorkAreas();
  // SPEC §5: "The default window should open large and centered, occupying
  // approximately 85–90% of the available work area while leaving a visible
  // desktop margin." A restored window keeps where the user put it, unless
  // that place is no longer on any attached display.
  const placement: WindowState = resolveWindowState(shellState?.state.window ?? null, areas, primary);

  const window = new BrowserWindow({
    ...placement.bounds,
    title: "Terminus",
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    ...macChrome(),
    show: false,
    webPreferences: rendererPreferences(),
  });
  mainWindow = window;
  mainRendererLoaded = false;

  if (placement.fullScreen) {
    window.setFullScreen(true);
  } else if (placement.maximized) {
    window.maximize();
  }

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.webContents.on("did-finish-load", () => {
    flushPendingMainWindowMessages(window);
  });
  window.webContents.on("did-start-loading", () => {
    mainRendererLoaded = false;
  });

  const capture = (): void => captureWindowState(window);
  window.on("resize", capture);
  window.on("move", capture);
  window.on("maximize", capture);
  window.on("unmaximize", capture);
  window.on("enter-full-screen", capture);
  window.on("leave-full-screen", capture);
  window.on("close", () => {
    captureWindowState(window);
    void shellState?.flush().catch((error: unknown) => {
      console.error("[terminus-desktop] could not persist window state", error);
    });
  });
  window.once("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainRendererLoaded = false;
    }
  });

  // No renderer-controlled window or top-level navigation may inherit preload.
  hardenWebContents(window, "main");

  void window.loadURL(rendererEntryUrl()).catch((error: unknown) => {
    handleDesktopFatal("Terminus renderer could not load", error);
  });
  // Opening DevTools attaches the inspector to the renderer for the whole
  // session, which keeps V8 in a de-optimised, fully instrumented mode and
  // makes every React commit noticeably slower — the cost lands on exactly the
  // streaming-transcript path we care most about. It stays one keystroke away
  // (View ▸ Toggle Developer Tools) and opts in with TERMINUS_DESKTOP_DEVTOOLS=1,
  // rather than taxing every dev run by default.
  if (isDev && process.env.TERMINUS_DESKTOP_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
  return window;
}

// ────────────────────────── Workspace directories ────────────────────────────

interface DirectoryValidation {
  readonly ok: boolean;
  readonly isGit: boolean;
  readonly canonicalPath: string | null;
}

const INVALID_DIRECTORY: DirectoryValidation = { ok: false, isGit: false, canonicalPath: null };

/**
 * Resolve a candidate project directory.
 *
 * `isGit` decides whether the renderer registers the workspace as `local_git`
 * or `local_directory`, and getting that wrong is not recoverable — the
 * control plane rejects the second registration of the same path under a
 * different kind. So the answer comes from the filesystem, not a guess.
 */
async function validateDirectory(value: unknown): Promise<DirectoryValidation> {
  const candidate = validateDirectoryPath(value);
  if (candidate === null) return INVALID_DIRECTORY;
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
    if (!(await stat(canonicalPath)).isDirectory()) return INVALID_DIRECTORY;
  } catch {
    return INVALID_DIRECTORY;
  }
  if (validateDirectoryPath(canonicalPath) === null) return INVALID_DIRECTORY;
  let isGit = false;
  try {
    await access(join(canonicalPath, ".git"));
    isGit = true;
  } catch {
    isGit = false;
  }
  return { ok: true, isGit, canonicalPath };
}

// ────────────────────────── IPC registration ─────────────────────────────────

function registerIpc(): void {
  ipcMain.handle("notify", (event, payload: { title: string; body: string; taskId?: unknown }) => {
    const window = senderWindow(event);
    if (!Notification.isSupported() || window.isFocused()) return null;
    const notification = new Notification({ title: payload.title, body: payload.body });
    const taskId = typeof payload.taskId === "string" && TASK_ID_PATTERN.test(payload.taskId)
      ? payload.taskId
      : null;
    // A notification that only makes noise is a worse version of a badge.
    // Clicking one raises the window and opens the task it is about — through
    // the same deep link an external caller would use, so there is one path.
    notification.on("click", () => {
      if (taskId === null) {
        showMainWindow();
        return;
      }
      handleDeepLink(taskDeepLink(taskId));
    });
    notification.show();
    return null;
  });
  ipcMain.handle("desktop:setAttentionCount", (event, value: unknown) => {
    senderWindow(event);
    // The Dock badge is the only part of this app visible when the window is
    // not. Anything that needs a person should reach them there.
    const count = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    app.setBadgeCount(count);
    return count;
  });
  ipcMain.handle("window:close", (event) => {
    // Routed to the sending window: Preferences' Close must close Preferences.
    senderWindow(event).close();
    return null;
  });
  ipcMain.handle("window:setTitle", (event, value: unknown): string => {
    const window = senderWindow(event);
    const title = normalizeWindowTitle(value);
    if (!title) throw new Error("invalid window title");
    window.setTitle(title);
    return title;
  });
  ipcMain.handle("theme:get", (event): ThemeChoice => {
    senderWindow(event);
    return nativeTheme.themeSource;
  });
  ipcMain.handle("theme:set", (event, value: unknown): ThemeChoice => {
    senderWindow(event);
    if (value !== "system" && value !== "light" && value !== "dark") {
      throw new Error("invalid theme choice");
    }
    nativeTheme.themeSource = value;
    // Mirrored under userData so the next launch can paint the right window
    // background before any renderer exists to be asked.
    requireShellState().update((state) => ({ ...state, theme: value }));
    return nativeTheme.themeSource;
  });
  ipcMain.handle("desktop:pickDirectory", async (event) => {
    const window = senderWindow(event);
    const result = await dialog.showOpenDialog(window, {
      title: "Open project",
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    });
    const picked = result.canceled ? null : result.filePaths[0] ?? null;
    if (picked !== null) noteRecentProject(picked);
    return picked;
  });
  ipcMain.handle("desktop:validateDirectory", async (event, value: unknown): Promise<DirectoryValidation> => {
    senderWindow(event);
    return validateDirectory(value);
  });
  ipcMain.handle("desktop:noteRecentProject", (event, value: unknown): readonly string[] => {
    senderWindow(event);
    const path = validateDirectoryPath(value);
    if (path === null) throw new Error("invalid project path");
    noteRecentProject(path);
    return requireShellState().state.recentProjects;
  });
}

async function readPackagedAppIdentity(): Promise<{
  readonly version: string;
  readonly commit: string;
  readonly buildKind: DesktopRuntimeBuildKind;
}> {
  const metadata = await readAppMetadata();
  if (metadata.name !== "@terminus/desktop") throw new Error("packaged desktop identity is invalid");
  const version = requireRuntimeVersion(metadata.version);
  const commit = requireRuntimeCommit(metadata.terminusCommit);
  const buildKind = requireRuntimeBuildKind(metadata.terminusBuildKind);
  if (app.getVersion() !== version) throw new Error("Electron app version does not match package metadata");
  return { version, commit, buildKind };
}

async function readAppMetadata(): Promise<Readonly<Record<string, unknown>>> {
  const packageJsonPath = join(app.getAppPath(), "package.json");
  const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("desktop package.json must be an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/** The packaged build commit, or null in development where there is none. */
function buildCommit(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return requireRuntimeCommit(value);
  } catch (error: unknown) {
    console.error("[terminus-desktop] package metadata carries an invalid build commit", error);
    return null;
  }
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

/** Refuse every OS capability except the notifications the app actually sends. */
function registerPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isAllowedRendererPermission(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => (
    isAllowedRendererPermission(permission)
  ));
}

async function launchDesktop(): Promise<void> {
  shellState = ShellStateStore.forUserData(app.getPath("userData"));
  const preferences = await shellState.load();
  // SPEC §24: "Theme and density changes should not require restart." The
  // persisted choice is applied before the first window exists, so a Light
  // install no longer flashes the dark background on every launch.
  nativeTheme.themeSource = preferences.theme;
  for (const path of preferences.recentProjects) app.addRecentDocument(path);

  await startPackagedRuntime();
  registerContentSecurityPolicyHeaders();
  await registerPackagedRendererProtocol();
  registerAuthenticatedTransport();
  registerPermissionHandlers();
  registerIpc();
  runtimeAcceptingRequests = true;

  const metadata = await readAppMetadata().catch((error: unknown) => {
    console.error("[terminus-desktop] could not read package metadata", error);
    return {} as Readonly<Record<string, unknown>>;
  });
  repositoryLinks = repositoryLinksFrom(metadata);
  app.setAboutPanelOptions(aboutPanelOptions({
    appName: app.name,
    version: app.getVersion(),
    commit: buildCommit(metadata.terminusCommit),
  }));

  createMainWindow();
  refreshApplicationMenu();
  registerGlobalShortcuts();

  nativeTheme.on("updated", () => {
    const payload = {
      themeSource: nativeTheme.themeSource,
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    };
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("terminus:native-theme", payload);
  });

  app.on("activate", () => {
    // Not `getAllWindows().length === 0`: with Preferences open and the main
    // window closed, that test is false and the document window can never
    // come back.
    showMainWindow();
  });
}

// ────────────────────────── Process lifecycle ────────────────────────────────

registerProcessFailureHandlers();

// `terminus://task/<id>` and `terminus://project/<id>`. macOS delivers these
// through `open-url`, which can fire before `whenReady`, so the handler is
// installed at module scope and the message queue absorbs the ordering.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

const ownsSingleInstance = app.requestSingleInstanceLock();
if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const target = findDeepLink(argv);
    if (target === null) {
      showMainWindow();
      return;
    }
    routeNavigation(target);
  });
  void app.whenReady().then(async () => {
    if (!app.isDefaultProtocolClient(PACKAGED_RENDERER_SCHEME)) {
      app.setAsDefaultProtocolClient(PACKAGED_RENDERER_SCHEME);
    }
    await launchDesktop();
  }).catch((error: unknown) => {
    handleDesktopFatal("Terminus could not start", error);
  });
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", (event) => {
  if (runtimeShutdownStarted) return;
  void shellState?.flush().catch((error: unknown) => {
    console.error("[terminus-desktop] could not persist shell preferences", error);
  });
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
