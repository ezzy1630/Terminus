/**
 * @terminus/public-api — HTTP API definitions and SSE event stream.
 *
 * Per SPEC §30, §32: Public product API served over HTTPS/loopback/UDS with
 * JSON request/response and SSE for ordered product events. Source of truth
 * for generated clients. Additive within a major version; explicit
 * deprecation windows.
 *
 * Resource groups (SPEC §32.1):
 *   /system /workspaces /sessions /threads /tasks /turns /events /context
 *   /artifacts /tools /jobs /approvals /agents /verification /memory
 *   /evals /configuration
 */
import { z } from "zod";

// ────────────────────────── Error envelope ─────────────────────────────────

export const ErrorCategory = z.enum([
  "validation",
  "not_found",
  "conflict",
  "permission",
  "policy_denied",
  "approval_required",
  "sandbox_unavailable",
  "resource_exhausted",
  "budget_exhausted",
  "timeout",
  "cancelled",
  "provider",
  "external_dependency",
  "integrity",
  "internal",
  "unknown_settlement",
]);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

export const TerminusError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  category: ErrorCategory,
  details: z.record(z.string(), z.unknown()).default({}),
  suggested_action: z.string().nullable().default(null),
  trace_id: z.string().nullable().default(null),
});
export type TerminusError = z.infer<typeof TerminusError>;

export const ErrorResponse = z.object({ error: TerminusError });

/** @deprecated Use `TerminusError`. Removed after the identity migration window. */
export const ForgeError = TerminusError;
/** @deprecated Use `TerminusError`. Removed after the identity migration window. */
export type ForgeError = TerminusError;
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ────────────────────────── Initialization handshake ───────────────────────

export const ClientHello = z.object({
  client: z.object({
    name: z.string(),
    version: z.string(),
    instance_id: z.string(),
  }),
  protocol: z.object({ major: z.number().int(), minor: z.number().int() }),
  capabilities: z
    .object({
      sse_resume: z.boolean().default(false),
      rich_approvals: z.boolean().default(false),
      artifact_streaming: z.boolean().default(false),
      acp_bridge: z.boolean().default(false),
    })
    .passthrough(),
});
export type ClientHello = z.infer<typeof ClientHello>;

export const ServerHello = z.object({
  server: z.object({
    version: z.string(),
    build_commit: z.string(),
    instance_id: z.string(),
  }),
  protocol: z.object({ major: z.number().int(), minor: z.number().int() }),
  capabilities: z.object({
    supported: z.array(z.string()),
    experimental: z.array(z.string()).default([]),
  }),
  limits: z.object({
    max_request_bytes: z.number().int(),
    max_sse_backlog: z.number().int(),
  }),
});
export type ServerHello = z.infer<typeof ServerHello>;

// ────────────────────────── Resource snapshots ─────────────────────────────

