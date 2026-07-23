import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  inheritedExec,
  inheritedWriteFile,
  inheritedReadFile,
  inheritedFetch,
  getBrokeredSecret,
  redactSecretsInText,
  wrapLegacyPluginHook,
  inheritedGitCommand,
  DEFAULT_BYPASS_REGISTER,
} from "./index.js";

describe("Effect Bypass Register & Containment Tests (SPEC §27.5)", () => {
  it("should list all 6 active contained bypass entries in the register", () => {
    expect(DEFAULT_BYPASS_REGISTER.length).toBe(6);
    for (const entry of DEFAULT_BYPASS_REGISTER) {
      expect(entry.status).toBe("contained");
      expect(entry.id).toMatch(/^BYPASS-000[1-6]$/);
    }
  });

  it("BYPASS-0001: should deny execute on illegal path or traversal", async () => {
    expect(inheritedExec("../bin/bad")).rejects.toThrow("Security Containment Violation");
    expect(inheritedExec("/etc/shadow")).rejects.toThrow("Security Containment Violation");
  });

  it("BYPASS-0002: should deny write outside worktree or to protected dirs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "terminus-bypass-test-"));
    try {
      // Writing outside worktree
      expect(inheritedWriteFile("/tmp/outside.txt", "data", { worktreeRoot: tmpDir })).rejects.toThrow(
        "Security Containment Violation"
      );

      // Writing to protected .git
      const gitPath = path.join(tmpDir, ".git", "config");
      expect(inheritedWriteFile(gitPath, "data", { worktreeRoot: tmpDir })).rejects.toThrow(
        "Security Containment Violation"
      );

      // Valid write inside worktree
      const validPath = path.join(tmpDir, "sub", "test.txt");
      await inheritedWriteFile(validPath, "valid content", { worktreeRoot: tmpDir });
      const readBack = await inheritedReadFile(validPath, { worktreeRoot: tmpDir });
      expect(readBack).toBe("valid content");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("BYPASS-0003: should deny non-secure egress URL protocol", async () => {
    expect(inheritedFetch({ url: "http://untrusted-remote.com/api" })).rejects.toThrow(
      "Security Containment Violation"
    );
  });

  it("BYPASS-0004: should deny raw secret access to untrusted plugin scope and redact secrets", () => {
    process.env.TEST_SECRET_KEY = "sk-proj-super-secret-key-12345";
    try {
      expect(() =>
        getBrokeredSecret({ key: "TEST_SECRET_KEY", scope: "untrusted-plugin" })
      ).toThrow("Security Containment Violation");

      const rawText = "Connecting with key sk-proj-super-secret-key-12345 in logs";
      process.env.OPENAI_API_KEY = "sk-proj-super-secret-key-12345";
      const redacted = redactSecretsInText(rawText);
      expect(redacted).not.toContain("sk-proj-super-secret-key-12345");
      expect(redacted).toContain("[REDACTED_OPENAI_API_KEY]");
    } finally {
      delete process.env.TEST_SECRET_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("BYPASS-0005: should deny plugin hook executing with ambient process/fs handles", async () => {
    const wrapped = wrapLegacyPluginHook("test-plugin", {
      name: "onExecute",
      execute: async (args) => args,
    });

    expect(wrapped.execute({ __raw_process__: true })).rejects.toThrow(
      "Security Containment Violation"
    );
  });

  it("BYPASS-0006: should deny git command targeting forbidden paths or un-audited subcommands", async () => {
    expect(inheritedGitCommand(["push", "origin", "main"], process.cwd())).rejects.toThrow(
      "Security Containment Violation"
    );

    expect(inheritedGitCommand(["status", ".git/hooks/pre-commit"], process.cwd())).rejects.toThrow(
      "Security Containment Violation"
    );
  });
});
