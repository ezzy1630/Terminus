import { z } from "zod";
import { randomUUID } from "node:crypto";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";
import type {
  ProviderToolCallChunk,
  ProviderToolCallTranscript,
  ProviderToolResultTranscript,
  ProviderToolSchema,
} from "@terminus/provider-core";
import { okResult, type ArtifactDescriptor, type ToolResult } from "@terminus/aci";
import type { ContentHash, Uuid7 } from "@terminus/domain";
import {
  PatchCommitMode,
  type ArtifactRef as KernelArtifactRef,
  type PolicyDecision as KernelPolicyDecision,
  type ProcessEvent,
  type RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { KernelUdsClients } from "./kernel-uds.js";

export const DEFAULT_MAX_TOOL_CYCLES = 64;
export const MIN_TOOL_CYCLES = 1;
export const MAX_TOOL_CYCLES_CEILING = 256;
export const MAX_TOOL_MODEL_RESULT_BYTES = 32 * 1_024;

/**
 * Resolve the per-turn tool-call budget (ADR-0039 §10). Operators tune it
 * through TERMINUS_MAX_TOOL_CYCLES; unparsable or out-of-range values fail
 * closed to the default rather than widening the budget.
 */
export function resolveMaxToolCycles(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_MAX_TOOL_CYCLES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed)) return DEFAULT_MAX_TOOL_CYCLES;
  if (parsed < MIN_TOOL_CYCLES || parsed > MAX_TOOL_CYCLES_CEILING) {
    throw new Error(`TERMINUS_MAX_TOOL_CYCLES must be an integer between ${MIN_TOOL_CYCLES} and ${MAX_TOOL_CYCLES_CEILING}`);
  }
  return parsed;
}

/**
 * Shell-mode exec is off unless the operator explicitly enables it
 * (ADR-0039 §10). When enabled, scripts still travel as kernel-dispatched
 * data under the same sandbox profile and strictest-wins policy engine.
 */
export function resolveShellModeEnabled(raw: string | undefined | null): boolean {
  return raw === "1" || raw === "true";
}

const pathSchema = z.string().min(1).max(4_096).refine(
  (path) => !path.includes("\0") && !path.includes("\r") && !path.includes("\n"),
  "path may not contain control delimiters",
);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const standaloneReadInputSchema = z.object({
  path: pathSchema,
  max_bytes: z.number().int().min(1).max(64 * 1_024).default(48 * 1_024),
  offset_line: z.number().int().min(1).default(1),
  max_lines: z.number().int().min(1).max(4_000).default(2_000),
  /**
   * "numbered" renders each line as `<line>→ <content>` so the model can
   * cite stable locations. The patch tool strips the same gutter format
   * before exact matching, so copied line numbers never break an edit.
   */
  render: z.enum(["numbered", "raw"]).default("numbered"),
  expected_sha256: sha256Schema.optional(),
}).strict();

const standalonePatchEditSchema = z.object({
  expected_utf8: z.string().min(1).max(64 * 1_024),
  replacement_utf8: z.string().max(64 * 1_024),
}).strict();

export const standalonePatchInputSchema = z.object({
  path: pathSchema,
  /**
   * Optional: when omitted, the control plane substitutes the file hash it
   * last observed through a successful read in this turn (stale-write
   * protection is preserved because the substituted hash is still the
   * observed source version, and the kernel still rejects a mismatch).
   */
  expected_sha256: sha256Schema.optional(),
  expected_utf8: z.string().max(64 * 1_024).optional(),
  replacement_utf8: z.string().max(64 * 1_024).optional(),
  edits: z.array(standalonePatchEditSchema).min(1).max(32).optional(),
  commit_mode: z.enum(["preview", "apply"]).default("apply"),
}).strict().refine(
  (value) => value.edits !== undefined || (value.expected_utf8 !== undefined && value.replacement_utf8 !== undefined),
  "provide expected_utf8+replacement_utf8, or a non-empty edits array",
);

export const standaloneShellInputSchema = z.object({
  dialect: z.enum(["bash", "sh"]),
  script: z.string().min(1).max(64 * 1_024),
}).strict();

export const standaloneExecInputSchema = z.object({
  program: z.string().max(4_096).refine(
    (program) => !/[\0\r\n]/.test(program) && !program.includes(";") && !program.includes("\\"),
    "program must be an executable path or name, not a shell expression",
  ).optional(),
  args: z.array(z.string().max(16_384)).max(128).default([]),
  shell: standaloneShellInputSchema.optional(),
  cwd: pathSchema.default("."),
  timeout_ms: z.number().int().min(100).max(60_000).default(60_000),
  expected_exit_codes: z.array(z.number().int().min(0).max(255)).min(1).max(16).default([0]),
}).strict().refine(
  (value) => (value.program !== undefined) !== (value.shell !== undefined),
  "provide either program+args (argv mode) or shell (shell mode), not both",
);

export const standaloneGrepInputSchema = z.object({
  pattern: z.string().min(1).max(512).refine(
    (pattern) => !pattern.includes("\0"),
    "pattern may not contain NUL",
  ),
  path: pathSchema.default("."),
  glob: z.string().min(1).max(256).optional(),
  ignore_case: z.boolean().default(false),
  max_results: z.number().int().min(1).max(500).default(100),
}).strict();

