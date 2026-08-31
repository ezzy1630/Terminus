/**
 * Kernel-brokered local provider transport.
 *
 * The configured executable receives one JSON line on stdin and emits
 * newline-delimited `ProviderResponseChunk` objects on stdout. The control
 * plane never spawns a process or opens a provider socket directly.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Observable, Subscription } from "rxjs";
import type {
  JobEvent,
  RequestContext,
} from "../../../packages/terminus-kernel-client/src/generated-ts-proto/terminus/kernel/v1/kernel.js";
import type { KernelUdsClients } from "./kernel-uds.js";
import type {
  ProviderResponse,
  ProviderResponseChunk,
  RenderedProviderRequest,
  UsageRecord,
} from "@terminus/provider-core";
import type { ModelKey, TokenCount } from "@terminus/domain";

const MAX_PROVIDER_STDOUT_BYTES = 4 * 1_024 * 1_024;
const MAX_PROVIDER_STDERR_BYTES = 256 * 1_024;

const providerCommandSchema = z.object({
  program: z.string().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(128).default([]),
  model: z.string().min(1).max(255),
  timeout_seconds: z.number().int().min(1).max(3_600).default(300),
  tools_enabled: z.boolean().default(false),
}).strict();

const usageWireSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().default(0),
  cache_write_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative().default(0),
  tool_schema_tokens: z.number().int().nonnegative().default(0),
  latency_ms: z.number().nonnegative(),
  time_to_first_token_ms: z.number().nonnegative().nullable().default(null),
}).strict();

const responseChunkWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({
    kind: z.literal("tool_call"),
    tool_call: z.object({
      tool_call_id: z.string().min(1),
      tool_name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("error"),
    error_code: z.string().min(1),
    error_message: z.string().min(1),
    retry_after_ms: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    kind: z.literal("done"),
    continuation_id: z.string().min(1).optional(),
    provider_request_id: z.string().min(1).optional(),
    usage: usageWireSchema.optional(),
  }).strict(),
]);

export interface LocalProviderCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly model: ModelKey;
  readonly timeoutSeconds: number;
  readonly toolsEnabled?: boolean;
}

export class ProviderCommandConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCommandConfigurationError";
  }
}

export function parseLocalProviderCommand(raw: string | undefined): LocalProviderCommand | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error: unknown) {
    throw new ProviderCommandConfigurationError(
      `TERMINUS_LOCAL_PROVIDER_COMMAND_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = providerCommandSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ProviderCommandConfigurationError(
      `TERMINUS_LOCAL_PROVIDER_COMMAND_JSON is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  if ([parsed.data.program, ...parsed.data.args].some((value) => /[\0\r\n]/.test(value))) {
    throw new ProviderCommandConfigurationError("provider command program and arguments may not contain control delimiters");
  }
  return {
    program: parsed.data.program,
    args: parsed.data.args,
    model: parsed.data.model as ModelKey,
    timeoutSeconds: parsed.data.timeout_seconds,
    toolsEnabled: parsed.data.tools_enabled,
  };
}

export interface ExecuteLocalProviderCommandInput {
  readonly clients: KernelUdsClients;
  readonly context: RequestContext;
  readonly workspaceId: string;
  readonly command: LocalProviderCommand;
  readonly rendered: RenderedProviderRequest;
  readonly signal: AbortSignal | null;
  readonly devMode: boolean;
}

export async function executeLocalProviderCommand(
  input: ExecuteLocalProviderCommandInput,
): Promise<ProviderResponse> {
  const requestContext = nextContext(input.context, "provider-start");
  const started = await input.clients.jobs.Start({
    context: requestContext,
    intent: {
      userIntentRef: "provider-request",
      taskContractHash: "",
      trustLabel: "trusted",
      confidentialityLabel: "workspace",
      taintSources: [],
      policyProfileId: "secure-local-default",
      expectedEffectClass: "execute_local",
    },
    command: {
      program: input.command.program,
      args: [...input.command.args],
      cwd: { workspaceId: input.workspaceId, relativePath: "." },
      publicEnv: { TERMINUS_PROVIDER_PROTOCOL: "terminus.local-provider.v1" },
      secretCapabilityUris: [],
      timeout: { seconds: input.command.timeoutSeconds, nanos: 0 },
      allocatePty: false,
      shell: undefined,
      allowUnboundedTimeout: false,
    },
    sandboxProfileId: input.devMode ? "degraded-local" : "secure-local-default",
    outputPolicyId: "provider-response-bounded",
    durable: false,
  });
  if (started.jobId.length === 0) {
    throw new Error("kernel provider job started without a job id");
  }

  const events = input.clients.jobs.Stream({
    context: nextContext(input.context, "provider-stream"),
    jobId: started.jobId,
    fromSequence: 0,
  });
  const output = collectProviderJob(events, input.clients, input.context, started.jobId, input.signal);
  const requestLine = JSON.stringify({
    protocol: "terminus.local-provider.v1",
    provider: input.rendered.providerId,
    model: input.rendered.model,
    body: input.rendered.body,
  });
  try {
    await input.clients.jobs.Input({
      context: nextContext(input.context, "provider-input"),
      jobId: started.jobId,
      stdin: new TextEncoder().encode(`${requestLine}\n`),
    });
    const settled = await output;
    if (settled.exitCode !== 0) {
      throw new Error(
        `local provider command exited ${settled.exitCode}: ${tail(settled.stderr, 4_096)}`,
      );
    }
    const chunks = decodeProviderChunks(settled.stdout);
    const providerError = chunks.find((chunk) => chunk.kind === "error");
    if (providerError?.kind === "error") {
      throw new Error(`${providerError.errorCode ?? "PROVIDER_ERROR"}: ${providerError.errorMessage ?? "provider failed"}`);
    }
    return {
      providerId: input.rendered.providerId,
      model: input.rendered.model,
      chunks,
      observedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    await input.clients.jobs.Stop({
      context: nextContext(input.context, "provider-stop"),
      jobId: started.jobId,
      reason: "provider-transport-failed",
    }).catch(() => undefined);
    const settled = await settleForDiagnostics(output, 1_000);
    const stderr = settled === null ? "" : tail(settled.stderr, 4_096).trim();
    if (stderr.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; provider stderr: ${stderr}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function settleForDiagnostics(
  output: Promise<CollectedJobOutput>,
  timeoutMs: number,
): Promise<CollectedJobOutput | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      output.catch(() => null),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

interface CollectedJobOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function collectProviderJob(
  events: Observable<JobEvent>,
  clients: KernelUdsClients,
  context: RequestContext,
  jobId: string,
  signal: AbortSignal | null,
): Promise<CollectedJobOutput> {
  return new Promise((resolve, reject) => {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let subscription: Subscription | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      callback();
    };
    const failForLimit = (stream: "stdout" | "stderr", maximum: number): void => {
      void clients.jobs.Stop({
        context: nextContext(context, "provider-output-limit"),
        jobId,
        reason: `${stream}-limit-exceeded`,
      }).catch(() => undefined);
      finish(() => reject(new Error(`local provider ${stream} exceeded the ${maximum}-byte limit`)));
    };
    subscription = events.subscribe({
      next: (event) => {
        if (event.stdout !== undefined) {
          if (event.stdout.redacted) {
            finish(() => reject(new Error("local provider stdout was redacted and cannot be decoded safely")));
            return;
          }
          stdoutBytes += event.stdout.bytes.byteLength;
          if (stdoutBytes > MAX_PROVIDER_STDOUT_BYTES) {
            failForLimit("stdout", MAX_PROVIDER_STDOUT_BYTES);
            return;
          }
          stdout.push(event.stdout.bytes);
        }
        if (event.stderr !== undefined) {
          stderrBytes += event.stderr.bytes.byteLength;
          if (stderrBytes > MAX_PROVIDER_STDERR_BYTES) {
            failForLimit("stderr", MAX_PROVIDER_STDERR_BYTES);
            return;
          }
          stderr.push(event.stderr.bytes);
        }
        if (event.exited !== undefined) {
          try {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            const result = {
              exitCode: event.exited.exitCode,
              stdout: decoder.decode(concat(stdout, stdoutBytes)),
              stderr: decoder.decode(concat(stderr, stderrBytes)),
            };
            finish(() => resolve(result));
          } catch (error: unknown) {
            finish(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
        }
      },
      error: (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      complete: () => finish(() => reject(new Error("kernel provider job stream ended without an exit event"))),
    });
    if (signal !== null) {
      const abort = (): void => {
        void clients.jobs.Stop({
          context: nextContext(context, "provider-abort"),
          jobId,
          reason: "provider-request-aborted",
        }).catch(() => undefined);
        finish(() => reject(new Error("local provider request was aborted")));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export function decodeProviderChunks(stdout: string): readonly ProviderResponseChunk[] {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("local provider produced no response chunks");
  const chunks = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      throw new Error(`local provider response line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = responseChunkWireSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `local provider response line ${index + 1} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    }
    const chunk = parsed.data;
    switch (chunk.kind) {
      case "text": return { kind: "text" as const, text: chunk.text };
      case "tool_call": return {
        kind: "tool_call" as const,
        toolCall: {
          toolCallId: chunk.tool_call.tool_call_id,
          toolName: chunk.tool_call.tool_name,
          arguments: chunk.tool_call.arguments,
        },
      };
      case "error": return {
        kind: "error" as const,
        errorCode: chunk.error_code,
        errorMessage: chunk.error_message,
        ...(chunk.retry_after_ms === undefined ? {} : { retryAfterMs: chunk.retry_after_ms }),
      };
      case "done": return {
        kind: "done" as const,
        ...(chunk.continuation_id === undefined ? {} : { continuationId: chunk.continuation_id }),
        ...(chunk.provider_request_id === undefined ? {} : { providerRequestId: chunk.provider_request_id }),
        ...(chunk.usage === undefined ? {} : { usage: toUsage(chunk.usage) }),
      };
    }
  });
  if (chunks.at(-1)?.kind !== "done") {
    throw new Error("local provider response must terminate with a done chunk");
  }
  return chunks;
}

function toUsage(value: z.infer<typeof usageWireSchema>): UsageRecord {
  return {
    inputTokens: BigInt(value.input_tokens) as TokenCount,
    cachedInputTokens: BigInt(value.cached_input_tokens) as TokenCount,
    cacheWriteTokens: BigInt(value.cache_write_tokens) as TokenCount,
    outputTokens: BigInt(value.output_tokens) as TokenCount,
    reasoningTokens: BigInt(value.reasoning_tokens) as TokenCount,
    toolSchemaTokens: BigInt(value.tool_schema_tokens) as TokenCount,
    latencyMs: value.latency_ms,
    timeToFirstTokenMs: value.time_to_first_token_ms,
  };
}

function nextContext(context: RequestContext, operation: string): RequestContext {
  return {
    ...context,
    requestId: randomUUID(),
    idempotencyKey: `${context.idempotencyKey}:${operation}:${randomUUID()}`,
  };
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tail(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}
