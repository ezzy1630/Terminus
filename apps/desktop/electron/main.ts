/**
 * Forge Desktop — Electron main process.
 *
 * Per SPEC §2: "Electron is the application shell, not the execution
 * authority. The renderer must consume the harness through the repository's
 * existing typed interfaces."
 *
 * The main process creates the native macOS window with integrated title bar,
 * native traffic lights, and correct draggable regions. It does NOT run any
 * harness logic — all cognition, effects, and execution happen in the Forge
 * kernel (port 3040) and control plane (port 3050).
 */
import { app, BrowserWindow, shell, nativeTheme, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  // SPEC §5: "The default window should open large and centered, occupying
  // approximately 85–90% of the available work area while leaving a visible
  // desktop margin."
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(Math.round(screenWidth * 0.88), 1600);
  const height = Math.min(Math.round(screenHeight * 0.88), 1000);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    center: true,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#f7f7f8",
    show: false,
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (isDev) {
    void mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }
}

// SPEC §24: "Theme and density changes should not require restart."
// Respect the system theme.
nativeTheme.themeSource = "system";

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
