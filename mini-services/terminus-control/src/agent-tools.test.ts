import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_TOOL_CYCLES,
  MAX_TOOL_CYCLES_CEILING,
  MIN_TOOL_CYCLES,
  STANDALONE_TOOL_SCHEMAS,
  STANDALONE_ALWAYS_ON_TOOL_IDS,
  selectInitialStandaloneToolSchemas,
  EXEC_OUTPUT_MAX_BYTES,
  EXEC_OUTPUT_STREAM_FLOOR_BYTES,
  kernelPublicEnv,
  withWorkspaceToolDirs,
  replayIsBlockedBy,
  splitOutputBudget,
  ObservedSourceTracker,
  executeStandaloneTool,
  normalizedToolOperationHash,
  pageLines,
  InvalidToolCallError,
  parseStandaloneToolCall,
  relativizeWorkspacePath,
  relativizeStandaloneCallPaths,
  projectModelVisibleResult,
  providerToolCallTranscript,
  renderNumbered,
  resolveMaxToolCycles,
  resolveShellModeEnabled,
  assertPublicHttpsUrl,
  duplicateOperationDenial,
  effectLedgerIdempotencyKey,
  isReadOnlyToolCall,
  mayChangeWorkspace,
  globArgv,
  semanticIdempotencyGateApplies,
  stripNumberedGuttersIfFullyNumbered,
  toolEffectMetadata,
  type ParsedStandaloneToolCall,
} from "./agent-tools.js";
import type { ToolResult } from "@terminus/aci";

