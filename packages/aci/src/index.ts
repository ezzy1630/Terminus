/**
 * @terminus/aci — Production Agent Control Interface.
 *
 * Per SPEC §11, §34:
 * - 7 default always-visible tools (read, search, patch, exec, job, inspect, capability).
 * - Universal result envelope matching §34.4 (status, summary, data, artifacts, sourceVersions, truncation, diagnostics, sideEffects, trust, confidentiality, timing, resourceUsage, toolCallId, traceId).
 * - Progressive disclosure (§11.2, §34.14): two-stage discovery.
 * - Production-real executors for all 7 tools delegating to kernel RPC / workspace providers.
 */
import { z } from "zod";
import type {
  Uuid7,
  TraceId,
  ContentHash,
  Micros,
} from "@terminus/domain";
import { ValidationError, NotFoundError } from "@terminus/domain";
import { computeContentHash } from "@terminus/context-ir";
import type { ConfidentialityLabel } from "@terminus/provider-core";

// ────────────────────────── Re-export Tool Modules ────────────────────────────

export * from "./read.js";
export * from "./search.js";
export * from "./inspect.js";
export * from "./patch.js";
export * from "./exec_job.js";
export * from "./capability.js";
export * from "./output_parsers.js";


// ────────────────────────── Tool definition contract (§34.3) ─────────────────

export type ToolId =
  | "read"
  | "search"
  | "patch"
  | "exec"
  | "job"
  | "inspect"
  | "capability"
  | (string & {});

export type SideEffectClass =
  | "none"
  | "read"
  | "workspace_write"
  | "process"
  | "durable_process"
  | "external"
  | "capability_activation";

export type ToolTrustLevel =
  | "builtin"
  | "first_party"
  | "verified_third_party"
  | "untrusted";

export interface ToolDefinition {
  readonly id: ToolId;
  readonly version: string;
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly resultSchema: Readonly<Record<string, unknown>>;
  readonly sideEffectClass: SideEffectClass;
  readonly requiredCapabilities: readonly string[];
  readonly trustLevel: ToolTrustLevel;
  readonly maximumModelResultBytes: number;
  readonly maximumArtifactBytes: number;
  readonly defaultTimeoutMs: number;
  readonly policyTags: readonly string[];
  /** Opaque hash pinning this definition (used for cache-key changes on activation). */
  readonly definitionHash: ContentHash;
}

export const toolDefinitionSchema = z.object({
  id: z.string(),
  version: z.string(),
  summary: z.string().max(1000),
  useWhen: z.array(z.string()),
  doNotUseWhen: z.array(z.string()),
  inputSchema: z.record(z.string(), z.unknown()),
  resultSchema: z.record(z.string(), z.unknown()),
  sideEffectClass: z.enum([
    "none",
    "read",
    "workspace_write",
    "process",
    "durable_process",
    "external",
    "capability_activation",
  ]),
  requiredCapabilities: z.array(z.string()),
  trustLevel: z.enum([
    "builtin",
    "first_party",
    "verified_third_party",
    "untrusted",
  ]),
  maximumModelResultBytes: z.number().int().nonnegative(),
  maximumArtifactBytes: z.number().int().nonnegative(),
  defaultTimeoutMs: z.number().int().positive(),
  policyTags: z.array(z.string()),
  definitionHash: z.string(),
});

// ────────────────────────── Universal result envelope (§34.4) ─────────────────

export type ToolResultStatus =
  | "success"
  | "partial"
  | "error"
  | "denied"
  | "timeout"
  | "cancelled"
  | "unknown";

export type ToolTrust = "trusted" | "derived" | "untrusted";

export interface ArtifactDescriptor {
  readonly uri: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly hash: ContentHash;
}

export interface Diagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string | null;
  readonly message: string;
  readonly path: string | null;
  readonly range: { readonly startLine: number; readonly endLine: number } | null;
}

export interface SideEffectDescriptor {
  readonly id: Uuid7;
  readonly kind: string;
  readonly description: string;
  readonly reversible: boolean;
  readonly settled: boolean;
}