export const standaloneGlobInputSchema = z.object({
  pattern: z.string().min(1).max(256).refine(
    (pattern) => !pattern.includes("\0") && !/[\r\n]/.test(pattern),
    "pattern may not contain control delimiters",
  ),
  path: pathSchema.default("."),
  max_results: z.number().int().min(1).max(1_000).default(200),
}).strict();

export type StandaloneReadInput = z.infer<typeof standaloneReadInputSchema>;
export type StandalonePatchInput = z.infer<typeof standalonePatchInputSchema>;
export type StandaloneExecInput = z.infer<typeof standaloneExecInputSchema>;
export type StandaloneGrepInput = z.infer<typeof standaloneGrepInputSchema>;
export type StandaloneGlobInput = z.infer<typeof standaloneGlobInputSchema>;

export type ParsedStandaloneToolCall =
  | { readonly providerCallId: string; readonly toolId: "read"; readonly toolVersion: "standalone-v1"; readonly arguments: StandaloneReadInput }
  | { readonly providerCallId: string; readonly toolId: "patch"; readonly toolVersion: "standalone-v1"; readonly arguments: StandalonePatchInput }
  | { readonly providerCallId: string; readonly toolId: "exec"; readonly toolVersion: "standalone-v1"; readonly arguments: StandaloneExecInput }
  | { readonly providerCallId: string; readonly toolId: "grep"; readonly toolVersion: "standalone-v1"; readonly arguments: StandaloneGrepInput }
  | { readonly providerCallId: string; readonly toolId: "glob"; readonly toolVersion: "standalone-v1"; readonly arguments: StandaloneGlobInput };

const resultSchema: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: [
    "status", "summary", "data", "artifacts", "sourceVersions", "truncation",
    "diagnostics", "sideEffects", "trust", "confidentiality", "timing",
    "resourceUsage", "toolCallId", "traceId", "estimatedCostUsd", "policyDecisionId",
  ],
  properties: {
    status: { enum: ["success", "partial", "error", "denied", "timeout", "cancelled", "unknown"] },
    summary: { type: "string" },
    data: {},
    artifacts: { type: "array" },
    sourceVersions: { type: "object" },
    truncation: { type: "object" },
    diagnostics: { type: "array" },
    sideEffects: { type: "array" },
    trust: { enum: ["trusted", "derived", "untrusted"] },
    confidentiality: { enum: ["public", "workspace", "secret_adjacent", "secret"] },
    timing: { type: "object" },
    resourceUsage: { type: "object" },
    toolCallId: { type: "string" },
    traceId: { type: "string" },
    estimatedCostUsd: { type: ["number", "null"] },
    policyDecisionId: { type: ["string", "null"] },
  },
};

export const STANDALONE_TOOL_SCHEMAS: readonly ProviderToolSchema[] = [
  {
    id: "read",
    version: "standalone-v1",
    summary: "Read a bounded, line-paged UTF-8 projection of one task-scoped workspace file. Returns the observed file hash (use it for patch) and total line count. Lines render as '<line>→ <content>'; patch strips this gutter automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        max_bytes: { type: "integer", minimum: 1, maximum: 64 * 1_024, default: 48 * 1_024 },
        offset_line: { type: "integer", minimum: 1, default: 1 },
        max_lines: { type: "integer", minimum: 1, maximum: 4_000, default: 2_000 },
        render: { enum: ["numbered", "raw"], default: "numbered" },
        expected_sha256: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      },
    },
    resultSchema,
    sideEffectClass: "read",
    requiredCapabilities: ["workspace.read"],
    trustLevel: "builtin",
    maximumModelResultBytes: MAX_TOOL_MODEL_RESULT_BYTES,
    maximumArtifactBytes: 16 * 1_024 * 1_024,
    defaultTimeoutMs: 30_000,
    policyTags: ["workspace", "read-only", "standalone"],
  },
  {
    id: "patch",
    version: "standalone-v1",
    summary: "Apply hash-anchored, unique exact-text replacements in the task write scope. expected_sha256 may be omitted: the last read-observed hash of the file is substituted. If your copied text carries '<line>→ ' gutters from a numbered read, they are stripped before matching.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        expected_sha256: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        expected_utf8: { type: "string", maxLength: 64 * 1_024 },
        replacement_utf8: { type: "string", maxLength: 64 * 1_024 },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["expected_utf8", "replacement_utf8"],
            properties: {
              expected_utf8: { type: "string", minLength: 1, maxLength: 64 * 1_024 },
              replacement_utf8: { type: "string", maxLength: 64 * 1_024 },
            },
          },
        },
        commit_mode: { enum: ["preview", "apply"], default: "apply" },
      },
    },
    resultSchema,
    sideEffectClass: "workspace_write",
    requiredCapabilities: ["workspace.patch"],
    trustLevel: "builtin",
    maximumModelResultBytes: MAX_TOOL_MODEL_RESULT_BYTES,
    maximumArtifactBytes: 16 * 1_024 * 1_024,
    defaultTimeoutMs: 60_000,
    policyTags: ["workspace", "write", "stale-write-protected", "standalone"],
  },
  {
    id: "exec",
    version: "standalone-v1",
    summary: "Run one bounded command without environment injection, network, or secrets. argv mode by default; shell mode requires operator enablement.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        program: { type: "string" },
        args: { type: "array", maxItems: 128, items: { type: "string" }, default: [] },
        shell: {
          type: "object",
          additionalProperties: false,
          required: ["dialect", "script"],
          properties: {
            dialect: { enum: ["bash", "sh"] },
            script: { type: "string", minLength: 1, maxLength: 64 * 1_024 },
          },
        },
        cwd: { type: "string", default: "." },
        timeout_ms: { type: "integer", minimum: 100, maximum: 60_000, default: 60_000 },
        expected_exit_codes: { type: "array", minItems: 1, maxItems: 16, items: { type: "integer", minimum: 0, maximum: 255 }, default: [0] },
      },
    },
    resultSchema,
    sideEffectClass: "process",
    requiredCapabilities: ["process.exec"],
    trustLevel: "builtin",
    maximumModelResultBytes: MAX_TOOL_MODEL_RESULT_BYTES,
    maximumArtifactBytes: 64 * 1_024 * 1_024,
    defaultTimeoutMs: 60_000,
    policyTags: ["workspace", "process", "no-shell", "standalone"],
  },
  {
    id: "grep",
    version: "standalone-v1",
    summary: "Lexical regex search over the task workspace via kernel-dispatched ripgrep. Returns file:line:text matches, bounded.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 512 },
        path: { type: "string", default: "." },
        glob: { type: "string", minLength: 1, maxLength: 256 },
        ignore_case: { type: "boolean", default: false },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
    },
    resultSchema,
    sideEffectClass: "read",
    requiredCapabilities: ["workspace.read", "process.exec"],
    trustLevel: "builtin",
    maximumModelResultBytes: MAX_TOOL_MODEL_RESULT_BYTES,
    maximumArtifactBytes: 16 * 1_024 * 1_024,
    defaultTimeoutMs: 30_000,
    policyTags: ["workspace", "read-only", "search", "standalone"],
  },
  {
    id: "glob",
    version: "standalone-v1",
    summary: "List task-workspace file paths matching one glob via kernel-dispatched ripgrep --files. Bounded.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 256 },
        path: { type: "string", default: "." },
        max_results: { type: "integer", minimum: 1, maximum: 1_000, default: 200 },
      },
    },
    resultSchema,
    sideEffectClass: "read",
    requiredCapabilities: ["workspace.read", "process.exec"],
    trustLevel: "builtin",
    maximumModelResultBytes: MAX_TOOL_MODEL_RESULT_BYTES,
    maximumArtifactBytes: 16 * 1_024 * 1_024,
    defaultTimeoutMs: 30_000,
    policyTags: ["workspace", "read-only", "search", "standalone"],
  },
] as const;