describe("standalone provider tools", () => {
  test("exposes the bounded kernel tool surface", () => {
    expect(STANDALONE_TOOL_SCHEMAS.map((tool) => tool.id)).toEqual(["capability", "read", "patch", "write", "exec", "exec_poll", "web_fetch", "grep", "glob"]);
    expect(selectInitialStandaloneToolSchemas(true).map((tool) => tool.id)).toEqual(["capability"]);
    expect(selectInitialStandaloneToolSchemas(false)).toEqual([]);
    // Every always-on tool has a schema, and every schema id is dispatchable.
    for (const toolId of STANDALONE_ALWAYS_ON_TOOL_IDS) {
      expect(STANDALONE_TOOL_SCHEMAS.some((tool) => tool.id === toolId)).toBe(true);
    }
    expect(DEFAULT_MAX_TOOL_CYCLES).toBe(200);
  });

  test("tool-cycle budget resolution is bounded and fail-closed", () => {
    expect(resolveMaxToolCycles(undefined)).toBe(200);
    expect(resolveMaxToolCycles("")).toBe(200);
    expect(resolveMaxToolCycles("16")).toBe(16);
    expect(resolveMaxToolCycles("1")).toBe(MIN_TOOL_CYCLES);
    expect(resolveMaxToolCycles("1000")).toBe(MAX_TOOL_CYCLES_CEILING);
    expect(() => resolveMaxToolCycles("1001")).toThrow(/between/);
    expect(() => resolveMaxToolCycles("0")).toThrow(/between/);
    expect(() => resolveMaxToolCycles("-4")).toThrow(/between/);
    expect(resolveMaxToolCycles("not-a-number")).toBe(DEFAULT_MAX_TOOL_CYCLES);
    // R3: shell mode defaults on under the sandboxed policy; explicit opt-out only.
    expect(resolveShellModeEnabled(undefined)).toBe(true);
    expect(resolveShellModeEnabled("")).toBe(true);
    expect(resolveShellModeEnabled("0")).toBe(false);
    expect(resolveShellModeEnabled("false")).toBe(false);
    expect(resolveShellModeEnabled("FALSE")).toBe(false);
    expect(resolveShellModeEnabled("1")).toBe(true);
    expect(resolveShellModeEnabled("true")).toBe(true);
  });

  test("strictly validates tool identity and arguments", () => {
    const call = parseStandaloneToolCall({
      toolCallId: "provider-call-1",
      toolName: "read",
      arguments: { path: "src/index.ts" },
    });
    expect(call.arguments).toMatchObject({
      path: "src/index.ts",
      max_bytes: 64 * 1_024,
      offset_line: 1,
      max_lines: 2_000,
      render: "numbered",
    });
    expect(toolEffectMetadata(call).effectType).toBe("READ_LOCAL");
    expect(providerToolCallTranscript(call).provider_call_id).toBe("provider-call-1");
    expect(() => parseStandaloneToolCall({ toolCallId: "x", toolName: "search", arguments: {} })).toThrow(/unknown standalone tool/);
    expect(() => parseStandaloneToolCall({ toolCallId: "x", toolName: "exec", arguments: { program: "sh; exit" } })).toThrow(/invalid/);
  });

  // Observed from big-pickle: every exec call arrived as a bare argv array,
  // was rejected as "you provided neither", and was rewritten identically
  // until the tool budget died.
  test("accepts a full argv in args with no separate program", () => {
    const call = parseStandaloneToolCall({
      toolCallId: "argv",
      toolName: "exec",
      arguments: { args: ["which", "node", "bun"], cwd: "/tmp/scratch" },
    });
    if (call.toolId !== "exec") throw new Error("expected exec");
    expect(call.arguments.program).toBe("which");
    expect(call.arguments.args).toEqual(["node", "bun"]);
    expect(call.arguments.cwd).toBe("/tmp/scratch");

    const single = parseStandaloneToolCall({
      toolCallId: "argv1",
      toolName: "exec",
      arguments: { args: ["ls"] },
    });
    if (single.toolId !== "exec") throw new Error("expected exec");
    expect(single.arguments.program).toBe("ls");
    expect(single.arguments.args).toEqual([]);
  });

  test("leaves an explicit program and shell mode untouched", () => {
    const explicit = parseStandaloneToolCall({
      toolCallId: "explicit",
      toolName: "exec",
      arguments: { program: "rg", args: ["--files"] },
    });
    if (explicit.toolId !== "exec") throw new Error("expected exec");
    expect(explicit.arguments.program).toBe("rg");
    expect(explicit.arguments.args).toEqual(["--files"]);

    // Shell mode with a stray args array must still be shell mode, not a
    // silently hoisted argv call.
    const shell = parseStandaloneToolCall({
      toolCallId: "shell",
      toolName: "exec",
      arguments: { shell: { dialect: "bash", script: "ls | wc -l" }, args: ["ignored"] },
    });
    if (shell.toolId !== "exec") throw new Error("expected exec");
    expect(shell.arguments.program).toBeUndefined();
    expect(shell.arguments.args).toEqual(["ignored"]);

    // An empty call still names both modes rather than hoisting nothing.
    expect(() => parseStandaloneToolCall({ toolCallId: "empty", toolName: "exec", arguments: { args: [] } }))
      .toThrow(/either program\+args/);
  });

  // The model is shown the workspace's absolute location and quotes it back;
  // the kernel's SafePath only accepts workspace-relative paths, and the
  // rejection used to surface as lost settlement certainty and end the turn.
  test("rewrites an absolute workspace path as workspace-relative", () => {
    const roots = ["/private/tmp/scratch", "/tmp/scratch"];
    expect(relativizeWorkspacePath("/tmp/scratch", roots)).toEqual({ path: "." });
    expect(relativizeWorkspacePath("/tmp/scratch/", roots)).toEqual({ path: "." });
    expect(relativizeWorkspacePath("/private/tmp/scratch/src/a.ts", roots)).toEqual({ path: "src/a.ts" });
    expect(relativizeWorkspacePath("/tmp//scratch//src/a.ts", roots)).toEqual({ path: "src/a.ts" });
    // Already relative: untouched, including the default.
    expect(relativizeWorkspacePath(".", roots)).toEqual({ path: "." });
    expect(relativizeWorkspacePath("src/a.ts", roots)).toEqual({ path: "src/a.ts" });
    // A sibling directory that merely shares a prefix is not inside the root.
    expect(relativizeWorkspacePath("/tmp/scratch-other/a.ts", roots)).toEqual({ outsideWorkspace: true });
    expect(relativizeWorkspacePath("/etc/passwd", roots)).toEqual({ outsideWorkspace: true });
  });

  test("relativizes the path each tool carries and denies the ones outside", () => {
    const roots = ["/tmp/scratch"];
    const exec = relativizeStandaloneCallPaths(
      parseStandaloneToolCall({
        toolCallId: "x",
        toolName: "exec",
        arguments: { args: ["ls", "-la"], cwd: "/tmp/scratch" },
      }),
      roots,
    );
    if (exec.toolId !== "exec") throw new Error("expected exec");
    expect(exec.arguments.cwd).toBe(".");
    expect(exec.arguments.program).toBe("ls");

    const read = relativizeStandaloneCallPaths(
      parseStandaloneToolCall({
        toolCallId: "y",
        toolName: "read",
        arguments: { path: "/tmp/scratch/README.md" },
      }),
      roots,
    );
    if (read.toolId !== "read") throw new Error("expected read");
    expect(read.arguments.path).toBe("README.md");

    // Outside the workspace stays a denial, but a correctable one the model
    // can act on rather than an ambiguous settlement that ends the turn.
    expect(() =>
      relativizeStandaloneCallPaths(
        parseStandaloneToolCall({ toolCallId: "z", toolName: "read", arguments: { path: "/etc/passwd" } }),
        roots,
      ),
    ).toThrow(/outside the workspace/);

    // With no known root, nothing is rewritten and nothing is denied.
    const untouched = relativizeStandaloneCallPaths(
      parseStandaloneToolCall({ toolCallId: "w", toolName: "read", arguments: { path: "/tmp/scratch/a.ts" } }),
      [],
    );
    if (untouched.toolId !== "read") throw new Error("expected read");
    expect(untouched.arguments.path).toBe("/tmp/scratch/a.ts");
  });

  test("exec requires exactly one of argv or shell mode", () => {
    const argv = parseStandaloneToolCall({ toolCallId: "a", toolName: "exec", arguments: { program: "rg", args: ["--files"] } });
    expect(toolEffectMetadata(argv).effectType).toBe("EXECUTE_LOCAL");
    expect(argv.arguments).toMatchObject({ timeout_ms: 120_000, background: false });
    const long = parseStandaloneToolCall({ toolCallId: "a2", toolName: "exec", arguments: { program: "rg", args: [], timeout_ms: 600_000 } });
    if (long.toolId !== "exec") throw new Error("expected exec");
    expect(long.arguments.timeout_ms).toBe(600_000);
    expect(() => parseStandaloneToolCall({ toolCallId: "a3", toolName: "exec", arguments: { program: "rg", timeout_ms: 600_001 } })).toThrow(/invalid/);
    const shell = parseStandaloneToolCall({ toolCallId: "b", toolName: "exec", arguments: { shell: { dialect: "bash", script: "cargo test" } } });
    expect(shell.arguments).toMatchObject({ shell: { dialect: "bash", script: "cargo test" }, args: [] });
    expect(() =>
      parseStandaloneToolCall({
        toolCallId: "c",
        toolName: "exec",
        arguments: { program: "rg", shell: { dialect: "sh", script: "ls" } },
      }),
    ).toThrow(/either program\+args.*or shell/);
    expect(() =>
      parseStandaloneToolCall({
        toolCallId: "d",
        toolName: "exec",
        arguments: { shell: { dialect: "fish", script: "ls" } },
      }),
    ).toThrow(/invalid/);
    expect(() => parseStandaloneToolCall({ toolCallId: "e", toolName: "exec", arguments: {} })).toThrow(/either program\+args/);
  });

  test("a call the model got wrong is an InvalidToolCallError the loop settles as a result", () => {
    // One exec carrying both modes used to end the whole turn as "not
    // retryable". It is the model's mistake, so it must come back as a
    // typed, correctable error keyed to the provider call.
    const both = (): void => {
      parseStandaloneToolCall({
        toolCallId: "c",
        toolName: "exec",
        arguments: { program: "rg", shell: { dialect: "sh", script: "ls" } },
      });
    };
    expect(both).toThrow(InvalidToolCallError);
    try {
      both();
    } catch (error: unknown) {
      if (!(error instanceof InvalidToolCallError)) throw error;
      expect(error.toolName).toBe("exec");
      expect(error.providerCallId).toBe("c");
      expect(error.modelMessage).toMatch(/you provided both; keep exactly one/);
      expect(error.modelMessage).toMatch(/correct the arguments and call again/);
    }
    expect(() => parseStandaloneToolCall({ toolCallId: "e", toolName: "exec", arguments: {} }))
      .toThrow(/you provided neither/);
    // Field names travel with the issue so "Required" never arrives alone.
    expect(() => parseStandaloneToolCall({ toolCallId: "r", toolName: "read", arguments: {} }))
      .toThrow(/path: /);
    // Unknown tools are the model's mistake too; the message names the alternatives.
    const unknown = (): void => { parseStandaloneToolCall({ toolCallId: "x", toolName: "search", arguments: {} }); };
    expect(unknown).toThrow(InvalidToolCallError);
    expect(unknown).toThrow(/Available tools: capability, read, patch, write, exec, exec_poll, grep, glob, web_fetch/);
    // A malformed call id is a transport fault, not a model mistake: there is
    // no id to key a corrective result to.
    const badId = (): void => { parseStandaloneToolCall({ toolCallId: "", toolName: "read", arguments: { path: "a" } }); };
    expect(badId).toThrow(/call id is invalid/);
    expect(badId).not.toThrow(InvalidToolCallError);
  });

  test("patch accepts a single edit and a multi-edit batch, never both missing", () => {
    const single = parseStandaloneToolCall({
      toolCallId: "p1",
      toolName: "patch",
      arguments: { path: "a.ts", expected_sha256: `sha256:${"a".repeat(64)}`, expected_utf8: "old", replacement_utf8: "new" },
    });
    if (single.toolId !== "patch") throw new Error("expected patch");
    expect(single.arguments.edits).toBeUndefined();
    const multi = parseStandaloneToolCall({
      toolCallId: "p2",
      toolName: "patch",
      arguments: {
        path: "a.ts",
        expected_sha256: `sha256:${"a".repeat(64)}`,
        edits: [
          { expected_utf8: "one", replacement_utf8: "1" },
          { expected_utf8: "two", replacement_utf8: "2" },
        ],
      },
    });
    if (multi.toolId !== "patch") throw new Error("expected patch");
    expect(multi.arguments.edits?.length).toBe(2);
    expect(() =>
      parseStandaloneToolCall({
        toolCallId: "p3",
        toolName: "patch",
        arguments: { path: "a.ts", expected_sha256: `sha256:${"a".repeat(64)}` },
      }),
    ).toThrow(/expected_utf8\+replacement_utf8, or a non-empty edits array/);
  });

  test("grep and glob validate bounds and defaults", () => {
    const grep = parseStandaloneToolCall({
      toolCallId: "g1",
      toolName: "grep",
      arguments: { pattern: "MAX_TOOL[A-Z_]*" },
    });
    if (grep.toolId !== "grep") throw new Error("expected grep");
    expect(grep.arguments).toMatchObject({ path: ".", ignore_case: false, max_results: 100 });
    expect(toolEffectMetadata(grep).effectType).toBe("READ_LOCAL");
    const glob = parseStandaloneToolCall({
      toolCallId: "g2",
      toolName: "glob",
      arguments: { pattern: "src/**/*.ts", max_results: 5 },
    });
    if (glob.toolId !== "glob") throw new Error("expected glob");
    expect(glob.arguments.max_results).toBe(5);
    expect(() => parseStandaloneToolCall({ toolCallId: "g3", toolName: "grep", arguments: {} })).toThrow(/invalid/);
    expect(() =>
      parseStandaloneToolCall({ toolCallId: "g4", toolName: "grep", arguments: { pattern: "x", max_results: 501 } }),
    ).toThrow(/invalid/);
  });

  test("recursive globs include root files and read-only argv discovery is not a mutation", () => {
    expect(globArgv({ pattern: "**/*", path: ".", max_results: 200 }).args).toEqual([
      "--files", "--color", "never", "--glob", "**/*", "--glob", "*",
    ]);
    const ls = parseStandaloneToolCall({
      toolCallId: "ls",
      toolName: "exec",
      arguments: { program: "ls", args: ["-la"] },
    });
    const shell = parseStandaloneToolCall({
      toolCallId: "shell",
      toolName: "exec",
      arguments: { shell: { dialect: "sh", script: "ls -la" } },
    });
    const write = parseStandaloneToolCall({
      toolCallId: "write",
      toolName: "exec",
      arguments: { program: "touch", args: ["new.txt"] },
    });
    expect(mayChangeWorkspace(ls)).toBe(false);
    expect(mayChangeWorkspace(shell)).toBe(true);
    expect(mayChangeWorkspace(write)).toBe(true);
  });

  test("semantic idempotency excludes provider attempts and call ids", () => {
    const first = parseStandaloneToolCall({ toolCallId: "call-a", toolName: "read", arguments: { path: "README.md" } });
    const second = parseStandaloneToolCall({ toolCallId: "call-b", toolName: "read", arguments: { path: "README.md" } });
    expect(normalizedToolOperationHash({ taskId: "task", contractVersion: 3, call: first })).toBe(
      normalizedToolOperationHash({ taskId: "task", contractVersion: 3, call: second }),
    );
  });

  test("read defaults to numbered render; raw is explicit; patch hash is optional", () => {
    const read = parseStandaloneToolCall({ toolCallId: "r1", toolName: "read", arguments: { path: "a.ts" } });
    if (read.toolId !== "read") throw new Error("expected read");
    expect(read.arguments.render).toBe("numbered");
    const raw = parseStandaloneToolCall({ toolCallId: "r2", toolName: "read", arguments: { path: "a.ts", render: "raw" } });
    if (raw.toolId !== "read") throw new Error("expected read");
    expect(raw.arguments.render).toBe("raw");
    const patch = parseStandaloneToolCall({
      toolCallId: "p9",
      toolName: "patch",
      arguments: { path: "a.ts", expected_utf8: "old", replacement_utf8: "new" },
    });
    if (patch.toolId !== "patch") throw new Error("expected patch");
    expect(patch.arguments.expected_sha256).toBeUndefined();
  });
});