export const WorkspaceSnapshot = z.object({
  id: z.string(),
  kind: z.enum(["local_git", "local_directory", "container", "microvm", "remote"]),
  root_uri: z.string(),
  canonical_root: z.string(),
  trust: z.enum(["trusted", "untrusted", "restricted"]),
  policy_profile_id: z.string(),
  created_at: z.string(),
  last_opened_at: z.string(),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;

export const SessionSnapshot = z.object({
  id: z.string(),
  workspace_id: z.string(),
  owner_principal: z.string(),
  title: z.string(),
  status: z.enum(["active", "paused", "archived", "deleted"]),
  default_model_profile: z.string(),
  default_permission_profile: z.string(),
  active_thread_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const TaskSnapshot = z.object({
  id: z.string(),
  session_id: z.string(),
  thread_id: z.string(),
  status: z.string(),
  phase: z.string(),
  active_contract_version: z.number().int(),
  risk_class: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  terminal_reason: z.record(z.string(), z.unknown()).nullable(),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshot>;

export const TurnSnapshot = z.object({
  id: z.string(),
  thread_id: z.string(),
  task_id: z.string().nullable(),
  sequence: z.number().int(),
  state: z.string(),
  initiating_actor: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type TurnSnapshot = z.infer<typeof TurnSnapshot>;

export const ToolCallSnapshot = z.object({
  id: z.string(),
  turn_id: z.string(),
  tool_id: z.string(),
  tool_version: z.string(),
  state: z.string(),
  result_status: z.string().nullable(),
  proposed_at: z.string(),
  settled_at: z.string().nullable(),
});
export type ToolCallSnapshot = z.infer<typeof ToolCallSnapshot>;

export const ContextManifestSnapshot = z.object({
  id: z.string(),
  provider_attempt_id: z.string().nullable(),
  compiler_version: z.string(),
  policy_version: z.string(),
  epoch_id: z.string().nullable(),
  provider_key: z.string(),
  model_key: z.string(),
  rendered_request_hash: z.string(),
  estimated_tokens: z.record(z.string(), z.number().int()),
  created_at: z.string(),
});
export type ContextManifestSnapshot = z.infer<typeof ContextManifestSnapshot>;

export const ArtifactSnapshot = z.object({
  hash: z.string(),
  size_bytes: z.number().int(),
  media_type: z.string(),
  content_encoding: z.enum(["identity", "zstd"]),
  confidentiality: z.string(),
  trust: z.string(),
  retention_class: z.string(),
  created_at: z.string(),
});
export type ArtifactSnapshot = z.infer<typeof ArtifactSnapshot>;

const Rfc3339Wire = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)),
  { message: "must be an RFC 3339 timestamp" },
);

export const ApprovalBindingV1 = z.object({
  version: z.literal(1),
  task_id: z.string().min(1),
  task_contract_version: z.number().int().nonnegative(),
  user_intent_ref: z.string().min(1),
  policy_version: z.string().min(1),
  effect_kind: z.string().min(1),
  exact_action: z.string().min(1),
  resources: z.array(z.string().min(1)).max(256),
  destinations: z.array(z.string().min(1)).max(256),
  source_versions: z.record(z.string().min(1), z.string().min(1)),
  secret_scope: z.array(z.string().min(1)).max(64),
  risk: z.object({
    class: z.enum(["low", "normal", "high", "critical"]),
    effects: z.array(z.string().min(1)).max(64),
  }).strict(),
  taint: z.object({
    influenced_by_untrusted_content: z.boolean(),
    warning: z.string().min(1).nullable(),
  }).strict(),
  expires_at: Rfc3339Wire.nullable(),
  use_limit: z.number().int().positive(),
}).strict();
export type ApprovalBindingV1 = z.infer<typeof ApprovalBindingV1>;

export const ApprovalDisplay = z.object({
  summary: z.string().min(1),
  exact_action: z.string().min(1),
  reason: z.string().min(1),
  reversibility: z.string().min(1).nullable(),
  environment: z.string().min(1).nullable(),
}).strict();
export type ApprovalDisplay = z.infer<typeof ApprovalDisplay>;

/** Durable server-authored envelope. Only `binding` participates in the hash. */
export const ApprovalOperationV1 = z.object({
  binding: ApprovalBindingV1,
  display: ApprovalDisplay,
}).strict();
export type ApprovalOperationV1 = z.infer<typeof ApprovalOperationV1>;

function sortApprovalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortApprovalJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sortApprovalJson(record[key])]),
    );
  }
  return value;
}

/** Canonical hash input shared by policy brokers and approval consumers. */
export function canonicalApprovalBinding(value: ApprovalBindingV1): string {
  const binding = ApprovalBindingV1.parse(value);
  return JSON.stringify(sortApprovalJson({
    ...binding,
    resources: [...binding.resources].sort(),
    destinations: [...binding.destinations].sort(),
    secret_scope: [...binding.secret_scope].sort(),
    risk: { ...binding.risk, effects: [...binding.risk.effects].sort() },
  }));
}

export const ApprovalSnapshot = z.object({
  id: z.string(),
  task_id: z.string(),
  operation_hash: z.string(),
  binding: ApprovalBindingV1.nullable(),
  display: ApprovalDisplay.nullable(),
  status: z.enum(["pending", "allowed", "denied", "expired", "revoked"]),
  decision: z.enum([
    "allow_once",
    "allow_for_action",
    "allow_for_task",
    "deny_once",
    "deny_and_add_task_rule",
    "stop_task",
  ]).nullable(),
  supported_decisions: z.array(z.enum([
    "allow_once",
    "allow_for_action",
    "allow_for_task",
    "deny_once",
    "deny_and_add_task_rule",
    "stop_task",
  ])),
  risk: z.string(),
  scope: z.array(z.string()),
  use_limit: z.number().int().positive(),
  use_count: z.number().int().nonnegative(),
  expires_at: z.string().nullable(),
  requested_at: z.string(),
  resolved_at: z.string().nullable(),
  rationale: z.string().nullable(),
});
export type ApprovalSnapshot = z.infer<typeof ApprovalSnapshot>;

