import { describe, expect, test } from "bun:test";
import {
  deriveWorldSignals,
  extractDiagnostics,
  extractFailingTests,
  extractLastCommand,
  extractPatchChanges,
} from "./world-state.js";

describe("extractPatchChanges", () => {
  test("reads changed files from a settled patch envelope", () => {
    const changes = extractPatchChanges(
      JSON.stringify({
        status: "success",
        data: {
          changed_files: [
            { path: "src/a.ts", old_sha256: "sha256:aa", new_sha256: "sha256:bb", operation: "EDIT" },
          ],
        },
      }),
    );
    expect(changes).toEqual([
      { path: "src/a.ts", oldSha256: "sha256:aa", newSha256: "sha256:bb", operation: "EDIT" },
    ]);
  });

  test("reads changed files from the canonical tool-result transcript wrapper", () => {
    const changes = extractPatchChanges(
      JSON.stringify({
        protocol: "terminus.tool-result.v1",
        provider_call_id: "call-1",
        tool_name: "patch",
        result: {
          status: "success",
          data: {
            changed_files: [
              { path: "src/with spaces.ts", old_sha256: "sha256:old", new_sha256: "sha256:new", operation: "EDIT" },
            ],
          },
        },
      }),
    );
    expect(changes).toEqual([
      { path: "src/with spaces.ts", oldSha256: "sha256:old", newSha256: "sha256:new", operation: "EDIT" },
    ]);
  });

  test("does not unwrap a bare envelope's unrelated result field", () => {
    expect(extractPatchChanges(JSON.stringify({
      status: "success",
      result: {
        data: {
          changed_files: [{ path: "not-a-tool-result.ts", operation: "EDIT" }],
        },
      },
    }))).toEqual([]);
  });

  test("malformed JSON yields no changes", () => {
    expect(extractPatchChanges("not json")).toEqual([]);
  });
});

describe("extractDiagnostics", () => {
  test("parses tsc output", () => {
    const diagnostics = extractDiagnostics(
      "src/app.ts(10,5): error TS2345: Argument of type 'string' is not assignable",
    );
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]!.path).toBe("src/app.ts");
    expect(diagnostics[0]!.line).toBe(10);
    expect(diagnostics[0]!.severity).toBe("error");
  });
});

describe("extractFailingTests", () => {
  test("parses pytest FAILED headers into normalized tests", () => {
    const failures = extractFailingTests(
      "FAILED tests/test_auth.py::test_login - AssertionError: assert False\n1 failed",
    );
    expect(failures.length).toBe(1);
    expect(failures[0]!.id).toBe("tests/test_auth.py::test_login");
    expect(failures[0]!.framework).toBe("pytest");
    expect(failures[0]!.summary).toContain("AssertionError");
  });

  test("returns empty for passing output", () => {
    expect(extractFailingTests("all tests passed\n")).toEqual([]);
  });
});

describe("extractLastCommand", () => {
  test("flags nonzero exit as failure", () => {
    const outcome = extractLastCommand(
      "exec",
      JSON.stringify({ status: "error", data: { exit_code: 2 } }),
    );
    expect(outcome?.failed).toBe(true);
    expect(outcome?.exitCode).toBe(2);
  });

  test("reads exit code zero from a canonical tool-result transcript", () => {
    const outcome = extractLastCommand(
      "bun verify.ts",
      JSON.stringify({
        protocol: "terminus.tool-result.v1",
        result: { status: "success", data: { exit_code: 0, stdout: "ok", stderr: "" } },
      }),
    );
    expect(outcome).toEqual({ command: "bun verify.ts", exitCode: 0, failed: false });
  });
});

describe("deriveWorldSignals", () => {
  test("folds episodes into cumulative signals with later evidence winning", () => {
    const signals = deriveWorldSignals([
      [
        "patch",
        JSON.stringify({
          status: "success",
          data: { changed_files: [{ path: "a.ts", old_sha256: null, new_sha256: "sha256:x", operation: "EDIT" }] },
        }),
      ],
      ["exec", JSON.stringify({ status: "success", data: { exit_code: 0, stdout: "", stderr: "" } })],
      [
        "patch",
        JSON.stringify({
          status: "success",
          data: { changed_files: [{ path: "b.ts", old_sha256: null, new_sha256: "sha256:y", operation: "CREATE" }] },
        }),
      ],
    ]);
    expect(signals.changedFiles.sort()).toEqual(["a.ts", "b.ts"]);
    expect(signals.lastCommand?.exitCode).toBe(0);
    expect(signals.failingTests).toEqual([]);
  });

  test("empty episode list produces empty signals", () => {
    const signals = deriveWorldSignals([]);
    expect(signals.changedFiles).toEqual([]);
    expect(signals.diagnostics).toEqual([]);
    expect(signals.lastCommand).toBeNull();
  });

  test("parses stdout and stderr from a canonical failing tool-result transcript", () => {
    const signals = deriveWorldSignals([
      [
        "exec",
        JSON.stringify({
          protocol: "terminus.tool-result.v1",
          result: {
            status: "error",
            data: {
              exit_code: 1,
              stdout: "FAILED tests/auth.test.ts::rejects_expired - AssertionError: expired token accepted",
              stderr: "src/auth.ts(42,7): error TS2345: Type 'string' is not assignable",
            },
          },
        }),
      ],
    ]);
    expect(signals.lastCommand).toEqual({ command: "exec", exitCode: 1, failed: true });
    expect(signals.failingTests[0]?.id).toBe("tests/auth.test.ts::rejects_expired");
    expect(signals.diagnostics[0]?.path).toBe("src/auth.ts");
    expect(signals.diagnostics[0]?.line).toBe(42);
  });
});