export interface TruncationInfo {
  readonly occurred: boolean;
  readonly reason: string | null;
  readonly continuation: string | null;
}

export interface TimingInfo {
  readonly queuedMs: number;
  readonly executionMs: number;
  readonly totalMs: number;
}

export interface ResourceUsage {
  readonly cpuMs: number | null;
  readonly peakMemoryBytes: number | null;
  readonly bytesRead: number | null;
  readonly bytesWritten: number | null;
  readonly networkBytes: number | null;
}

export interface ToolResult<T> {
  readonly status: ToolResultStatus;
  readonly summary: string;
  readonly data: T | null;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly truncation: TruncationInfo;
  readonly diagnostics: readonly Diagnostic[];
  readonly sideEffects: readonly SideEffectDescriptor[];
  readonly trust: ToolTrust;
  readonly confidentiality: ConfidentialityLabel;
  readonly timing: TimingInfo;
  readonly resourceUsage: ResourceUsage;
  readonly toolCallId: string;
  readonly traceId: string;
  readonly estimatedCostUsd: number | null;
  readonly policyDecisionId: string | null;
}

export function okResult<T>(
  data: T,
  opts: {
    readonly toolCallId: string;
    readonly traceId: string;
    readonly summary: string;
    readonly sourceVersions?: Readonly<Record<string, string>> | undefined;
    readonly artifacts?: readonly ArtifactDescriptor[] | undefined;
    readonly sideEffects?: readonly SideEffectDescriptor[] | undefined;
    readonly diagnostics?: readonly Diagnostic[] | undefined;
    readonly timing?: Partial<TimingInfo> | undefined;
    readonly confidentiality?: ConfidentialityLabel | undefined;
  },
): ToolResult<T> {
  return {
    status: "success",
    summary: opts.summary,
    data,
    artifacts: opts.artifacts ?? [],
    sourceVersions: opts.sourceVersions ?? {},
    truncation: { occurred: false, reason: null, continuation: null },
    diagnostics: opts.diagnostics ?? [],
    sideEffects: opts.sideEffects ?? [],
    trust: "derived",
    confidentiality: opts.confidentiality ?? "workspace",
    timing: {
      queuedMs: opts.timing?.queuedMs ?? 0,
      executionMs: opts.timing?.executionMs ?? 0,
      totalMs: opts.timing?.totalMs ?? (opts.timing?.executionMs ?? 0),
    },
    resourceUsage: {
      cpuMs: null,
      peakMemoryBytes: null,
      bytesRead: null,
      bytesWritten: null,
      networkBytes: null,
    },
    toolCallId: opts.toolCallId,
    traceId: opts.traceId,
    estimatedCostUsd: null,
    policyDecisionId: null,
  };
}

export function errorResult<T = null>(
  reason: string,
  opts: {
    readonly toolCallId: string;
    readonly traceId: string;
    readonly status?: ToolResultStatus | undefined;
    readonly summary?: string | undefined;
    readonly diagnostics?: readonly Diagnostic[] | undefined;
  },
): ToolResult<T> {
  const status: ToolResultStatus = opts.status ?? "error";
  return {
    status,
    summary: opts.summary ?? reason,
    data: null,
    artifacts: [],
    sourceVersions: {},
    truncation: { occurred: false, reason: null, continuation: null },
    diagnostics: opts.diagnostics ?? [],
    sideEffects: [],
    trust: "derived",
    confidentiality: "workspace",
    timing: { queuedMs: 0, executionMs: 0, totalMs: 0 },
    resourceUsage: {
      cpuMs: null,
      peakMemoryBytes: null,
      bytesRead: null,
      bytesWritten: null,
      networkBytes: null,
    },
    toolCallId: opts.toolCallId,
    traceId: opts.traceId,
    estimatedCostUsd: null,
    policyDecisionId: null,
  };
}

// ────────────────────────── Tool Call Context & Executor ──────────────────────

