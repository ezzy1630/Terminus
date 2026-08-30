import { describe, expect, test } from "bun:test";
import { parseStandaloneToolCall } from "./agent-tools.js";
import {
  DEFAULT_PERMISSION_PROFILE,
  LEGACY_PERMISSION_PROFILE,
  approvalActionFor,
  approvalReasonFor,
  approvalRequiredFor,
  describePermissionProfile,
  normalizePermissionProfile,
} from "./permission-profiles.js";

const read = parseStandaloneToolCall({ toolCallId: "r", toolName: "read", arguments: { path: "src/a.ts" } });
const capability = parseStandaloneToolCall({
  toolCallId: "c",
  toolName: "capability",
  arguments: { action: "activate_workspace" },
});
const grep = parseStandaloneToolCall({ toolCallId: "g", toolName: "grep", arguments: { pattern: "todo" } });
const patch = parseStandaloneToolCall({
  toolCallId: "p",
  toolName: "patch",
  arguments: { path: "src/a.ts", expected_utf8: "a", replacement_utf8: "b" },
});
const write = parseStandaloneToolCall({
  toolCallId: "w",
  toolName: "write",
  arguments: { path: "src/new.ts", content: "export {}\n" },
});
const exec = parseStandaloneToolCall({ toolCallId: "e", toolName: "exec", arguments: { program: "bun", args: ["test"] } });
const fetch = parseStandaloneToolCall({ toolCallId: "f", toolName: "web_fetch", arguments: { url: "https://example.com/x" } });

describe("permission profiles", () => {
  test("the default is full access, and the legacy id means the same thing", () => {
    expect(DEFAULT_PERMISSION_PROFILE).toBe("full-access");
    expect(normalizePermissionProfile(undefined)).toBe("full-access");
    expect(normalizePermissionProfile(null)).toBe("full-access");
    expect(normalizePermissionProfile(LEGACY_PERMISSION_PROFILE)).toBe("full-access");
    expect(normalizePermissionProfile("auto")).toBe("auto");
    expect(normalizePermissionProfile("ask")).toBe("ask");
  });

  test("an unknown stored profile fails closed to ask", () => {
    expect(normalizePermissionProfile("yolo")).toBe("ask");
  });

  test("full access never asks", () => {
    for (const call of [read, grep, patch, write, exec, fetch]) {
      expect(approvalRequiredFor("full-access", call)).toBe(false);
    }
  });

  test("auto asks only before leaving the workspace", () => {
    expect(approvalRequiredFor("auto", read)).toBe(false);
    expect(approvalRequiredFor("auto", grep)).toBe(false);
    expect(approvalRequiredFor("auto", patch)).toBe(false);
    expect(approvalRequiredFor("auto", write)).toBe(false);
    expect(approvalRequiredFor("auto", exec)).toBe(false);
    expect(approvalRequiredFor("auto", fetch)).toBe(true);
  });

  test("ask asks before every edit, command, or fetch — never before a read", () => {
    expect(approvalRequiredFor("ask", capability)).toBe(false);
    expect(approvalRequiredFor("ask", read)).toBe(false);
    expect(approvalRequiredFor("ask", grep)).toBe(false);
    expect(approvalRequiredFor("ask", patch)).toBe(true);
    // `write` replaces a whole file: the same authority as an edit.
    expect(approvalRequiredFor("ask", write)).toBe(true);
    expect(approvalRequiredFor("ask", exec)).toBe(true);
    expect(approvalRequiredFor("ask", fetch)).toBe(true);
  });

  test("the approval card copy names the level and the action", () => {
    expect(describePermissionProfile("ask").label).toBe("Ask for approval");
    expect(approvalReasonFor("ask", exec)).toContain('"Ask for approval"');
    expect(approvalReasonFor("ask", exec)).toContain("running a command");
    expect(approvalActionFor(exec)).toBe("Run bun test");
    expect(approvalActionFor(patch)).toBe("Edit src/a.ts");
    expect(approvalActionFor(write)).toBe("Write src/new.ts");
    expect(approvalActionFor(capability)).toBe("Activate workspace tools");
    expect(approvalReasonFor("ask", write)).toContain("editing a file");
    expect(approvalActionFor(fetch)).toBe("Fetch https://example.com/x");
  });
});