describe("R1 numbered rendering and gutter-safe patching", () => {
  test("renderNumbered emits stable <line>→ gutters", () => {
    expect(renderNumbered("alpha\nbeta\n", 7)).toBe("7→ alpha\n8→ beta\n");
    expect(renderNumbered("", 1)).toBe("");
  });

  test("gutters are stripped only when every non-empty line carries one", () => {
    const fully = stripNumberedGuttersIfFullyNumbered("1→ alpha\n2→ beta\n");
    expect(fully).toEqual({ text: "alpha\nbeta\n", stripped: true });
    const partial = stripNumberedGuttersIfFullyNumbered("1→ alpha\nbeta\n");
    expect(partial).toEqual({ text: "1→ alpha\nbeta\n", stripped: false });
    // Real code that merely starts with digits is untouched.
    const code = stripNumberedGuttersIfFullyNumbered("12 days\nlater\n");
    expect(code.stripped).toBe(false);
  });

  test("ObservedSourceTracker records valid hashes per workspace:path and ignores malformed ones", () => {
    const tracker = new ObservedSourceTracker();
    const good = `sha256:${"a".repeat(64)}`;
    tracker.record("w1", "src/a.ts", good);
    tracker.record("w1", "src/b.ts", "sha256:nothex");
    tracker.record("w1", "src/c.ts", "");
    expect(tracker.resolve("w1", "src/a.ts")).toBe(good);
    expect(tracker.resolve("w1", "src/b.ts")).toBeNull();
    expect(tracker.resolve("w2", "src/a.ts")).toBeNull();
    expect(tracker.size).toBe(1);
    tracker.record("w1", "src/a.ts", `sha256:${"b".repeat(64)}`);
    expect(tracker.resolve("w1", "src/a.ts")).toBe(`sha256:${"b".repeat(64)}`);
  });

  test("read exposes file_sha256 + total_lines and registers the observation", async () => {
    const sha = `sha256:${"c".repeat(64)}`;
    let patchedWith: string | null = null;
    const clients = {
      files: {
        Read: (_request: unknown) => ({
          modelProjectionUtf8: new TextEncoder().encode("alpha\nbeta\n"),
          sourceVersion: { sha256: sha, repositoryRevision: "no-vcs" },
          renderedMode: "full",
          continuationToken: "",
          truncated: false,
          fullContent: undefined,
          diagnostics: [],
        }),
      },
      patch: {
        Apply: (request: { baseline: { sources: readonly { sha256: string }[] } }) => {
          patchedWith = request.baseline.sources[0]?.sha256 ?? null;
          return {
            transactionId: "txn",
            state: "APPLIED",
            finalRepositoryRevision: "no-vcs",
            finalDirtyDigest: "",
            changedFiles: [],
            validations: [],
            completeDiff: undefined,
          };
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const tracker = new ObservedSourceTracker();
    const base = {
      context: { idempotencyKey: "idem" } as never,
      workspaceId: "ws-1",
      internalToolCallId: "tc",
      sideEffectId: "00000000-0000-7000-8000-000000000011" as never,
      policyDecisionId: "pd",
      traceId: "trace",
      contractHash: "hash",
      devMode: false,
      shellModeEnabled: true,
      observedSources: tracker,
    } as const;
    const readResult = await executeStandaloneTool({
      ...base,
      clients,
      call: parseStandaloneToolCall({ toolCallId: "rr", toolName: "read", arguments: { path: "src/a.ts" } }) as Extract<ParsedStandaloneToolCall, { toolId: "read" }>,
    });
    expect(readResult.status).toBe("success");
    const data = readResult.data as Record<string, unknown>;
    expect(data.file_sha256).toBe(sha);
    expect(data.total_lines).toBe(2);
    expect(data.render).toBe("numbered");
    expect(data.content_utf8).toBe("1→ alpha\n2→ beta\n");
    expect(tracker.resolve("ws-1", "src/a.ts")).toBe(sha);
    const patchResult = await executeStandaloneTool({
      ...base,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "pp",
        toolName: "patch",
        arguments: { path: "src/a.ts", expected_utf8: "1→ alpha\n", replacement_utf8: "1→ ALPHA\n" },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "patch" }>,
    });
    expect(patchResult.status).toBe("success");
    expect(patchedWith as string | null).toBe(sha);
    expect((patchResult.data as Record<string, unknown>).resolved_from_observed_hash).toBe(true);
    expect((patchResult.data as Record<string, unknown>).gutters_stripped).toBe(true);
  });

  test("patch without any observed hash is denied with a read-first directive", async () => {
    const clients = {} as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const result = await executeStandaloneTool({
      clients,
      context: { idempotencyKey: "idem" } as never,
      workspaceId: "ws-1",
      call: parseStandaloneToolCall({
        toolCallId: "pz",
        toolName: "patch",
        arguments: { path: "src/never-read.ts", expected_utf8: "x", replacement_utf8: "y" },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "patch" }>,
      internalToolCallId: "tc",
      sideEffectId: "00000000-0000-7000-8000-000000000012" as never,
      policyDecisionId: "pd",
      traceId: "trace",
      contractHash: "hash",
      devMode: false,
      shellModeEnabled: true,
      observedSources: new ObservedSourceTracker(),
    });
    expect(result.status).toBe("denied");
    expect(result.diagnostics[0]?.code).toBe("PATCH_REQUIRES_OBSERVED_SOURCE");
    expect(result.summary).toMatch(/read the file before editing/i);
  });

  test("stale source rejection becomes an actionable error result, not an exception", async () => {
    const clients = {
      patch: {
        Apply: () => {
          throw new Error("expected_sha256 does not match source");
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const tracker = new ObservedSourceTracker();
    tracker.record("ws-1", "stale.ts", `sha256:${"d".repeat(64)}`);
    const result = await executeStandaloneTool({
      clients,
      context: { idempotencyKey: "idem" } as never,
      workspaceId: "ws-1",
      call: parseStandaloneToolCall({
        toolCallId: "ps",
        toolName: "patch",
        arguments: { path: "stale.ts", expected_utf8: "x", replacement_utf8: "y" },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "patch" }>,
      internalToolCallId: "tc",
      sideEffectId: "00000000-0000-7000-8000-000000000013" as never,
      policyDecisionId: "pd",
      traceId: "trace",
      contractHash: "hash",
      devMode: false,
      shellModeEnabled: true,
      observedSources: tracker,
    });
    expect(result.status).toBe("error");
    expect(result.diagnostics[0]?.code).toBe("PATCH_STALE_SOURCE");
    expect(result.diagnostics[0]?.message).toMatch(/Re-read the file/);
  });
});

function makeResult(overrides: Partial<ToolResult<unknown>>): ToolResult<unknown> {
  return {
    status: "success",
    summary: "summary",
    data: {},
    artifacts: [],
    sourceVersions: {},
    truncation: { occurred: false, reason: null, continuation: null },
    diagnostics: [],
    sideEffects: [],
    trust: "derived",
    confidentiality: "workspace",
    timing: { executionMs: 1, totalMs: 1, queuedMs: 0 },
    resourceUsage: { cpuMs: 0, peakMemoryBytes: 0, bytesRead: 0, bytesWritten: 0, networkBytes: 0 },
    policyDecisionId: "pd-1",
    toolCallId: "tc-1",
    traceId: "trace-1",
    estimatedCostUsd: null,
    ...overrides,
  };
}

describe("dual-path model-visible projection (ADR-0039 §11)", () => {
  test("successful read keeps payload, drops ceremony", () => {
    const projected = projectModelVisibleResult(makeResult({
      data: {
        path: "src/app.ts",
        content_utf8: "export {}\n",
        offset_line: 1,
        end_line: 1,
        rendered_mode: "full",
        continuation_token: null,
        next_offset_line: null,
      },
      timing: { executionMs: 12_345, totalMs: 12_345, queuedMs: 0 },
      resourceUsage: { cpuMs: 1, peakMemoryBytes: 0, bytesRead: 10, bytesWritten: 0, networkBytes: 0 },
      policyDecisionId: "pd-9",
      trust: "derived",
      confidentiality: "workspace",
    })) as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual(["data", "status", "summary"]);
    expect((projected.data as Record<string, unknown>).content_utf8).toBe("export {}\n");
    expect(projected.is_error).toBeUndefined();
  });

  test("failed results carry an error message and is_error marker", () => {
    const projected = projectModelVisibleResult(makeResult({
      status: "error",
      summary: "rg exited 2",
      data: null,
      diagnostics: [{ severity: "error", code: null, message: "unrecognized flag", path: null, range: null }],
    })) as Record<string, unknown>;
    expect(projected.is_error).toBe(true);
    expect(projected.error).toContain("unrecognized flag");
    expect(projected.data).toBeUndefined();
  });

  test("truncation survives projection with its continuation", () => {
    const projected = projectModelVisibleResult(makeResult({
      truncation: { occurred: true, reason: "line page continues beyond this read", continuation: "read src at offset_line 2001" },
    })) as Record<string, unknown>;
    expect(projected.truncation).toMatchObject({ occurred: true, continuation: "read src at offset_line 2001" });
  });

  test("patch projections keep only failing validations", () => {
    const projected = projectModelVisibleResult(makeResult({
      data: {
        transaction_id: "t",
        state: "APPLIED",
        applied_edits: 2,
        changed_files: [{ path: "a.ts", operation: "UPDATE" }],
        validations: [
          { check_id: "fmt", status: "pass", summary: "" },
          { check_id: "test", status: "fail", summary: "1 failing" },
        ],
      },
    })) as Record<string, unknown>;
    const validations = ((projected.data as Record<string, unknown>).validations as unknown[]).length;
    expect(validations).toBe(1);
  });

  test("model-visible transcript stays far below the per-call byte cap", () => {
    const projected = projectModelVisibleResult(makeResult({
      summary: "Read src/app.ts lines 1-2000 (continued)",
      data: { path: "src/app.ts", content_utf8: "x".repeat(40 * 1_024), offset_line: 1, end_line: 2000, rendered_mode: "full", continuation_token: "artifact:full", next_offset_line: 2001 },
    }));
    const transcript = JSON.stringify({
      protocol: "terminus.tool-result.v1",
      provider_call_id: "call",
      tool_name: "read",
      result: projected,
    });
    expect(new TextEncoder().encode(transcript).byteLength).toBeLessThan(48 * 1_024);
  });
});

describe("line paging", () => {
  test("pages are 1-based inclusive with a next offset", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const page = pageLines(text, 4, 3);
    expect(page.startLine).toBe(4);
    expect(page.endLine).toBe(6);
    expect(page.hasMore).toBe(true);
    expect(page.text.split("\n")).toEqual(["line 4", "line 5", "line 6", ""]);
  });

  test("final page reports hasMore=false; offsets past EOF return an empty page", () => {
    expect(pageLines("a\nb\n", 1, 10)).toMatchObject({ startLine: 1, endLine: 2, hasMore: false });
    expect(pageLines("", 1, 10)).toMatchObject({ startLine: 1, endLine: 0, hasMore: false, text: "" });
    expect(pageLines("only\n", 5, 10)).toMatchObject({ startLine: 5, endLine: 4, hasMore: false, text: "" });
  });
});

describe("shell-mode gating", () => {
  const shellCall: ParsedStandaloneToolCall = {
    providerCallId: "s1",
    toolId: "exec",
    toolVersion: "standalone-v1",
    arguments: {
      program: undefined,
      args: [],
      shell: { dialect: "bash", script: "echo hi" },
      cwd: ".",
      background: false,
      timeout_ms: 60_000,
      expected_exit_codes: [0],
    },
  };

  function fakeClients(started: boolean): Parameters<typeof executeStandaloneTool>[0]["clients"] {
    return {
      process: {
        Start: () => {
          expect(started).toBe(true);
          throw new Error("should not be reached in denied case");
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
  }

  test("denied fail-closed when operator disabled shell mode", async () => {
    const result = await executeStandaloneTool({
      clients: fakeClients(false),
      context: {} as never,
      workspaceId: "w",
      call: shellCall,
      internalToolCallId: "tc",
      sideEffectId: "00000000-0000-7000-8000-000000000001" as never,
      policyDecisionId: "pd",
      traceId: "trace",
      contractHash: "hash",
      devMode: false,
      shellModeEnabled: false,
    });
    expect(result.status).toBe("denied");
    expect(result.diagnostics[0]?.code).toBe("SHELL_MODE_DISABLED");
  });

  test("argv exec unaffected by shell-mode gate", async () => {
    let started = false;
    const clients = {
      process: {
        Start: () => {
          started = true;
          return {
            subscribe: (observer: { complete: () => void }) => {
              observer.complete();
              return { unsubscribe: () => {} };
            },
          };
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const attempt = executeStandaloneTool({
      clients,
      context: {} as never,
      workspaceId: "w",
      call: {
        providerCallId: "s2",
        toolId: "exec",
        toolVersion: "standalone-v1",
        arguments: { program: "true", args: [], cwd: ".", background: false, timeout_ms: 60_000, expected_exit_codes: [0] },
      },
      internalToolCallId: "tc",
      sideEffectId: "00000000-0000-7000-8000-000000000002" as never,
      policyDecisionId: "pd",
      traceId: "trace",
      contractHash: "hash",
      devMode: false,
      shellModeEnabled: false,
    }).catch(() => undefined);
    await attempt;
    expect(started).toBe(true);
  });
});

describe("R3 background exec and exec_poll", () => {
  const baseInput = {
    context: { idempotencyKey: "idem" } as never,
    workspaceId: "ws-1",
    internalToolCallId: "tc",
    sideEffectId: "00000000-0000-7000-8000-000000000021" as never,
    policyDecisionId: "pd",
    traceId: "trace",
    contractHash: "hash",
    devMode: false,
    shellModeEnabled: true,
  } as const;

  test("background exec returns a job id immediately without waiting for exit", async () => {
    let processStarted = false;
    let jobStarted = false;
    const clients = {
      process: {
        Start: () => {
          processStarted = true;
          return { subscribe: () => ({ unsubscribe: () => {} }) };
        },
      },
      jobs: {
        Start: (request: { command: { program: string } }) => {
          jobStarted = true;
          expect(request.command.program).toBe("sleep");
          return { jobId: "job-123", processId: "proc-9", startedAt: undefined };
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const result = await executeStandaloneTool({
      ...baseInput,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "bg1",
        toolName: "exec",
        arguments: { program: "sleep", args: ["600"], background: true, timeout_ms: 600_000 },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "exec" }>,
      observedSources: new ObservedSourceTracker(),
    });
    expect(result.status).toBe("success");
    expect(jobStarted).toBe(true);
    expect(processStarted).toBe(false);
    expect((result.data as Record<string, unknown>).background_id).toBe("job-123");
    expect((result.data as Record<string, unknown>).poll_hint).toMatch(/exec_poll/);
  });

  test("exec_poll reports running jobs without artifacts", async () => {
    const clients = {
      jobs: {
        Get: () => ({ jobId: "job-123", state: "running", exitCode: 0 }),
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const result = await executeStandaloneTool({
      ...baseInput,
      clients,
      call: parseStandaloneToolCall({ toolCallId: "pl1", toolName: "exec_poll", arguments: { background_id: "job-123" } }) as Extract<ParsedStandaloneToolCall, { toolId: "exec_poll" }>,
      observedSources: new ObservedSourceTracker(),
    });
    expect(result.status).toBe("success");
    expect((result.data as Record<string, unknown>).state).toBe("running");
    expect(toolEffectMetadata(parseStandaloneToolCall({ toolCallId: "pl2", toolName: "exec_poll", arguments: { background_id: "j" } })).effectType).toBe("READ_LOCAL");
  });

  test("exec_poll fetches bounded tails from stdout/stderr artifacts once exited", async () => {
    const bigStdout = new TextEncoder().encode("h".repeat(50_000) + "\nDONE\n");
    const clients = {
      jobs: {
        Get: () => ({
          jobId: "job-7",
          state: "exited",
          exitCode: 3,
          stdoutArtifact: { sha256: `sha256:${"e".repeat(64)}`, sizeBytes: bigStdout.byteLength, mediaType: "text/plain" },
          stderrArtifact: undefined,
        }),
      },
      artifacts: {
        Get: (_request: unknown) => ({ content: bigStdout, artifact: { sha256: `sha256:${"e".repeat(64)}` } }),
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const result = await executeStandaloneTool({
      ...baseInput,
      clients,
      call: parseStandaloneToolCall({ toolCallId: "pl3", toolName: "exec_poll", arguments: { background_id: "job-7", tail_bytes: 8_192, expected_exit_codes: [3] } }) as Extract<ParsedStandaloneToolCall, { toolId: "exec_poll" }>,
      observedSources: new ObservedSourceTracker(),
    });
    expect(result.status).toBe("success");
    const data = result.data as Record<string, unknown>;
    expect(data.exit_code).toBe(3);
    expect(data.stdout_total_bytes).toBe(bigStdout.byteLength);
    expect(data.stdout_truncated_head).toBe(true);
    expect(String(data.stdout_tail).endsWith("\nDONE\n")).toBe(true);
    expect(data.stderr_tail).toBe("");
    expect(result.artifacts.length).toBe(1);
  });

  test("artifact fetch failure degrades to an unavailable marker instead of failing the poll", async () => {
    const clients = {
      jobs: {
        Get: () => ({
          jobId: "job-8",
          state: "exited",
          exitCode: 0,
          stdoutArtifact: { sha256: `sha256:${"f".repeat(64)}`, sizeBytes: 10, mediaType: "text/plain" },
        }),
      },
      artifacts: {
        Get: () => {
          throw new Error("cas blob missing");
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const result = await executeStandaloneTool({
      ...baseInput,
      clients,
      call: parseStandaloneToolCall({ toolCallId: "pl4", toolName: "exec_poll", arguments: { background_id: "job-8" } }) as Extract<ParsedStandaloneToolCall, { toolId: "exec_poll" }>,
      observedSources: new ObservedSourceTracker(),
    });
    expect(result.status).toBe("success");
    expect(String((result.data as Record<string, unknown>).stdout_tail)).toContain("cas blob missing");
  });
});

describe("R11 web_fetch URL guards", () => {
  const base = {
    context: { idempotencyKey: "idem" } as never,
    workspaceId: "ws-1",
    internalToolCallId: "tc",
    sideEffectId: "00000000-0000-7000-8000-000000000031" as never,
    policyDecisionId: "pd",
    traceId: "trace",
    contractHash: "hash",
    devMode: false,
    shellModeEnabled: true,
    observedSources: new ObservedSourceTracker(),
  } as const;

  test("accepts public https URLs and rejects private/loopback/userinfo forms", () => {
    expect(assertPublicHttpsUrl("https://example.com/docs?x=1")).toMatchObject({ host: "example.com", port: 443, pathWithQuery: "/docs?x=1" });
    for (const bad of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://localhost/x",
      "https://foo.localhost/x",
      "https://10.0.0.9/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.4/x",
      "https://[::1]/x",
    ]) {
      expect(() => assertPublicHttpsUrl(bad)).toThrow();
    }
  });

  test("egress denial surfaces explicit allowlist guidance", async () => {
    const clients = {
      connectors: {
        MintGrant: () => ({ encodedGrant: new Uint8Array([1]), grantId: "g", expiresAtUnix: 0n }),
        Execute: () => {
          throw new Error("egress policy denied destination");
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const result = await executeStandaloneTool({
      ...base,
      clients,
      call: parseStandaloneToolCall({ toolCallId: "wf1", toolName: "web_fetch", arguments: { url: "https://example.com/" } }) as Extract<ParsedStandaloneToolCall, { toolId: "web_fetch" }>,
    });
    expect(result.status).toBe("denied");
    expect(result.diagnostics[0]?.code).toBe("WEB_FETCH_EGRESS_DENIED");
    expect(result.diagnostics[0]?.message).toMatch(/allowlist/);
  });

  test("successful fetch marks content untrusted, bounds the excerpt, spills to artifact", async () => {
    const body = new TextEncoder().encode("hello world".repeat(2_000));
    let ingestedBytes = 0;
    const clients = {
      connectors: {
        MintGrant: (request: { binding: { connectorId: string; destinationHost: string; method: string } }) => {
          expect(request.binding.connectorId).toBe("web-fetch");
          expect(request.binding.destinationHost).toBe("example.com");
          expect(request.binding.method).toBe("GET");
          return { encodedGrant: new Uint8Array([1]), grantId: "g", expiresAtUnix: 0n };
        },
        Execute: () => ({
          receipt: { statusCode: 200, outcome: "ACCEPTED" },
          body,
        }),
      },
      artifacts: {
        Ingest: (request: { content: Uint8Array }) => {
          ingestedBytes = request.content.byteLength;
          return { artifact: { sha256: `sha256:${"a".repeat(64)}`, sizeBytes: BigInt(request.content.byteLength), mediaType: "application/octet-stream" }, already_present: false };
        },
      },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
    const result = await executeStandaloneTool({
      ...base,
      clients,
      call: parseStandaloneToolCall({ toolCallId: "wf2", toolName: "web_fetch", arguments: { url: "https://example.com/", max_bytes: 16_384 } }) as Extract<ParsedStandaloneToolCall, { toolId: "web_fetch" }>,
    });
    expect(result.status).toBe("success");
    expect(result.trust).toBe("untrusted");
    const data = result.data as Record<string, unknown>;
    expect(data.untrusted_content_notice).toMatch(/untrusted/i);
    expect(String(data.body_excerpt).length).toBeLessThanOrEqual(8_000);
    expect(data.body_bytes_fetched).toBe(16_384);
    expect(ingestedBytes).toBe(16_384);
    expect(result.truncation.occurred).toBe(true);
  });
});

describe("R-cubic exec_poll exit-code contract", () => {
  const base = {
    context: { idempotencyKey: "idem" } as never,
    workspaceId: "ws-1",
    internalToolCallId: "tc",
    sideEffectId: "00000000-0000-7000-8000-000000000041" as never,
    policyDecisionId: "pd",
    traceId: "trace",
    contractHash: "hash",
    devMode: false,
    shellModeEnabled: true,
    observedSources: new ObservedSourceTracker(),
  } as const;

  function clientsWithExit(code: number): Parameters<typeof executeStandaloneTool>[0]["clients"] {
    return {
      jobs: { Get: () => ({ jobId: "j", state: "exited", exitCode: code }) },
    } as unknown as Parameters<typeof executeStandaloneTool>[0]["clients"];
  }

  test("an unexpected exit code is reported, not turned into a tool error", async () => {
    // The old behaviour settled this as an error, and the error projection
    // deleted `data` — so the job's exit code and output never reached the
    // model at all.
    const result = await executeStandaloneTool({
      ...base,
      clients: clientsWithExit(2),
      call: parseStandaloneToolCall({ toolCallId: "px", toolName: "exec_poll", arguments: { background_id: "j" } }) as Extract<ParsedStandaloneToolCall, { toolId: "exec_poll" }>,
    });
    expect(result.status).toBe("success");
    const data = result.data as Record<string, unknown>;
    expect(data.exit_code).toBe(2);
    expect(data.exit_expected).toBe(false);
    expect(result.summary).toMatch(/exited 2 \(non-zero\)/);
    expect((projectModelVisibleResult(result).data as Record<string, unknown>).exit_code).toBe(2);
  });

  test("expected exit codes stay success", async () => {
    const result = await executeStandaloneTool({
      ...base,
      clients: clientsWithExit(7),
      call: parseStandaloneToolCall({ toolCallId: "py", toolName: "exec_poll", arguments: { background_id: "j", expected_exit_codes: [7] } }) as Extract<ParsedStandaloneToolCall, { toolId: "exec_poll" }>,
    });
    expect(result.status).toBe("success");
  });
});

describe("H1 semantic idempotency exempts observations", () => {
  const call = (name: string, args: Record<string, unknown>): ParsedStandaloneToolCall =>
    parseStandaloneToolCall({ toolCallId: `c-${name}-${JSON.stringify(args)}`, toolName: name, arguments: args });

  test("reads and processes are exempt; workspace mutations are gated", () => {
    // `exec` is exempt on purpose: `exec cargo test` after an edit observes a
    // different workspace, and denying the repeat as a duplicate broke the
    // edit → test → edit loop outright.
    const gated = new Map<string, boolean>([
      ["read", false],
      ["grep", false],
      ["glob", false],
      ["exec_poll", false],
      ["exec", false],
      ["patch", true],
      ["write", true],
      ["web_fetch", true],
    ]);
    const readOnly = new Set(["read", "grep", "glob", "exec_poll"]);
    const args: Record<string, Record<string, unknown>> = {
      read: { path: "src/a.ts" },
      grep: { pattern: "x" },
      glob: { pattern: "**/*.ts" },
      exec_poll: { background_id: "j1" },
      patch: { path: "src/a.ts", expected_utf8: "a", replacement_utf8: "b" },
      write: { path: "src/new.ts", content: "export {}\n" },
      exec: { program: "true", cwd: "." },
      web_fetch: { url: "https://example.com/x" },
    };
    for (const [toolId, expected] of gated) {
      const parsed = call(toolId, args[toolId] ?? {});
      expect(`${toolId}:${String(semanticIdempotencyGateApplies(parsed))}`).toBe(`${toolId}:${String(expected)}`);
      expect(`${toolId}:${String(isReadOnlyToolCall(parsed))}`).toBe(`${toolId}:${String(readOnly.has(toolId))}`);
    }
  });

  test("a repeated exec dispatches; two identical execs get distinct ledger keys", () => {
    const first = call("exec", { program: "cargo", args: ["test"], cwd: "." });
    const second = call("exec", { program: "cargo", args: ["test"], cwd: "." });
    const hash = normalizedToolOperationHash({ taskId: "t1", contractVersion: 1, call: first });
    expect(normalizedToolOperationHash({ taskId: "t1", contractVersion: 1, call: second })).toBe(hash);
    expect(semanticIdempotencyGateApplies(first)).toBe(false);
    // Distinct ledger keys, or the second run would collide on the unique index.
    expect(effectLedgerIdempotencyKey({ call: first, operationHash: hash, toolCallId: "tc-1" }))
      .not.toBe(effectLedgerIdempotencyKey({ call: second, operationHash: hash, toolCallId: "tc-2" }));
  });

  test("read → patch → read all dispatch; a replayed patch is denied", () => {
    // Simulates the index.ts gate: a store keyed by (effectType, ledger key).
    const store = new Map<string, { readonly id: string; readonly state: string }>();
    const dispatch = (parsed: ParsedStandaloneToolCall, toolCallId: string): "dispatched" | "denied" => {
      const operationHash = normalizedToolOperationHash({ taskId: "t1", contractVersion: 1, call: parsed });
      const effect = toolEffectMetadata(parsed);
      const existing = semanticIdempotencyGateApplies(parsed)
        ? store.get(`${effect.effectType}\u0000${operationHash}`)
        : undefined;
      if (existing !== undefined) return "denied";
      const key = effectLedgerIdempotencyKey({ call: parsed, operationHash, toolCallId });
      const ledgerKey = `${effect.effectType}\u0000${key}`;
      if (store.has(ledgerKey)) throw new Error(`ledger key collision on ${ledgerKey}`);
      store.set(ledgerKey, { id: `effect-${store.size + 1}`, state: "SETTLED" });
      return "dispatched";
    };

    const read = () => call("read", { path: "src/a.ts" });
    const patchCall = () => call("patch", { path: "src/a.ts", expected_utf8: "a", replacement_utf8: "b" });

    expect(dispatch(read(), "tc-1")).toBe("dispatched");
    expect(dispatch(patchCall(), "tc-2")).toBe("dispatched");
    expect(dispatch(read(), "tc-3")).toBe("dispatched");
    // The mutating gate still bites on a verbatim replay.
    expect(dispatch(patchCall(), "tc-4")).toBe("denied");
  });

  test("identical reads never collide on the effect ledger unique index", () => {
    const parsed = call("read", { path: "src/a.ts" });
    const operationHash = normalizedToolOperationHash({ taskId: "t1", contractVersion: 1, call: parsed });
    const first = effectLedgerIdempotencyKey({ call: parsed, operationHash, toolCallId: "tc-1" });
    const second = effectLedgerIdempotencyKey({ call: parsed, operationHash, toolCallId: "tc-2" });
    expect(first).not.toBe(second);
    expect(first.startsWith(operationHash)).toBe(true);
  });

  test("mutating effects keep the semantic hash as their ledger key", () => {
    const parsed = call("patch", { path: "src/a.ts", expected_utf8: "a", replacement_utf8: "b" });
    const operationHash = normalizedToolOperationHash({ taskId: "t1", contractVersion: 1, call: parsed });
    expect(effectLedgerIdempotencyKey({ call: parsed, operationHash, toolCallId: "tc-9" })).toBe(operationHash);
  });

  test("denial text tells the model what to do instead", () => {
    const parsed = call("patch", { path: "src/a.ts", expected_utf8: "a", replacement_utf8: "b" });
    const text = duplicateOperationDenial({ call: parsed, effectId: "eff-1", effectState: "SETTLED" });
    expect(text).toContain("eff-1");
    expect(text).toContain("SETTLED");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("re-read the file");
    expect(text).toContain("Do not retry");
  });
});

// ───────────────────────── Phase 0 workstream C ─────────────────────────────

const PHASE0_BASE = {
  context: { idempotencyKey: "idem" } as never,
  workspaceId: "ws-1",
  internalToolCallId: "tc",
  sideEffectId: "00000000-0000-7000-8000-0000000000f1" as never,
  policyDecisionId: "pd",
  traceId: "trace",
  contractHash: "hash",
  devMode: false,
  shellModeEnabled: true,
} as const;

type Clients = Parameters<typeof executeStandaloneTool>[0]["clients"];

/** A kernel process stream that emits the given chunks and then exits. */
function processStream(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
  readonly signal?: string;
}) {
  return {
    subscribe: (observer: { next: (event: unknown) => void; error: (e: unknown) => void; complete: () => void }) => {
      const encoder = new TextEncoder();
      observer.next({ started: { processId: "p1" } });
      if (input.stdout !== undefined) observer.next({ stdout: { bytes: encoder.encode(input.stdout) } });
      if (input.stderr !== undefined) observer.next({ stderr: { bytes: encoder.encode(input.stderr) } });
      observer.next({
        exited: {
          exitCode: input.exitCode,
          signal: input.signal ?? "",
          stdoutArtifact: undefined,
          stderrArtifact: undefined,
        },
      });
      return { unsubscribe: () => {} };
    },
  };
}

describe("C1 exec always returns its output", () => {
  test("a non-zero exit is a normal result carrying stdout and stderr", async () => {
    // The whole point: `bun test` exiting 1 must deliver the failing test
    // names. Before this it delivered {"status":"error","summary":"exited 1"}.
    let started: Record<string, unknown> | null = null;
    const clients = {
      process: {
        Start: (request: { command: Record<string, unknown> }) => {
          started = request.command;
          return processStream({ stdout: "1 pass\n1 fail\n", stderr: "AssertionError: expected 2\n", exitCode: 1 });
        },
      },
    } as unknown as Clients;
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "e1",
        toolName: "exec",
        arguments: { shell: { dialect: "bash", script: "bun test" } },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "exec" }>,
    });
    expect(result.status).toBe("success");
    const data = result.data as Record<string, unknown>;
    expect(data.exit_code).toBe(1);
    expect(data.stdout).toContain("1 fail");
    expect(data.stderr).toContain("AssertionError");
    expect(data.timed_out).toBe(false);
    expect(typeof data.duration_ms).toBe("number");
    // …and it survives the model-visible projection.
    const projected = projectModelVisibleResult(result) as Record<string, unknown>;
    expect(projected.is_error).toBeUndefined();
    expect((projected.data as Record<string, unknown>).stderr).toContain("AssertionError");
    expect(started).not.toBeNull();
  });

  test("a timeout is reported as such, with whatever output arrived", async () => {
    const clients = {
      process: { Start: () => processStream({ stdout: "working…\n", exitCode: -1, signal: "TIMEOUT" }) },
    } as unknown as Clients;
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "e2",
        toolName: "exec",
        arguments: { program: "sleep", args: ["999"], timeout_ms: 1_000 },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "exec" }>,
    });
    expect(result.status).toBe("success");
    expect((result.data as Record<string, unknown>).timed_out).toBe(true);
    expect((result.data as Record<string, unknown>).stdout).toContain("working");
    expect(result.summary).toMatch(/timed out/);
  });

  test("a kernel dispatch fault is a correctable tool error, not a lost turn", async () => {
    const clients = {
      process: {
        Start: () => {
          throw new Error("kernel transport closed");
        },
      },
    } as unknown as Clients;
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "e3",
        toolName: "exec",
        arguments: { program: "true" },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "exec" }>,
    });
    expect(result.status).toBe("error");
    expect(result.diagnostics[0]?.code).toBe("PROCESS_DISPATCH_FAILED");
    expect(result.diagnostics[0]?.message).toMatch(/did not run/);
  });

  test("a typed kernel policy refusal is a denial, not a retryable dispatch fault", async () => {
    const permissionDenied = Object.assign(new Error("policy denied: no matching rule"), { code: 7 });
    const clients = {
      process: {
        Start: () => {
          throw permissionDenied;
        },
      },
    } as unknown as Clients;
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "e-policy",
        toolName: "exec",
        arguments: { program: "file", args: ["missing.png"] },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "exec" }>,
    });
    expect(result.status).toBe("denied");
    expect(result.diagnostics[0]?.code).toBe("PERMISSION_DENIED");
    expect(result.diagnostics[0]?.message).toMatch(/Do not retry/);
  });

  test("output is capped 50/50 head/tail with an inline elision marker", async () => {
    const stdout = `${"H".repeat(40_000)}${"T".repeat(40_000)}`;
    const clients = {
      process: { Start: () => processStream({ stdout, stderr: "short stderr\n", exitCode: 0 }) },
    } as unknown as Clients;
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "e4",
        toolName: "exec",
        arguments: { program: "cat", args: ["big"] },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "exec" }>,
    });
    const data = result.data as Record<string, unknown>;
    const text = data.stdout as string;
    expect(text.startsWith("H")).toBe(true);
    expect(text.endsWith("T")).toBe(true);
    expect(text).toMatch(/\[… \d+ bytes elided …\]/);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(EXEC_OUTPUT_MAX_BYTES + 64);
    expect(data.stdout_total_bytes).toBe(80_000);
    // The floor kept the small stderr intact.
    expect(data.stderr).toBe("short stderr\n");
    expect(result.truncation.occurred).toBe(true);
  });

  test("the shared output budget floors each stream", () => {
    expect(splitOutputBudget(100, 200)).toEqual({ stdout: 100, stderr: 200 });
    const split = splitOutputBudget(10_000_000, 300);
    expect(split.stderr).toBe(300);
    expect(split.stdout + split.stderr).toBeLessThanOrEqual(EXEC_OUTPUT_MAX_BYTES);
    const both = splitOutputBudget(10_000_000, 10_000_000);
    expect(both.stdout).toBeGreaterThanOrEqual(EXEC_OUTPUT_STREAM_FLOOR_BYTES);
    expect(both.stderr).toBeGreaterThanOrEqual(EXEC_OUTPUT_STREAM_FLOOR_BYTES);
    expect(both.stdout + both.stderr).toBeLessThanOrEqual(EXEC_OUTPUT_MAX_BYTES);
  });
});

describe("kernel tool capability renewal", () => {
  test("a later tool operation does not reuse a capability after its simulated expiry", async () => {
    const capabilityTokens: string[] = [];
    const clients = {
      files: {
        Read: (request: { readonly context: { readonly capabilityToken: string } }) => {
          capabilityTokens.push(request.context.capabilityToken);
          return {
            modelProjectionUtf8: new TextEncoder().encode("content\n"),
            sourceVersion: { sha256: `sha256:${"a".repeat(64)}`, repositoryRevision: "no-vcs" },
            renderedMode: "full",
            continuationToken: "",
            truncated: false,
            fullContent: undefined,
            diagnostics: [],
          };
        },
      },
    } as unknown as Clients;
    let nowUnix = 1_000;
    const context = async () => ({
      idempotencyKey: `operation-${nowUnix}`,
      capabilityToken: nowUnix < 1_300 ? "capability-before-expiry" : "capability-renewed",
    }) as never;
    const call = parseStandaloneToolCall({
      toolCallId: "renew-read",
      toolName: "read",
      arguments: { path: "README.md" },
    });

    await executeStandaloneTool({ ...PHASE0_BASE, clients, context, call });
    nowUnix = 1_301;
    await executeStandaloneTool({ ...PHASE0_BASE, clients, context, call });

    expect(capabilityTokens).toEqual(["capability-before-expiry", "capability-renewed"]);
  });
});

describe("C6 process environment and timeout forwarding", () => {
  test("publicEnv carries the toolchain and never a secret", () => {
    const env = kernelPublicEnv({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/dev",
      LANG: "en_US.UTF-8",
      TMPDIR: "/host/tmp",
      ANTHROPIC_API_KEY: "sk-should-not-travel",
      GITHUB_TOKEN: "ghp_should-not-travel",
      AWS_SECRET_ACCESS_KEY: "nope",
      DB_PASSWORD: "nope",
      SOME_CREDENTIAL: "nope",
    });
    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/dev",
      TERM: "dumb",
      LANG: "en_US.UTF-8",
      CI: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    // TMPDIR is the kernel's to supply; the host's is denied inside the sandbox.
    expect(env.TMPDIR).toBeUndefined();
    for (const name of Object.keys(env)) {
      expect(/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)).toBe(false);
    }
    expect(kernelPublicEnv({}).LANG).toBe("C.UTF-8");
  });

  test("packaged runtime user HOME and PATH override the isolated control environment", () => {
    expect(kernelPublicEnv({
      HOME: "/Users/dev/Library/Application Support/Terminus",
      PATH: "/usr/bin:/bin",
      TERMINUS_USER_HOME: "/Users/dev",
      TERMINUS_USER_PATH: "/Users/dev/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin",
    })).toMatchObject({
      HOME: "/Users/dev",
      PATH: "/Users/dev/.cargo/bin:/opt/homebrew/bin:/usr/bin:/bin",
    });
  });

  test("exec forwards the model's timeout_ms and the public env to the kernel", async () => {
    let command: Record<string, unknown> | null = null;
    const clients = {
      process: {
        Start: (request: { command: Record<string, unknown> }) => {
          command = request.command;
          return processStream({ exitCode: 0 });
        },
      },
    } as unknown as Clients;
    await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "e5",
        toolName: "exec",
        arguments: { program: "cargo", args: ["test"], timeout_ms: 600_000 },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "exec" }>,
    });
    const sent = command as unknown as { timeout: { seconds: number }; publicEnv: Record<string, string> };
    expect(sent.timeout.seconds).toBe(600);
    expect(sent.publicEnv.PATH).toBe(process.env.PATH);
    expect(sent.publicEnv.TERM).toBe("dumb");
    expect(sent.publicEnv.NO_COLOR).toBe("1");
  });

  test("a foreground timeout above 600 s is refused with a usable message", () => {
    expect(() => parseStandaloneToolCall({
      toolCallId: "e6",
      toolName: "exec",
      arguments: { program: "sleep", args: ["1200"], timeout_ms: 900_000 },
    })).toThrow(/background: true/);
    // Backgrounded, the same budget is accepted up to 30 minutes.
    const backgrounded = parseStandaloneToolCall({
      toolCallId: "e7",
      toolName: "exec",
      arguments: { program: "sleep", args: ["1200"], timeout_ms: 1_800_000, background: true },
    });
    expect(backgrounded.arguments).toMatchObject({ timeout_ms: 1_800_000 });
  });
});

describe("C2 write creates files", () => {
  function patchClients(existing: boolean) {
    const applied: { edits: unknown[] } = { edits: [] };
    const clients = {
      patch: {
        Apply: (request: { edits: unknown[] }) => {
          applied.edits = request.edits;
          return {
            transactionId: "txn-w",
            state: "APPLIED",
            finalRepositoryRevision: "no-vcs",
            finalDirtyDigest: "",
            changedFiles: [{
              path: { workspaceId: "ws-1", relativePath: "src/new.ts" },
              oldSha256: existing ? `sha256:${"1".repeat(64)}` : "",
              newSha256: `sha256:${"2".repeat(64)}`,
              operation: existing ? "update" : "create",
            }],
            validations: [],
            completeDiff: undefined,
          };
        },
      },
    } as unknown as Clients;
    return { clients, applied };
  }

  test("a new file is created and reported with bytes_written", async () => {
    const { clients, applied } = patchClients(false);
    const tracker = new ObservedSourceTracker();
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      observedSources: tracker,
      call: parseStandaloneToolCall({
        toolCallId: "w1",
        toolName: "write",
        arguments: { path: "src/new.ts", content: "export const a = 1;\n" },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "write" }>,
    });
    expect(result.status).toBe("success");
    const data = result.data as Record<string, unknown>;
    expect(data.bytes_written).toBe(20);
    expect(data.created).toBe(true);
    expect(result.summary).toMatch(/^Created src\/new\.ts/);
    // Mapped to the kernel CreateFile effect, not an anchored replacement.
    const edit = applied.edits[0] as { createFile?: { mustNotExist: boolean; path: { relativePath: string } } };
    expect(edit.createFile?.path.relativePath).toBe("src/new.ts");
    expect(edit.createFile?.mustNotExist).toBe(false);
    // A file this turn wrote is a file this turn observed.
    expect(tracker.resolve("ws-1", "src/new.ts")).toBe(`sha256:${"2".repeat(64)}`);
  });

  test("an existing file is replaced and reported as such", async () => {
    const { clients } = patchClients(true);
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "w2",
        toolName: "write",
        arguments: { file_path: "src/new.ts", content: "" },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "write" }>,
    });
    expect((result.data as Record<string, unknown>).created).toBe(false);
    expect((result.data as Record<string, unknown>).bytes_written).toBe(0);
    expect(result.summary).toMatch(/^Replaced/);
  });

  test("a rejected write is an actionable error, not an exception", async () => {
    const clients = {
      patch: { Apply: () => { throw new Error("path is outside the write scope"); } },
    } as unknown as Clients;
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "w3",
        toolName: "write",
        arguments: { path: "outside.ts", content: "x" },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "write" }>,
    });
    expect(result.status).toBe("error");
    expect(result.diagnostics[0]?.code).toBe("WRITE_REJECTED");
  });
});

