/**
 * Terminus Desktop — project (workspace + session) identity and history.
 *
 * A "project" in the UI is a session bound to a workspace root. Three things
 * needed one home rather than three copies:
 *
 *   - the path ⇄ `file://` URI conversion, which was private to onboarding and
 *     therefore unavailable to every other surface that opens a project;
 *   - the recently-opened list, which the native File ▸ Open Recent menu also
 *     keeps, so the renderer defers to the shell's list when the bridge
 *     exposes one and only falls back to its own storage in a plain browser;
 *   - the "is this already open?" question, which is why opening the same
 *     directory twice used to produce two sessions pointing at one workspace.
 */

/** How many recent projects are remembered. Matches the native menu's cap. */
export const MAX_RECENT_PROJECTS = 10;
const RECENT_PROJECTS_KEY = "terminus-desktop.recent-projects.v1";

/** The last directory name, which is what a human calls the project. */
export function deriveProjectTitle(path: string): string {
  if (!path) return "";
  const cleaned = path.replace(/\/+$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] ?? cleaned;
}

/**
 * Convert a native path to the canonical URI the control plane accepts.
 *
 * Encodes segments directly: `new URL(path, "file:///")` would treat valid
 * filename characters such as `#` and `?` as URL syntax.
 */
export function projectPathToUri(path: string): string {
  return `file://${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/**
 * The inverse, for display. Returns the input unchanged when it is not a
 * `file://` URI — a remote workspace's URI is shown as it is rather than
 * mangled into something that looks like a local path.
 */
export function projectUriToPath(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (!uri.startsWith("file://")) return uri;
  const encoded = uri.slice("file://".length);
  try {
    return encoded.split("/").map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    // A malformed escape is still more useful shown raw than swallowed.
    return encoded;
  }
}

export function isAbsoluteLocalPath(path: string): boolean {
  const value = path.trim();
  return value.startsWith("/") && !value.includes("\0") && !value.startsWith("//");
}

/**
 * Compare two workspace roots.
 *
 * Trailing slashes and percent-encoding differences are cosmetic; a session
 * pointing at `file:///Users/x/repo/` is the same project as one pointing at
 * `file:///Users/x/repo`.
 */
export function sameProjectRoot(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string): string => (projectUriToPath(value) ?? value).replace(/\/+$/, "");
  return normalize(left) === normalize(right);
}

function readStoredRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_RECENT_PROJECTS);
  } catch {
    return [];
  }
}

function writeStoredRecents(paths: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(paths.slice(0, MAX_RECENT_PROJECTS)));
  } catch {
    // A full or blocked storage costs the recents list, nothing else.
  }
}

/** The recently-opened directories, most recent first. */
export function readRecentProjects(): readonly string[] {
  return readStoredRecents();
}

/**
 * Record a directory as opened.
 *
 * The native shell keeps the same list for File ▸ Open Recent, so when the
 * bridge is present it is the source of truth and its answer is mirrored
 * locally; two lists that disagree are worse than one that is occasionally
 * stale.
 */
export async function noteRecentProject(path: string): Promise<readonly string[]> {
  const local = [path, ...readStoredRecents().filter((entry) => entry !== path)].slice(0, MAX_RECENT_PROJECTS);
  writeStoredRecents(local);
  const bridge = window.terminusDesktop?.noteRecentProject;
  if (!bridge) return local;
  try {
    const fromShell = await bridge(path);
    const normalized = fromShell.filter((entry): entry is string => typeof entry === "string");
    writeStoredRecents(normalized);
    return normalized;
  } catch {
    return local;
  }
}
