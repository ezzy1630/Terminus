/**
 * External Codex App Server lane.
 *
 * This is deliberately not a provider renderer. The Codex process owns its
 * model, tools, approvals, sandbox, and thread state. Terminus only starts
 * and observes that process through the kernel JobService and projects the
 * bounded, non-secret protocol surface to its callers.
 */
import { randomUUID } from "node:crypto";
import type { Observable, Subscription } from "rxjs";
import type {
  JobEvent,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { KernelUdsClients } from "./kernel-uds.js";

export const CODEX_EXTERNAL_HARNESS = "codex" as const;
export const CODEX_APP_SERVER_PROTOCOL = "codex-app-server.v2" as const;
/** JobService has a hard background ceiling; sessions must also state it. */
export const CODEX_APP_SERVER_MAX_LIFETIME_SECONDS = 30 * 60;
/** Every App Server request has its own finite response budget. */
export const CODEX_APP_SERVER_RPC_TIMEOUT_MS = 30_000;

const MAX_PROTOCOL_BYTES = 8 * 1_024 * 1_024;
const MAX_LINE_BYTES = 1 * 1_024 * 1_024;
const MAX_SANITIZED_STRING = 64 * 1_024;
const MAX_SANITIZED_KEYS = 128;
const MAX_SANITIZED_ARRAY = 128;
const MAX_SANITIZED_DEPTH = 8;
const CODEX_PUBLIC_ENV_ALLOWLIST = new Set(["TERM", "LANG", "LC_ALL", "COLORTERM"]);

const ALLOWED_REQUESTS = new Set([
  "account/read",
  "account/rateLimits/read",
  "model/list",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
]);

type KernelJobs = Pick<KernelUdsClients, "jobs">;

export type CodexAppServerState =
  | "not_started"
  | "starting"
  | "ready"
  | "running"
  | "exited"
  | "expired"
  | "unknown_settlement"
  | "stopped";

export type CodexAppServerFailureCode =
  | "CODEX_APP_SERVER_UNAVAILABLE"
  | "CODEX_APP_SERVER_EXITED"
  | "CODEX_APP_SERVER_EXPIRED"
  | "CODEX_APP_SERVER_UNKNOWN_SETTLEMENT"
  | "CODEX_APP_SERVER_OUTPUT_LIMIT"
  | "CODEX_APP_SERVER_PROTOCOL_ERROR"
  | "CODEX_APP_SERVER_METHOD_UNSUPPORTED";

export class CodexAppServerError extends Error {
  readonly code: CodexAppServerFailureCode;

  constructor(code: CodexAppServerFailureCode, message: string) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

export interface CodexAppServerStatus {
  readonly available: boolean;
  readonly state: CodexAppServerState;
  readonly external_harness: typeof CODEX_EXTERNAL_HARNESS;
  readonly protocol: typeof CODEX_APP_SERVER_PROTOCOL;
  readonly executable: "codex";
  readonly job_id: string | null;
  readonly reason: string | null;
}

export interface CodexAppServerModel {
  readonly id: string;
  readonly model: string | null;
  readonly display_name: string | null;
  readonly reasoning_efforts: readonly string[];
  readonly default_reasoning_effort: string | null;
  readonly hidden: boolean;
}

export interface CodexAppServerAccount {
  readonly type: string | null;
  readonly email: string | null;
  readonly plan_type: string | null;
  readonly requires_openai_auth: boolean;
}

export interface CodexAppServerEvent {
  readonly external_harness: typeof CODEX_EXTERNAL_HARNESS;
  readonly job_id: string;
  readonly sequence: number;
  readonly message: Record<string, unknown>;
}

export interface CodexAppServerSessionOptions {
  readonly clients: KernelJobs;
  readonly context: RequestContext | (() => Promise<RequestContext>);
  readonly workspace_id: string;
  readonly public_env: Readonly<Record<string, string>>;
  /** A lease recovered from Session.metadataJson after a control restart. */
  readonly persisted_lease?: {
    readonly job_id: string | null;
    readonly state: string;
  };
  /** Persist the lease before launch and after every settlement transition. */
  readonly on_lease?: (lease: CodexAppServerLease) => Promise<void>;
  /** Test-only shortening, still hard-capped by the production RPC budget. */
  readonly rpc_timeout_ms?: number;
  readonly on_event?: (event: CodexAppServerEvent) => void;
  /** Handle Codex approval/input requests. Returning null denies the request. */
  readonly on_server_request?: (
    request: Record<string, unknown>,
  ) => Promise<unknown | null>;
}

export interface CodexAppServerLease {
  readonly job_id: string | null;
  readonly state: "starting" | "running" | "exited" | "unknown_settlement" | "stopped";
}

export interface CodexAppServerStartThreadInput {
  readonly cwd?: string;
  readonly model?: string;
  readonly sandbox?: string;
  readonly approval_policy?: string;
  readonly base_instructions?: string;
}

export interface CodexAppServerTurnInput {
  readonly thread_id: string;
  readonly text: string;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  readonly approval_policy?: string;
  readonly sandbox_policy?: Record<string, unknown>;
}

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface JsonRpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

class CodexRpcTimeoutError extends Error {
  constructor(operation: string) {
    super(`Codex App Server ${operation} RPC timed out`);
    this.name = "CodexRpcTimeoutError";
  }
}

/**
 * One process-backed App Server connection. Keep this object alive across
 * turns so Codex can retain its own durable thread and turn state.
 */
export class CodexAppServerSession {
  private readonly options: CodexAppServerSessionOptions;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly decoder = new TextDecoder();
  private subscription: Subscription | null = null;
  private jobId: string | null = null;
  private processId: string | null = null;
  private state: CodexAppServerState = "not_started";
  private nextRequestId = 1;
  private inputBuffer = "";
  private protocolBytes = 0;
  private opened: Promise<void> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rpcTimeoutMs: number;

  constructor(options: CodexAppServerSessionOptions) {
    if (options.workspace_id.length === 0) {
      throw new Error("Codex App Server requires a concrete workspace id");
    }
    for (const [name, value] of Object.entries(options.public_env)) {
      if (!CODEX_PUBLIC_ENV_ALLOWLIST.has(name)) {
        throw new Error(`Codex App Server public environment is not allowlisted: ${name}`);
      }
      if (/[\0\r\n]/.test(value)) {
        throw new Error(`Codex App Server public environment contains a control delimiter: ${name}`);
      }
    }
    if (options.rpc_timeout_ms !== undefined
      && (!Number.isInteger(options.rpc_timeout_ms)
        || options.rpc_timeout_ms <= 0
        || options.rpc_timeout_ms > CODEX_APP_SERVER_RPC_TIMEOUT_MS)) {
      throw new Error(`Codex App Server RPC timeout must be an integer in 1..${CODEX_APP_SERVER_RPC_TIMEOUT_MS} ms`);
    }
    this.options = options;
    this.rpcTimeoutMs = options.rpc_timeout_ms ?? CODEX_APP_SERVER_RPC_TIMEOUT_MS;
    if (options.persisted_lease?.state === "starting" && options.persisted_lease.job_id === null) {
      // A control restart during the launch window cannot prove whether the
      // kernel created a process. Refuse a second launch until reconciliation.
      this.state = "unknown_settlement";
    }
    if (options.persisted_lease?.job_id !== null
      && options.persisted_lease?.job_id !== undefined
      && (options.persisted_lease.state === "running" || options.persisted_lease.state === "unknown_settlement")) {
      this.jobId = options.persisted_lease.job_id;
      if (options.persisted_lease.state === "unknown_settlement") this.state = "unknown_settlement";
    }
  }

  status(): CodexAppServerStatus {
    return {
      available: this.state === "ready" || this.state === "running",
      state: this.state,
      external_harness: CODEX_EXTERNAL_HARNESS,
      protocol: CODEX_APP_SERVER_PROTOCOL,
      executable: "codex",
      job_id: this.jobId,
      reason: this.state === "unknown_settlement"
        ? "Codex App Server job settlement is unknown; reconcile before retrying"
        : this.state === "expired"
          ? "Codex App Server session lifetime expired; reconnect and resume the thread"
        : this.state === "exited"
          ? "Codex App Server exited; start a new external session"
          : null,
    };
  }

  async open(): Promise<void> {
    if (this.opened !== null) return this.opened;
    this.opened = this.startAndInitialize();
    try {
      await this.opened;
    } catch (error: unknown) {
      this.opened = null;
      throw error;
    }
  }

  async account(): Promise<CodexAppServerAccount> {
    await this.open();
    const response = await this.request("account/read", { refreshToken: false });
    const record = asRecord(response);
    const account = asRecord(record?.account);
    return {
      type: stringOrNull(account?.type),
      email: stringOrNull(account?.email),
      plan_type: stringOrNull(account?.planType),
      requires_openai_auth: record?.requiresOpenaiAuth === true,
    };
  }

  async models(): Promise<readonly CodexAppServerModel[]> {
    await this.open();
    const response = await this.request("model/list", { includeHidden: false });
    const data = asRecord(response)?.data;
    if (!Array.isArray(data)) return [];
    return data.flatMap((value) => {
      const model = asRecord(value);
      const id = stringOrNull(model?.id);
      if (id === null) return [];
      return [{
        id,
        model: stringOrNull(model?.model),
        display_name: stringOrNull(model?.displayName),
        reasoning_efforts: stringArray(model?.supportedReasoningEfforts),
        default_reasoning_effort: stringOrNull(model?.defaultReasoningEffort),
        hidden: model?.hidden === true,
      }];
    });
  }

  async startThread(input: CodexAppServerStartThreadInput = {}): Promise<{
    readonly thread_id: string;
    readonly external_harness: typeof CODEX_EXTERNAL_HARNESS;
  }> {
    await this.open();
    const response = await this.request("thread/start", {
      cwd: input.cwd ?? null,
      model: input.model ?? null,
      sandbox: input.sandbox ?? null,
      approvalPolicy: input.approval_policy ?? null,
      baseInstructions: input.base_instructions ?? null,
      ephemeral: false,
      threadSource: "terminus_external",
    });
    return {
      thread_id: requireNestedString(response, "thread", "id", "thread/start"),
      external_harness: CODEX_EXTERNAL_HARNESS,
    };
  }

  async resumeThread(threadId: string): Promise<{ readonly thread_id: string; readonly external_harness: typeof CODEX_EXTERNAL_HARNESS }> {
    if (!isSafeId(threadId)) throw new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "thread id is invalid");
    await this.open();
    const response = await this.request("thread/resume", { threadId });
    return {
      thread_id: requireNestedString(response, "thread", "id", "thread/resume"),
      external_harness: CODEX_EXTERNAL_HARNESS,
    };
  }

  async startTurn(input: CodexAppServerTurnInput): Promise<{ readonly thread_id: string; readonly turn_id: string; readonly external_harness: typeof CODEX_EXTERNAL_HARNESS }> {
    if (!isSafeId(input.thread_id)) throw new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "thread id is invalid");
    if (input.text.length === 0 || input.text.length > MAX_LINE_BYTES) {
      throw new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "turn text is empty or exceeds the bounded input limit");
    }
    await this.open();
    const response = await this.request("turn/start", {
      threadId: input.thread_id,
      input: [{ type: "text", text: input.text }],
      model: input.model ?? null,
      effort: input.effort ?? null,
      cwd: input.cwd ?? null,
      approvalPolicy: input.approval_policy ?? null,
      sandboxPolicy: input.sandbox_policy ?? null,
    });
    return {
      thread_id: input.thread_id,
      turn_id: requireNestedString(response, "turn", "id", "turn/start"),
      external_harness: CODEX_EXTERNAL_HARNESS,
    };
  }

  async interrupt(threadId: string, turnId: string): Promise<{ readonly interrupted: true; readonly external_harness: typeof CODEX_EXTERNAL_HARNESS }> {
    if (!isSafeId(threadId) || !isSafeId(turnId)) {
      throw new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "thread and turn ids are invalid");
    }
    await this.open();
    await this.request("turn/interrupt", { threadId, turnId });
    return { interrupted: true, external_harness: CODEX_EXTERNAL_HARNESS };
  }

  async stop(reason = "user-stop"): Promise<void> {
    if (this.jobId === null) return;
    const jobId = this.jobId;
    this.clearExpiryTimer();
    for (const pending of this.pending.values()) pending.reject(new CodexAppServerError("CODEX_APP_SERVER_EXITED", `Codex App Server stopped: ${reason}`));
    this.pending.clear();
    this.subscription?.unsubscribe();
    this.subscription = null;
    try {
      await this.withRpcDeadline(this.options.clients.jobs.Stop({
        context: await nextContext(this.options.context, "codex-stop"),
        jobId,
        reason,
      }), "stop");
    } catch (error: unknown) {
      this.state = "unknown_settlement";
      void this.persistLease({ job_id: jobId, state: "unknown_settlement" }).catch(() => undefined);
      throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", `Codex App Server stop settlement is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await this.persistLease({ job_id: null, state: "stopped" });
    } catch (error: unknown) {
      this.state = "unknown_settlement";
      void this.persistLease({ job_id: jobId, state: "unknown_settlement" }).catch(() => undefined);
      throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", `Codex App Server stop lease persistence is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.state = "stopped";
    this.jobId = null;
    this.processId = null;
  }

  /** Expire the bounded lease while retaining a truthful terminal state. */
  private async expire(): Promise<void> {
    if (this.jobId === null || this.state === "stopped" || this.state === "exited" || this.state === "unknown_settlement") return;
    const jobId = this.jobId;
    this.clearExpiryTimer();
    this.state = "expired";
    this.failPending(new CodexAppServerError("CODEX_APP_SERVER_EXPIRED", "Codex App Server session lifetime expired; reconnect and resume the thread"));
    this.subscription?.unsubscribe();
    this.subscription = null;
    try {
      await this.withRpcDeadline(this.options.clients.jobs.Stop({
        context: await nextContext(this.options.context, "codex-expire"),
        jobId,
        reason: "session-expired",
      }), "expire");
      await this.persistLease({ job_id: null, state: "stopped" });
      this.jobId = null;
      this.processId = null;
    } catch (error: unknown) {
      this.state = "unknown_settlement";
      void this.persistLease({ job_id: jobId, state: "unknown_settlement" }).catch(() => undefined);
      this.failPending(new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", `Codex App Server expiry settlement is unknown: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async startAndInitialize(): Promise<void> {
    if (this.state === "unknown_settlement") {
      throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", "Codex App Server job settlement is unknown; reconcile before retrying");
    }
    if (this.options.persisted_lease?.job_id !== null
      && this.options.persisted_lease?.job_id !== undefined
      && this.options.persisted_lease.state === "running") {
      const restoredJobId = this.options.persisted_lease.job_id;
      this.jobId = restoredJobId;
      try {
        const recovered = await this.withRpcDeadline(this.options.clients.jobs.Get({
          context: await nextContext(this.options.context, "codex-reconcile"),
          jobId: restoredJobId,
        }), "reconcile");
        if (recovered.state === "running" || recovered.state === "queued") {
          this.state = "starting";
          await this.attachAndInitialize(restoredJobId, 0);
          return;
        }
        if (recovered.state === "unknown") {
          this.state = "unknown_settlement";
          void this.persistLease({ job_id: restoredJobId, state: "unknown_settlement" }).catch(() => undefined);
          throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", "Codex App Server job reconciliation is unknown");
        }
        // A known exit is settled. Release the old identity before reserving
        // a fresh lease for an explicit reconnect/resume operation.
        await this.persistLease({ job_id: restoredJobId, state: "exited" });
        this.jobId = null;
        this.processId = null;
        this.state = "not_started";
      } catch (error: unknown) {
        if (error instanceof CodexAppServerError) throw error;
        this.state = "unknown_settlement";
        void this.persistLease({ job_id: restoredJobId, state: "unknown_settlement" }).catch(() => undefined);
        throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", `Codex App Server reconciliation is unknown: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.state = "starting";
    try {
      await this.persistLease({ job_id: null, state: "starting" });
    } catch (error: unknown) {
      this.state = "unknown_settlement";
      throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", `Codex App Server launch lease persistence is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    let started;
    try {
      started = await this.withRpcDeadline(this.options.clients.jobs.Start({
        context: await nextContext(this.options.context, "codex-start"),
        intent: {
          userIntentRef: "external-harness:codex",
          taskContractHash: "",
          trustLabel: "trusted",
          confidentialityLabel: "workspace",
          taintSources: [],
          policyProfileId: "secure-local-default",
          expectedEffectClass: "execute_local",
        },
        command: {
          program: "codex",
          args: ["app-server", "--stdio"],
          cwd: { workspaceId: this.options.workspace_id, relativePath: "." },
          publicEnv: { ...this.options.public_env },
          secretCapabilityUris: [],
          // JobService durable jobs have a finite background ceiling. A
          // session reconnects and resumes its persisted thread after this
          // limit; an external lane is never an unbounded process.
          timeout: { seconds: CODEX_APP_SERVER_MAX_LIFETIME_SECONDS, nanos: 0 },
          allocatePty: false,
          shell: undefined,
          allowUnboundedTimeout: false,
        },
        sandboxProfileId: "secure-local-default",
        outputPolicyId: "provider-response-bounded",
        durable: true,
      }), "start");
    } catch (error: unknown) {
      const uncertain = error instanceof CodexRpcTimeoutError;
      this.state = uncertain ? "unknown_settlement" : "exited";
      try {
        await this.persistLease({ job_id: null, state: uncertain ? "unknown_settlement" : "exited" });
      } catch {
        this.state = "unknown_settlement";
      }
      throw new CodexAppServerError(uncertain ? "CODEX_APP_SERVER_UNKNOWN_SETTLEMENT" : "CODEX_APP_SERVER_UNAVAILABLE", uncertain
        ? "Codex App Server launch settlement is unknown; reconcile before retrying"
        : "the Codex App Server could not be started through the kernel");
    }
    if (started.jobId.length === 0 || started.processId.length === 0) {
      this.state = "unknown_settlement";
      void this.persistLease({ job_id: null, state: "unknown_settlement" }).catch(() => undefined);
      throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", "the kernel returned no durable Codex App Server job identity");
    }
    this.jobId = started.jobId;
    this.processId = started.processId;
    try {
      await this.persistLease({ job_id: started.jobId, state: "running" });
    } catch (error: unknown) {
      this.state = "unknown_settlement";
      void this.persistLease({ job_id: started.jobId, state: "unknown_settlement" }).catch(() => undefined);
      throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", `Codex App Server lease persistence is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.attachAndInitialize(started.jobId, 0);
  }

  private async attachAndInitialize(jobId: string, fromSequence: number): Promise<void> {
    this.expiryTimer = setTimeout(() => { void this.expire(); }, CODEX_APP_SERVER_MAX_LIFETIME_SECONDS * 1_000);
    this.subscription = this.options.clients.jobs.Stream({
      context: await nextContext(this.options.context, "codex-stream"),
      jobId,
      fromSequence,
    }).subscribe({
      next: (event) => this.handleJobEvent(event),
      error: (error: unknown) => this.handleStreamFailure(error),
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "terminus_external_harness", version: "0.1.0" },
        capabilities: {},
      });
      await this.notify("initialized", {});
      this.state = "ready";
    } catch (error: unknown) {
      await this.stop("initialization-failed").catch(() => undefined);
      throw error;
    }
  }

  private handleJobEvent(event: JobEvent): void {
    if (this.state === "stopped" || this.state === "expired") return;
    if (event.stdout !== undefined) {
      this.protocolBytes += event.stdout.bytes.byteLength;
      if (this.protocolBytes > MAX_PROTOCOL_BYTES) {
        this.state = "exited";
        this.failPending(new CodexAppServerError("CODEX_APP_SERVER_OUTPUT_LIMIT", "Codex App Server output exceeded the bounded protocol limit"));
        void this.stop("output-limit").catch(() => undefined);
        return;
      }
      this.inputBuffer += this.decoder.decode(event.stdout.bytes, { stream: true });
      if (this.inputBuffer.length > MAX_LINE_BYTES * 2) {
        this.state = "exited";
        this.failPending(new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "Codex App Server emitted an overlong protocol line"));
        void this.stop("protocol-line-limit").catch(() => undefined);
        return;
      }
      for (;;) {
        const newline = this.inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.inputBuffer.slice(0, newline).trim();
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (line.length > 0) this.handleLine(line, event.sequence);
      }
      return;
    }
    if (event.exited !== undefined) {
      this.clearExpiryTimer();
      this.subscription = null;
      this.state = event.exited.exitCode === 0 ? "exited" : "unknown_settlement";
      void this.persistLease({ job_id: this.jobId, state: this.state }).catch(() => undefined);
      this.failPending(new CodexAppServerError(
        this.state === "exited" ? "CODEX_APP_SERVER_EXITED" : "CODEX_APP_SERVER_UNKNOWN_SETTLEMENT",
        `Codex App Server exited with code ${event.exited.exitCode}`,
      ));
      return;
    }
    if (event.reconciled !== undefined && event.reconciled.state === "unknown-settlement") {
      this.markUnknown(event.reconciled.explanation || "Codex App Server job settlement is unknown");
    }
  }

  private handleLine(line: string, sequence: number): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      this.failPending(new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "Codex App Server emitted invalid JSON"));
      return;
    }
    const message = asRecord(decoded);
    if (message === null) return;
    const id = numberOrNull(message.id);
    if (id !== null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      if ("error" in message) pending.reject(new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "Codex App Server returned a request error"));
      else pending.resolve(sanitize(message.result));
      return;
    }
    const method = stringOrNull(message.method);
    if (method === null) return;
    const sanitized = sanitize(message);
    this.options.on_event?.({
      external_harness: CODEX_EXTERNAL_HARNESS,
      job_id: this.jobId ?? "",
      sequence,
      message: isRecord(sanitized) ? sanitized : {},
    });
    if (id !== null) void this.answerServerRequest({ id, method, params: message.params });
  }

  private async answerServerRequest(request: JsonRpcRequest): Promise<void> {
    const result = this.options.on_server_request === undefined
      ? null
      : await this.options.on_server_request(sanitize(request) as Record<string, unknown>);
    await this.write({ jsonrpc: "2.0", id: request.id, ...(result === null ? { error: { code: -32001, message: "approval is not available in this Terminus external lane" } } : { result: sanitize(result) }) });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.state === "unknown_settlement") {
      throw new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", "Codex App Server job settlement is unknown; reconcile before retrying");
    }
    if (this.state === "expired") {
      throw new CodexAppServerError("CODEX_APP_SERVER_EXPIRED", "Codex App Server session lifetime expired; reconnect and resume the thread");
    }
    if (this.state === "exited" || this.state === "stopped") {
      throw new CodexAppServerError("CODEX_APP_SERVER_EXITED", "Codex App Server exited; start a new external session");
    }
    if (method !== "initialize" && !ALLOWED_REQUESTS.has(method)) {
      throw new CodexAppServerError("CODEX_APP_SERVER_METHOD_UNSUPPORTED", `Codex App Server method '${method}' is not allowed in the external lane`);
    }
    const id = this.nextRequestId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      await this.write({ jsonrpc: "2.0", id, method, params: sanitize(params) });
    } catch (error: unknown) {
      this.pending.delete(id);
      throw error;
    }
    this.state = "running";
    return this.withPendingDeadline(id, result, method);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params: sanitize(params) });
  }

  private async write(message: unknown): Promise<void> {
    if (this.jobId === null) throw new CodexAppServerError("CODEX_APP_SERVER_UNAVAILABLE", "Codex App Server has not started");
    const encoded = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if (encoded.byteLength > MAX_LINE_BYTES) throw new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", "Codex App Server request exceeds the bounded input limit");
    await this.withRpcDeadline(this.options.clients.jobs.Input({
      context: await nextContext(this.options.context, "codex-input"),
      jobId: this.jobId,
      stdin: encoded,
    }), "input");
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async withPendingDeadline(id: number, result: Promise<unknown>, method: string): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          const error = new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", `Codex App Server ${method} response timed out`);
          this.markUnknown(error.message);
          reject(error);
        }, this.rpcTimeoutMs);
        result.then(resolve, reject);
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async withRpcDeadline<T>(result: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new CodexRpcTimeoutError(operation)), this.rpcTimeoutMs);
        result.then(resolve, reject);
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private handleStreamFailure(error: unknown): void {
    this.clearExpiryTimer();
    this.subscription = null;
    this.markUnknown(`Codex App Server stream failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === null) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private markUnknown(message: string): void {
    if (this.state === "stopped") return;
    this.state = "unknown_settlement";
    void this.persistLease({ job_id: this.jobId, state: "unknown_settlement" }).catch(() => undefined);
    this.failPending(new CodexAppServerError("CODEX_APP_SERVER_UNKNOWN_SETTLEMENT", message));
  }

  private async persistLease(lease: CodexAppServerLease): Promise<void> {
    await this.options.on_lease?.(lease);
  }
}

/** Probe availability without making a subscription credential or model call. */
export async function probeCodexAppServer(options: CodexAppServerSessionOptions): Promise<CodexAppServerStatus> {
  const session = new CodexAppServerSession(options);
  try {
    await session.open();
    return session.status();
  } catch (error: unknown) {
    const status = session.status();
    return {
      ...status,
      available: false,
      reason: error instanceof CodexAppServerError ? error.message : "Codex App Server availability probe failed",
    };
  } finally {
    await session.stop("availability-probe").catch(() => undefined);
  }
}

function nextContext(source: RequestContext | (() => Promise<RequestContext>), operation: string): Promise<RequestContext> {
  const base = typeof source === "function" ? source() : Promise.resolve(source);
  return base.then((context) => ({
    ...context,
    requestId: randomUUID(),
    idempotencyKey: `${context.idempotencyKey}:codex:${operation}:${randomUUID()}`,
  }));
}

function requireNestedString(value: unknown, parent: string, child: string, method: string): string {
  const result = asRecord(value);
  const nested = asRecord(result?.[parent]);
  const id = stringOrNull(nested?.[child]);
  if (id === null || !isSafeId(id)) throw new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", `${method} returned no valid ${parent}.${child}`);
  return id;
}

function isSafeId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_SANITIZED_STRING ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length <= 256).slice(0, 32);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZED_DEPTH) return "[depth-limited]";
  if (typeof value === "string") return value.length <= MAX_SANITIZED_STRING ? value : `${value.slice(0, MAX_SANITIZED_STRING)}...[truncated]`;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_SANITIZED_ARRAY).map((entry) => sanitize(entry, depth + 1));
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_SANITIZED_KEYS)) {
    if (/token|secret|authorization|cookie|password/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitize(entry, depth + 1);
    }
  }
  return output;
}
