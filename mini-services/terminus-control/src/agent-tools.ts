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

export const MAX_TOOL_CYCLES = 4;
export const MAX_TOOL_MODEL_RESULT_BYTES = 32 * 1_024;

const pathSchema = z.string().min(1).max(4_096).refine(
  (path) => !path.includes("\0") && !path.includes("\r") && !path.includes("\n"),
  "path may not contain control delimiters",
);
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const standaloneReadInputSchema = z.object({
  path: pathSchema,
  max_bytes: z.number().int().min(1).max(24 * 1_024).default(24 * 1_024),
  expected_sha256: sha256Schema.optional(),
}).strict();

export const standalonePatchInputSchema = z.object({
  path: pathSchema,
  expected_sha256: sha256Schema,
  expected_utf8: z.string().max(64 * 1_024),
  replacement_utf8: z.string().max(64 * 1_024),
  commit_mode: z.enum(["preview", "apply"]).default("apply"),
}).strict();

export const standaloneExecInputSchema = z.object({
  program: z.string().min(1).max(4_096).refine(
    (program) => !/[\0\r\n]/.test(program) && !program.includes(";") && !program.includes("\\"),
    "program must be an executable path or name, not a shell expression",
  ),
  args: z.array(z.string().max(16_384)).max(128).default([]),
  cwd: pathSchema.default("."),
  timeout_ms: z.number().int().min(100).max(60_000).default(60_000),
  expected_exit_codes: z.array(z.number().int().min(0).max(255)).min(1).max(16).default([0]),
}).strict();

export type StandaloneReadInput = z.infer<typeof standaloneReadInputSchema>;
export type StandalonePatchInput = z.infer<typeof standalonePatchInputSchema>;
export type StandaloneExecInput = z.infer<typeof standaloneExecInputSchema>;