export function parseStandaloneToolCall(call: ProviderToolCallChunk): ParsedStandaloneToolCall {
  if (call.toolCallId.length === 0 || call.toolCallId.length > 255 || /[\0\r\n]/.test(call.toolCallId)) {
    throw new Error("provider tool call id is invalid");
  }
  switch (call.toolName) {
    case "read":
      return { providerCallId: call.toolCallId, toolId: "read", toolVersion: "standalone-v1", arguments: parseArguments("read", standaloneReadInputSchema, call.arguments) };
    case "patch":
      return { providerCallId: call.toolCallId, toolId: "patch", toolVersion: "standalone-v1", arguments: parseArguments("patch", standalonePatchInputSchema, call.arguments) };
    case "exec":
      return { providerCallId: call.toolCallId, toolId: "exec", toolVersion: "standalone-v1", arguments: parseArguments("exec", standaloneExecInputSchema, call.arguments) };
    case "grep":
      return { providerCallId: call.toolCallId, toolId: "grep", toolVersion: "standalone-v1", arguments: parseArguments("grep", standaloneGrepInputSchema, call.arguments) };
    case "glob":
      return { providerCallId: call.toolCallId, toolId: "glob", toolVersion: "standalone-v1", arguments: parseArguments("glob", standaloneGlobInputSchema, call.arguments) };
    default:
      throw new Error(`provider requested unknown standalone tool '${call.toolName}'`);
  }
}