export interface ToolCallContext {
  readonly toolCallId: string;
  readonly traceId: string;
  readonly sessionId: Uuid7;
  readonly taskId: Uuid7 | null;
  readonly turnId: Uuid7 | null;
  readonly workspaceId: Uuid7;
  readonly actorId: string;
  readonly capabilityToken: string | null;
  readonly policyDecisionId: string | null;
  readonly signal: AbortSignal | null;
  readonly deadlineMs: number | null;
}

export interface ToolExecutor<T = unknown> {
  readonly toolId: ToolId;
  execute(args: unknown, ctx: ToolCallContext): Promise<ToolResult<T>>;
}

// ────────────────────────── Tool Registry ────────────────────────────────────

export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly executor: ToolExecutor<unknown>;
  readonly alwaysVisible: boolean;
}

export class ToolRegistry {
  private readonly tools: Map<string, RegisteredTool> = new Map();
  private readonly activeOverrides: Set<string> = new Set();
  private readonly disabled: Set<string> = new Set();

  register(
    definition: ToolDefinition,
    executor: ToolExecutor<unknown>,
    opts: { readonly alwaysVisible?: boolean | undefined } = {},
  ): void {
    const parsed = toolDefinitionSchema.parse(definition);
    if (this.tools.has(parsed.id)) {
      throw new ValidationError(`tool '${parsed.id}' is already registered`);
    }
    this.tools.set(parsed.id, {
      definition,
      executor,
      alwaysVisible: opts.alwaysVisible ?? false,
    });
  }

  get(toolId: string): RegisteredTool | null {
    return this.tools.get(toolId) ?? null;
  }

  require(toolId: string): RegisteredTool {
    const t = this.tools.get(toolId);
    if (!t) throw new NotFoundError("tool", toolId);
    return t;
  }

  list(): readonly RegisteredTool[] {
    return [...this.tools.values()];
  }

  listActive(): readonly RegisteredTool[] {
    const out: RegisteredTool[] = [];
    for (const t of this.tools.values()) {
      if (this.disabled.has(t.definition.id)) continue;
      if (t.alwaysVisible || this.activeOverrides.has(t.definition.id)) {
        out.push(t);
      }
    }
    return out;
  }

  activate(toolId: string): void {
    const t = this.tools.get(toolId);
    if (!t) throw new NotFoundError("tool", toolId);
    if (t.alwaysVisible) return;
    this.activeOverrides.add(toolId);
  }

  deactivate(toolId: string): void {
    const t = this.tools.get(toolId);
    if (!t) throw new NotFoundError("tool", toolId);
    if (t.alwaysVisible) {
      throw new ValidationError(
        `cannot deactivate always-visible tool '${toolId}'`,
      );
    }
    this.activeOverrides.delete(toolId);
  }

  disable(toolId: string): void {
    if (!this.tools.has(toolId)) throw new NotFoundError("tool", toolId);
    this.disabled.add(toolId);
  }

  enable(toolId: string): void {
    if (!this.tools.has(toolId)) throw new NotFoundError("tool", toolId);
    this.disabled.delete(toolId);
  }

  activeToolSetHash(): string {
    const ids = this.listActive().map((t) => `${t.definition.id}@${t.definition.version}`);
    ids.sort();
    return ids.join("|");
  }
}

// ────────────────────────── Progressive Disclosure (§11.2) ───────────────────

export interface CapabilityCard {
  readonly id: string;
  readonly version: string;
  readonly kind:
    | "tool_pack"
    | "skill"
    | "mcp_server"
    | "plugin"
    | "external_harness"
    | "environment";
  readonly name: string;
  readonly purpose: string;
  readonly effects: readonly string[];
  readonly trustLevel: ToolTrustLevel;
  readonly schemaCostTokens: number;
  readonly useWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly definitionHash: ContentHash;
}

export interface ProgressiveDisclosureDeps {
  readonly registry: ToolRegistry;
  readonly resolveCard: (capabilityId: string) => CapabilityCard | null;
}

export class ProgressiveDisclosure {
  private readonly cards: Map<string, CapabilityCard> = new Map();
  private readonly active: Set<string> = new Set();

  constructor(private readonly deps: ProgressiveDisclosureDeps) {}

