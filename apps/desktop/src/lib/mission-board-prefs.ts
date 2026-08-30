import type { MissionBoardColumnId } from "./mission-board";

const STORAGE_KEY = "terminus-desktop.mission-board-state.v1";
const SCHEMA = "terminus.desktop-mission-board-state.v1";
const MAX_QUERY_LENGTH = 512;
const MAX_SPACE_FILTER_LENGTH = 256;
const MAX_SCROLL_OFFSET = 10_000_000;
const STATUS_FILTERS = new Set<string>([
  "all",
  "queued",
  "working",
  "needs_you",
  "review",
  "done",
]);

export type MissionBoardViewMode = "board" | "list";
export type MissionBoardStatusFilter = "all" | MissionBoardColumnId;

export interface MissionBoardPreferences {
  readonly viewMode: MissionBoardViewMode;
  readonly query: string;
  readonly spaceFilter: string;
  readonly statusFilter: MissionBoardStatusFilter;
  readonly attentionOnly: boolean;
  readonly doneExpanded: boolean;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  /** The rail selection that was current when this state was recorded. */
  readonly selectedSessionId: string | null;
}

interface StoredMissionBoardPreferences extends MissionBoardPreferences {
  readonly schema: typeof SCHEMA;
}

function defaultPreferences(selectedSessionId: string | null): MissionBoardPreferences {
  return {
    viewMode: "list",
    query: "",
    spaceFilter: selectedSessionId ?? "all",
    statusFilter: "all",
    attentionOnly: false,
    doneExpanded: false,
    scrollLeft: 0,
    scrollTop: 0,
    selectedSessionId,
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function boundedString(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" && value.length <= maximumLength ? value : null;
}

function scrollOffset(value: unknown): number | null {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_SCROLL_OFFSET
    ? Math.round(value)
    : null;
}

/**
 * Board state is scoped to the current window session.
 *
 * Filters and scroll position should survive a trip into a task, but restoring
 * an old query after relaunch can make work look missing. `sessionStorage`
 * gives the Board exactly that lifetime without turning navigation state into
 * a durable product setting.
 */
export function readMissionBoardPreferences(selectedSessionId: string | null): MissionBoardPreferences {
  const fallback = defaultPreferences(selectedSessionId);
  if (typeof window === "undefined") return fallback;
  try {
    const stored = record(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as unknown);
    if (stored?.schema !== SCHEMA) return fallback;
    const viewMode = stored.viewMode === "board" || stored.viewMode === "list" ? stored.viewMode : null;
    const query = boundedString(stored.query, MAX_QUERY_LENGTH);
    const storedSpaceFilter = boundedString(stored.spaceFilter, MAX_SPACE_FILTER_LENGTH);
    const statusFilter = typeof stored.statusFilter === "string" && STATUS_FILTERS.has(stored.statusFilter)
      ? stored.statusFilter as MissionBoardStatusFilter
      : null;
    const storedSelectedSessionId = stored.selectedSessionId === null
      ? null
      : boundedString(stored.selectedSessionId, MAX_SPACE_FILTER_LENGTH);
    const scrollLeft = scrollOffset(stored.scrollLeft);
    const scrollTop = scrollOffset(stored.scrollTop);
    if (
      viewMode === null
      || query === null
      || storedSpaceFilter === null
      || statusFilter === null
      || typeof stored.attentionOnly !== "boolean"
      || typeof stored.doneExpanded !== "boolean"
      || storedSelectedSessionId === null && stored.selectedSessionId !== null
      || scrollLeft === null
      || scrollTop === null
    ) return fallback;

    // A deliberate project switch updates the Board's scope. Opening a task
    // and returning does not, because the selected session is unchanged.
    const projectChanged = selectedSessionId !== null && storedSelectedSessionId !== selectedSessionId;
    return {
      viewMode,
      query,
      spaceFilter: projectChanged ? selectedSessionId : storedSpaceFilter,
      statusFilter,
      attentionOnly: stored.attentionOnly,
      doneExpanded: stored.doneExpanded,
      scrollLeft,
      scrollTop,
      selectedSessionId,
    };
  } catch {
    return fallback;
  }
}

export function writeMissionBoardPreferences(preferences: MissionBoardPreferences): void {
  if (typeof window === "undefined") return;
  const stored: StoredMissionBoardPreferences = { schema: SCHEMA, ...preferences };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Losing optional view state must never block the canonical Board read.
  }
}