function parseArguments<T>(
  toolId: string,
  schema: { readonly safeParse: (value: unknown) => { readonly success: true; readonly data: T } | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${toolId} arguments are invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export function normalizedToolOperationHash(input: {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly call: ParsedStandaloneToolCall;
}): string {
  return computeContentHash(canonicalJson({
    task_id: input.taskId,
    contract_version: input.contractVersion,
    tool_id: input.call.toolId,
    tool_version: input.call.toolVersion,
    arguments: input.call.arguments,
  }));
}

export function providerToolCallTranscript(call: ParsedStandaloneToolCall): ProviderToolCallTranscript {
  return {
    protocol: "terminus.tool-call.v1",
    provider_call_id: call.providerCallId,
    tool_name: call.toolId,
    arguments: call.arguments,
  };
}

export function providerToolResultTranscript(
  call: ParsedStandaloneToolCall,
  result: Readonly<Record<string, unknown>>,
): ProviderToolResultTranscript {
  return {
    protocol: "terminus.tool-result.v1",
    provider_call_id: call.providerCallId,
    tool_name: call.toolId,
    result,
  };
}

const MODEL_VISIBLE_RESULT_STATUSES = new Set(["success", "partial"]);

/**
 * Dual-path projection (ADR-0039 §11): the model sees a minimal
 * status/summary/data view of a settled result; the full envelope stays in
 * the observability artifact. Payload fields the provider must consume
 * (file content, command output, match lists) are preserved verbatim;
 * ceremony fields (timing, resource usage, trace ids, artifact catalogs)
 * are dropped. `is_error` is set so renderers can mark failed tool results.
 */
export function projectModelVisibleResult(
  result: ToolResult<unknown>,
): Readonly<Record<string, unknown>> {
  const ok = MODEL_VISIBLE_RESULT_STATUSES.has(result.status);
  const data = ok ? projectModelVisibleData(result) : null;
  const projection: Record<string, unknown> = {
    status: result.status,
    summary: result.summary,
    ...(data !== null ? { data } : {}),
    ...(!ok && result.diagnostics.length > 0
      ? { error: result.diagnostics.map((diagnostic) => diagnostic.message).join("; ") }
      : {}),
    ...(result.truncation.occurred ? { truncation: result.truncation } : {}),
    ...(ok ? {} : { is_error: true }),
  };
  return projection;
}

function projectModelVisibleData(result: ToolResult<unknown>): unknown {
  const data = result.data;
  if (data === null || data === undefined || typeof data !== "object") return data;
  const record = data as Readonly<Record<string, unknown>>;
  if (!Array.isArray(record.validations)) return data;
  // patch: keep only failing validations in the model view.
  return {
    ...record,
    validations: (record.validations as readonly { status?: string }[]).filter(
      (validation) => validation.status !== "pass",
    ),
  };
}

export function toolEffectMetadata(call: ParsedStandaloneToolCall): {
  readonly effectType: "READ_LOCAL" | "WRITE_LOCAL" | "EXECUTE_LOCAL";
  readonly resourceUri: string;
  readonly reversibility: "none" | "reversible" | "unknown";
} {
  switch (call.toolId) {
    case "read":
      return { effectType: "READ_LOCAL", resourceUri: `workspace://${call.arguments.path}`, reversibility: "none" };
    case "patch":
      return { effectType: "WRITE_LOCAL", resourceUri: `workspace://${call.arguments.path}`, reversibility: "reversible" };
    case "exec":
      return { effectType: "EXECUTE_LOCAL", resourceUri: `workspace://${call.arguments.cwd}`, reversibility: "unknown" };
    case "grep":
      return { effectType: "READ_LOCAL", resourceUri: `workspace://${call.arguments.path}`, reversibility: "none" };
    case "glob":
      return { effectType: "READ_LOCAL", resourceUri: `workspace://${call.arguments.path}`, reversibility: "none" };
  }
}

export interface ExecuteStandaloneToolInput {
  readonly clients: KernelUdsClients;
  readonly context: RequestContext;
  readonly workspaceId: string;
  readonly call: ParsedStandaloneToolCall;
  readonly internalToolCallId: string;
  readonly sideEffectId: Uuid7;
  readonly policyDecisionId: string;
  readonly traceId: string;
  readonly contractHash: string;
  readonly devMode: boolean;
  readonly shellModeEnabled: boolean;
  /**
   * Per-turn registry of file hashes actually observed through reads.
   * Patch resolves an omitted expected_sha256 from this tracker; the
   * substituted value is still an observed source version, so stale-write
   * protection (safety rule §2) is preserved.
   */
  readonly observedSources?: ObservedSourceTracker;
}

/** Gutter used by numbered reads: `<line>→ <content>`. */
const NUMBERED_GUTTER_PATTERN = /^(\d+)→ /;

export function renderNumbered(text: string, startLine: number): string {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (normalized.length === 0) return text;
  const lines = normalized.split("\n");
  return lines.map((line, index) => `${startLine + index}→ ${line}`).join("\n") + "\n";
}

function isFullyNumbered(block: string): boolean {
  const lines = block.split("\n");
  const significant = lines.filter((line) => line.length > 0);
  if (significant.length === 0) return false;
  return lines.every((line) => line.length === 0 || NUMBERED_GUTTER_PATTERN.test(line));
}

/**
 * Strip `<line>→ ` gutters from a copied block, but only when every
 * non-empty line carries one. A partially guttered block is returned
 * unchanged so exact-match semantics stay conservative: a wrong copy fails
 * the patch instead of silently mutating content.
 */
export function stripNumberedGuttersIfFullyNumbered(block: string): { text: string; stripped: boolean } {
  if (!isFullyNumbered(block)) return { text: block, stripped: false };
  const text = block
    .split("\n")
    .map((line) => line.replace(NUMBERED_GUTTER_PATTERN, ""))
    .join("\n");
  return { text, stripped: true };
}

/**
 * Tracks source hashes observed through successful reads, scoped per turn.
 * Keys are `${workspaceId}:${path}`; values are whole-file sha256 labels as
 * reported by the kernel read response.
 */
export class ObservedSourceTracker {
  private readonly observed = new Map<string, string>();

  record(workspaceId: string, path: string, sha256: string): void {
    if (!/^sha256:[0-9a-f]{64}$/.test(sha256)) return;
    this.observed.set(`${workspaceId}:${path}`, sha256);
  }

  resolve(workspaceId: string, path: string): string | null {
    return this.observed.get(`${workspaceId}:${path}`) ?? null;
  }

  get size(): number {
    return this.observed.size;
  }
}


/** Slice decoded UTF-8 text into a 1-based inclusive line page. */
export function pageLines(text: string, offsetLine: number, maxLines: number): {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly hasMore: boolean;
} {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (offsetLine > lines.length) {
    return {
      text: "",
      startLine: Math.max(offsetLine, 1),
      endLine: offsetLine - 1,
      hasMore: false,
    };
  }
  const start = Math.max(1, Math.min(offsetLine, lines.length));
  const slice = lines.slice(start - 1, start - 1 + maxLines);
  const end = start + slice.length - 1;
  return {
    text: `${slice.join("\n")}\n`,
    startLine: start,
    endLine: end,
    hasMore: end < lines.length,
  };
}

export async function executeStandaloneTool(
  input: ExecuteStandaloneToolInput,
): Promise<ToolResult<unknown>> {
  const startedAt = performance.now();
  switch (input.call.toolId) {
    case "read": {
      const response = await input.clients.files.Read({
        context: nextRequestContext(input.context, "read"),
        intent: toolIntent(input.contractHash, "read_local"),
        path: { workspaceId: input.workspaceId, relativePath: input.call.arguments.path },
        mode: "full",
        ranges: [],
        symbols: [],
        maxBytes: input.call.arguments.max_bytes,
        expectedSha256: input.call.arguments.expected_sha256 ?? "",
      });
      const fullProjection = new TextDecoder("utf-8", { fatal: true }).decode(response.modelProjectionUtf8);
      const totalLines = fullProjection.length === 0 ? 0 : (fullProjection.endsWith("\n") ? fullProjection.slice(0, -1) : fullProjection).split("\n").length;
      const page = pageLines(fullProjection, input.call.arguments.offset_line, input.call.arguments.max_lines);
      const sourceHash = response.sourceVersion?.sha256 ?? "";
      if (sourceHash.length > 0 && input.observedSources !== undefined) {
        input.observedSources.record(input.workspaceId, input.call.arguments.path, sourceHash);
      }
      const contentUtf8 = input.call.arguments.render === "numbered"
        ? renderNumbered(page.text, page.startLine)
        : page.text;
      const artifact = kernelArtifactDescriptor(response.fullContent);
      const elapsed = performance.now() - startedAt;
      const result = okResult({
        path: input.call.arguments.path,
        content_utf8: contentUtf8,
        file_sha256: sourceHash.length === 0 ? null : sourceHash,
        total_lines: totalLines,
        render: input.call.arguments.render,
        offset_line: page.startLine,
        end_line: page.endLine,
        rendered_mode: response.renderedMode,
        continuation_token: response.continuationToken || null,
        next_offset_line: page.hasMore ? page.endLine + 1 : null,
      }, {
        toolCallId: input.internalToolCallId,
        traceId: input.traceId,
        summary: `Read ${input.call.arguments.path} lines ${page.startLine}-${page.endLine} of ${totalLines}${page.hasMore ? " (continued)" : ""}`,
        sourceVersions: sourceHash.length === 0 ? {} : { [input.call.arguments.path]: sourceHash },
        artifacts: artifact === null ? [] : [artifact],
        sideEffects: [sideEffect(input.sideEffectId, "read", `Read ${input.call.arguments.path}`, true)],
        timing: { executionMs: elapsed, totalMs: elapsed },
      });
      return {
        ...result,
        policyDecisionId: input.policyDecisionId,
        truncation: response.truncated || page.hasMore
          ? {
              occurred: true,
              reason: page.hasMore
                ? "line page continues beyond this read"
                : "kernel read projection reached max_bytes",
              continuation: page.hasMore
                ? `read ${input.call.arguments.path} at offset_line ${page.endLine + 1}`
                : response.continuationToken || artifact?.uri || null,
            }
          : result.truncation,
        diagnostics: response.diagnostics.map((diagnostic) => ({
          severity: diagnostic.severity === "error" || diagnostic.severity === "warning" ? diagnostic.severity : "info",
          code: diagnostic.code || null,
          message: diagnostic.message,
          path: diagnostic.path?.relativePath ?? null,
          range: diagnostic.startLine > 0
            ? { startLine: diagnostic.startLine, endLine: Math.max(diagnostic.startLine, diagnostic.endLine) }
            : null,
        })),
        resourceUsage: { ...result.resourceUsage, bytesRead: response.modelProjectionUtf8.byteLength },
      };
    }
    case "patch": {
      const patchArguments = input.call.arguments;
      let baselineSha256 = patchArguments.expected_sha256 ?? "";
      let resolvedFromObservation = false;
      if (baselineSha256.length === 0) {
        const observed = input.observedSources?.resolve(input.workspaceId, patchArguments.path) ?? null;
        if (observed === null) {
          const elapsed = performance.now() - startedAt;
          const base = okResult(null, {
            toolCallId: input.internalToolCallId,
            traceId: input.traceId,
            summary: `No observed source version for ${patchArguments.path}; read the file before editing`,
            timing: { executionMs: elapsed, totalMs: elapsed },
          });
          return {
            ...base,
            status: "denied",
            policyDecisionId: input.policyDecisionId,
            diagnostics: [{
              severity: "error",
              code: "PATCH_REQUIRES_OBSERVED_SOURCE",
              message: `patch requires the observed source hash of ${patchArguments.path}. Read the file first (the read result carries file_sha256), then retry; or pass expected_sha256 explicitly.`,
              path: patchArguments.path,
              range: null,
            }],
          };
        }
        baselineSha256 = observed;
        resolvedFromObservation = true;
      }
      const edits = (patchArguments.edits ?? [{
        expected_utf8: nonEmptyAsserted(patchArguments.expected_utf8, "expected_utf8"),
        replacement_utf8: patchArguments.replacement_utf8 ?? "",
      }]).map((edit) => {
        const expected = stripNumberedGuttersIfFullyNumbered(edit.expected_utf8);
        const replacement = stripNumberedGuttersIfFullyNumbered(edit.replacement_utf8);
        return { expected_utf8: expected.text, replacement_utf8: replacement.text, guttersStripped: expected.stripped || replacement.stripped };
      });
      const anyGuttersStripped = edits.some((edit) => edit.guttersStripped);
      let response: Awaited<ReturnType<KernelUdsClients["patch"]["Apply"]>>;
      try {
        response = await input.clients.patch.Apply({
          context: nextRequestContext(input.context, "patch"),
          intent: toolIntent(input.contractHash, "write_local"),
          transactionId: input.context.idempotencyKey,
          baseline: {
            workspaceId: input.workspaceId,
            repositoryRevision: "no-vcs",
            dirtyDigest: "",
            sources: [{
              path: { workspaceId: input.workspaceId, relativePath: patchArguments.path },
              sha256: baselineSha256,
              repositoryRevision: "no-vcs",
            }],
          },
          edits: edits.map((edit) => ({
            replaceExactText: {
              path: { workspaceId: input.workspaceId, relativePath: patchArguments.path },
              expectedSha256: baselineSha256,
              expectedUtf8: new TextEncoder().encode(edit.expected_utf8),
              replacementUtf8: new TextEncoder().encode(edit.replacement_utf8),
              requireUnique: true,
            },
          })),
          validationProfileId: "task-default",
          allowTransientInvalidState: false,
          commitMode: patchArguments.commit_mode === "preview"
            ? PatchCommitMode.PATCH_COMMIT_MODE_PREVIEW_ONLY
            : PatchCommitMode.PATCH_COMMIT_MODE_APPLY_TO_WORKTREE,
        });
      } catch (error: unknown) {
        // Deterministic transaction rejection (stale hash, anchor not found,
        // non-unique anchor): no effects were committed, so report a clean,
        // actionable tool error instead of surfacing ambiguous settlement.
        const message = error instanceof Error ? error.message : String(error);
        const stale = /sha256|source|stale|precondition/i.test(message);
        const elapsed = performance.now() - startedAt;
        const base = okResult(null, {
          toolCallId: input.internalToolCallId,
          traceId: input.traceId,
          summary: stale
            ? `Patch rejected: ${patchArguments.path} changed since the observed read; re-read and retry`
            : `Patch rejected: ${message.slice(0, 512)}`,
          timing: { executionMs: elapsed, totalMs: elapsed },
        });
        return {
          ...base,
          status: "error",
          policyDecisionId: input.policyDecisionId,
          diagnostics: [{
            severity: "error",
            code: stale ? "PATCH_STALE_SOURCE" : "PATCH_REJECTED",
            message: stale
              ? `The observed source version of ${patchArguments.path} no longer matches. Re-read the file (a fresh read returns file_sha256) and retry with current content.`
              : message.slice(0, 2_048),
            path: patchArguments.path,
            range: null,
          }],
        };
      }
      const elapsed = performance.now() - startedAt;
      const artifact = kernelArtifactDescriptor(response.completeDiff);
      const result = okResult({
        transaction_id: response.transactionId,
        state: response.state,
        final_repository_revision: response.finalRepositoryRevision,
        final_dirty_digest: response.finalDirtyDigest,
        applied_edits: edits.length,
        changed_files: response.changedFiles.map((file) => ({
          path: file.path?.relativePath ?? "",
          old_sha256: file.oldSha256,
          new_sha256: file.newSha256,
          operation: file.operation,
        })),
        validations: response.validations.map((validation) => ({
          check_id: validation.checkId,
          status: validation.status,
          summary: validation.summary,
        })),
        resolved_from_observed_hash: resolvedFromObservation,
        gutters_stripped: anyGuttersStripped,
      }, {
        toolCallId: input.internalToolCallId,
        traceId: input.traceId,
        summary: `${patchArguments.commit_mode === "preview" ? "Previewed" : "Applied"} ${edits.length} exact edit${edits.length === 1 ? "" : "s"} to ${patchArguments.path}${anyGuttersStripped ? " (line-number gutters stripped)" : ""}`,
        artifacts: artifact === null ? [] : [artifact],
        sideEffects: [sideEffect(input.sideEffectId, "workspace_write", `Patch ${patchArguments.path}`, patchArguments.commit_mode === "preview")],
        timing: { executionMs: elapsed, totalMs: elapsed },
      });
      return { ...result, policyDecisionId: input.policyDecisionId };
    }
    case "exec": {
      if (input.call.arguments.shell !== undefined && !input.shellModeEnabled) {
        const elapsed = performance.now() - startedAt;
        const base = okResult(null, {
          toolCallId: input.internalToolCallId,
          traceId: input.traceId,
          summary: "shell mode is disabled by operator policy; use argv exec",
          timing: { executionMs: elapsed, totalMs: elapsed },
        });
        return {
          ...base,
          status: "denied",
          policyDecisionId: input.policyDecisionId,
          diagnostics: [{
            severity: "error",
            code: "SHELL_MODE_DISABLED",
            message: "shell-mode exec requires the operator to enable TERMINUS_SHELL_MODE; use program+args instead",
            path: null,
            range: null,
          }],
        };
      }
      const shell = input.call.arguments.shell;
      const events = input.clients.process.Start({
        context: nextRequestContext(input.context, "exec"),
        intent: toolIntent(input.contractHash, "execute_local"),
        command: {
          program: shell !== undefined ? "" : assertProgram(input.call.arguments.program),
          args: shell !== undefined ? [] : [...input.call.arguments.args],
          cwd: { workspaceId: input.workspaceId, relativePath: input.call.arguments.cwd },
          publicEnv: {},
          secretCapabilityUris: [],
          timeout: durationFromMilliseconds(input.call.arguments.timeout_ms),
          allocatePty: false,
          shell: shell === undefined ? undefined : { enabled: true, dialect: shell.dialect, script: shell.script },
        },
        sandboxProfileId: input.devMode ? "degraded-local" : "secure-local-default",
        outputPolicyId: "tool-result-bounded",
      });
      return settleProcessOutcome(input, events, startedAt);
    }
    case "grep":
    case "glob": {
      const argv = input.call.toolId === "grep"
        ? grepArgv(input.call.arguments)
        : globArgv(input.call.arguments);
      const events = input.clients.process.Start({
        context: nextRequestContext(input.context, input.call.toolId),
        intent: toolIntent(input.contractHash, "execute_local"),
        command: {
          program: argv.program,
          args: [...argv.args],
          cwd: { workspaceId: input.workspaceId, relativePath: input.call.arguments.path },
          publicEnv: {},
          secretCapabilityUris: [],
          timeout: durationFromMilliseconds(30_000),
          allocatePty: false,
          shell: undefined,
        },
        sandboxProfileId: input.devMode ? "degraded-local" : "secure-local-default",
        outputPolicyId: "tool-result-bounded",
      });
      return settleProcessOutcome(input, events, startedAt);
    }
  }
}

function assertProgram(program: string | undefined): string {
  if (program === undefined || program.length === 0) throw new Error("argv exec requires program");
  return program;
}

function nonEmptyAsserted(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0) throw new Error(`single-edit patch requires ${field}`);
  return value;
}

function grepArgv(args: StandaloneGrepInput): { readonly program: string; readonly args: readonly string[] } {
  const argv = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "400"];
  if (args.ignore_case) argv.push("--ignore-case");
  if (args.glob !== undefined) argv.push("--glob", args.glob);
  return { program: "rg", args: [...argv, "--", args.pattern, "."] };
}