describe("C5 read paging is real", () => {
  const body = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

  function readClients(): { clients: Clients; requests: Record<string, unknown>[] } {
    const requests: Record<string, unknown>[] = [];
    const clients = {
      files: {
        Read: (request: Record<string, unknown>) => {
          requests.push(request);
          return {
            modelProjectionUtf8: new TextEncoder().encode(body),
            sourceVersion: { sha256: `sha256:${"a".repeat(64)}`, repositoryRevision: "no-vcs" },
            renderedMode: "full",
            continuationToken: "",
            truncated: false,
            fullContent: undefined,
            diagnostics: [],
          };
        },
      },
    } as unknown as Clients;
    return { clients, requests };
  }

  test("offset_line + max_lines return that exact range and say what is left", async () => {
    const { clients, requests } = readClients();
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "r1",
        toolName: "read",
        arguments: { path: "big.ts", offset_line: 401, max_lines: 50 },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "read" }>,
    });
    const data = result.data as Record<string, unknown>;
    // The kernel has no ranges, so the control plane slices — and the slice
    // is the requested range, not the head of the file relabelled.
    expect(requests[0]?.mode).toBe("full");
    expect(data.offset_line).toBe(401);
    expect(data.end_line).toBe(450);
    expect(data.total_lines).toBe(500);
    expect(data.lines_remaining).toBe(50);
    expect(data.next_offset_line).toBe(451);
    expect(data.content_utf8).toContain("401→ line 401");
    expect(data.content_utf8).toContain("450→ line 450");
    expect(data.content_utf8).not.toContain("line 1\n");
    expect(result.truncation.continuation).toBe("read big.ts at offset_line 451");
  });

  test("the trained spellings offset/limit/file_path are accepted", async () => {
    const { clients } = readClients();
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "r2",
        toolName: "read",
        arguments: { file_path: "big.ts", offset: 10, limit: 5 },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "read" }>,
    });
    const data = result.data as Record<string, unknown>;
    expect(data.offset_line).toBe(10);
    expect(data.end_line).toBe(14);
    expect(data.lines_remaining).toBe(486);
  });

  test("the last page reports nothing remaining", async () => {
    const { clients } = readClients();
    const result = await executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      call: parseStandaloneToolCall({
        toolCallId: "r3",
        toolName: "read",
        arguments: { path: "big.ts", offset_line: 451, limit_lines: 500 },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "read" }>,
    });
    const data = result.data as Record<string, unknown>;
    expect(data.end_line).toBe(500);
    expect(data.lines_remaining).toBe(0);
    expect(data.next_offset_line).toBeNull();
    expect(result.truncation.occurred).toBe(false);
  });
});