// ────────────────────────── API endpoints ──────────────────────────────────

export interface ApiEndpoint<Req, Res> {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly request: z.ZodType<Req>;
  readonly response: z.ZodType<Res>;
}

// /system
export const SystemHealth = {
  method: "GET" as const,
  path: "/v1/system/health",
  request: z.void(),
  response: z.object({
    status: z.enum(["ok", "degraded", "down"]),
    version: z.string(),
    build_commit: z.string(),
    instance_id: z.string(),
    uptime_seconds: z.number().int(),
    ready: z.boolean(),
  }),
};

// /workspaces
export const OpenWorkspace = {
  method: "POST" as const,
  path: "/v1/workspaces/open",
  request: z.object({
    root_uri: z.string(),
    kind: z.enum(["local_git", "local_directory", "container", "microvm", "remote"]).default("local_directory"),
    trust: z.enum(["trusted", "untrusted", "restricted"]).default("trusted"),
    policy_profile_id: z.string().default("secure-local-default"),
  }),
  response: WorkspaceSnapshot,
};

export const GetWorkspace = {
  method: "GET" as const,
  path: "/v1/workspaces/{id}",
  request: z.object({ id: z.string() }),
  response: WorkspaceSnapshot,
};

// /sessions
export const CreateSession = {
  method: "POST" as const,
  path: "/v1/sessions",
  request: z.object({
    workspace_id: z.string(),
    title: z.string(),
    default_model_profile: z.string().default("implementer"),
    default_permission_profile: z.string().default("secure-local-default"),
  }),
  response: SessionSnapshot,
};

export const GetSession = {
  method: "GET" as const,
  path: "/v1/sessions/{id}",
  request: z.object({ id: z.string() }),
  response: SessionSnapshot,
};

// /threads
export const CreateThread = {
  method: "POST" as const,
  path: "/v1/threads",
  request: z.object({
    session_id: z.string(),
    parent_thread_id: z.string().nullable().default(null),
  }),
  response: z.object({ id: z.string(), session_id: z.string(), created_at: z.string() }),
};

// /tasks
export const CreateTask = {
  method: "POST" as const,
  path: "/v1/tasks",
  request: z.object({
    session_id: z.string(),
    thread_id: z.string(),
    objective: z.string(),
    non_goals: z.array(z.string()).default([]),
    acceptance_criteria: z
      .array(
        z.object({
          id: z.string(),
          statement: z.string(),
          verification_hint: z.string().nullable().default(null),
          required: z.boolean().default(true),
        }),
      )
      .default([]),
    allowed_scope: z
      .object({
        read_paths: z.array(z.string()).default([]),
        write_paths: z.array(z.string()).default([]),
        external_systems: z.array(z.string()).default([]),
      })
      .default({ read_paths: [], write_paths: [], external_systems: [] }),
    risk_class: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  }),
  response: TaskSnapshot,
};

export const StartTask = {
  method: "POST" as const,
  path: "/v1/tasks/{id}/start",
  request: z.object({ id: z.string() }),
  response: z.object({
    task_id: z.string(),
    status: z.string(),
    event_cursor: z.string(),
    links: z.object({
      events: z.string(),
      task: z.string(),
    }),
  }),
};

export const CancelTask = {
  method: "POST" as const,
  path: "/v1/tasks/{id}/cancel",
  request: z.object({ id: z.string(), reason: z.string().nullable().default(null) }),
  response: TaskSnapshot,
};

// /turns
export const StartTurn = {
  method: "POST" as const,
  path: "/v1/turns",
  request: z.object({
    thread_id: z.string(),
    task_id: z.string(),
    user_input: z.string(),
  }),
  response: TurnSnapshot,
};

export const InterruptTurn = {
  method: "POST" as const,
  path: "/v1/turns/{id}/interrupt",
  request: z.object({ id: z.string() }),
  response: TurnSnapshot,
};

// /events (SSE)
export const SubscribeEvents = {
  method: "GET" as const,
  path: "/v1/events",
  request: z.object({
    cursor: z.string().nullable().default(null),
    task_id: z.string().nullable().default(null),
    session_id: z.string().nullable().default(null),
  }),
  response: z.never(), // SSE stream
};

