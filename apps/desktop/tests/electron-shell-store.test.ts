import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseShellState,
  parseThemeChoice,
  withRecentProject,
  ShellStateStore,
  DEFAULT_SHELL_STATE,
  MAX_RECENT_PROJECTS,
  SHELL_STATE_FILENAME,
  type ShellState,
} from "../electron/shell-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "terminus-shell-state-"));
  roots.push(root);
  return root;
}

const WINDOW = { bounds: { x: 10, y: 40, width: 1200, height: 800 }, maximized: false, fullScreen: false };

describe("shell state decoding", () => {
  test("decodes a complete document", () => {
    const state = parseShellState({
      window: WINDOW,
      theme: "light",
      recentProjects: ["/tmp/one", "/tmp/two"],
    });
    expect(state).toEqual({ window: WINDOW, theme: "light", recentProjects: ["/tmp/one", "/tmp/two"] });
  });

  test("a lost field costs only that field", () => {
    expect(parseShellState({ theme: "dark" }))
      .toEqual({ window: null, theme: "dark", recentProjects: [] });
    expect(parseShellState({ window: WINDOW, theme: "chartreuse" }).theme).toBe("system");
  });

  test("drops recent entries that are not usable absolute paths", () => {
    expect(parseShellState({ recentProjects: ["/tmp/ok", "relative", "/tmp/../escape", 7, "/tmp/ok"] })
      .recentProjects).toEqual(["/tmp/ok"]);
  });

  test.each([[null], ["not an object"], [[]]])("falls back entirely for %j", (value) => {
    expect(parseShellState(value)).toEqual(DEFAULT_SHELL_STATE);
  });

  test.each([["system"], ["light"], ["dark"]])("accepts the %s theme", (theme) => {
    expect(parseThemeChoice(theme)).toBe(theme);
  });

  test.each([["Light"], [null], [1]])("refuses the theme %j", (theme) => {
    expect(parseThemeChoice(theme)).toBeNull();
  });
});

describe("recent projects", () => {
  const base: ShellState = { window: null, theme: "system", recentProjects: [] };

  test("puts the newest first and de-duplicates", () => {
    const once = withRecentProject(base, "/tmp/a");
    const twice = withRecentProject(withRecentProject(once, "/tmp/b"), "/tmp/a");
    expect(twice.recentProjects).toEqual(["/tmp/a", "/tmp/b"]);
  });

  test("is bounded", () => {
    let state = base;
    for (let index = 0; index < MAX_RECENT_PROJECTS + 5; index += 1) {
      state = withRecentProject(state, `/tmp/project-${index}`);
    }
    expect(state.recentProjects).toHaveLength(MAX_RECENT_PROJECTS);
    expect(state.recentProjects[0]).toBe(`/tmp/project-${MAX_RECENT_PROJECTS + 4}`);
  });

  test("refuses a path that is not an absolute directory path", () => {
    expect(withRecentProject(base, "../etc").recentProjects).toEqual([]);
    expect(withRecentProject(base, 7).recentProjects).toEqual([]);
  });
});

describe("shell state store", () => {
  test("a missing file yields the defaults", async () => {
    const store = ShellStateStore.forUserData(await temporaryRoot());
    expect(await store.load()).toEqual(DEFAULT_SHELL_STATE);
  });

  test("a corrupt file does not block launch", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, SHELL_STATE_FILENAME), "{ not json", "utf8");
    const store = ShellStateStore.forUserData(root);
    expect(await store.load()).toEqual(DEFAULT_SHELL_STATE);
  });

  test("round-trips through the filesystem", async () => {
    const root = await temporaryRoot();
    const store = ShellStateStore.forUserData(root, 5);
    await store.load();
    store.update((state) => ({ ...state, theme: "dark", window: WINDOW }));
    store.update((state) => withRecentProject(state, "/tmp/project"));
    await store.flush();

    const reloaded = ShellStateStore.forUserData(root);
    expect(await reloaded.load()).toEqual({
      window: WINDOW,
      theme: "dark",
      recentProjects: ["/tmp/project"],
    });
  });

  test("coalesces a burst of resize updates into the last one", async () => {
    const root = await temporaryRoot();
    const store = ShellStateStore.forUserData(root, 10_000);
    await store.load();
    for (let width = 1000; width <= 1200; width += 100) {
      store.update((state) => ({
        ...state,
        window: { bounds: { x: 0, y: 25, width, height: 700 }, maximized: false, fullScreen: false },
      }));
    }
    await store.flush();
    const written = JSON.parse(await readFile(join(root, SHELL_STATE_FILENAME), "utf8")) as unknown;
    expect(parseShellState(written).window?.bounds.width).toBe(1200);
  });

  test("an update that changes nothing writes nothing", async () => {
    const root = await temporaryRoot();
    const store = ShellStateStore.forUserData(root, 5);
    await store.load();
    store.update((state) => state);
    await store.flush();
    await expect(readFile(join(root, SHELL_STATE_FILENAME), "utf8")).rejects.toThrow();
  });
});
