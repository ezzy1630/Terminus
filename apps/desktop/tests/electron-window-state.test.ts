import { describe, expect, test } from "vitest";
import {
  centeredBounds,
  isBoundsVisible,
  parseWindowState,
  resolveWindowState,
  MAX_DEFAULT_HEIGHT,
  MAX_DEFAULT_WIDTH,
  type DisplayArea,
} from "../electron/window-state";

const LAPTOP: DisplayArea = { x: 0, y: 25, width: 1728, height: 1080 };
const SECOND: DisplayArea = { x: 1728, y: 0, width: 2560, height: 1440 };

describe("window state decoding", () => {
  test("accepts a complete state", () => {
    expect(parseWindowState({
      bounds: { x: 10, y: 40, width: 1200, height: 800 },
      maximized: true,
      fullScreen: false,
    })).toEqual({ bounds: { x: 10, y: 40, width: 1200, height: 800 }, maximized: true, fullScreen: false });
  });

  test("defaults the flags rather than rejecting the geometry", () => {
    expect(parseWindowState({ bounds: { x: 0, y: 25, width: 1000, height: 700 } }))
      .toEqual({ bounds: { x: 0, y: 25, width: 1000, height: 700 }, maximized: false, fullScreen: false });
  });

  test.each([
    [null],
    [{}],
    [{ bounds: { x: 0, y: 0, width: 100, height: 100 } }],
    [{ bounds: { x: 0, y: 0, width: 1200.5, height: 800 } }],
    [{ bounds: { x: "0", y: 0, width: 1200, height: 800 } }],
  ])("rejects unusable stored state: %j", (value) => {
    expect(parseWindowState(value)).toBeNull();
  });
});

describe("display visibility", () => {
  test("accepts bounds fully inside a work area", () => {
    expect(isBoundsVisible({ x: 100, y: 100, width: 1200, height: 800 }, [LAPTOP])).toBe(true);
  });

  test("accepts bounds mostly on a secondary display", () => {
    expect(isBoundsVisible({ x: 2000, y: 100, width: 1200, height: 800 }, [LAPTOP, SECOND])).toBe(true);
  });

  test("rejects bounds on a display that is no longer attached", () => {
    expect(isBoundsVisible({ x: 2000, y: 100, width: 1200, height: 800 }, [LAPTOP])).toBe(false);
  });

  test("rejects a window whose title bar sits above the work area", () => {
    expect(isBoundsVisible({ x: 100, y: -400, width: 1200, height: 800 }, [LAPTOP])).toBe(false);
  });

  test("rejects a sliver hanging off the right edge", () => {
    expect(isBoundsVisible({ x: 1700, y: 100, width: 1200, height: 800 }, [LAPTOP])).toBe(false);
  });
});

describe("placement resolution", () => {
  test("keeps a visible stored placement, flags included", () => {
    const stored = {
      bounds: { x: 120, y: 80, width: 1300, height: 900 },
      maximized: false,
      fullScreen: true,
    };
    expect(resolveWindowState(stored, [LAPTOP], LAPTOP)).toEqual(stored);
  });

  test("falls back to centered bounds when the stored display is gone", () => {
    const resolved = resolveWindowState(
      { bounds: { x: 3000, y: 200, width: 1300, height: 900 }, maximized: true, fullScreen: false },
      [LAPTOP],
      LAPTOP,
    );
    expect(resolved.bounds).toEqual(centeredBounds(LAPTOP));
    // How the user left the window survives even when where does not.
    expect(resolved.maximized).toBe(true);
  });

  test("a fresh profile opens centered on the primary display", () => {
    const resolved = resolveWindowState(null, [LAPTOP], LAPTOP);
    expect(resolved).toEqual({ bounds: centeredBounds(LAPTOP), maximized: false, fullScreen: false });
  });

  test("the centered default leaves a desktop margin and stays capped", () => {
    const bounds = centeredBounds(SECOND);
    expect(bounds.width).toBe(MAX_DEFAULT_WIDTH);
    expect(bounds.height).toBe(MAX_DEFAULT_HEIGHT);
    expect(bounds.x).toBeGreaterThan(SECOND.x);
    expect(bounds.y).toBeGreaterThanOrEqual(SECOND.y);
    expect(isBoundsVisible(bounds, [SECOND])).toBe(true);
  });
});