describe("C8 observed sources survive edits and turns", () => {
  test("a successful patch records the new hash so a second edit anchors", async () => {
    const first = `sha256:${"a".repeat(64)}`;
    const second = `sha256:${"b".repeat(64)}`;
    const tracker = new ObservedSourceTracker();
    tracker.record("ws-1", "src/a.ts", first);
    const seen: string[] = [];
    const clients = {
      patch: {
        Apply: (request: { baseline: { sources: readonly { sha256: string }[] } }) => {
          seen.push(request.baseline.sources[0]?.sha256 ?? "");
          return {
            transactionId: "t",
            state: "APPLIED",
            finalRepositoryRevision: "no-vcs",
            finalDirtyDigest: "",
            changedFiles: [{
              path: { workspaceId: "ws-1", relativePath: "src/a.ts" },
              oldSha256: first,
              newSha256: second,
              operation: "update",
            }],
            validations: [],
            completeDiff: undefined,
          };
        },
      },
    } as unknown as Clients;
    const patchCall = (id: string, from: string, to: string) => executeStandaloneTool({
      ...PHASE0_BASE,
      clients,
      observedSources: tracker,
      call: parseStandaloneToolCall({
        toolCallId: id,
        toolName: "patch",
        arguments: { path: "src/a.ts", expected_utf8: from, replacement_utf8: to },
      }) as Extract<ParsedStandaloneToolCall, { toolId: "patch" }>,
    });
    const one = await patchCall("p1", "a", "b");
    expect(one.status).toBe("success");
    // The second edit of the same file in the same turn used to die with
    // PATCH_STALE_SOURCE because the tracker still held the pre-edit hash.
    expect(tracker.resolve("ws-1", "src/a.ts")).toBe(second);
    const two = await patchCall("p2", "b", "c");
    expect(two.status).toBe("success");
    expect(seen).toEqual([first, second]);
    // The hashes are published so a later turn can seed from them.
    expect(one.sourceVersions).toEqual({ "src/a.ts": second });
  });

  test("seeding restores prior observations, last write winning", () => {
    const tracker = new ObservedSourceTracker();
    const applied = tracker.seed([
      { workspaceId: "ws-1", path: "src/a.ts", sha256: `sha256:${"1".repeat(64)}` },
      { workspaceId: "ws-1", path: "src/a.ts", sha256: `sha256:${"2".repeat(64)}` },
      { workspaceId: "ws-1", path: "src/b.ts", sha256: "not-a-hash" },
    ]);
    expect(applied).toBe(2);
    expect(tracker.resolve("ws-1", "src/a.ts")).toBe(`sha256:${"2".repeat(64)}`);
    expect(tracker.resolve("ws-1", "src/b.ts")).toBeNull();
  });
});