// /context
export const GetContextManifest = {
  method: "GET" as const,
  path: "/v1/context/manifests/{id}",
  request: z.object({ id: z.string() }),
  response: ContextManifestSnapshot,
};

// /artifacts
export const GetArtifact = {
  method: "GET" as const,
  path: "/v1/artifacts/{hash}",
  request: z.object({ hash: z.string(), task_id: z.string().min(1) }),
  response: z.instanceof(Uint8Array as never as ArrayBufferConstructor),
};

// /approvals
/**
 * Approval decision enum. Per SPEC §32.4, the canonical names are
 * `allow_for_action` / `allow_for_task` (matching `@terminus/domain`'s
 * `ApprovalDecision`). For backwards compatibility with older clients, the
 * aliases `allow_exact` / `allow_task_scope` are also accepted and are
 * normalized to the canonical names via a zod transform.
 */
export const ApprovalDecisionParam = z
  .enum([
    "allow_once",
    "allow_for_action",
    "allow_for_task",
    "allow_exact",
    "allow_task_scope",
    "deny_once",
    "deny_and_add_task_rule",
    "deny_and_rule",
    "stop_task",
  ])
  .transform((v): "allow_once" | "allow_for_action" | "allow_for_task" | "deny_once" | "deny_and_add_task_rule" | "stop_task" => {
    switch (v) {
      case "allow_exact":
        return "allow_for_action";
      case "allow_task_scope":
        return "allow_for_task";
      case "deny_and_rule":
        return "deny_and_add_task_rule";
      case "allow_once":
      case "allow_for_action":
      case "allow_for_task":
      case "deny_once":
      case "deny_and_add_task_rule":
      case "stop_task":
        return v;
      default: {
        const _exhaustive: never = v;
        void _exhaustive;
        return v;
      }
    }
  });
export type ApprovalDecisionParam = z.infer<typeof ApprovalDecisionParam>;

export const ResolveApproval = {
  method: "POST" as const,
  path: "/v1/approvals/{id}/resolve",
  request: z.object({
    id: z.string(),
    operation_hash: z.string().min(1),
    decision: ApprovalDecisionParam,
    rationale: z.string().nullable().default(null),
  }),
  response: ApprovalSnapshot,
};

// /jobs
export const GetJob = {
  method: "GET" as const,
  path: "/v1/jobs/{id}",
  request: z.object({ id: z.string() }),
  response: z.object({
    id: z.string(),
    state: z.string(),
    started_at: z.string().nullable(),
    settled_at: z.string().nullable(),
    output_cursor: z.number().int(),
  }),
};

export const StopJob = {
  method: "POST" as const,
  path: "/v1/jobs/{id}/stop",
  request: z.object({ id: z.string(), reason: z.string().nullable().default(null) }),
  response: z.object({ id: z.string(), state: z.string() }),
};

// /verification
export const GetVerificationPlan = {
  method: "GET" as const,
  path: "/v1/verification/plans/{id}",
  request: z.object({ id: z.string() }),
  response: z.object({
    id: z.string(),
    task_id: z.string(),
    contract_version: z.number().int(),
    source_revision: z.string(),
    completion_expression: z.string(),
    nodes: z
      .array(
        z.object({
          id: z.string(),
          kind: z.string(),
          required: z.boolean(),
          depends_on: z.array(z.string()),
        }),
      )
      .default([]),
  }),
};

// ────────────────────────── Additional resource groups (§32.1) ───────────────
// /tools /agents /memory /evals /configuration /policies — list endpoints.

// /tools — list registered tools (capability registry).
export const ToolSnapshot = z.object({
  id: z.string(),
  version: z.string(),
  trust_level: z.enum(["builtin", "first_party", "verified_third_party", "untrusted"]),
  summary: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  deprecated: z.boolean().default(false),
});
export type ToolSnapshot = z.infer<typeof ToolSnapshot>;

export const ListTools = {
  method: "GET" as const,
  path: "/v1/tools",
  request: z.object({
    trust_level: z.enum(["builtin", "first_party", "verified_third_party", "untrusted"]).nullable().default(null),
    include_deprecated: z.boolean().default(false),
  }),
  response: z.object({
    tools: z.array(ToolSnapshot).default([]),
    next_cursor: z.string().nullable().default(null),
  }),
};

