/**
 * Terminus Desktop — the sidebar's remembered shape.
 *
 * Which projects are collapsed, which task lists are expanded, whether the
 * rail is showing the inbox, and whether the rail is showing at all were all
 * plain `useState`. Every relaunch reopened three projects that had been
 * deliberately collapsed the day before, and re-showed a rail that had been
 * deliberately hidden. Layout is user state: whatever was configured yesterday
 * should still be there tomorrow, and an update that rearranges it has undone
 * work rather than delivered any.
 *
 * The filter query is deliberately *not* stored. A restored filter would greet
 * the next launch with a rail hiding most of its rows for a reason that
 * scrolled off screen a day earlier — which, at a glance, is indistinguishable
 * from having lost the work.
 */

const VISIBLE_KEY = "terminus-desktop.sidebar-visible.v1";
const VIEW_KEY = "terminus-desktop.sidebar-view.v1";
const COLLAPSED_PROJECTS_KEY = "terminus-desktop.sidebar-collapsed-projects.v1";
const EXPANDED_PROJECTS_KEY = "terminus-desktop.sidebar-expanded-projects.v1";

/**
 * A ceiling on the remembered id sets.
 *
 * These are keyed by session id, and a session that is deleted never comes
 * back to clear its entry, so without a bound the lists grow for the life of
 * the install. Pruning against the loaded sessions instead would be wrong at
 * the only moment it runs: at first paint the session list is still empty, so
 * "prune what is not loaded" means "forget everything".
 */
const MAX_REMEMBERED_PROJECTS = 200;

/** How the rail files its one list of tasks. */
export type SidebarGrouping = "recent" | "project";

function readIdSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function writeIdSet(key: string, ids: Iterable<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids].slice(0, MAX_REMEMBERED_PROJECTS)));
  } catch {
    // A full or blocked storage costs the remembered shape, nothing else.
  }
}

/**
 * Whether the rail is shown. Defaults to visible: a first launch that opens
 * with no navigation at all looks broken rather than clean.
 */
export function readSidebarVisible(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(VISIBLE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeSidebarVisible(visible: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VISIBLE_KEY, String(visible));
  } catch {
    // ignore
  }
}

/**
 * How the rail files its tasks.
 *
 * Recent is the default. "By project" answers "what is in this repository",
 * which is a question you ask once you already know where you are going;
 * Recent answers "what happened while I was away", which is the question the
 * window is opened to ask. Opening on the tree meant the first thing on screen
 * was a folder list and yesterday's work was two clicks down.
 *
 * This replaced a two-tab mode switch, and it reads the same storage key so
 * nobody's choice is lost in the change: the old `"projects"` value means the
 * same thing the new `"project"` one does. Anyone who chose the tree keeps it.
 */
export function readSidebarGrouping(): SidebarGrouping {
  if (typeof window === "undefined") return "recent";
  try {
    const stored = window.localStorage.getItem(VIEW_KEY);
    return stored === "project" || stored === "projects" ? "project" : "recent";
  } catch {
    return "recent";
  }
}

export function writeSidebarGrouping(grouping: SidebarGrouping): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_KEY, grouping);
  } catch {
    // ignore
  }
}

export function readCollapsedProjects(): Set<string> {
  return readIdSet(COLLAPSED_PROJECTS_KEY);
}

export function writeCollapsedProjects(ids: Iterable<string>): void {
  writeIdSet(COLLAPSED_PROJECTS_KEY, ids);
}

export function readExpandedProjects(): Set<string> {
  return readIdSet(EXPANDED_PROJECTS_KEY);
}

export function writeExpandedProjects(ids: Iterable<string>): void {
  writeIdSet(EXPANDED_PROJECTS_KEY, ids);
}

/**
 * Which shelves of the queue are collapsed.
 *
 * Stored by shelf id ("needs_you" / "working" / "unread") rather than as
 * booleans so a future fourth shelf costs no migration — which is exactly what
 * happened when "unread" was split out of the old merged priority shelf.
 */
const STRIP_COLLAPSED_KEY = "terminus-desktop.sidebar-strip-collapsed.v1";

export function readCollapsedStripSections(): Set<string> {
  return readIdSet(STRIP_COLLAPSED_KEY);
}

export function writeCollapsedStripSections(ids: Iterable<string>): void {
  writeIdSet(STRIP_COLLAPSED_KEY, ids);
}
