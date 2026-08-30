import { parseCompilerDiagnostics, parseTestFailures } from "@terminus/aci";

/**
 * Authoritative world-state extraction (deep-audit Rank 1, PR2).
 *
 * The historical live loop passed `changedFiles: []`, `failingTests: []`,
 * and `diagnostics: []` to the context compiler on every turn, so the model
 * had to rediscover its own edits and every failing assertion through
 * tools. This module derives those signals from durable evidence that the
 * turn runtime already persists: settled tool episodes (patch results,
 * exec output) and prior verification failures.
 *
 * All inputs are raw strings decoded from immutable artifacts; nothing here
 * executes commands or touches the filesystem directly.
 */

export interface WorkspaceChange {
  readonly path: string;
  readonly oldSha256: string | null;
  readonly newSha256: string | null;
  readonly operation: string;
}

export interface FailingTest {
  /** Normalized test identity, e.g. `suite::test`. */
  readonly id: string;
  readonly framework: string | null;
  readonly summary: string;
}

export interface CompilerDiagnostic {
  readonly path: string | null;
  readonly severity: string;
  readonly code: string | null;
  readonly message: string;
  readonly line: number | null;
}

export interface LastCommandOutcome {
  readonly command: string;
  readonly exitCode: number | null;
  readonly failed: boolean;
}

export interface WorldSignals {
  readonly changedFiles: readonly string[];
  readonly workspaceChanges: readonly WorkspaceChange[];
  readonly failingTests: readonly FailingTest[];
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly lastCommand: LastCommandOutcome | null;
}

const EMPTY_SIGNALS: WorldSignals = {
  changedFiles: [],
  workspaceChanges: [],
  failingTests: [],
  diagnostics: [],
  lastCommand: null,
};

export function emptyWorldSignals(): WorldSignals {
  return EMPTY_SIGNALS;
}

interface PatchResultShape {
  readonly changed_files?: ReadonlyArray<{
    readonly path?: unknown;
    readonly old_sha256?: unknown;
    readonly new_sha256?: unknown;
    readonly operation?: unknown;
  }>;
}

interface ToolResultTranscriptShape {
  readonly protocol?: unknown;
  readonly result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode a settled patch tool result into workspace changes. */
export function extractPatchChanges(resultJson: string): readonly WorkspaceChange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  // Settled artifacts store the provider-facing transcript wrapper around the
  // result (`terminus.tool-result.v1`). Older artifacts contain the bare
  // result envelope. Accept both shapes at this boundary so a bounded context
  // window cannot erase durable patch observations.
  const wrapper = parsed as ToolResultTranscriptShape;
  const envelope = isRecord(wrapper.result) ? wrapper.result : parsed;
  const data = isRecord(envelope.data) ? envelope.data : envelope;
  const files = (data as PatchResultShape).changed_files;
  if (!Array.isArray(files)) return [];
  const changes: WorkspaceChange[] = [];
  for (const file of files) {
    if (typeof file?.path !== "string" || file.path.length === 0) continue;
    changes.push({
      path: file.path,
      oldSha256: typeof file.old_sha256 === "string" ? file.old_sha256 : null,
      newSha256: typeof file.new_sha256 === "string" ? file.new_sha256 : null,
      operation: typeof file.operation === "string" ? file.operation : "unknown",
    });
  }
  return changes;
}

/** Normalize compiler/linter output from an exec result into diagnostics. */
export function extractDiagnostics(execOutput: string): readonly CompilerDiagnostic[] {
  const parsed = parseCompilerDiagnostics(execOutput);
  return parsed.map((diagnostic) => ({
    path: diagnostic.path ?? null,
    severity: diagnostic.severity,
    code: diagnostic.code ?? null,
    message: diagnostic.message,
    line:
      diagnostic.range !== null && diagnostic.range.startLine > 0
        ? diagnostic.range.startLine
        : null,
  }));
}

