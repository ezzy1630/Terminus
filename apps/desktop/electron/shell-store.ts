/**
 * Terminus Desktop — durable shell preferences.
 *
 * The shell owns three things that must survive a relaunch and must be known
 * *before* the first window is shown: where the window was, which theme the
 * user chose, and which projects they opened recently. They live in one small
 * JSON document under `userData` so a launch reads one file.
 *
 * Writes are debounced (a drag emits `resize` continuously) and atomic (a
 * half-written preferences file must never be able to lose the user's theme).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseWindowState, type WindowState } from "./window-state";
import { validateDirectoryPath } from "./shell-guards";

export type ThemeChoice = "system" | "light" | "dark";

export interface ShellState {
  readonly window: WindowState | null;
  readonly theme: ThemeChoice;
  readonly recentProjects: readonly string[];
}

export const SHELL_STATE_FILENAME = "shell-state.json";
export const MAX_RECENT_PROJECTS = 10;
const MAX_SHELL_STATE_BYTES = 65_536;

export const DEFAULT_SHELL_STATE: ShellState = {
  window: null,
  theme: "system",
  recentProjects: [],
};

export function parseThemeChoice(value: unknown): ThemeChoice | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

/**
 * Decode field by field. A preferences file that lost one field to a partial
 * write or a downgrade should not cost the user the other two, so each field
 * independently falls back to its default.
 */
export function parseShellState(value: unknown): ShellState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_SHELL_STATE;
  const candidate = value as Record<string, unknown>;
  const recent = Array.isArray(candidate.recentProjects)
    ? candidate.recentProjects
      .map((entry) => validateDirectoryPath(entry))
      .filter((entry): entry is string => entry !== null)
    : [];
  return {
    window: parseWindowState(candidate.window),
    theme: parseThemeChoice(candidate.theme) ?? DEFAULT_SHELL_STATE.theme,
    recentProjects: dedupe(recent).slice(0, MAX_RECENT_PROJECTS),
  };
}

/** Most-recent-first, de-duplicated, bounded. Invalid paths are refused. */
export function withRecentProject(state: ShellState, path: unknown): ShellState {
  const validated = validateDirectoryPath(path);
  if (validated === null) return state;
  const recentProjects = dedupe([validated, ...state.recentProjects]).slice(0, MAX_RECENT_PROJECTS);
  return { ...state, recentProjects };
}

/**
 * The on-disk shell preferences.
 *
 * `load()` must complete before the first window is created; after that the
 * in-memory `state` is authoritative and every mutation schedules a write.
 */
export class ShellStateStore {
  private current: ShellState = DEFAULT_SHELL_STATE;
  private pending: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly filePath: string,
    private readonly debounceMs: number = 400,
  ) {}

  static forUserData(userDataPath: string, debounceMs?: number): ShellStateStore {
    return new ShellStateStore(join(userDataPath, SHELL_STATE_FILENAME), debounceMs);
  }

  get state(): ShellState {
    return this.current;
  }

  async load(): Promise<ShellState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // No preferences yet, or an unreadable file. Either way the defaults are
      // the correct starting point and a launch must not be blocked by it.
      this.current = DEFAULT_SHELL_STATE;
      return this.current;
    }
    if (raw.length > MAX_SHELL_STATE_BYTES) {
      console.warn(`[terminus-desktop] ignoring oversized shell state at ${this.filePath}`);
      this.current = DEFAULT_SHELL_STATE;
      return this.current;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      console.warn(`[terminus-desktop] shell state is not valid JSON; using defaults`, error);
      this.current = DEFAULT_SHELL_STATE;
      return this.current;
    }
    this.current = parseShellState(parsed);
    return this.current;
  }

  /** Apply a change and schedule the debounced write. */
  update(mutate: (state: ShellState) => ShellState): ShellState {
    const next = mutate(this.current);
    if (isSameState(next, this.current)) return this.current;
    this.current = next;
    this.dirty = true;
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.persist();
    }, this.debounceMs);
    this.pending.unref?.();
    return this.current;
  }

  /** Write immediately (quit, or a test that will not wait on a timer). */
  async flush(): Promise<void> {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    await this.persist();
    await this.writing;
  }

  private async persist(): Promise<void> {
    if (!this.dirty) {
      await this.writing;
      return;
    }
    this.dirty = false;
    const snapshot = this.current;
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await rename(temporary, this.filePath);
      });
    await this.writing;
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isSameState(left: ShellState, right: ShellState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