  registerCard(card: CapabilityCard): void {
    this.cards.set(card.id, card);
  }

  removeCard(capabilityId: string): void {
    this.cards.delete(capabilityId);
    this.active.delete(capabilityId);
  }

  searchCards(query: string): readonly CapabilityCard[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [...this.cards.values()];
    const scored: { card: CapabilityCard; score: number }[] = [];
    for (const card of this.cards.values()) {
      const score = scoreCard(card, q);
      if (score > 0) scored.push({ card, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.card);
  }

  activate(capabilityId: string): CapabilityCard {
    const card =
      this.cards.get(capabilityId) ?? this.deps.resolveCard(capabilityId);
    if (!card) throw new NotFoundError("capability", capabilityId);
    this.cards.set(capabilityId, card);
    this.active.add(capabilityId);
    if (this.deps.registry.get(capabilityId)) {
      this.deps.registry.activate(capabilityId);
    }
    return card;
  }

  deactivate(capabilityId: string): void {
    const card = this.cards.get(capabilityId);
    if (!card) throw new NotFoundError("capability", capabilityId);
    this.active.delete(capabilityId);
    if (this.deps.registry.get(capabilityId)) {
      try {
        this.deps.registry.deactivate(capabilityId);
      } catch {
        // Ignore always-visible deactivation attempt
      }
    }
  }

  isActive(capabilityId: string): boolean {
    return this.active.has(capabilityId);
  }

  activeCards(): readonly CapabilityCard[] {
    const out: CapabilityCard[] = [];
    for (const id of this.active) {
      const c = this.cards.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  activeToolSet(): readonly RegisteredTool[] {
    return this.deps.registry.listActive();
  }
}

function scoreCard(card: CapabilityCard, q: string): number {
  let score = 0;
  if (card.name.toLowerCase().includes(q)) score += 3;
  if (card.purpose.toLowerCase().includes(q)) score += 2;
  for (const e of card.effects) {
    if (e.toLowerCase().includes(q)) score += 1;
  }
  for (const u of card.useWhen) {
    if (u.toLowerCase().includes(q)) score += 1;
  }
  return score;
}

// ────────────────────────── Default Tool Definitions (§34.2) ─────────────────

function definitionHash(s: string): ContentHash {
  return computeContentHash(s);
}

const READ_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string" },
    mode: {
      type: "string",
      enum: ["auto", "full", "outline", "range", "symbol", "dirty-region", "source-hash", "related-test", "diagnostic", "artifact", "metadata"],
    },
    ranges: { type: ["array", "null"], items: { type: "object", required: ["startLine", "endLine"] } },
    symbols: { type: ["array", "null"], items: { type: "string" } },
    maxBytes: { type: ["integer", "null"] },
    expectedVersion: { type: ["string", "null"] },
    includeRelated: { type: ["boolean", "null"] },
    continuation: { type: ["string", "null"] },
  },
});

const SEARCH_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 500 },
    mode: {
      type: "string",
      enum: ["auto", "path", "symbol", "text", "structural", "lsp", "call_hierarchy", "references"],
    },
    scope: { type: ["array", "null"], items: { type: "string" } },
    exclude: { type: ["array", "null"], items: { type: "string" } },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    continuation: { type: ["string", "null"] },
    includeSnippets: { type: "boolean" },
    diversityRerank: { type: "boolean" },
    sourceVersion: { type: ["string", "null"] },
  },
});

const PATCH_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: {
        type: "object",
        required: ["op", "path"],
        properties: {
          op: {
            type: "string",
            enum: [
              "replace_symbol",
              "range",
              "replace_hashline",
              "exact_text",
              "insert",
              "delete",
              "create_file",
              "move_file",
              "delete_file",
              "unified_diff",
            ],
          },
          path: { type: "string" },
          observed_hash: { type: ["string", "null"] },
          symbol: { type: ["string", "null"] },
          range: { type: ["object", "null"] },
          line_hashes: { type: ["array", "null"], items: { type: "string" } },
          old_text: { type: ["string", "null"] },
          new_text: { type: ["string", "null"] },
          destination: { type: ["string", "null"] },
          diff: { type: ["string", "null"] },
          mustNotExist: { type: ["boolean", "null"] },
        },
      },
    },
    dialect: {
      type: "string",
      enum: ["canonical", "search_replace", "hashline", "unified_diff", "ast"],
    },
    validation_profile: {
      type: "string",
      enum: ["none", "syntax_only", "syntax_format", "language_fast", "language_strict"],
    },
    commitMode: {
      type: "string",
      enum: ["apply_to_worktree", "stage_only", "preview_only"],
    },
    isolated_transaction: { type: "boolean" },
    allowTransientInvalidState: { type: "boolean" },
  },
});

