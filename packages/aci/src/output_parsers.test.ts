/**
 * Characterization tests for the typed command-output parsers (SPEC §11.3).
 *
 * The parsers run on uncontrolled command output, so these tests pin both the
 * parsing contract and the linear-time behavior on adversarial input shapes
 * (CodeQL js/polynomial-redos regressions).
 */
import { describe, expect, test } from "bun:test";
import { parseCompilerDiagnostics, parseTestFailures } from "./output_parsers.js";

describe("parseCompilerDiagnostics", () => {
  test("parses tsc-style diagnostics", () => {
    const diags = parseCompilerDiagnostics("src/index.ts(12,34): error TS2304: Cannot find name 'foo'.");
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toBe("src/index.ts");
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.code).toBe("TS2304");
    expect(diags[0]!.message).toBe("Cannot find name 'foo'.");
    expect(diags[0]!.range?.startLine).toBe(12);
  });

  test("parses unix-style diagnostics", () => {
    const diags = parseCompilerDiagnostics("src/main.c:42:10: error: expected ';' before 'return'");
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toBe("src/main.c");
    expect(diags[0]!.code).toBeNull();
    expect(diags[0]!.range?.startLine).toBe(42);
  });

  test("parses rustc file pointers", () => {
    const diags = parseCompilerDiagnostics(" --> src/main.rs:42:10");
    expect(diags.length).toBe(1);
    expect(diags[0]!.path).toBe("src/main.rs");
    expect(diags[0]!.code).toBe("rustc_error");
  });

  test("returns no diagnostics for unrelated output", () => {
    expect(parseCompilerDiagnostics("hello world\nall good")).toEqual([]);
  });
});

describe("parseTestFailures", () => {
  test("parses pytest failure headers", () => {
    const analysis = parseTestFailures("FAILED tests/test_auth.py::test_login - AssertionError: assert False");
    expect(analysis.testName).toBe("test_login");
    expect(analysis.path).toBe("tests/test_auth.py");
    expect(analysis.errorMessage).toBe("AssertionError: assert False");
    expect(analysis.rootCauseHint).toBe("Assertion failure. Compare expected vs actual values.");
  });

  test("keeps stack frames that share a line with the failure marker", () => {
    // Regression: an early return after the pytest match used to drop the
    // inline frame on the same line.
    const analysis = parseTestFailures(
      "FAILED tests/test_auth.py::test_login - TypeError: undefined is not a function at Object.<anonymous> (src/auth.test.ts:42:15)",
    );
    expect(analysis.testName).toBe("test_login");
    expect(analysis.path).toBe("tests/test_auth.py");
    expect(analysis.stackTrace.length).toBe(1);
    expect(analysis.stackTrace[0]!.functionName).toBe("Object.<anonymous>");
    expect(analysis.stackTrace[0]!.path).toBe("src/auth.test.ts");
    expect(analysis.stackTrace[0]!.line).toBe(42);
    expect(analysis.stackTrace[0]!.column).toBe(15);
  });

  test("parses jest failure headers and standalone frames", () => {
    const analysis = parseTestFailures(
      [
        "FAIL src/auth.test.ts",
        "    at Object.<anonymous> (src/auth.test.ts:42:15)",
        "    at Module._compile (src/loader.ts:1105:14)",
      ].join("\n"),
    );
    expect(analysis.path).toBe("src/auth.test.ts");
    expect(analysis.stackTrace.length).toBe(2);
    expect(analysis.stackTrace[0]!.functionName).toBe("Object.<anonymous>");
    expect(analysis.stackTrace[1]!.functionName).toBe("Module._compile");
  });

  test("ignores 'at' occurrences that are not frames", () => {
    const analysis = parseTestFailures("the cat sat on the mat at 9 o'clock");
    expect(analysis.testName).toBe("unknown_test");
    expect(analysis.stackTrace.length).toBe(0);
  });

  test("stays linear on adversarial whitespace runs", () => {
    // These shapes are what CodeQL js/polynomial-redos flags: long whitespace
    // runs after the marker and before the separator. The rewritten parser
    // has no overlapping quantifiers, so it settles in linear time; bun's
    // default 5s test timeout bounds this implicitly.
    const parsed = parseTestFailures(`FAILED ${" ".repeat(200_000)}x::t - msg`);
    expect(parsed.path).toBe("x");
    expect(parsed.testName).toBe("t");
    expect(parsed.errorMessage).toBe("msg");

    const rejected = parseTestFailures(`FAILED ${" ".repeat(200_000)}::t - msg`);
    expect(rejected.path).toBe("unknown_file");
    expect(rejected.stackTrace.length).toBe(0);
  });

  test("derives a null-dereference hint from the message", () => {
    const analysis = parseTestFailures("FAILED tests/a.py::t_b - AttributeError: 'None' has no attribute");
    expect(analysis.rootCauseHint).toBe(
      "Null/undefined dereference detected. Verify state initialization before property dereferencing.",
    );
  });

  test("returns the untouched default shape for unrelated output", () => {
    const analysis = parseTestFailures("3 passed, 0 failed in 0.2s");
    expect(analysis.testName).toBe("unknown_test");
    expect(analysis.path).toBe("unknown_file");
    expect(analysis.errorMessage).toBe("Test execution failed");
    expect(analysis.stackTrace.length).toBe(0);
    expect(analysis.rootCauseHint).toBeUndefined();
  });
});
