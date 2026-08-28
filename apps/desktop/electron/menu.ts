/**
 * Terminus Desktop — application menu template.
 *
 * Pure: it takes what the shell knows and returns a template. No Electron
 * runtime, no module state, so every accelerator and every enablement rule is
 * a unit test rather than a thing discovered by clicking.
 *
 * Two rules this template exists to enforce:
 *   - ⌘1–⌘9 belong to the renderer (task selection). The Window menu must not
 *     claim ⌘1 for "bring Terminus forward".
 *   - A menu item with nothing to act on is disabled, not silently inert.
 */
import type { MenuItemConstructorOptions } from "electron";

export type DesktopCommandId =
  | "command-palette"
  | "open-project"
  | "settings"
  | "shortcut-reference"
  | "new-task"
  | "stop-run"
  | "show-changes"
  | "toggle-inspector"
  | "toggle-sidebar";

export interface MenuActions {
  /** Deliver a command to the main window, creating it if it is gone. */
  readonly sendCommand: (commandId: DesktopCommandId) => void;
  readonly openSettings: (category?: string) => void;
  /** Show and focus the main window, recreating it when it has been closed. */
  readonly showMainWindow: () => void;
  readonly openRecentProject: (path: string) => void;
  readonly clearRecentProjects: () => void;
  readonly openLogsFolder: () => void;
  readonly openExternal: (url: string) => void;
}

export interface MenuTemplateOptions {
  readonly appName: string;
  readonly isDev: boolean;
  /** Most-recent-first absolute project paths. */
  readonly recentProjects: readonly string[];
  /**
   * Where Help ▸ documentation should point. `null` removes the item: an
   * entry that opens a 404 is worse than an entry that is not there.
   */
  readonly documentationUrl: string | null;
  readonly issuesUrl: string | null;
  readonly actions: MenuActions;
}

export interface AboutPanelOptions {
  readonly applicationName: string;
  readonly applicationVersion: string;
  readonly version: string;
}

/** Version in the headline, build commit in the secondary line. */
export function aboutPanelOptions(input: {
  readonly appName: string;
  readonly version: string;
  readonly commit: string | null;
}): AboutPanelOptions {
  return {
    applicationName: input.appName,
    applicationVersion: input.version,
    version: input.commit === null ? "development build" : input.commit.slice(0, 12),
  };
}

export function buildMenuTemplate(options: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const { actions } = options;
  const command = (
    label: string,
    commandId: DesktopCommandId,
    accelerator: string,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => actions.sendCommand(commandId),
  });

  const helpSubmenu: MenuItemConstructorOptions[] = [
    command("Keyboard shortcuts", "shortcut-reference", "CommandOrControl+/"),
    { type: "separator" },
    { label: "Open logs folder", click: () => actions.openLogsFolder() },
  ];
  if (options.documentationUrl !== null) {
    const url = options.documentationUrl;
    helpSubmenu.push({ label: `${options.appName} documentation`, click: () => actions.openExternal(url) });
  }
  if (options.issuesUrl !== null) {
    const url = options.issuesUrl;
    helpSubmenu.push({ label: "Report an issue", click: () => actions.openExternal(url) });
  }

  return [
    {
      label: options.appName,
      submenu: [
        { role: "about", label: `About ${options.appName}` },
        { type: "separator" },
        // macOS puts preferences under the app menu, at ⌘,.
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => actions.openSettings() },
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
      label: "File",
      submenu: [
        command("New task", "new-task", "CommandOrControl+N"),
        command("Open project…", "open-project", "CommandOrControl+O"),
        openRecentItem(options),
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
        { type: "separator" },
        // Available in packaged builds too: a renderer that died leaves a
        // blank window, and reloading it is the only recovery that does not
        // involve quitting the application.
        { role: "reload", accelerator: "CommandOrControl+R" },
        ...(options.isDev ? [{ role: "toggleDevTools" as const }] : []),
      ],
    },
    {
      label: "Task",
      submenu: [
        command("Stop run", "stop-run", "CommandOrControl+."),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        // Deliberately unaccelerated: ⌘1–⌘9 select tasks in the renderer.
        { label: options.appName, click: () => actions.showMainWindow() },
        { label: "Settings", click: () => actions.openSettings() },
        { type: "separator" },
        { role: "front" },
      ],
    },
    {
      label: "Help",
      role: "help",
      submenu: helpSubmenu,
    },
  ];
}

function openRecentItem(options: MenuTemplateOptions): MenuItemConstructorOptions {
  if (options.recentProjects.length === 0) {
    return { label: "Open Recent", enabled: false };
  }
  const { actions } = options;
  const entries: MenuItemConstructorOptions[] = options.recentProjects.map((path) => ({
    label: recentProjectLabel(path),
    toolTip: path,
    click: () => actions.openRecentProject(path),
  }));
  entries.push({ type: "separator" }, { label: "Clear Menu", click: () => actions.clearRecentProjects() });
  return { label: "Open Recent", submenu: entries };
}

/** The directory name, with enough of the parent to tell two apart. */
export function recentProjectLabel(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.slice(-2).join("/") || path;
}
/**
 * Help menu destinations.
 *
 * Derived from the package's declared repository so the menu can never point
 * at a repository that does not exist. Absent metadata removes the items
 * rather than shipping a placeholder link.
 */
export function repositoryLinksFrom(metadata: Readonly<Record<string, unknown>>): {
  documentationUrl: string | null;
  issuesUrl: string | null;
} {
  const declared = metadata.repository;
  const raw = typeof declared === "string"
    ? declared
    : typeof declared === "object" && declared !== null && !Array.isArray(declared)
      ? (declared as Record<string, unknown>).url
      : undefined;
  if (typeof raw !== "string") return { documentationUrl: null, issuesUrl: null };
  const normalized = raw.replace(/^git\+/, "").replace(/\.git$/, "");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return { documentationUrl: null, issuesUrl: null };
  }
  if (url.protocol !== "https:") return { documentationUrl: null, issuesUrl: null };
  const base = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  return { documentationUrl: `${base}#readme`, issuesUrl: `${base}/issues/new` };
}

