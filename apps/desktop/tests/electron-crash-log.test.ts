import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendCrashLog,
  crashLogDirectory,
  crashLogPath,
  describeFailure,
  formatCrashLogLine,
} from "../electron/crash-log";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "terminus-crash-log-"));
  roots.push(root);
  return root;
}

describe("crash log paths", () => {
  test("live under userData/logs", async () => {
    const root = await temporaryRoot();
    expect(crashLogDirectory(root)).toBe(join(root, "logs"));
    expect(crashLogPath(root)).toBe(join(root, "logs", "desktop.log"));
  });
});

describe("crash log formatting", () => {
  test("keeps one entry on one line", () => {
    const line = formatCrashLogLine({
      timestamp: "2026-08-28T12:00:00.000Z",
      kind: "render-process-gone",
      message: "main renderer gone: crashed",
      detail: "Error: boom\n    at frame",
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    expect(line).toContain("[render-process-gone]");
    expect(line).toContain("Error: boom\\n    at frame");
  });

  test("describes an Error with its stack and a non-Error without losing it", () => {
    const error = new Error("boom");
    expect(describeFailure(error).message).toBe("boom");
    expect(describeFailure(error).detail).toContain("Error: boom");
    expect(describeFailure("plain").message).toBe("plain");
    expect(describeFailure({ code: 7 }).message).toBe('{"code":7}');
  });
});

describe("crash log append", () => {
  test("creates the directory and appends", async () => {
    const root = await temporaryRoot();
    const path = crashLogPath(root);
    await appendCrashLog(path, { timestamp: "t1", kind: "fatal", message: "one" });
    await appendCrashLog(path, { timestamp: "t2", kind: "fatal", message: "two" });
    const contents = await readFile(path, "utf8");
    expect(contents.trimEnd().split("\n")).toHaveLength(2);
  });

  test("rotates one generation once the cap is reached", async () => {
    const root = await temporaryRoot();
    const path = crashLogPath(root);
    await appendCrashLog(path, { timestamp: "t1", kind: "fatal", message: "first" });
    await writeFile(path, "x".repeat(400), "utf8");
    await appendCrashLog(path, { timestamp: "t2", kind: "fatal", message: "second" }, 256);
    expect(await readFile(path, "utf8")).toContain("second");
    expect((await stat(`${path}.1`)).size).toBe(400);
  });

  test("does not rotate before the cap", async () => {
    const root = await temporaryRoot();
    const path = crashLogPath(root);
    await appendCrashLog(path, { timestamp: "t1", kind: "fatal", message: "first" }, 1024);
    await appendCrashLog(path, { timestamp: "t2", kind: "fatal", message: "second" }, 1024);
    await expect(stat(`${path}.1`)).rejects.toThrow();
  });
});