const EXEC_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    argv: { type: ["array", "null"], minItems: 1, maxItems: 64, items: { type: "string" } },
    shell: { type: ["object", "null"] },
    cwd: { type: ["string", "null"] },
    env: { type: ["object", "null"], additionalProperties: { type: "string" } },
    timeout_ms: { type: "integer", minimum: 100, maximum: 600000 },
    stdin_artifact: { type: ["string", "null"] },
    redact_patterns: { type: ["array", "null"], items: { type: "string" } },
  },
});

const JOB_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op: {
      type: "string",
      enum: ["start", "read", "input", "signal", "stop", "status"],
    },
    job_id: { type: ["string", "null"] },
    argv: { type: ["array", "null"], items: { type: "string" } },
    cwd: { type: ["string", "null"] },
    env: { type: ["object", "null"], additionalProperties: { type: "string" } },
    cursor: { type: ["integer", "null"], minimum: 0 },
    input: { type: ["string", "null"] },
    signal: {
      type: ["string", "null"],
      enum: ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"],
    },
    restart_policy: { type: ["object", "null"] },
  },
});

const INSPECT_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op: {
      type: "string",
      enum: [
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
      ],
    },
    path: { type: ["string", "null"] },
    symbol: { type: ["string", "null"] },
    files: { type: ["array", "null"], items: { type: "string" } },
    newName: { type: ["string", "null"] },
    testSelector: { type: ["string", "null"] },
    functionName: { type: ["string", "null"] },
    failureArtifact: { type: ["string", "null"] },
  },
});

const CAPABILITY_INPUT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op: { type: "string", enum: ["list", "search", "describe", "activate", "deactivate", "status"] },
    capability_id: { type: ["string", "null"] },
    query: { type: ["string", "null"] },
    kind: {
      type: ["string", "null"],
      enum: ["skill", "tool_pack", "mcp_server", "plugin", "external_harness", "environment"],
    },
    configuration: { type: ["object", "null"] },
  },
});

const GENERIC_RESULT: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: {
      type: "string",
      enum: ["success", "partial", "error", "denied", "timeout", "cancelled", "unknown"],
    },
    summary: { type: "string", maxLength: 1000 },
  },
});

export const READ: ToolDefinition = Object.freeze({
  id: "read",
  version: "1.0.0",
  summary:
    "Read a file or artifact from the workspace. Small files return full content; large files return an outline plus relevant ranges with explicit elision markers. Never silently truncates.",
  useWhen: [
    "You need the content of a specific file or artifact.",
    "You need to inspect a symbol definition or its references.",
  ],
  doNotUseWhen: [
    "You do not yet know which file to read — use search first.",
    "The file is secret-classified and you have not requested authorization.",
  ],
  inputSchema: READ_INPUT,
  resultSchema: GENERIC_RESULT,
  sideEffectClass: "read",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 32_768,
  maximumArtifactBytes: 16 * 1024 * 1024,
  defaultTimeoutMs: 10_000,
  policyTags: ["read", "filesystem"],
  definitionHash: definitionHash("read@1.0.0"),
});

