/**
 * Isolated MCP stdio & HTTP relays — SPEC §35.6, §49.6.
 *
 * Stdio servers run through KernelProcessPort (no ambient spawn).
 * HTTP servers use a brokered fetch port with private-IP denial.
 * All descriptions/results are labeled untrusted unless builtin.
 */
import { ValidationError, PermissionError, TimeoutError } from "@terminus/domain";
import type { ContentHash } from "@terminus/domain";
import type { KernelProcessPort } from "./kernel_port.js";
import { labelUntrustedMcpText, type AdmittedMcpServer, mcpToolCallAuthorized } from "./mcp_admission.js";

export interface McpServerConfig {
  readonly id: string;
  readonly version: string;
  readonly transport: "stdio" | "http" | "streamable_http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
  readonly contentHash: ContentHash;
  readonly capabilityGrantId: string;
}

export interface McpLimits {
  readonly maxMessageSizeBytes: number;
  readonly maxOutputBytes: number;
  readonly deadlineMs: number;
  readonly maxCpuMs?: number;
  readonly maxMemoryBytes?: number;
}

export const DEFAULT_MCP_LIMITS: McpLimits = {
  maxMessageSizeBytes: 1_048_576,
  maxOutputBytes: 4_194_304,
  deadlineMs: 10_000,
  maxCpuMs: 8_000,
  maxMemoryBytes: 256 * 1024 * 1024,
};

export interface McpToolCallRequest {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly callerId: string;
}

export interface McpToolCallResult {
  readonly status: "success" | "error";
  readonly output: Readonly<Record<string, unknown>> | string;
  readonly trustLabel: {
    readonly source: string;
    readonly trustLevel: "builtin" | "first_party" | "verified_third_party" | "untrusted";
    readonly contentHash: ContentHash;
    readonly verified: boolean;
    /** Server-generated instructions are always untrusted data. */
    readonly instructionsUntrusted: true;
  };
  readonly executionTimeMs: number;
  readonly truncated: boolean;
}

const DANGEROUS_ENV_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "TERMINUS_MASTER_SECRET",
]);

export function sanitizeMcpEnvironment(
  rawEnv: Readonly<Record<string, string>> | undefined,
  trustLevel: string,
): Record<string, string> {
  const cleanEnv: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    TERMINUS_NO_AMBIENT: "1",
  };
  if (!rawEnv) return cleanEnv;

  for (const [key, value] of Object.entries(rawEnv)) {
    if (DANGEROUS_ENV_KEYS.has(key.toUpperCase()) && trustLevel !== "builtin") {
      continue;
    }
    cleanEnv[key] = value;
  }
  return cleanEnv;
}

const PRIVATE_IP_PATTERN = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// skipcq: JS-0067
export function isPrivateIp(ip: string): boolean {
  const cleaned = ip.replace(/^::ffff:/, "");
  if (LOCAL_HOSTS.has(cleaned)) return true;
  return PRIVATE_IP_PATTERN.test(cleaned);
}

export interface McpHttpPort {
  fetchJson(
    url: string,
    body: Readonly<Record<string, unknown>>,
    opts: { readonly deadlineMs: number; readonly maxOutputBytes: number },
  ): Promise<{ readonly status: number; readonly body: unknown; readonly truncated: boolean }>;
}

