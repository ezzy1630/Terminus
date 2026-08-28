/**
 * Terminus Desktop — window geometry restore rules.
 *
 * The renderer used to persist bounds in `localStorage` and push them back
 * after mount, which produced a visible jump on every launch, dropped the
 * maximized and full-screen states, and could restore a window onto a display
 * that no longer exists. Geometry belongs to the shell, and it has to be
 * validated against the displays that are actually attached.
 *
 * Everything here is pure: `main.ts` supplies the work areas from
 * `screen.getAllDisplays()`.
 */
import { parseWindowBounds, type WindowBounds } from "./shell-guards";

/** A display's usable area, in the same coordinate space as window bounds. */
export interface DisplayArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState {
  readonly bounds: WindowBounds;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

/**
 * How much of the window must land on a display for the restore to be usable.
 * A sliver on the edge is not a restored window; it is a window the user has
 * to hunt for.
 */
export const MIN_VISIBLE_WIDTH = 200;
export const MIN_VISIBLE_HEIGHT = 100;

/** SPEC §5: open at ~88% of the work area, capped, with a desktop margin. */
export const MAX_DEFAULT_WIDTH = 1600;
export const MAX_DEFAULT_HEIGHT = 1000;
const DEFAULT_WORK_AREA_FRACTION = 0.88;

export function parseWindowState(value: unknown): WindowState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const bounds = parseWindowBounds(candidate.bounds);
  if (bounds === null) return null;
  return {
    bounds,
    maximized: candidate.maximized === true,
    fullScreen: candidate.fullScreen === true,
  };
}

function intersection(bounds: WindowBounds, area: DisplayArea): { width: number; height: number } {
  const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Whether the stored bounds still land somewhere the user can reach.
 *
 * The top edge must sit at or below the work-area top so the title bar is not
 * hidden under the menu bar, and enough of the window must overlap that the
 * user can see and grab it.
 */
export function isBoundsVisible(bounds: WindowBounds, workAreas: readonly DisplayArea[]): boolean {
  return workAreas.some((area) => {
    if (bounds.y < area.y) return false;
    const overlap = intersection(bounds, area);
    return overlap.width >= MIN_VISIBLE_WIDTH && overlap.height >= MIN_VISIBLE_HEIGHT;
  });
}

/** The centered default placement for a fresh profile. */
export function centeredBounds(workArea: DisplayArea): WindowBounds {
  const width = Math.min(Math.round(workArea.width * DEFAULT_WORK_AREA_FRACTION), MAX_DEFAULT_WIDTH);
  const height = Math.min(Math.round(workArea.height * DEFAULT_WORK_AREA_FRACTION), MAX_DEFAULT_HEIGHT);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

/**
 * Placement for the next launch: the stored geometry when it is still
 * reachable, otherwise a centered window on the primary display. The
 * maximized and full-screen flags survive either way — they describe how the
 * user left the window, not where.
 */
export function resolveWindowState(
  stored: WindowState | null,
  workAreas: readonly DisplayArea[],
  primaryWorkArea: DisplayArea,
): WindowState {
  if (stored !== null && isBoundsVisible(stored.bounds, workAreas)) return stored;
  return {
    bounds: centeredBounds(primaryWorkArea),
    maximized: stored?.maximized ?? false,
    fullScreen: stored?.fullScreen ?? false,
  };
}