export const SEARCH: ToolDefinition = Object.freeze({
  id: "search",
  version: "1.0.0",
  summary:
    "Search the workspace for symbols, paths, or text. Composes lexical, structural, and LSP channels; reranks by intent, path proximity, freshness, authority, and graph centrality.",
  useWhen: [
    "You need to find where a symbol is defined or referenced.",
    "You need to locate files matching a query before reading them.",
  ],
  doNotUseWhen: [
    "You already know the exact path — use read directly.",
    "You need diagnostics for a known file — use inspect.",
  ],
  inputSchema: SEARCH_INPUT,
  resultSchema: GENERIC_RESULT,
  sideEffectClass: "read",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 32_768,
  maximumArtifactBytes: 1 * 1024 * 1024,
  defaultTimeoutMs: 15_000,
  policyTags: ["read", "search"],
  definitionHash: definitionHash("search@1.0.0"),
});

export const PATCH: ToolDefinition = Object.freeze({
  id: "patch",
  version: "1.0.0",
  summary:
    "Apply one or more edit operations atomically inside an isolated transaction. Each operation references an observed source hash; stale anchors are rejected.",
  useWhen: [
    "You have read the file and have its observed hash.",
    "You need to apply a multi-file refactor atomically.",
  ],
  doNotUseWhen: [
    "You have not yet read the target file at the current revision.",
    "The change is out of the allowed write scope — request a scope update instead.",
  ],
  inputSchema: PATCH_INPUT,
  resultSchema: GENERIC_RESULT,
  sideEffectClass: "workspace_write",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 16_384,
  maximumArtifactBytes: 4 * 1024 * 1024,
  defaultTimeoutMs: 60_000,
  policyTags: ["write", "filesystem", "transactional"],
  definitionHash: definitionHash("patch@1.0.0"),
});

export const EXEC: ToolDefinition = Object.freeze({
  id: "exec",
  version: "1.0.0",
  summary:
    "Run a short bounded command in the sandbox. The command AST (not a raw shell string) is classified by the policy engine before execution. Shell requires prompt unless explicitly allowlisted.",
  useWhen: [
    "You need to run a one-shot command (test, build, formatter) and capture its output.",
    "The command fits within the exec timeout (default 30s).",
  ],
  doNotUseWhen: [
    "The process is long-running (server, watcher) — use job instead.",
    "You need to interact with the process — use job instead.",
  ],
  inputSchema: EXEC_INPUT,
  resultSchema: GENERIC_RESULT,
  sideEffectClass: "process",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 32_768,
  maximumArtifactBytes: 16 * 1024 * 1024,
  defaultTimeoutMs: 30_000,
  policyTags: ["exec", "process", "sandboxed"],
  definitionHash: definitionHash("exec@1.0.0"),
});

export const JOB: ToolDefinition = Object.freeze({
  id: "job",
  version: "1.0.0",
  summary:
    "Manage a durable process. Operations: start, read, input, signal, stop, status. Long-running processes (servers, watchers, test runners that exceed exec timeout) use job instead of exec.",
  useWhen: [
    "You need to start a long-running process and read its output incrementally.",
    "You need to send input or signals to a running process.",
  ],
  doNotUseWhen: [
    "The command will finish within the exec timeout — use exec.",
    "You only need a one-shot result — use exec.",
  ],
  inputSchema: JOB_INPUT,
  resultSchema: GENERIC_RESULT,
  sideEffectClass: "durable_process",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 32_768,
  maximumArtifactBytes: 16 * 1024 * 1024,
  defaultTimeoutMs: 30_000,
  policyTags: ["exec", "process", "durable"],
  definitionHash: definitionHash("job@1.0.0"),
});

export const INSPECT: ToolDefinition = Object.freeze({
  id: "inspect",
  version: "1.0.0",
  summary:
    "High-level LSP/DAP operations (SPEC §11.8). Composes LSP calls and degrades gracefully when a server is unavailable.",
  useWhen: [
    "You need diagnostics for a file.",
    "You need to inspect a symbol, find references, or rename.",
    "You need to debug a test or trace a function.",
  ],
  doNotUseWhen: [
    "You just need the file content — use read.",
    "No LSP server is available for the language — fall back to search.",
  ],
  inputSchema: INSPECT_INPUT,
  resultSchema: GENERIC_RESULT,
  sideEffectClass: "read",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 32_768,
  maximumArtifactBytes: 4 * 1024 * 1024,
  defaultTimeoutMs: 30_000,
  policyTags: ["read", "lsp", "diagnostics"],
  definitionHash: definitionHash("inspect@1.0.0"),
});