function boundOutput(raw: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(raw, "utf8");
  if (buf.byteLength <= maxBytes) return { text: raw, truncated: false };
  return {
    text: buf.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

function trustLabelFor(
  config: McpServerConfig,
): McpToolCallResult["trustLabel"] {
  return {
    source: config.id,
    trustLevel: config.trustLevel,
    contentHash: config.contentHash,
    verified: config.trustLevel === "builtin" || config.trustLevel === "first_party",
    instructionsUntrusted: true,
  };
}

export class McpProcessRelay {
  constructor(
    public readonly config: McpServerConfig,
    public readonly limits: McpLimits = DEFAULT_MCP_LIMITS,
    private readonly kernel: KernelProcessPort | null = null,
    private readonly admission: AdmittedMcpServer | null = null,
  ) {
    if (config.transport !== "stdio") {
      throw new ValidationError("McpProcessRelay requires stdio transport");
    }
  }

  async executeTool(
    request: McpToolCallRequest,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    if (signal?.aborted) {
      throw new ValidationError("MCP tool execution aborted prior to launch");
    }
    if (this.admission) {
      mcpToolCallAuthorized(this.admission, request.toolName, null);
    }

    const serializedReq = JSON.stringify(request);
    if (serializedReq.length > this.limits.maxMessageSizeBytes) {
      throw new ValidationError("MCP request payload exceeds max message size limit", {
        size: serializedReq.length,
        limit: this.limits.maxMessageSizeBytes,
      });
    }

    const env = sanitizeMcpEnvironment(this.config.env, this.config.trustLevel);
    const start = Date.now();

    if (this.kernel === null) {
      throw new PermissionError(
        "MCP stdio relay requires KernelProcessPort — ambient process spawn denied",
        { serverId: this.config.id },
      );
    }
    if (!this.config.command) {
      throw new ValidationError("MCP stdio relay missing command", { id: this.config.id });
    }

    const rpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: request.toolName, arguments: request.arguments },
    };

    let result;
    try {
      result = await this.kernel.exec({
        program: this.config.command,
        args: this.config.args ?? [],
        env,
        stdin: `${JSON.stringify(rpcRequest)}\n`,
        deadlineMs: this.limits.deadlineMs,
        maxOutputBytes: this.limits.maxOutputBytes,
        capabilityGrantId: this.config.capabilityGrantId,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("deadline")) {
        throw new TimeoutError(`MCP tool ${request.toolName} execution timeout`, this.limits.deadlineMs);
      }
      throw err;
    }

    const elapsed = Date.now() - start;
    if (elapsed > this.limits.deadlineMs) {
      throw new TimeoutError(`MCP tool ${request.toolName} execution timeout`, this.limits.deadlineMs);
    }

    const bounded = boundOutput(result.stdout, this.limits.maxOutputBytes);
    let parsed: unknown = bounded.text;
    try {
      const line = bounded.text.trim().split("\n").find((l) => l.startsWith("{")) ?? bounded.text;
      parsed = JSON.parse(line) as unknown;
    } catch {
      parsed = labelUntrustedMcpText(bounded.text, this.config.id, this.config.contentHash);
    }

    const status: "success" | "error" =
      result.exitCode === 0 && !(parsed as { error?: unknown })?.error ? "success" : "error";

    return {
      status,
      output: parsed as Readonly<Record<string, unknown>> | string,
      trustLabel: trustLabelFor(this.config),
      executionTimeMs: elapsed,
      truncated: bounded.truncated || result.truncated,
    };
  }
}

export class McpHttpRelay {
  constructor(
    public readonly config: McpServerConfig,
    public readonly limits: McpLimits = DEFAULT_MCP_LIMITS,
    private readonly http: McpHttpPort | null = null,
    private readonly admission: AdmittedMcpServer | null = null,
  ) {
    if (config.transport !== "http" && config.transport !== "streamable_http") {
      throw new ValidationError("McpHttpRelay requires http or streamable_http transport");
    }
  }

  async executeHttpRequest(
    targetUrl: string,
    payload: Readonly<Record<string, unknown>>,
    toolName?: string,
  ): Promise<McpToolCallResult> {
    if (toolName && this.admission) {
      mcpToolCallAuthorized(this.admission, toolName, null);
    }

    const urlObj = new URL(targetUrl);
    if (this.config.trustLevel === "untrusted" || this.config.trustLevel === "verified_third_party") {
      if (isPrivateIp(urlObj.hostname)) {
        throw new PermissionError(
          "untrusted or third-party MCP HTTP relay prohibited from accessing private IP address",
          { hostname: urlObj.hostname },
        );
      }
    }

    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > this.limits.maxMessageSizeBytes) {
      throw new ValidationError("MCP HTTP payload exceeds max message size limit");
    }

    if (this.http === null) {
      throw new PermissionError(
        "MCP HTTP relay requires brokered McpHttpPort — ambient fetch denied",
        { serverId: this.config.id },
      );
    }

    const start = Date.now();
    const response = await this.http.fetchJson(targetUrl, payload, {
      deadlineMs: this.limits.deadlineMs,
      maxOutputBytes: this.limits.maxOutputBytes,
    });
    const elapsed = Date.now() - start;

    return {
      status: response.status >= 200 && response.status < 300 ? "success" : "error",
      output: {
        httpStatus: response.status,
        body: response.body,
        trust: labelUntrustedMcpText(
          typeof response.body === "string" ? response.body : JSON.stringify(response.body),
          this.config.id,
          this.config.contentHash,
        ),
      },
      trustLabel: trustLabelFor(this.config),
      executionTimeMs: elapsed,
      truncated: response.truncated,
    };
  }
}