describe("C4 every declared tool dispatches", () => {
  test("no always-on tool is advertised and then rejected at the kernel boundary", async () => {
    const reached: string[] = [];
    const clients = {
      files: {
        Read: () => {
          reached.push("files.Read");
          return {
            modelProjectionUtf8: new TextEncoder().encode("x\n"),
            sourceVersion: { sha256: `sha256:${"c".repeat(64)}`, repositoryRevision: "no-vcs" },
            renderedMode: "full",
            continuationToken: "",
            truncated: false,
            fullContent: undefined,
            diagnostics: [],
          };
        },
      },
      patch: {
        Apply: () => {
          reached.push("patch.Apply");
          return {
            transactionId: "t",
            state: "APPLIED",
            finalRepositoryRevision: "no-vcs",
            finalDirtyDigest: "",
            changedFiles: [],
            validations: [],
            completeDiff: undefined,
          };
        },
      },
      process: {
        Start: () => {
          reached.push("process.Start");
          return processStream({ stdout: "", exitCode: 0 });
        },
      },
      jobs: {
        Get: () => {
          reached.push("jobs.Get");
          return { jobId: "j", state: "running", exitCode: 0 };
        },
      },
    } as unknown as Clients;
    const argumentsFor: Record<string, Record<string, unknown>> = {
      read: { path: "a.ts" },
      patch: { path: "a.ts", expected_sha256: `sha256:${"c".repeat(64)}`, expected_utf8: "x", replacement_utf8: "y" },
      write: { path: "a.ts", content: "y" },
      exec: { program: "true" },
      exec_poll: { background_id: "j" },
      grep: { pattern: "x" },
      glob: { pattern: "**/*.ts" },
    };
    for (const toolId of STANDALONE_ALWAYS_ON_TOOL_IDS) {
      const call = parseStandaloneToolCall({
        toolCallId: `d-${toolId}`,
        toolName: toolId,
        arguments: argumentsFor[toolId] ?? {},
      });
      const result = await executeStandaloneTool({
        ...PHASE0_BASE,
        clients,
        observedSources: new ObservedSourceTracker(),
        call,
      });
      expect(`${toolId}:${result.status}`).toBe(`${toolId}:success`);
    }
    expect(reached).toContain("files.Read");
    expect(reached).toContain("patch.Apply");
    expect(reached).toContain("process.Start");
    expect(reached).toContain("jobs.Get");
  });
});

