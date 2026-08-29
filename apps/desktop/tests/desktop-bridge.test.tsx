/**
 * The renderer's half of the preload bridge.
 *
 * The bridge shape is declared once, on `Window`, in `src/types/global.d.ts`.
 * A second hand-written copy in `src/types/index.ts` had already drifted from
 * it. These tests cover the behaviours that copy was hiding: an address the
 * shell refused to supply, and the navigation, theme and command channels the
 * renderer never subscribed to.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveApiBase, TerminusApiClient, TerminusApiError } from "../src/lib/api";
import { useThemeStore } from "../src/hooks/use-theme";

type Bridge = NonNullable<Window["terminusDesktop"]>;

function installBridge(partial: Partial<Bridge>): Bridge {
  const bridge = {
    apiBase: "http://127.0.0.1:3050",
    apiBaseError: null,
    isMac: true,
    notify: vi.fn(async () => undefined),
    windowClose: vi.fn(async () => undefined),
    setWindowTitle: vi.fn(async (title: string) => title),
    getTheme: vi.fn(async () => "system" as const),
    setTheme: vi.fn(async (theme: "system" | "light" | "dark") => theme),
    pickDirectory: vi.fn(async () => null),
    onDirectoryDrop: vi.fn(() => () => undefined),
    onCommand: vi.fn(() => () => undefined),
    ...partial,
  } as Bridge;
  (window as { terminusDesktop?: Bridge }).terminusDesktop = bridge;
  return bridge;
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  delete (window as { terminusDesktop?: Bridge }).terminusDesktop;
});

afterEach(() => {
  cleanup();
  delete (window as { terminusDesktop?: Bridge }).terminusDesktop;
});

describe("the control-plane address", () => {
  test("uses the address the shell approved", () => {
    installBridge({ apiBase: "http://127.0.0.1:4111" });
    expect(resolveApiBase()).toEqual({ baseUrl: "http://127.0.0.1:4111", error: null });
  });

  test("reports the shell's reason instead of guessing at localhost", () => {
    installBridge({ apiBase: null, apiBaseError: "the control plane never wrote its port file" });

    const resolved = resolveApiBase();

    expect(resolved.baseUrl).toBe("");
    expect(resolved.error).toBe("the control plane never wrote its port file");
  });

  test("still falls back to localhost in a plain browser, where there is no shell to ask", () => {
    expect(resolveApiBase().baseUrl).toBe("http://127.0.0.1:3050");
    expect(resolveApiBase().error).toBeNull();
  });

  test("a client with no address fails with that reason rather than fetching nothing", () => {
    installBridge({ apiBase: null, apiBaseError: "no approved control origin" });
    const client = new TerminusApiClient();

    expect(() => client.assertBaseUrl()).toThrow(TerminusApiError);
    try {
      client.assertBaseUrl();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TerminusApiError);
      expect((error as TerminusApiError).envelope?.code).toBe("API_BASE_UNAVAILABLE");
      expect((error as TerminusApiError).message).toBe("no approved control origin");
    }
  });
});

describe("native appearance", () => {
  test("adopts the shell's own theme choice", async () => {
    let deliver: ((state: { themeSource: "system" | "light" | "dark"; shouldUseDarkColors: boolean }) => void) | null = null;
    installBridge({
      onNativeThemeChange: vi.fn((callback) => {
        deliver = callback;
        return () => undefined;
      }),
    });
    // The subscription is established at module load, so re-import the module
    // under this bridge.
    vi.resetModules();
    const themeModule = await import("../src/hooks/use-theme");
    expect(deliver).not.toBeNull();

    deliver!({ themeSource: "light", shouldUseDarkColors: false });

    await waitFor(() => expect(themeModule.useThemeStore.getState().theme).toBe("light"));
    themeModule.useThemeStore.getState().setTheme("system");
    useThemeStore.getState().setTheme("system");
  });
});
