/**
 * @terminus/aci — Production Inspect Tool Implementation.
 *
 * Implements SPEC §11.3, §34.13 and prompt requirements:
 * - Real compiler / linter diagnostics
 * - Symbol information & references
 * - Call & type hierarchy
 * - Workspace diff & patch previews
 * - Test status & failure analysis (stack trace parsing, root-cause hints)
 * - Rename planning (`rename_preview` read-only edit plan)
 * - High-level debugger operations (`debug_test`, `trace_function`)
 * - Prevents raw LSP/DAP wire protocol dumps in tool palette
 */
import { z } from "zod";
import type { ContentHash } from "@terminus/domain";
import type {
  ToolExecutor,
  ToolCallContext,
  ToolResult,
  Diagnostic,
} from "./index.js";
import { okResult, errorResult } from "./index.js";

// ────────────────────────── Inspect Schemas ──────────────────────────────────

export const inspectOpSchema = z.enum([
  "diagnostics",
  "inspect_symbol",
  "find_references",
  "definition",
  "call_hierarchy",
  "type_hierarchy",
  "test_status",
  "inspect_failure",
  "workspace_diff",
  "rename_symbol",
  "debug_test",
  "trace_function",
]);

export type InspectOp = z.infer<typeof inspectOpSchema>;

export const inspectInputSchema = z.object({
  op: inspectOpSchema,
  path: z.string().optional(),
  symbol: z.string().optional(),
  files: z.array(z.string()).optional(),
  newName: z.string().optional(),
  testSelector: z.string().optional(),
  functionName: z.string().optional(),
  failureArtifact: z.string().optional(),
});

export type InspectInput = z.infer<typeof inspectInputSchema>;

export interface CallHierarchyItem {
  readonly symbol: string;
  readonly path: string;
  readonly line: number;
  readonly direction: "incoming" | "outgoing";
}

export interface RenamePlanEdit {
  readonly path: string;
  readonly line: number;
  readonly oldText: string;
  readonly newText: string;
}

export interface StackFrame {
  readonly frameIndex: number;
  readonly functionName: string;
  readonly path: string;
  readonly line: number;
  readonly column?: number | undefined;
}

export interface FailureAnalysis {
  readonly testName: string;
  readonly path: string;
  readonly errorMessage: string;
  readonly stackTrace: readonly StackFrame[];
  readonly rootCauseHint?: string | undefined;
}

export interface DebuggerState {
  readonly currentFrame: StackFrame;
  readonly variables: Readonly<Record<string, string>>;
  readonly callStack: readonly StackFrame[];
  readonly breakpointHit?: boolean | undefined;
}

export interface InspectResultData {
  readonly op: InspectOp;
  readonly summary: string;
  readonly diagnostics?: readonly Diagnostic[] | undefined;
  readonly symbol?: {
    name: string;
    kind: string;
    path: string;
    range: [number, number];
    signature?: string;
  } | undefined;
  readonly references?: readonly { path: string; line: number; text: string }[] | undefined;
  readonly callHierarchy?: readonly CallHierarchyItem[] | undefined;
  readonly typeHierarchy?: readonly CallHierarchyItem[] | undefined;
  readonly renamePlan?: readonly RenamePlanEdit[] | undefined;
  readonly failureAnalysis?: FailureAnalysis | undefined;
  readonly debuggerState?: DebuggerState | undefined;
  readonly workspaceDiff?: {
    modified: readonly string[];
    added: readonly string[];
    removed: readonly string[];
  } | undefined;
}

// ────────────────────────── Inspect Provider Interface ───────────────────────

export interface InspectProvider {
  getDiagnostics(paths?: readonly string[]): Promise<readonly Diagnostic[]>;
  lookupSymbol(name: string, path?: string): Promise<InspectResultData["symbol"] | null>;
  findReferences(symbol: string): Promise<readonly { path: string; line: number; text: string }[]>;
  getWorkspaceDiff(): Promise<{ modified: string[]; added: string[]; removed: string[] }>;
  getCallHierarchy?(symbol: string): Promise<readonly CallHierarchyItem[]>;
  getTypeHierarchy?(symbol: string): Promise<readonly CallHierarchyItem[]>;
  debugTest?(input: { readonly path?: string; readonly testSelector?: string }): Promise<DebuggerState | null>;
  getTestStatus?(selector: string): Promise<readonly Diagnostic[]>;
  parseFailureArtifact?(uri: string): Promise<FailureAnalysis | null>;
}

// ────────────────────────── Failure Parser Helper ─────────────────────────────

const ERROR_LINE_PATTERN = /(FAIL|AssertionError|Error:)/;
const NULL_DEREF_PATTERN = /(undefined|null)/;