export const CAPABILITY: ToolDefinition = Object.freeze({
  id: "capability",
  version: "1.0.0",
  summary:
    "List, activate, or deactivate capabilities (SPEC §11.2, §35). Progressive disclosure: capability cards are always visible; full schemas become visible on activation.",
  useWhen: [
    "You need a capability pack (web, GitHub, database, debugger) not in the default surface.",
    "You need to inspect or describe an available capability.",
  ],
  doNotUseWhen: [
    "The default 7-tool surface is sufficient for the task.",
    "You are mid-refactor and activating a pack would cause schema churn — wait for a coherent phase boundary.",
  ],
  inputSchema: CAPABILITY_INPUT,
  resultSchema: GENERIC_RESULT,
  sideEffectClass: "capability_activation",
  requiredCapabilities: [],
  trustLevel: "builtin",
  maximumModelResultBytes: 16_384,
  maximumArtifactBytes: 1 * 1024 * 1024,
  defaultTimeoutMs: 5_000,
  policyTags: ["capability", "activation"],
  definitionHash: definitionHash("capability@1.0.0"),
});

/** The 7 default always-visible tools (§34.2). */
export const DEFAULT_TOOLS: readonly ToolDefinition[] = Object.freeze([
  READ,
  SEARCH,
  PATCH,
  EXEC,
  JOB,
  INSPECT,
  CAPABILITY,
]);

export function registerDefaultTools(
  registry: ToolRegistry,
  executors: readonly ToolExecutor<unknown>[],
): void {
  const byId = new Map(executors.map((e) => [e.toolId, e] as const));
  for (const def of DEFAULT_TOOLS) {
    const ex = byId.get(def.id);
    if (!ex) {
      throw new ValidationError(`missing executor for default tool '${def.id}'`);
    }
    registry.register(def, ex, { alwaysVisible: true });
  }
}

// ────────────────────────── Fake Tool Executor (for tests) ───────────────────

export interface FakeToolExecutorScript {
  readonly matchArgs?: unknown | undefined;
  readonly result?: ToolResult<unknown> | undefined;
  readonly throw?: Error | undefined;
  readonly delayMs?: number | undefined;
}

export class FakeToolExecutor implements ToolExecutor<unknown> {
  readonly toolId: ToolId;
  readonly calls: { args: unknown; ctx: ToolCallContext }[] = [];
  private readonly scripts: FakeToolExecutorScript[] = [];
  private defaultResult: ToolResult<unknown> | null = null;

  constructor(toolId: ToolId) {
    this.toolId = toolId;
  }

  script(s: FakeToolExecutorScript): this {
    this.scripts.push(s);
    return this;
  }

  setDefault(result: ToolResult<unknown>): this {
    this.defaultResult = result;
    return this;
  }

  async execute(args: unknown, ctx: ToolCallContext): Promise<ToolResult<unknown>> {
    this.calls.push({ args, ctx });
    let chosen: FakeToolExecutorScript | null = null;
    for (let i = 0; i < this.scripts.length; i++) {
      const s = this.scripts[i]!;
      if (s.matchArgs === undefined || deepEqual(s.matchArgs, args)) {
        chosen = s;
        this.scripts.splice(i, 1);
        break;
      }
    }
    if (chosen === null) {
      if (this.defaultResult !== null) return this.defaultResult;
      return okResult<unknown>(args, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
        summary: `fake execution of '${this.toolId}'`,
      });
    }
    if (chosen.delayMs && chosen.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, chosen.delayMs));
    }
    if (chosen.throw) throw chosen.throw;
    if (chosen.result) return chosen.result;
    return okResult<unknown>(args, {
      toolCallId: ctx.toolCallId,
      traceId: ctx.traceId,
      summary: `fake execution of '${this.toolId}'`,
    });
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

export type {
  Uuid7,
  TraceId,
  ContentHash,
  Micros,
  ConfidentialityLabel,
};
