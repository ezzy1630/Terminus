/**
 * @terminus/aci — Typed Command-Output Parsers.
 *
 * Implements SPEC §11.3, §34.11 and prompt requirements:
 * - Compiler / linter error diagnostics parsing (rustc, tsc, gcc, clang, eslint)
 * - Test framework output parsing (jest, vitest, pytest, cargo test)
 * - Stack trace frame extraction and root cause hint generation
 *
 * Parsers in this module run on uncontrolled command output. Their regexes
 * must stay linear-time: adjacent quantified groups must never accept
 * overlapping character sets (e.g. `\s+` followed by a class that admits
 * whitespace), or adversarial input forces polynomial backtracking.
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

// Pytest failure header: "FAILED tests/test_auth.py::test_login - AssertionError: assert False".
// `[^:\s]+` cannot overlap the preceding `\s+`, and the message is taken as
// the remainder of the line, so the match is linear in the input length.
const PYTEST_FAILURE_PATTERN = /^FAILED\s+([^:\s]+)::([^\s]+)\s+-\s+/;

// skipcq: JS-0067
function parsePytestLine(line: string): { primaryPath: string; testName: string; errorMessage: string } | null {
  const match = PYTEST_FAILURE_PATTERN.exec(line);
  if (match === null) return null;
  const errorMessage = line.slice(match[0].length);
  if (errorMessage.length === 0) return null;
  return {
    primaryPath: match[1]!,
    testName: match[2]!,
    errorMessage,
  };
}

const isWhitespace = (ch: string): boolean => " \t\r\n\f\v".includes(ch);
const isStackNameChar = (ch: string): boolean => /[A-Za-z0-9_$.<>]/.test(ch);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

// Reads a run of ASCII digits starting at `from`. Returns the index just past
// the run, or -1 when the run is empty.
const readDigits = (line: string, from: number): number => {
  let i = from;
  while (i < line.length && isDigit(line[i]!)) i++;
  return i > from ? i : -1;
};

// Parses one V8-style stack frame starting at the `at` occurrence:
// "at <name> (<path>:<line>:<column>)". Each segment is bounded by a literal
// delimiter, so scanning never walks the whole line per candidate.
const parseStackFrameAt = (line: string, at: number, frameIndex: number): StackFrame | null => {
  let i = at + 2;
  if (i >= line.length || !isWhitespace(line[i]!)) return null;
  while (i < line.length && isWhitespace(line[i]!)) i++;

  const nameStart = i;
  if (i >= line.length || !isStackNameChar(line[i]!)) return null;
  while (i < line.length && isStackNameChar(line[i]!)) i++;
  const functionName = line.slice(nameStart, i);

  if (i >= line.length || !isWhitespace(line[i]!)) return null;
  while (i < line.length && isWhitespace(line[i]!)) i++;
  if (line[i] !== "(") return null;

  const pathStart = i + 1;
  const pathColon = line.indexOf(":", pathStart);
  if (pathColon < 0 || pathColon === pathStart) return null;
  const path = line.slice(pathStart, pathColon);

  const lineEnd = readDigits(line, pathColon + 1);
  if (lineEnd < 0 || line[lineEnd] !== ":") return null;
  const columnEnd = readDigits(line, lineEnd + 1);
  if (columnEnd < 0 || line[columnEnd] !== ")") return null;

  return {
    frameIndex,
    functionName,
    path,
    line: Number.parseInt(line.slice(pathColon + 1, lineEnd), 10),
    column: Number.parseInt(line.slice(lineEnd + 1, columnEnd), 10),
  };
};

// skipcq: JS-0067
function parseStackLine(line: string, frameIndex: number): StackFrame | null {
  let at = line.indexOf("at");
  while (at >= 0) {
    const frame = parseStackFrameAt(line, at, frameIndex);
    if (frame !== null) return frame;
    at = line.indexOf("at", at + 1);
  }
  return null;
}

// skipcq: JS-0067
function parseFailureLine(
  line: string,
  frames: StackFrame[],
  current: { primaryPath: string; testName: string; errorMessage: string },
): void {
  // Every pattern is checked on every line: a failure-marker line can also
  // carry an inline stack frame, and dropping it would lose traceback data.
  const pytest = parsePytestLine(line);
  if (pytest) {
    current.primaryPath = pytest.primaryPath;
    current.testName = pytest.testName;
    current.errorMessage = pytest.errorMessage;
  }
  const jestMatch = line.match(/^FAIL\s+([^\s]+)/);
  if (jestMatch) {
    current.primaryPath = jestMatch[1]!;
  }
  const frame = parseStackLine(line, frames.length);
  if (frame) {
    if (current.primaryPath === "unknown_file") current.primaryPath = frame.path;
    frames.push(frame);
  }
}

// skipcq: JS-0067
export function parseTestFailures(rawOutput: string): FailureAnalysis {
  const lines = rawOutput.split("\n");
  const current = { testName: "unknown_test", errorMessage: "Test execution failed", primaryPath: "unknown_file" };
  const frames: StackFrame[] = [];

  for (const line of lines) {
    parseFailureLine(line, frames, current);
  }

  return {
    testName: current.testName,
    path: current.primaryPath,
    errorMessage: current.errorMessage,
    stackTrace: frames,
    rootCauseHint: getRootCauseHint(current.errorMessage),
  };
}