// skipcq: JS-0067
function inferRootCauseHint(errorMessage: string): string | undefined {
  if (NULL_DEREF_PATTERN.test(errorMessage)) {
    return "Null/undefined dereference detected. Verify state initialization before access.";
  }
  if (errorMessage.includes("expected") && errorMessage.includes("received")) {
    return "Assertion value mismatch. Inspect expected vs actual return values.";
  }
  return undefined;
}

// skipcq: JS-0067
export function parseStackTrace(rawLog: string): FailureAnalysis {
  const lines = rawLog.split("\n");
  let testName = "unknown_test";
  let errorMessage = "Test failed";
  let path = "unknown_file";
  const frames: StackFrame[] = [];

  for (const l of lines) {
    if (ERROR_LINE_PATTERN.test(l)) {
      errorMessage = l.trim();
    }
    // Parse stack frame lines like: "at functionName (path/file.ts:12:34)"
    // without applying a backtracking regular expression to log input.
    const frame = parseStackFrame(l);
    if (frame) {
      if (frames.length === 0) {
        path = frame.path;
      }
      frames.push({
        frameIndex: frames.length,
        functionName: frame.functionName,
        path: frame.path,
        line: frame.line,
        column: frame.column,
      });
    }
  }

  return {
    testName,
    path,
    errorMessage,
    stackTrace: frames,
    rootCauseHint: inferRootCauseHint(errorMessage),
  };
}

function parseStackFrame(line: string): {
  readonly functionName: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
} | null {
  const marker = line.indexOf("at ");
  if (marker < 0) return null;
  const open = line.indexOf("(", marker + 3);
  const close = line.lastIndexOf(")");
  if (open < 0 || close <= open) return null;

  const functionName = line.slice(marker + 3, open).trim();
  const location = line.slice(open + 1, close);
  const lastColon = location.lastIndexOf(":");
  const previousColon = location.lastIndexOf(":", lastColon - 1);
  if (!functionName || previousColon <= 0 || lastColon <= previousColon) return null;

  const path = location.slice(0, previousColon);
  const lineNumber = Number(location.slice(previousColon + 1, lastColon));
  const column = Number(location.slice(lastColon + 1));
  if (!path || !Number.isInteger(lineNumber) || !Number.isInteger(column)) return null;
  return { functionName, path, line: lineNumber, column };
}

// ────────────────────────── Inspect Executor ──────────────────────────────────

export class ProductionInspectExecutor implements ToolExecutor<InspectResultData> {
  readonly toolId = "inspect" as const;

  constructor(private readonly provider: InspectProvider) {}

