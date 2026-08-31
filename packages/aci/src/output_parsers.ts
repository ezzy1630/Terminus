/**
 * @terminus/aci — Typed Command-Output Parsers.
 *
 * Implements SPEC §11.3, §34.11 and prompt requirements:
 * - Compiler / linter error diagnostics parsing (rustc, tsc, gcc, clang, eslint)
 * - Test framework output parsing (jest, vitest, pytest, cargo test)
 * - Stack trace frame extraction and root cause hint generation
 */
import type { Diagnostic } from "./index.js";
import type { FailureAnalysis, StackFrame } from "./inspect.js";

export function parseCompilerDiagnostics(rawOutput: string): readonly Diagnostic[] {
  const diags: Diagnostic[] = [];
  const lines = rawOutput.split("\n");

  for (const line of lines) {
    // Rustc style: "error[E0308]: mismatched types\n --> src/main.rs:42:10"
    const rustcMatch = line.match(/^\s*-->\s+([^:]+):(\d+):(\d+)/);
    if (rustcMatch) {
      diags.push({
        severity: "error",
        code: "rustc_error",
        message: line.trim(),
        path: rustcMatch[1]!,
        range: {
          startLine: parseInt(rustcMatch[2]!, 10),
          endLine: parseInt(rustcMatch[2]!, 10),
        },
      });
      continue;
    }

    // Standard GCC / Clang / TSC format: "src/index.ts(12,34): error TS2304: Cannot find name 'foo'."
    const tscMatch = line.match(/^([^\s()]+)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z0-9]+):\s*(.+)$/i);
    if (tscMatch) {
      diags.push({
        severity: tscMatch[4]!.toLowerCase() === "error" ? "error" : "warning",
        code: tscMatch[5]!,
        message: tscMatch[6]!,
        path: tscMatch[1]!,
        range: {
          startLine: parseInt(tscMatch[2]!, 10),
          endLine: parseInt(tscMatch[2]!, 10),
        },
      });
      continue;
    }

    // Unix style: "src/main.c:42:10: error: expected ';' before 'return'"
    const unixMatch = line.match(/^([^:]+):(\d+):(\d+):\s*(error|warning):\s*(.+)$/i);
    if (unixMatch) {
      diags.push({
        severity: unixMatch[4]!.toLowerCase() === "error" ? "error" : "warning",
        code: null,
        message: unixMatch[5]!,
        path: unixMatch[1]!,
        range: {
          startLine: parseInt(unixMatch[2]!, 10),
          endLine: parseInt(unixMatch[2]!, 10),
        },
      });
    }
  }

  return diags;
}

const NULL_PATTERN = /(undefined|null|None)/;
const ASSERTION_PATTERN = /(assert|expect)/;

function getRootCauseHint(errorMessage: string): string | undefined {
  if (NULL_PATTERN.test(errorMessage)) {
    return "Null/undefined dereference detected. Verify state initialization before property dereferencing.";
  }
  if (ASSERTION_PATTERN.test(errorMessage)) {
    return "Assertion failure. Compare expected vs actual values.";
  }
  return undefined;
}

export function parseTestFailures(rawOutput: string): FailureAnalysis {
  const lines = rawOutput.split("\n");
  let testName = "unknown_test";
  let errorMessage = "Test execution failed";
  let primaryPath = "unknown_file";
  const frames: StackFrame[] = [];

  for (const line of lines) {
    // Pytest failure header: "FAILED tests/test_auth.py::test_login - AssertionError: assert False"
    const pytestMatch = line.match(/^FAILED\s+([^:]+)::([^\s]+)\s+-\s+(.+)$/);
    if (pytestMatch) {
      primaryPath = pytestMatch[1]!;
      testName = pytestMatch[2]!;
      errorMessage = pytestMatch[3]!;
    }

    // Jest / Vitest failure header: "FAIL src/auth.test.ts"
    const jestMatch = line.match(/^FAIL\s+([^\s]+)/);
    if (jestMatch) {
      primaryPath = jestMatch[1]!;
    }

    // Stack frame matching: "    at Object.<anonymous> (src/auth.test.ts:42:15)"
    const stackMatch = line.match(/at\s+([A-Za-z0-9_$.<>]+)\s+\(([^:]+):(\d+):(\d+)\)/);
    if (stackMatch) {
      if (frames.length === 0 && primaryPath === "unknown_file") {
        primaryPath = stackMatch[2]!;
      }
      frames.push({
        frameIndex: frames.length,
        functionName: stackMatch[1]!,
        path: stackMatch[2]!,
        line: parseInt(stackMatch[3]!, 10),
        column: parseInt(stackMatch[4]!, 10),
      });
    }
  }

  return {
    testName,
    path: primaryPath,
    errorMessage,
    stackTrace: frames,
    rootCauseHint: getRootCauseHint(errorMessage),
  };
}