describe("C3 the idempotency gate blocks replays, not retries", () => {
  test("only an effect that may have touched the workspace blocks an identical call", () => {
    // The row is written at AUTHORIZED and never removed, so matching on
    // existence alone told a patch that had FAILED on a stale hash that it
    // was "already applied … Do not retry" when it retried correctly.
    for (const state of ["STARTED", "SETTLED", "UNKNOWN", "RECONCILING", "MANUAL_REVIEW"]) {
      expect(`${state}:${String(replayIsBlockedBy({ state }))}`).toBe(`${state}:true`);
    }
    for (const state of ["AUTHORIZED", "FAILED", "CANCELLED", "DENIED"]) {
      expect(`${state}:${String(replayIsBlockedBy({ state }))}`).toBe(`${state}:false`);
    }
    expect(replayIsBlockedBy(null)).toBe(false);
    expect(replayIsBlockedBy(undefined)).toBe(false);
  });

  test("a failed patch may retry verbatim; a settled one may not", () => {
    // Simulates the index.ts gate over a store keyed by (effectType, key).
    const store = new Map<string, { readonly state: string }>();
    const dispatch = (parsed: ParsedStandaloneToolCall, toolCallId: string, settleAs: string): "dispatched" | "denied" => {
      const operationHash = normalizedToolOperationHash({ taskId: "t1", contractVersion: 1, call: parsed });
      const effect = toolEffectMetadata(parsed);
      const prior = semanticIdempotencyGateApplies(parsed)
        ? store.get(`${effect.effectType}\u0000${operationHash}`) ?? null
        : null;
      if (replayIsBlockedBy(prior)) return "denied";
      store.set(
        `${effect.effectType}\u0000${effectLedgerIdempotencyKey({ call: parsed, operationHash, toolCallId })}`,
        { state: settleAs },
      );
      return "dispatched";
    };
    const patchCall = (): ParsedStandaloneToolCall => parseStandaloneToolCall({
      toolCallId: "c",
      toolName: "patch",
      arguments: { path: "src/a.ts", expected_utf8: "a", replacement_utf8: "b" },
    });
    expect(dispatch(patchCall(), "tc-1", "FAILED")).toBe("dispatched");
    expect(dispatch(patchCall(), "tc-2", "SETTLED")).toBe("dispatched");
    expect(dispatch(patchCall(), "tc-3", "SETTLED")).toBe("denied");
  });
});