function globArgv(args: StandaloneGlobInput): { readonly program: string; readonly args: readonly string[] } {
  return { program: "rg", args: ["--files", "--color", "never", "--glob", args.pattern] };
}

async function settleProcessOutcome(
  input: ExecuteStandaloneToolInput,
  events: ReturnType<KernelUdsClients["process"]["Start"]>,
  startedAt: number,
): Promise<ToolResult<unknown>> {
  const outcome = await collectProcess(events);
  const elapsed = performance.now() - startedAt;
  if (outcome.kind === "denied") {
    const base = okResult(null, {
      toolCallId: input.internalToolCallId,
      traceId: input.traceId,
      summary: outcome.policy.explanation || `Kernel policy ${outcome.policy.decision}`,
      timing: { executionMs: elapsed, totalMs: elapsed },
    });
    return {
      ...base,
      status: "denied",
      policyDecisionId: input.policyDecisionId,
      diagnostics: [{
        severity: "error",
        code: outcome.policy.decisionId || null,
        message: outcome.policy.explanation || `kernel policy decision: ${outcome.policy.decision}`,
        path: null,
        range: null,
      }],
    };
  }
  const stdoutArtifact = kernelArtifactDescriptor(outcome.stdoutArtifact);
  const stderrArtifact = kernelArtifactDescriptor(outcome.stderrArtifact);
  const artifacts = [stdoutArtifact, stderrArtifact].filter((artifact): artifact is ArtifactDescriptor => artifact !== null);
  const expected = processExitExpected(input.call, outcome.exitCode);
  let data: Record<string, unknown>;
  let summary: string;
  if (input.call.toolId === "grep" || input.call.toolId === "glob") {
    const lines = outcome.stdout.length === 0 ? [] : outcome.stdout.replace(/\n$/, "").split("\n");
    const limit = input.call.toolId === "grep" ? input.call.arguments.max_results : input.call.arguments.max_results;
    const total = lines.length;
    const bounded = lines.slice(0, limit);
    data = input.call.toolId === "grep"
      ? { matches: bounded, reported_matches: bounded.length, total_found: total, exit_code: outcome.exitCode }
      : { paths: bounded, reported_paths: bounded.length, total_found: total, exit_code: outcome.exitCode };
    summary = input.call.toolId === "grep"
      ? `grep found ${total} match${total === 1 ? "" : "es"} for '${input.call.arguments.pattern}'${total > bounded.length ? `; showing first ${bounded.length}` : ""}`
      : `glob matched ${total} path${total === 1 ? "" : "s"} for '${input.call.arguments.pattern}'${total > bounded.length ? `; showing first ${bounded.length}` : ""}`;
  } else if (input.call.toolId === "exec") {
    data = {
      exit_code: outcome.exitCode,
      signal: outcome.signal || null,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
    summary = expected
      ? `${describeProcessCommand(input.call)} exited ${outcome.exitCode}`
      : `${describeProcessCommand(input.call)} exited ${outcome.exitCode}; expected ${(input.call.toolId === "exec" ? input.call.arguments.expected_exit_codes : [0]).join(", ")}`;
  } else {
    throw new Error("settleProcessOutcome called for a non-process tool");
  }
  const base = okResult(data, {
    toolCallId: input.internalToolCallId,
    traceId: input.traceId,
    summary,
    artifacts,
    sideEffects: [sideEffect(input.sideEffectId, input.call.toolId === "exec" ? "process" : "read", describeProcessCommand(input.call), false)],
    timing: { executionMs: elapsed, totalMs: elapsed },
  });
  return {
    ...base,
    status: expected ? "success" : "error",
    policyDecisionId: input.policyDecisionId,
    truncation: outcome.truncated
      ? {
          occurred: true,
          reason: "process output exceeded the model-result projection",
          continuation: stdoutArtifact?.uri ?? stderrArtifact?.uri ?? null,
        }
      : base.truncation,
  };
}

function describeProcessCommand(call: ParsedStandaloneToolCall): string {
  if (call.toolId === "exec") {
    return call.arguments.shell !== undefined
      ? `${call.arguments.shell.dialect} script`
      : assertProgram(call.arguments.program);
  }
  if (call.toolId === "grep") return "rg";
  if (call.toolId === "glob") return "rg --files";
  throw new Error("not a process tool");
}

function processExitExpected(call: ParsedStandaloneToolCall, exitCode: number): boolean {
  if (call.toolId === "exec") return call.arguments.expected_exit_codes.includes(exitCode);
  // rg exits 0 with matches/files and 1 when nothing matched; both are
  // successful searches, not tool failures.
  if (call.toolId === "grep" || call.toolId === "glob") return exitCode === 0 || exitCode === 1;
  return exitCode === 0;
}

function nextRequestContext(context: RequestContext, suffix: string): RequestContext {
  return {
    ...context,
    requestId: randomUUID(),
    idempotencyKey: `${context.idempotencyKey}:${suffix}`,
  };
}

function toolIntent(contractHash: string, effectClass: string) {
  return {
    userIntentRef: "task-contract",
    taskContractHash: contractHash,
    trustLabel: "derived",
    confidentialityLabel: "workspace",
    taintSources: [],
    policyProfileId: "secure-local-default",
    expectedEffectClass: effectClass,
  };
}

function durationFromMilliseconds(milliseconds: number): { readonly seconds: number; readonly nanos: number } {
  return {
    seconds: Math.floor(milliseconds / 1_000),
    nanos: (milliseconds % 1_000) * 1_000_000,
  };
}

function kernelArtifactDescriptor(artifact: KernelArtifactRef | undefined): ArtifactDescriptor | null {
  if (artifact === undefined || artifact.sha256.length === 0) return null;
  return {
    uri: `artifact://sha256/${artifact.sha256.replace(/^sha256:/, "")}`,
    mediaType: artifact.mediaType || "application/octet-stream",
    bytes: artifact.sizeBytes,
    hash: artifact.sha256 as ContentHash,
  };
}

function sideEffect(
  id: Uuid7,
  kind: string,
  description: string,
  reversible: boolean,
) {
  return { id, kind, description, reversible, settled: true };
}

type ProcessOutcome =
  | { readonly kind: "denied"; readonly policy: KernelPolicyDecision }
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly signal: string;
      readonly stdout: string;
      readonly stderr: string;
      readonly stdoutArtifact: KernelArtifactRef | undefined;
      readonly stderrArtifact: KernelArtifactRef | undefined;
      readonly truncated: boolean;
    };