/** Parse test-runner output into normalized failing tests. */
export function extractFailingTests(execOutput: string): readonly FailingTest[] {
  const failures: FailingTest[] = [];
  const seen = new Set<string>();
  const lines = execOutput.split("\n");
  // Pytest-style per-test headers: "FAILED path::test - message".
  for (const line of lines) {
    const pytestMatch = line.match(/^FAILED\s+([^:\s]+)::([^\s]+)\s+-\s+(.+)$/);
    if (pytestMatch) {
      const id = `${pytestMatch[1]}::${pytestMatch[2]}`;
      if (!seen.has(id)) {
        seen.add(id);
        failures.push({
          id,
          framework: "pytest",
          summary: pytestMatch[3]!.slice(0, 2_000),
        });
      }
    }
  }
  if (failures.length > 0) return failures;
  // Fall back to the shared failure parser for jest/vitest-style output.
  const analysis = parseTestFailures(execOutput);
  if (analysis.testName === "unknown_test" && analysis.path === "unknown_file") {
    return [];
  }
  const id = `${analysis.path}::${analysis.testName}`;
  return [
    {
      id,
      framework: /jest|vitest/i.test(execOutput) ? "jest-vitest" : "unknown",
      summary: (analysis.rootCauseHint
        ? `${analysis.errorMessage} — ${analysis.rootCauseHint}`
        : analysis.errorMessage
      ).slice(0, 2_000),
    },
  ];
}

/** Extract a bounded last-command outcome summary from an exec result. */
export function extractLastCommand(
  commandLine: string,
  resultJson: string,
): LastCommandOutcome | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const data = isRecord(parsed.data) ? parsed.data : parsed;
  const exitCode =
    typeof data.exit_code === "number" ? data.exit_code : null;
  const status = typeof parsed.status === "string" ? parsed.status : "unknown";
  return {
    command: commandLine.slice(0, 500),
    exitCode,
    failed: status === "error" || (exitCode !== null && exitCode !== 0),
  };
}

/**
 * Fold a sequence of episode observations (oldest → newest) into world
 * signals. Later evidence wins; patch changes accumulate across the turn.
 *
 * `episode` yields `[toolName, resultJson]` pairs in settlement order.
 */
export function deriveWorldSignals(
  episodes: readonly (readonly [toolName: string, resultJson: string])[],
): WorldSignals {
  const changeMap = new Map<string, WorkspaceChange>();
  let failingTests: readonly FailingTest[] = EMPTY_SIGNALS.failingTests;
  let diagnostics: readonly CompilerDiagnostic[] = EMPTY_SIGNALS.diagnostics;
  let lastCommand: LastCommandOutcome | null = null;

  for (const [toolName, resultJson] of episodes) {
    if (toolName === "patch") {
      for (const change of extractPatchChanges(resultJson)) {
        changeMap.set(change.path, change);
      }
    } else if (toolName === "exec") {
      // Tool results wrap data in the universal envelope; tests/diagnostics
      // are parsed from stdout/stderr projections when present.
      const output = extractExecOutput(resultJson);
      if (output.length > 0) {
        const parsedTests = extractFailingTests(output);
        if (parsedTests.length > 0) failingTests = parsedTests;
        const parsedDiagnostics = extractDiagnostics(output);
        if (parsedDiagnostics.length > 0) diagnostics = parsedDiagnostics;
      }
      lastCommand = extractLastCommand(toolName, resultJson) ?? lastCommand;
    }
  }

  return {
    changedFiles: [...changeMap.keys()],
    workspaceChanges: [...changeMap.values()],
    failingTests,
    diagnostics,
    lastCommand,
  };
}

function extractExecOutput(resultJson: string): string {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (!isRecord(parsed)) return "";
    const data = isRecord(parsed.data) ? parsed.data : parsed;
    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    const stderr = typeof data.stderr === "string" ? data.stderr : "";
    return `${stdout}\n${stderr}`.slice(0, 64 * 1_024);
  } catch {
    return "";
  }
}