// /agents — list registered agents / harnesses.
export const AgentSnapshot = z.object({
  id: z.string(),
  display_name: z.string(),
  kind: z.enum(["implementer", "scout", "reviewer", "specialist"]),
  model_profile: z.string(),
  trust_level: z.enum(["builtin", "first_party", "verified_third_party", "untrusted"]),
  enabled: z.boolean().default(true),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshot>;

export const ListAgents = {
  method: "GET" as const,
  path: "/v1/agents",
  request: z.object({
    enabled_only: z.boolean().default(true),
  }),
  response: z.object({
    agents: z.array(AgentSnapshot).default([]),
  }),
};

// /memory — list memory claims.
export const MemoryClaimSnapshot = z.object({
  id: z.string(),
  kind: z.enum([
    "fact",
    "convention",
    "preference",
    "pitfall",
    "command",
    "architecture",
    "procedure",
    "failure_resolution",
  ]),
  statement: z.string(),
  status: z.enum(["candidate", "active", "disputed", "expired", "rejected"]),
  confidence_ppm: z.number().int().min(0).max(1_000_000),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});
export type MemoryClaimSnapshot = z.infer<typeof MemoryClaimSnapshot>;

export const ListMemory = {
  method: "GET" as const,
  path: "/v1/memory",
  request: z.object({
    status: z
      .enum(["candidate", "active", "disputed", "expired", "rejected"])
      .nullable()
      .default(null),
    kind: z
      .enum([
        "fact",
        "convention",
        "preference",
        "pitfall",
        "command",
        "architecture",
        "procedure",
        "failure_resolution",
      ])
      .nullable()
      .default(null),
  }),
  response: z.object({
    claims: z.array(MemoryClaimSnapshot).default([]),
    next_cursor: z.string().nullable().default(null),
  }),
};

// /evals — list eval runs.
export const EvalRunSnapshot = z.object({
  run_id: z.string(),
  suite: z.string(),
  task: z.string(),
  harness: z.string(),
  harness_commit: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  outcome: z.enum(["pass", "fail", "error", "missing"]),
});
export type EvalRunSnapshot = z.infer<typeof EvalRunSnapshot>;

export const ListEvals = {
  method: "GET" as const,
  path: "/v1/evals",
  request: z.object({
    suite: z.string().nullable().default(null),
    harness: z.string().nullable().default(null),
    since: z.string().nullable().default(null),
  }),
  response: z.object({
    runs: z.array(EvalRunSnapshot).default([]),
    next_cursor: z.string().nullable().default(null),
  }),
};

// /configuration — list configuration profiles.
export const ConfigurationSnapshot = z.object({
  id: z.string(),
  kind: z.enum(["model_profile", "permission_profile", "policy_profile", "runtime_profile"]),
  display_name: z.string(),
  summary: z.string(),
  enabled: z.boolean().default(true),
  mutable: z.boolean().default(false),
});
export type ConfigurationSnapshot = z.infer<typeof ConfigurationSnapshot>;

export const ListConfiguration = {
  method: "GET" as const,
  path: "/v1/configuration",
  request: z.object({
    kind: z
      .enum(["model_profile", "permission_profile", "policy_profile", "runtime_profile"])
      .nullable()
      .default(null),
  }),
  response: z.object({
    configurations: z.array(ConfigurationSnapshot).default([]),
  }),
};

// /policies — list policy rules.
export const PolicySnapshot = z.object({
  id: z.string(),
  profile_id: z.string(),
  kind: z.enum(["allow", "deny", "prompt", "rate_limit"]),
  effect_type: z.string(),
  selector: z.string(),
  rationale: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type PolicySnapshot = z.infer<typeof PolicySnapshot>;

export const ListPolicies = {
  method: "GET" as const,
  path: "/v1/policies",
  request: z.object({
    profile_id: z.string().nullable().default(null),
    enabled_only: z.boolean().default(true),
  }),
  response: z.object({
    policies: z.array(PolicySnapshot).default([]),
  }),
};

// ────────────────────────── Endpoint registry ──────────────────────────────

export const ENDPOINTS = {
  SystemHealth,
  OpenWorkspace,
  GetWorkspace,
  CreateSession,
  GetSession,
  CreateThread,
  CreateTask,
  StartTask,
  CancelTask,
  StartTurn,
  InterruptTurn,
  SubscribeEvents,
  GetContextManifest,
  GetArtifact,
  ResolveApproval,
  GetJob,
  StopJob,
  GetVerificationPlan,
  ListTools,
  ListAgents,
  ListMemory,
  ListEvals,
  ListConfiguration,
  ListPolicies,
} as const;

export type EndpointName = keyof typeof ENDPOINTS;

// ────────────────────────── SSE event stream ───────────────────────────────

export interface SseEvent {
  id: string;
  event: string;
  data: string;
  retry?: number;
}

export function encodeSseEvent(ev: SseEvent): string {
  const lines: string[] = [];
  if (ev.id) lines.push(`id: ${ev.id}`);
  if (ev.event) lines.push(`event: ${ev.event}`);
  if (typeof ev.retry === "number") lines.push(`retry: ${ev.retry}`);
  // Data may contain newlines — split and prefix each.
  for (const line of ev.data.split("\n")) lines.push(`data: ${line}`);
  return lines.join("\n") + "\n\n";
}

export type SseDecoderLimitKind = "frame" | "buffer";

export class SseDecoderLimitError extends Error {
  readonly kind: SseDecoderLimitKind;
  readonly limitBytes: number;
  readonly observedBytes: number;

  constructor(kind: SseDecoderLimitKind, limitBytes: number, observedBytes: number) {
    super(`SSE ${kind} exceeded the ${limitBytes}-byte limit (observed ${observedBytes} bytes)`);
    this.name = "SseDecoderLimitError";
    this.kind = kind;
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
  }
}

export class SseDecoderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseDecoderProtocolError";
  }
}

export interface SseDecoderOptions {
  maxFrameBytes?: number;
  maxBufferBytes?: number;
}

export interface SseDecoder {
  /** Feed raw bytes; returns completed events. */
  feed(chunk: string): SseEvent[];
  /** Signal stream EOF; rejects an unterminated frame explicitly. */
  finish(): void;
}

export const DEFAULT_SSE_MAX_FRAME_BYTES = 1 * 1024 * 1024;
export const DEFAULT_SSE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export function createSseDecoder(options: SseDecoderOptions = {}): SseDecoder {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_SSE_MAX_FRAME_BYTES;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_SSE_MAX_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError("maxFrameBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < maxFrameBytes) {
    throw new RangeError("maxBufferBytes must be a safe integer at least maxFrameBytes");
  }

  let buffer = "";
  let bufferBytes = 0;
  let pendingId = "";
  let pendingEvent = "";
  let pendingData: string[] = [];
  const encoder = new TextEncoder();
  return {
    feed(chunk) {
      const chunkBytes = encoder.encode(chunk).byteLength;
      if (chunkBytes > maxBufferBytes || bufferBytes + chunkBytes > maxBufferBytes) {
        throw new SseDecoderLimitError("buffer", maxBufferBytes, bufferBytes + chunkBytes);
      }
      buffer += chunk;
      bufferBytes += chunkBytes;
      const out: SseEvent[] = [];
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx < 0) break;
        const block = buffer.slice(0, idx);
        const consumedBytes = encoder.encode(buffer.slice(0, idx + 2)).byteLength;
        const frameBytes = encoder.encode(block).byteLength;
        if (frameBytes > maxFrameBytes) {
          throw new SseDecoderLimitError("frame", maxFrameBytes, frameBytes);
        }
        buffer = buffer.slice(idx + 2);
        bufferBytes -= consumedBytes;
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) pendingId = line.slice(3).trim();
          else if (line.startsWith("event:")) pendingEvent = line.slice(6).trim();
          else if (line.startsWith("data:")) pendingData.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("retry:")) {
            // ignore for now
          } else if (line === "") {
            // dispatch
          }
        }
        if (pendingData.length > 0) {
          out.push({
            id: pendingId,
            event: pendingEvent || "message",
            data: pendingData.join("\n"),
          });
        }
        pendingId = "";
        pendingEvent = "";
        pendingData = [];
      }
      return out;
    },
    finish() {
      if (buffer.length > 0 || pendingId.length > 0 || pendingEvent.length > 0 || pendingData.length > 0) {
        throw new SseDecoderProtocolError("SSE stream ended with an unterminated frame");
      }
    },
  };
}

// ────────────────────────── Idempotency ────────────────────────────────────

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

export function requireIdempotency(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

// ────────────────────────── ARP v2 Exports ───────────────────────────────────

export * from "./v2_endpoints.js";
export * from "./idempotency.js";
export * from "./gateway.js";
