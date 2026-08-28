import { describe, expect, test, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  aboutPanelOptions,
  buildMenuTemplate,
  recentProjectLabel,
  repositoryLinksFrom,
  type MenuActions,
  type MenuTemplateOptions,
} from "../electron/menu";

function actionSpies(): MenuActions & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (...args: unknown[]): void => {
    calls[name] = args;
  };
  return {
    calls,
    sendCommand: record("sendCommand") as MenuActions["sendCommand"],
    openSettings: record("openSettings") as MenuActions["openSettings"],
    showMainWindow: record("showMainWindow") as MenuActions["showMainWindow"],
    openRecentProject: record("openRecentProject") as MenuActions["openRecentProject"],
    clearRecentProjects: record("clearRecentProjects") as MenuActions["clearRecentProjects"],
    openLogsFolder: record("openLogsFolder") as MenuActions["openLogsFolder"],
    openExternal: record("openExternal") as MenuActions["openExternal"],
  };
}

function template(overrides: Partial<MenuTemplateOptions> = {}): MenuItemConstructorOptions[] {
  return buildMenuTemplate({
    appName: "Terminus",
    isDev: false,
    recentProjects: [],
    documentationUrl: null,
    issuesUrl: null,
    actions: actionSpies(),
    ...overrides,
  });
}

function submenu(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const item = items.find((entry) => entry.label === label);
  if (item === undefined) throw new Error(`menu has no "${label}"`);
  return Array.isArray(item.submenu) ? item.submenu : [];
}

function walk(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? walk(item.submenu) : [])]);
}

function accelerators(items: readonly MenuItemConstructorOptions[]): string[] {
  return walk(items)
    .map((item) => item.accelerator)
    .filter((value): value is string => typeof value === "string");
}

