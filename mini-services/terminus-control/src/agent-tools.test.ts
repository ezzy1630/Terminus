import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_TOOL_CYCLES,
  MAX_TOOL_CYCLES_CEILING,
  MIN_TOOL_CYCLES,
  STANDALONE_TOOL_SCHEMAS,
  ObservedSourceTracker,
  executeStandaloneTool,
  normalizedToolOperationHash,
  pageLines,
  parseStandaloneToolCall,
  projectModelVisibleResult,
  providerToolCallTranscript,
  renderNumbered,
  resolveMaxToolCycles,
  resolveShellModeEnabled,
  assertPublicHttpsUrl,
  stripNumberedGuttersIfFullyNumbered,
  toolEffectMetadata,
  type ParsedStandaloneToolCall,
} from "./agent-tools.js";
import type { ToolResult } from "@terminus/aci";

describe("standalone provider tools", () => {
  test("exposes the bounded kernel tool surface", () => {
    expect(STANDALONE_TOOL_SCHEMAS.map((tool) => tool.id)).toEqual(["read", "patch", "exec", "exec_poll", "web_fetch", "grep", "glob"]);
    expect(DEFAULT_MAX_TOOL_CYCLES).toBe(64);
  });

  test("tool-cycle budget resolution is bounded and fail-closed", () => {
    expect(resolveMaxToolCycles(undefined)).toBe(64);
    expect(resolveMaxToolCycles("")).toBe(64);
    expect(resolveMaxToolCycles("16")).toBe(16);
    expect(resolveMaxToolCycles("1")).toBe(MIN_TOOL_CYCLES);
    expect(resolveMaxToolCycles("256")).toBe(MAX_TOOL_CYCLES_CEILING);
    expect(() => resolveMaxToolCycles("257")).toThrow(/between/);
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
      max_bytes: 28 * 1_024,
      offset_line: 1,
      max_lines: 2_000,
      render: "numbered",
    });
    expect(toolEffectMetadata(call).effectType).toBe("READ_LOCAL");
    expect(providerToolCallTranscript(call).provider_call_id).toBe("provider-call-1");
    expect(() => parseStandaloneToolCall({ toolCallId: "x", toolName: "search", arguments: {} })).toThrow(/unknown standalone tool/);
    expect(() => parseStandaloneToolCall({ toolCallId: "x", toolName: "exec", arguments: { program: "sh; exit" } })).toThrow(/invalid/);
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
    expect(patchedWith).toBe(sha);
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
        arguments: { program: "true", args: [], cwd: ".", timeout_ms: 60_000, expected_exit_codes: [0] },
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

  test("unexpected exit codes settle the poll as an error", async () => {
    const result = await executeStandaloneTool({
      ...base,
      clients: clientsWithExit(2),
      call: parseStandaloneToolCall({ toolCallId: "px", toolName: "exec_poll", arguments: { background_id: "j" } }) as Extract<ParsedStandaloneToolCall, { toolId: "exec_poll" }>,
    });
    expect(result.status).toBe("error");
    expect(result.diagnostics[0]?.code).toBe("EXEC_POLL_EXIT_UNEXPECTED");
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