export type ParsedStandaloneToolCall =
  | { readonly providerCallId: string; readonly toolId: "read"; readonly toolVersion: "standalone-v1"; readonly arguments: StandaloneReadInput }
  | { readonly providerCallId: string; readonly toolId: "patch"; readonly toolVersion: "standalone-v1"; readonly arguments: StandalonePatchInput }
  | { readonly providerCallId: string; readonly toolId: "exec"; readonly toolVersion: "standalone-v1"; readonly arguments: StandaloneExecInput };

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
    summary: "Read a bounded UTF-8 projection of one task-scoped workspace file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string" },
        max_bytes: { type: "integer", minimum: 1, maximum: 24 * 1_024, default: 24 * 1_024 },
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
    summary: "Apply one hash-anchored, unique exact-text replacement in the task write scope.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "expected_sha256", "expected_utf8", "replacement_utf8"],
      properties: {
        path: { type: "string" },
        expected_sha256: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        expected_utf8: { type: "string", maxLength: 64 * 1_024 },
        replacement_utf8: { type: "string", maxLength: 64 * 1_024 },
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
    summary: "Run one bounded argv command without a shell, environment injection, network, or secrets.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["program"],
      properties: {
        program: { type: "string" },
        args: { type: "array", maxItems: 128, items: { type: "string" }, default: [] },
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
      const content = new TextDecoder("utf-8", { fatal: true }).decode(response.modelProjectionUtf8);
      const artifact = kernelArtifactDescriptor(response.fullContent);
      const elapsed = performance.now() - startedAt;
      const sourceHash = response.sourceVersion?.sha256 ?? "";
      const result = okResult({
        path: input.call.arguments.path,
        content_utf8: content,
        rendered_mode: response.renderedMode,
        continuation_token: response.continuationToken || null,
      }, {
        toolCallId: input.internalToolCallId,
        traceId: input.traceId,
        summary: `Read ${input.call.arguments.path}`,
        sourceVersions: sourceHash.length === 0 ? {} : { [input.call.arguments.path]: sourceHash },
        artifacts: artifact === null ? [] : [artifact],
        sideEffects: [sideEffect(input.sideEffectId, "read", `Read ${input.call.arguments.path}`, true)],
        timing: { executionMs: elapsed, totalMs: elapsed },
      });
      return {
        ...result,
        policyDecisionId: input.policyDecisionId,
        truncation: response.truncated
          ? {
              occurred: true,
              reason: "kernel read projection reached max_bytes",
              continuation: response.continuationToken || artifact?.uri || null,
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
      const response = await input.clients.patch.Apply({
        context: nextRequestContext(input.context, "patch"),
        intent: toolIntent(input.contractHash, "write_local"),
        transactionId: input.context.idempotencyKey,
        baseline: {
          workspaceId: input.workspaceId,
          repositoryRevision: "no-vcs",
          dirtyDigest: "",
          sources: [{
            path: { workspaceId: input.workspaceId, relativePath: input.call.arguments.path },
            sha256: input.call.arguments.expected_sha256,
            repositoryRevision: "no-vcs",
          }],
        },
        edits: [{
          replaceExactText: {
            path: { workspaceId: input.workspaceId, relativePath: input.call.arguments.path },
            expectedSha256: input.call.arguments.expected_sha256,
            expectedUtf8: new TextEncoder().encode(input.call.arguments.expected_utf8),
            replacementUtf8: new TextEncoder().encode(input.call.arguments.replacement_utf8),
            requireUnique: true,
          },
        }],
        validationProfileId: "task-default",
        allowTransientInvalidState: false,
        commitMode: input.call.arguments.commit_mode === "preview"
          ? PatchCommitMode.PATCH_COMMIT_MODE_PREVIEW_ONLY
          : PatchCommitMode.PATCH_COMMIT_MODE_APPLY_TO_WORKTREE,
      });
      const elapsed = performance.now() - startedAt;
      const artifact = kernelArtifactDescriptor(response.completeDiff);
      const result = okResult({
        transaction_id: response.transactionId,
        state: response.state,
        final_repository_revision: response.finalRepositoryRevision,
        final_dirty_digest: response.finalDirtyDigest,
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
      }, {
        toolCallId: input.internalToolCallId,
        traceId: input.traceId,
        summary: `${input.call.arguments.commit_mode === "preview" ? "Previewed" : "Applied"} exact patch to ${input.call.arguments.path}`,
        artifacts: artifact === null ? [] : [artifact],
        sideEffects: [sideEffect(input.sideEffectId, "workspace_write", `Patch ${input.call.arguments.path}`, input.call.arguments.commit_mode === "preview")],
        timing: { executionMs: elapsed, totalMs: elapsed },
      });
      return { ...result, policyDecisionId: input.policyDecisionId };
    }
    case "exec": {
      const events = input.clients.process.Start({
        context: nextRequestContext(input.context, "exec"),
        intent: toolIntent(input.contractHash, "execute_local"),
        command: {
          program: input.call.arguments.program,
          args: [...input.call.arguments.args],
          cwd: { workspaceId: input.workspaceId, relativePath: input.call.arguments.cwd },
          publicEnv: {},
          secretCapabilityUris: [],
          timeout: durationFromMilliseconds(input.call.arguments.timeout_ms),
          allocatePty: false,
          shell: undefined,
        },
        sandboxProfileId: input.devMode ? "degraded-local" : "secure-local-default",
        outputPolicyId: "tool-result-bounded",
      });
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
      const expected = input.call.arguments.expected_exit_codes.includes(outcome.exitCode);
      const base = okResult({
        exit_code: outcome.exitCode,
        signal: outcome.signal || null,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      }, {
        toolCallId: input.internalToolCallId,
        traceId: input.traceId,
        summary: expected
          ? `${input.call.arguments.program} exited ${outcome.exitCode}`
          : `${input.call.arguments.program} exited ${outcome.exitCode}; expected ${input.call.arguments.expected_exit_codes.join(", ")}`,
        artifacts,
        sideEffects: [sideEffect(input.sideEffectId, "process", `Execute ${input.call.arguments.program}`, false)],
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
  }
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
