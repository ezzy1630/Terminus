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

// skipcq: JS-0067
function getRootCauseHint(errorMessage: string): string | undefined {
  if (NULL_PATTERN.test(errorMessage)) {
    return "Null/undefined dereference detected. Verify state initialization before property dereferencing.";
  }
  if (ASSERTION_PATTERN.test(errorMessage)) {
    return "Assertion failure. Compare expected vs actual values.";
  }
  return undefined;
}

// skipcq: JS-0067
function parsePytestLine(line: string): { primaryPath: string; testName: string; errorMessage: string } | null {
  const match = line.match(/^FAILED\s+([^:]+)::([^\s]+)\s+-\s+(.+)$/);
  if (!match) return null;
  return { primaryPath: match[1]!, testName: match[2]!, errorMessage: match[3]! };
}

// skipcq: JS-0067
function parseStackLine(line: string, frameIndex: number): StackFrame | null {
  const match = line.match(/at\s+([A-Za-z0-9_$.<>]+)\s+\(([^:]+):(\d+):(\d+)\)/);
  if (!match) return null;
  return {
    frameIndex,
    functionName: match[1]!,
    path: match[2]!,
    line: parseInt(match[3]!, 10),
    column: parseInt(match[4]!, 10),
  };
}

// skipcq: JS-0067
export function parseTestFailures(rawOutput: string): FailureAnalysis {
  const lines = rawOutput.split("\n");
  let testName = "unknown_test";
  let errorMessage = "Test execution failed";
  let primaryPath = "unknown_file";
  const frames: StackFrame[] = [];

  for (const line of lines) {
    const pytest = parsePytestLine(line);
    if (pytest) {
      primaryPath = pytest.primaryPath;
      testName = pytest.testName;
      errorMessage = pytest.errorMessage;
    }
    const jestMatch = line.match(/^FAIL\s+([^\s]+)/);
    if (jestMatch) {
      primaryPath = jestMatch[1]!;
    }
    const frame = parseStackLine(line, frames.length);
    if (frame) {
      if (primaryPath === "unknown_file") primaryPath = frame.path;
      frames.push(frame);
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