function collectProcess(events: { readonly subscribe: (observer: {
  readonly next: (event: ProcessEvent) => void;
  readonly error: (error: unknown) => void;
  readonly complete: () => void;
}) => { readonly unsubscribe: () => void } }): Promise<ProcessOutcome> {
  const maximumProjectionBytes = 20 * 1_024;
  return new Promise((resolve, reject) => {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let projectedBytes = 0;
    let totalBytes = 0;
    let settled = false;
    let subscription: { readonly unsubscribe: () => void } | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      callback();
    };
    const retain = (target: Uint8Array[], bytes: Uint8Array): void => {
      totalBytes += bytes.byteLength;
      const remaining = maximumProjectionBytes - projectedBytes;
      if (remaining <= 0) return;
      const retained = bytes.byteLength <= remaining ? bytes : bytes.slice(0, remaining);
      target.push(retained);
      projectedBytes += retained.byteLength;
    };
    subscription = events.subscribe({
      next: (event) => {
        const policy = event.policy;
        if (policy !== undefined && policy.decision !== "allow") {
          finish(() => resolve({ kind: "denied", policy }));
          return;
        }
        if (event.stdout !== undefined) retain(stdout, event.stdout.bytes);
        if (event.stderr !== undefined) retain(stderr, event.stderr.bytes);
        const exited = event.exited;
        if (exited !== undefined) {
          const decoder = new TextDecoder("utf-8");
          finish(() => resolve({
            kind: "exited",
            exitCode: exited.exitCode,
            signal: exited.signal,
            stdout: decoder.decode(concatBytes(stdout)),
            stderr: decoder.decode(concatBytes(stderr)),
            stdoutArtifact: exited.stdoutArtifact,
            stderrArtifact: exited.stderrArtifact,
            truncated: totalBytes > projectedBytes,
          }));
        }
      },
      error: (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      complete: () => finish(() => reject(new Error("kernel process stream ended without settlement"))),
    });
  });
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