describe("application menu", () => {
  test("has the expected top-level menus", () => {
    expect(template().map((item) => item.label))
      .toEqual(["Terminus", "File", "Edit", "View", "Task", "Window", "Help"]);
  });

  test("leaves the number accelerators to the renderer's task selection", () => {
    const claimed = accelerators(template());
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(claimed).not.toContain(`CommandOrControl+${digit}`);
    }
  });

  test("Window ▸ Terminus is still there, just unaccelerated", () => {
    const item = submenu(template(), "Window").find((entry) => entry.label === "Terminus");
    expect(item).toBeDefined();
    expect(item?.accelerator).toBeUndefined();
  });

  test("Window ▸ Terminus recreates the window rather than assuming one", () => {
    const actions = actionSpies();
    const item = submenu(template({ actions }), "Window").find((entry) => entry.label === "Terminus");
    item?.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(actions.calls.showMainWindow).toBeDefined();
  });

  test("Task ▸ Stop run is bound to ⌘.", () => {
    const stop = submenu(template(), "Task").find((entry) => entry.label === "Stop run");
    expect(stop?.accelerator).toBe("CommandOrControl+.");
  });

  test("Task ▸ Stop run sends the stop-run command", () => {
    const actions = actionSpies();
    const stop = submenu(template({ actions }), "Task").find((entry) => entry.label === "Stop run");
    stop?.click?.(undefined as never, undefined as never, undefined as never);
    expect(actions.calls.sendCommand).toEqual(["stop-run"]);
  });

  test("File ▸ Open Recent is disabled when there is nothing to open", () => {
    const item = submenu(template(), "File").find((entry) => entry.label === "Open Recent");
    expect(item?.enabled).toBe(false);
    expect(item?.submenu).toBeUndefined();
  });

  test("File ▸ Open Recent lists the persisted projects and a way to clear them", () => {
    const actions = actionSpies();
    const item = submenu(template({ recentProjects: ["/Volumes/Workspace/Terminus", "/tmp/scratch"], actions }), "File")
      .find((entry) => entry.label === "Open Recent");
    const entries = Array.isArray(item?.submenu) ? item.submenu : [];
    expect(item?.enabled).toBeUndefined();
    expect(entries.map((entry) => entry.label)).toEqual(["Neural/Terminus", "tmp/scratch", undefined, "Clear Menu"]);
    entries[0]?.click?.(undefined as never, undefined as never, undefined as never);
    expect(actions.calls.openRecentProject).toEqual(["/Volumes/Workspace/Terminus"]);
  });

  test("Reload is available in packaged builds so a dead renderer is recoverable", () => {
    const view = submenu(template({ isDev: false }), "View");
    const reload = view.find((entry) => entry.role === "reload");
    expect(reload).toBeDefined();
    expect(reload?.accelerator).toBe("CommandOrControl+R");
    expect(view.some((entry) => entry.role === "toggleDevTools")).toBe(false);
  });

  test("developer tools are added only in development", () => {
    expect(submenu(template({ isDev: true }), "View").some((entry) => entry.role === "toggleDevTools")).toBe(true);
  });

  test("Help always offers the logs folder", () => {
    const actions = actionSpies();
    const help = submenu(template({ actions }), "Help");
    const logs = help.find((entry) => entry.label === "Open logs folder");
    expect(logs).toBeDefined();
    logs?.click?.(undefined as never, undefined as never, undefined as never);
    expect(actions.calls.openLogsFolder).toBeDefined();
  });

  test("Help omits link items when the package declares no repository", () => {
    const labels = submenu(template(), "Help").map((entry) => entry.label);
    expect(labels).not.toContain("Terminus documentation");
    expect(labels).not.toContain("Report an issue");
  });

  test("Help gains the links when a repository is declared", () => {
    const actions = actionSpies();
    const help = submenu(template({
      documentationUrl: "https://github.com/example/terminus#readme",
      issuesUrl: "https://github.com/example/terminus/issues/new",
      actions,
    }), "Help");
    const documentation = help.find((entry) => entry.label === "Terminus documentation");
    expect(documentation).toBeDefined();
    documentation?.click?.(undefined as never, undefined as never, undefined as never);
    expect(actions.calls.openExternal).toEqual(["https://github.com/example/terminus#readme"]);
  });

  test("keeps Settings at ⌘, and Keyboard shortcuts at ⌘/", () => {
    const app = submenu(template(), "Terminus");
    expect(app.find((entry) => entry.label === "Settings…")?.accelerator).toBe("CommandOrControl+,");
    const help = submenu(template(), "Help");
    expect(help.find((entry) => entry.label === "Keyboard shortcuts")?.accelerator).toBe("CommandOrControl+/");
  });

  test("Help ▸ Keyboard shortcuts asks for the shortcut reference, not Appearance", () => {
    const actions = actionSpies();
    const item = submenu(template({ actions }), "Help").find((entry) => entry.label === "Keyboard shortcuts");
    item?.click?.(undefined as never, undefined as never, undefined as never);
    expect(actions.calls.sendCommand).toEqual(["shortcut-reference"]);
  });

  test("no accelerator is claimed twice", () => {
    const claimed = accelerators(template({ isDev: true, recentProjects: ["/tmp/a"] }));
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe("recent project labels", () => {
  test.each([
    ["/Volumes/Workspace/Terminus", "Neural/Terminus"],
    ["/Terminus", "Terminus"],
    ["/a/b/c/d", "c/d"],
  ])("%s renders as %s", (path, expected) => {
    expect(recentProjectLabel(path)).toBe(expected);
  });
});

describe("about panel", () => {
  test("shows the version and the build commit", () => {
    expect(aboutPanelOptions({ appName: "Terminus", version: "0.1.0", commit: "a".repeat(40) }))
      .toEqual({ applicationName: "Terminus", applicationVersion: "0.1.0", version: "aaaaaaaaaaaa" });
  });

  test("says so when there is no build commit", () => {
    expect(aboutPanelOptions({ appName: "Terminus", version: "0.1.0", commit: null }).version)
      .toBe("development build");
  });
});

describe("repository links", () => {
  test.each([
    ["git+https://github.com/example/terminus.git"],
    ["https://github.com/example/terminus"],
    [{ type: "git", url: "https://github.com/example/terminus.git" }],
  ])("derives both links from %j", (repository) => {
    expect(repositoryLinksFrom({ repository })).toEqual({
      documentationUrl: "https://github.com/example/terminus#readme",
      issuesUrl: "https://github.com/example/terminus/issues/new",
    });
  });

  test.each([
    [{}],
    [{ repository: 42 }],
    [{ repository: "git@github.com:example/terminus.git" }],
    [{ repository: "http://github.com/example/terminus" }],
  ])("removes the links rather than guessing: %j", (metadata) => {
    expect(repositoryLinksFrom(metadata)).toEqual({ documentationUrl: null, issuesUrl: null });
  });
});

describe("menu template purity", () => {
  test("building the template touches nothing outside the actions it was given", () => {
    const actions = actionSpies();
    const spy = vi.spyOn(console, "log");
    buildMenuTemplate({
      appName: "Terminus",
      isDev: false,
      recentProjects: [],
      documentationUrl: null,
      issuesUrl: null,
      actions,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(Object.keys(actions.calls)).toHaveLength(0);
    spy.mockRestore();
  });
});
