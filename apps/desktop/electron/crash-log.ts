/**
 * Terminus Desktop — crash and fatal-error log.
 *
 * A renderer that dies takes the whole visible product with it, and until now
 * it did so silently: no log, no dialog, and no way back because `reload` was
 * a development-only menu item. This module owns the durable half of that
 * story — one rotating file under `userData` the user can be pointed at.
 *
 * It deliberately does not depend on Electron: the same append path is used
 * from `process.on("uncaughtException")`, where the app may already be in a
 * bad enough state that touching Electron APIs is unwise.
 */
import { mkdir, rename, stat, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CRASH_LOG_DIRECTORY = "logs";
export const CRASH_LOG_FILENAME = "desktop.log";
/** One megabyte, then rotate. Two generations are kept. */
export const MAX_CRASH_LOG_BYTES = 1_048_576;

export type CrashLogKind =
  | "render-process-gone"
  | "child-process-gone"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "fatal";

export interface CrashLogEntry {
  readonly timestamp: string;
  readonly kind: CrashLogKind;
  readonly message: string;
  readonly detail?: string;
}

export function crashLogPath(userDataPath: string): string {
  return join(userDataPath, CRASH_LOG_DIRECTORY, CRASH_LOG_FILENAME);
}

export function crashLogDirectory(userDataPath: string): string {
  return join(userDataPath, CRASH_LOG_DIRECTORY);
}

/**
 * Electron also reports helper exits while the app is intentionally stopping
 * its owned runtime. Those are shutdown mechanics, not crashes, and must not
 * interrupt Quit with a recovery dialog.
 */
export function childProcessExitNeedsRecovery(
  reason: string,
  runtimeShutdownStarted: boolean,
): boolean {
  return !runtimeShutdownStarted && reason !== "clean-exit";
}

/** One entry, one line: newlines in the payload are escaped, not dropped. */
export function formatCrashLogLine(entry: CrashLogEntry): string {
  const detail = entry.detail === undefined ? "" : ` | ${escapeLine(entry.detail)}`;
  return `${entry.timestamp} [${entry.kind}] ${escapeLine(entry.message)}${detail}\n`;
}

/** Describe an unknown thrown value without losing its stack. */
export function describeFailure(error: unknown): { message: string; detail?: string } {
  if (error instanceof Error) {
    return error.stack === undefined ? { message: error.message } : { message: error.message, detail: error.stack };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

/**
 * Append one entry, rotating first when the file would grow past the cap.
 *
 * Rotation replaces the previous generation rather than accumulating files:
 * the point is to keep the last crash, not to build an archive.
 */
export async function appendCrashLog(
  logPath: string,
  entry: CrashLogEntry,
  maxBytes: number = MAX_CRASH_LOG_BYTES,
): Promise<void> {
  const line = formatCrashLogLine(entry);
  await mkdir(dirname(logPath), { recursive: true });
  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch {
    size = 0;
  }
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
    await rename(logPath, `${logPath}.1`);
  }
  await appendFile(logPath, line, "utf8");
}

function escapeLine(value: string): string {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}
