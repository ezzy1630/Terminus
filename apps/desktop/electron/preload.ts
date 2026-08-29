/**
 * Terminus Desktop — Electron preload script.
 *
 * Per SPEC §2: "The renderer must consume the harness through the repository's
 * existing typed interfaces. Do not move harness logic into React components
 * or Electron renderer code."
 *
 * The preload exposes one constrained presentation bridge (`terminusDesktop`)
 * so the renderer can read the control-plane origin, send native
 * notifications, close its own window, read and set the theme, choose and
 * classify a project directory, and receive navigation and menu commands.
 *
 * Process execution, workspace filesystem access, and computer-use capture
 * are intentionally absent. Those effects require kernel-backed contracts.
 *
 * All harness logic stays in the Rust kernel + TS control plane. The renderer
 * uses @terminus/public-client to talk to the control plane over HTTP/SSE.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { DesktopCommandId } from "./menu";
import type { NavigationTarget } from "./deep-links";

/**
 * Launch arguments the main process attaches to this window.
 *
 * Carried as launch arguments rather than in the URL: the packaged
 * `terminus://` protocol handler refuses an entry URL with a query or a
 * fragment, and relaxing that to pass a view name would be a poor trade.
 */
function launchArgument(prefix: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function parseLocalOrigin(value: string | undefined): { origin: string | null; error: string | null } {
  if (value === undefined || value.length === 0) {
    return { origin: null, error: "The Terminus control origin was not supplied to this window." };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { origin: null, error: `The Terminus control origin is not a URL: ${value}` };
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
    return { origin: null, error: `The Terminus control origin is not an approved local origin: ${value}` };
  }
  return { origin: url.origin, error: null };
}

/**
 * The control origin fails closed.
 *
 * There used to be a `http://127.0.0.1:3050` default here, so a window
 * launched without a configured origin would quietly talk to whatever was
 * listening on that port. With no origin the bridge reports the failure and
 * the renderer has nothing to send requests to.
 */
const API_BASE = parseLocalOrigin(launchArgument("--terminus-api-base="));
/** Whether this window is backed by a vibrant material the renderer may paint over. */
const RENDERER_VIBRANCY = launchArgument("--terminus-vibrancy=") === "on";

type ThemeChoice = "system" | "light" | "dark";

interface NativeThemeState {
  themeSource: ThemeChoice;
  shouldUseDarkColors: boolean;
}

interface DirectoryValidation {
  ok: boolean;
  isGit: boolean;
  canonicalPath: string | null;
}

function subscribe<Payload>(
  channel: string,
  callback: (payload: Payload) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, payload: Payload): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// ────────────────────────── terminusDesktop ─────────────────────────────────

contextBridge.exposeInMainWorld("terminusDesktop", {
  /** null when this window was launched without an approved control origin. */
  apiBase: API_BASE.origin,
  /** Why `apiBase` is null, for the renderer to surface rather than hide. */
  apiBaseError: API_BASE.error,
  isMac: process.platform === "darwin",
  vibrancy: RENDERER_VIBRANCY,
  // Native notification bridge (SPEC §5: "Use native notifications only when
  // the app is unfocused or a task requires attention"). `taskId` makes the
  // notification actionable: clicking it raises the window on that task.
  notify: (title: string, body: string, taskId?: string): Promise<unknown> =>
    ipcRenderer.invoke("notify", { title, body, taskId }),
  setAttentionCount: (count: number): Promise<unknown> =>
    ipcRenderer.invoke("desktop:setAttentionCount", count),
  /** Deep links, notification clicks, and File ▸ Open Recent all arrive here. */
  onNavigate: (callback: (target: NavigationTarget) => void): (() => void) =>
    subscribe<NavigationTarget>("desktop:navigate", callback),
  onOpenTask: (callback: (taskId: string) => void): (() => void) =>
    subscribe<NavigationTarget>("desktop:navigate", (target) => {
      if (target.kind === "task") callback(target.taskId);
    }),
  onNativeThemeChange: (callback: (state: NativeThemeState) => void): (() => void) =>
    subscribe<NativeThemeState>("terminus:native-theme", callback),
  /** Closes the window that asked, which for Preferences is Preferences. */
  windowClose: (): Promise<unknown> => ipcRenderer.invoke("window:close"),
  setWindowTitle: (title: string): Promise<string> => ipcRenderer.invoke("window:setTitle", title),
  getTheme: (): Promise<ThemeChoice> => ipcRenderer.invoke("theme:get"),
  setTheme: (theme: ThemeChoice): Promise<ThemeChoice> => ipcRenderer.invoke("theme:set", theme),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("desktop:pickDirectory"),
  /** Resolve a directory and report whether it is a git working tree. */
  validateDirectory: (path: string): Promise<DirectoryValidation> =>
    ipcRenderer.invoke("desktop:validateDirectory", path),
  noteRecentProject: (path: string): Promise<readonly string[]> =>
    ipcRenderer.invoke("desktop:noteRecentProject", path),
  onDirectoryDrop: (callback: (path: string) => void): (() => void) => {
    const allowDrop = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const listener = (event: DragEvent): void => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const candidate = files[0];
      if (files.length !== 1 || candidate === undefined) return;
      event.preventDefault();
      // `File.path` was removed in Electron 32, which is why dropping a folder
      // did nothing at all. `webUtils.getPathForFile` is its replacement.
      const droppedPath = webUtils.getPathForFile(candidate);
      if (droppedPath.length === 0) return;
      void ipcRenderer.invoke("desktop:validateDirectory", droppedPath).then((result: unknown) => {
        const validation = result as DirectoryValidation | undefined;
        if (validation?.ok === true && typeof validation.canonicalPath === "string") {
          callback(validation.canonicalPath);
        }
      });
    };
    document.addEventListener("dragover", allowDrop, true);
    document.addEventListener("drop", listener, true);
    return () => {
      document.removeEventListener("dragover", allowDrop, true);
      document.removeEventListener("drop", listener, true);
    };
  },
  onCommand: (callback: (commandId: DesktopCommandId) => void): (() => void) =>
    subscribe<DesktopCommandId>("terminus:command", callback),
});