describe("workspace tool directories on the sandbox PATH", () => {
  test("existing .venv/bin and node_modules/.bin are put ahead of the user's PATH", () => {
    const exists = (path: string) => path === "/ws/.venv/bin" || path === "/ws/node_modules/.bin";
    expect(withWorkspaceToolDirs("/usr/bin:/bin", "/ws", exists)).toBe("/ws/.venv/bin:/ws/node_modules/.bin:/usr/bin:/bin");
    expect(kernelPublicEnv({ PATH: "/usr/bin", HOME: "/home/u" }, { workspaceRoot: "/ws", exists }).PATH)
      .toBe("/ws/.venv/bin:/ws/node_modules/.bin:/usr/bin");
  });

  test("a repository without local tool directories leaves PATH byte-identical", () => {
    const none = () => false;
    expect(withWorkspaceToolDirs("/usr/bin:/bin", "/ws", none)).toBe("/usr/bin:/bin");
    expect(withWorkspaceToolDirs("/usr/bin:/bin", null, () => true)).toBe("/usr/bin:/bin");
    expect(kernelPublicEnv({ PATH: "/usr/bin" }, { workspaceRoot: null, exists: () => true }).PATH).toBe("/usr/bin");
  });

  test("only the directories that exist are added, in the declared order", () => {
    const onlyVenv = (path: string) => path.endsWith("/.venv/bin");
    expect(withWorkspaceToolDirs(undefined, "/ws", onlyVenv)).toBe("/ws/.venv/bin");
    expect(withWorkspaceToolDirs("", "/ws", onlyVenv)).toBe("/ws/.venv/bin");
  });
});
