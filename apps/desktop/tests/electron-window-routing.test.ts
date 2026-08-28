import { describe, expect, test } from "vitest";
import {
  resolveTrustedWindow,
  UNTRUSTED_RENDERER_MESSAGE,
  type WindowRouter,
} from "../electron/window-routing";

interface FakeWindow {
  readonly name: string;
  destroyed: boolean;
  isDestroyed(): boolean;
}

const TRUSTED_URL = "http://localhost:5173/?app=terminus";

function fakeWindow(name: string, destroyed = false): FakeWindow {
  return { name, destroyed, isDestroyed: () => destroyed };
}

function router(windows: Record<string, FakeWindow>, owned: readonly FakeWindow[]): WindowRouter<FakeWindow, string> {
  return {
    windowForSender: (sender) => windows[sender] ?? null,
    isOwnedWindow: (window) => owned.includes(window),
    isTrustedUrl: (url) => url === TRUSTED_URL,
  };
}

describe("window routing", () => {
  const main = fakeWindow("main");
  const settings = fakeWindow("settings");
  const windows = { "main-contents": main, "settings-contents": settings };
  const owned = [main, settings];

  test("resolves the window that sent the message, not the main window", () => {
    const resolved = resolveTrustedWindow(
      { sender: "settings-contents", senderFrameUrl: TRUSTED_URL },
      router(windows, owned),
    );
    expect(resolved).toBe(settings);
    expect(resolved).not.toBe(main);
  });

  test("resolves the main window for the main window's sender", () => {
    expect(resolveTrustedWindow(
      { sender: "main-contents", senderFrameUrl: TRUSTED_URL },
      router(windows, owned),
    )).toBe(main);
  });

  test.each([
    ["an unknown sender", "other-contents", TRUSTED_URL],
    ["a missing frame url", "main-contents", null],
    ["an untrusted frame url", "main-contents", "https://evil.example/"],
  ])("refuses %s", (_label, sender, url) => {
    expect(() => resolveTrustedWindow(
      { sender, senderFrameUrl: url },
      router(windows, owned),
    )).toThrow(UNTRUSTED_RENDERER_MESSAGE);
  });

  test("refuses a window the shell no longer owns", () => {
    expect(() => resolveTrustedWindow(
      { sender: "settings-contents", senderFrameUrl: TRUSTED_URL },
      router(windows, [main]),
    )).toThrow(UNTRUSTED_RENDERER_MESSAGE);
  });

  test("refuses a destroyed window", () => {
    const gone = fakeWindow("gone", true);
    expect(() => resolveTrustedWindow(
      { sender: "gone-contents", senderFrameUrl: TRUSTED_URL },
      router({ "gone-contents": gone }, [gone]),
    )).toThrow(UNTRUSTED_RENDERER_MESSAGE);
  });
});