  async execute(
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResult<InspectResultData>> {
    const parseRes = inspectInputSchema.safeParse(args);
    if (!parseRes.success) {
      return errorResult(`Invalid inspect input: ${parseRes.error.message}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }
    const input = parseRes.data;

    switch (input.op) {
      case "diagnostics": {
        const targetFiles = input.files ?? (input.path ? [input.path] : undefined);
        const diags = await this.provider.getDiagnostics(targetFiles);
        const errorCount = diags.filter((d) => d.severity === "error").length;

        const data: InspectResultData = {
          op: "diagnostics",
          summary: `Found ${diags.length} diagnostics (${errorCount} errors)`,
          diagnostics: diags,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: data.summary,
        });
      }

      case "inspect_symbol": {
        if (!input.symbol) {
          return errorResult("symbol parameter required for inspect_symbol", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const sym = await this.provider.lookupSymbol(input.symbol, input.path);

        const data: InspectResultData = {
          op: "inspect_symbol",
          summary: sym ? `Symbol ${sym.name} found in ${sym.path}` : `Symbol ${input.symbol} not found`,
          symbol: sym ?? undefined,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: data.summary,
        });
      }

      case "find_references": {
        if (!input.symbol) {
          return errorResult("symbol parameter required for find_references", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const refs = await this.provider.findReferences(input.symbol);

        const data: InspectResultData = {
          op: "find_references",
          summary: `Found ${refs.length} references for symbol ${input.symbol}`,
          references: refs,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: data.summary,
        });
      }

      case "definition": {
        if (!input.symbol) {
          return errorResult("symbol parameter required for definition", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const resolvedSymbol = await this.provider.lookupSymbol(input.symbol, input.path);
        if (resolvedSymbol === undefined || resolvedSymbol === null) {
          return errorResult(`definition not found for symbol ${input.symbol}`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const data: InspectResultData = {
          op: "definition",
          summary: `Definition for ${resolvedSymbol.name} is ${resolvedSymbol.path}:${resolvedSymbol.range[0]}`,
          symbol: resolvedSymbol,
        };
        return okResult(data, { toolCallId: ctx.toolCallId, traceId: ctx.traceId, summary: data.summary });
      }

      case "call_hierarchy":
      case "trace_function": {
        const symbol = input.symbol ?? input.functionName;
        if (!symbol) {
          return errorResult("symbol or functionName parameter required for call hierarchy", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        if (!this.provider.getCallHierarchy) {
          return errorResult("call-hierarchy provider is unavailable", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const hierarchy = await this.provider.getCallHierarchy(symbol);
        const data: InspectResultData = {
          op: input.op,
          summary: `Found ${hierarchy.length} call-hierarchy edges for ${symbol}`,
          callHierarchy: hierarchy,
        };
        return okResult(data, { toolCallId: ctx.toolCallId, traceId: ctx.traceId, summary: data.summary });
      }

      case "type_hierarchy": {
        if (!input.symbol) {
          return errorResult("symbol parameter required for type_hierarchy", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        if (!this.provider.getTypeHierarchy) {
          return errorResult("type-hierarchy provider is unavailable", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const hierarchy = await this.provider.getTypeHierarchy(input.symbol);
        const data: InspectResultData = {
          op: input.op,
          summary: `Found ${hierarchy.length} type-hierarchy items for ${input.symbol}`,
          typeHierarchy: hierarchy,
        };
        return okResult(data, { toolCallId: ctx.toolCallId, traceId: ctx.traceId, summary: data.summary });
      }

      case "test_status": {
        const selector = input.testSelector ?? input.path;
        if (!selector) {
          return errorResult("testSelector or path parameter required for test_status", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        if (!this.provider.getTestStatus) {
          return errorResult("test-status provider is unavailable", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const diagnostics = await this.provider.getTestStatus(selector);
        const data: InspectResultData = {
          op: "test_status",
          summary: `Test status for ${selector}: ${diagnostics.length} diagnostic(s)`,
          diagnostics,
        };
        return okResult(data, { toolCallId: ctx.toolCallId, traceId: ctx.traceId, summary: data.summary });
      }

      case "rename_symbol": {
        if (!input.symbol || !input.newName) {
          return errorResult("symbol and newName parameters required for rename_symbol", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const refs = await this.provider.findReferences(input.symbol);

        const renamePlan: RenamePlanEdit[] = refs.map((r) => ({
          path: r.path,
          line: r.line,
          oldText: input.symbol!,
          newText: input.newName!,
        }));

        const data: InspectResultData = {
          op: "rename_symbol",
          summary: `Generated read-only rename plan for ${input.symbol} -> ${input.newName} across ${renamePlan.length} sites. Apply with patch.`,
          renamePlan,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: data.summary,
        });
      }

      case "inspect_failure": {
        if (!input.failureArtifact) {
          return errorResult("failureArtifact is required for inspect_failure; synthetic failures are not evidence", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        let fa: FailureAnalysis;
        if (this.provider.parseFailureArtifact) {
          const parsed = await this.provider.parseFailureArtifact(input.failureArtifact);
          fa = parsed ?? parseStackTrace(input.failureArtifact);
        } else {
          fa = parseStackTrace(input.failureArtifact);
        }

        const data: InspectResultData = {
          op: "inspect_failure",
          summary: `Failure analysis for ${fa.testName}: ${fa.errorMessage}`,
          failureAnalysis: fa,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: data.summary,
        });
      }

      case "workspace_diff": {
        const diff = await this.provider.getWorkspaceDiff();

        const data: InspectResultData = {
          op: "workspace_diff",
          summary: `Workspace diff: ${diff.modified.length} modified, ${diff.added.length} added, ${diff.removed.length} removed`,
          workspaceDiff: diff,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: data.summary,
        });
      }

      case "debug_test": {
        if (!this.provider.debugTest) {
          return errorResult("debugger provider is unavailable", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const debugInput: { path?: string; testSelector?: string } = {};
        if (input.path !== undefined) {
          debugInput.path = input.path;
        }
        if (input.testSelector !== undefined) {
          debugInput.testSelector = input.testSelector;
        }
        const dbg = await this.provider.debugTest(debugInput);
        if (dbg === null) {
          return errorResult("debugger returned no paused test state", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        const data: InspectResultData = {
          op: "debug_test",
          summary: `Paused at breakpoint in ${dbg.currentFrame.functionName} (${dbg.currentFrame.path}:${dbg.currentFrame.line})`,
          debuggerState: dbg,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: data.summary,
        });
      }

      default: {
        return errorResult(`Inspect operation '${input.op}' is not implemented by the configured provider`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }
  }
}
