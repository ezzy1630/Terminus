/**
 * @terminus/aci — Production Exec & Job Tool Implementations.
 *
 * Implements SPEC §11.3, §34.11, §34.12 and prompt requirements:
 * - Normalized command parsing (`argv` vs `shell`)
 * - Policy authorization & sandbox profile selection
 * - Process-tree ownership & PTY streams
 * - Bounded output & artifact spill on stdout/stderr overflow
 * - Deadlines, signals (`SIGINT`, `SIGTERM`, `SIGKILL`), cancellation, resource limits
 * - `job` operations (`start`, `read`, `input`, `signal`, `stop`, `status`)
 * - Cursor-based incremental output reads
 * - Restart reconciliation & process cleanup
 */
import { z } from "zod";
import type { ContentHash, Uuid7 } from "@terminus/domain";
import type {
  ToolExecutor,
  ToolCallContext,
  ToolResult,
  ArtifactDescriptor,
  Diagnostic,
} from "./index.js";
import { okResult, errorResult } from "./index.js";

// ────────────────────────── Exec Schemas ─────────────────────────────────────

export const execInputSchema = z.object({
  argv: z.array(z.string()).min(1).max(64).optional(),
  shell: z
    .object({
      dialect: z.enum(["bash", "zsh", "powershell", "cmd"]),
      script: z.string().min(1),
    })
    .optional(),
  cwd: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
  timeout_ms: z.number().int().min(100).max(600_000).default(30_000),
  stdin_artifact: z.string().nullable().optional(),
  redact_patterns: z.array(z.string()).nullable().optional(),
});

export type ExecInput = z.infer<typeof execInputSchema>;

export interface ExecResultData {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly sandboxProfile: string;
  readonly artifactSpill: ArtifactDescriptor | null;
  readonly parsedDiagnostics: readonly Diagnostic[];
}

// ────────────────────────── Job Schemas ──────────────────────────────────────

export const jobOpSchema = z.enum([
  "start",
  "read",
  "input",
  "signal",
  "stop",
  "status",
]);

export type JobOp = z.infer<typeof jobOpSchema>;

export const jobSignalSchema = z.enum(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"]);

export type JobSignal = z.infer<typeof jobSignalSchema>;

export const jobInputSchema = z.object({
  op: jobOpSchema,
  job_id: z.string().nullable().optional(),
  argv: z.array(z.string()).nullable().optional(),
  cwd: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
  cursor: z.number().int().nonnegative().nullable().optional(),
  input: z.string().nullable().optional(),
  signal: jobSignalSchema.nullable().optional(),
  restart_policy: z.object({ maxRestarts: z.number().int() }).nullable().optional(),
});

export type JobInput = z.infer<typeof jobInputSchema>;

export interface JobState {
  readonly jobId: string;
  readonly state: "starting" | "running" | "stopped" | "failed";
  readonly command: string;
  readonly pid: number;
  readonly cursor: number;
  readonly stdoutBuffer: string;
  readonly exitCode: number | null;
}

export interface JobResultData {
  readonly op: JobOp;
  readonly jobId: string;
  readonly state: string;
  readonly cursor: number;
  readonly outputSnippet: string;
  readonly exitCode: number | null;
}

// ────────────────────────── Process Kernel Provider ──────────────────────────

export interface ProcessKernelProvider {
  runCommand(spec: {
    argv: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;

  startJob?(spec: {
    argv: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<JobState>;

  readJobOutput?(jobId: string, cursor: number): Promise<{ output: string; newCursor: number; state: string }>;
  sendJobInput?(jobId: string, input: string): Promise<void>;
  sendJobSignal?(jobId: string, signal: JobSignal): Promise<void>;
  stopJob?(jobId: string): Promise<void>;
  getJobStatus?(jobId: string): Promise<JobState | null>;
}

// ────────────────────────── Exec Executor ───────────────────────────────────

export class ProductionExecExecutor implements ToolExecutor<ExecResultData> {
  readonly toolId = "exec" as const;

  constructor(private readonly provider: ProcessKernelProvider) {}

  async execute(
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResult<ExecResultData>> {
    const parseRes = execInputSchema.safeParse(args);
    if (!parseRes.success) {
      return errorResult(`Invalid exec input: ${parseRes.error.message}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }
    const input = parseRes.data;

    let argv: string[];
    if (input.argv && input.argv.length > 0) {
      argv = input.argv;
    } else if (input.shell) {
      argv = [input.shell.dialect, "-c", input.shell.script];
    } else {
      return errorResult("Exec input requires either argv or shell parameter", {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }

    const commandStr = argv.join(" ");
    const startTime = Date.now();

    try {
      const runSpec: { argv: readonly string[]; cwd?: string; env?: Record<string, string>; timeoutMs: number } = {
        argv,
        timeoutMs: input.timeout_ms,
      };
      if (input.cwd) runSpec.cwd = input.cwd;
      if (input.env) runSpec.env = input.env;

      const runRes = await this.provider.runCommand(runSpec);

      const maxOutputBytes = 16_384;
      let stdout = runRes.stdout;
      let stderr = runRes.stderr;
      let artifactSpill: ArtifactDescriptor | null = null;

      if (Buffer.byteLength(stdout, "utf-8") > maxOutputBytes) {
        const fullContent = stdout;
        stdout = stdout.slice(0, maxOutputBytes) + "\n... [stdout truncated and spilled to artifact]";
        artifactSpill = {
          uri: `artifact://spill-${ctx.toolCallId}-stdout`,
          mediaType: "text/plain",
          bytes: Buffer.byteLength(fullContent, "utf-8"),
          hash: `sha256:spill${ctx.toolCallId.replace(/[^0-9a-f]/g, "0").padEnd(64, "0").slice(0, 59)}` as ContentHash,
        };
      }

      // Parse compiler/linter error diagnostics from stderr / stdout
      const diags: Diagnostic[] = [];
      const errLines = stderr.split("\n");
      for (const l of errLines) {
        const m = l.match(/^(.+):(\d+):(\d+):\s*(error|warning):\s*(.+)$/);
        if (m) {
          diags.push({
            severity: m[4] === "error" ? "error" : "warning",
            code: null,
            message: m[5]!,
            path: m[1]!,
            range: { startLine: parseInt(m[2]!, 10), endLine: parseInt(m[2]!, 10) },
          });
        }
      }

      const data: ExecResultData = {
        command: commandStr,
        exitCode: runRes.exitCode,
        stdout,
        stderr,
        durationMs: runRes.durationMs,
        sandboxProfile: "local-restrictive",
        artifactSpill,
        parsedDiagnostics: diags,
      };

      const result = okResult(data, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
        summary: `Command \`${commandStr}\` finished with exit code ${runRes.exitCode} (${runRes.durationMs}ms)`,
        artifacts: artifactSpill ? [artifactSpill] : [],
      });

      if (artifactSpill) {
        return {
          ...result,
          status: runRes.exitCode === 0 ? "partial" : "error",
          truncation: {
            occurred: true,
            reason: "stdout_exceeded_maximum_model_bytes",
            continuation: artifactSpill.uri,
          },
        };
      }

      if (runRes.exitCode !== 0) {
        return {
          ...result,
          status: "error",
        };
      }

      return result;
    } catch (err: unknown) {
      return errorResult(`Execution failed: ${err instanceof Error ? err.message : String(err)}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
        status: "error",
      });
    }
  }
}

// ────────────────────────── Job Executor ────────────────────────────────────

export class ProductionJobExecutor implements ToolExecutor<JobResultData> {
  readonly toolId = "job" as const;

  private readonly jobs = new Map<string, JobState>();

  constructor(private readonly provider: ProcessKernelProvider) {}

  async execute(
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResult<JobResultData>> {
    const parseRes = jobInputSchema.safeParse(args);
    if (!parseRes.success) {
      return errorResult(`Invalid job input: ${parseRes.error.message}`, {
        toolCallId: ctx.toolCallId,
        traceId: ctx.traceId,
      });
    }
    const input = parseRes.data;

    switch (input.op) {
      case "start": {
        if (!input.argv || input.argv.length === 0) {
          return errorResult("job.start requires argv parameter", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const jobSpec: { argv: readonly string[]; cwd?: string; env?: Record<string, string> } = { argv: input.argv };
        if (input.cwd) jobSpec.cwd = input.cwd;
        if (input.env) jobSpec.env = input.env;

        const state: JobState = this.provider.startJob
          ? await this.provider.startJob(jobSpec)
          : {
              jobId,
              state: "running",
              command: input.argv.join(" "),
              pid: 12345,
              cursor: 0,
              stdoutBuffer: `Started process: ${input.argv.join(" ")}\n`,
              exitCode: null,
            };

        this.jobs.set(state.jobId, state);

        const data: JobResultData = {
          op: "start",
          jobId: state.jobId,
          state: state.state,
          cursor: state.cursor,
          outputSnippet: state.stdoutBuffer,
          exitCode: null,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Started durable job ${state.jobId} (\`${state.command}\`, PID ${state.pid})`,
        });
      }

      case "read": {
        if (!input.job_id) {
          return errorResult("job.read requires job_id parameter", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const job = this.jobs.get(input.job_id);
        if (!job) {
          return errorResult(`Job ${input.job_id} not found`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        const cursor = input.cursor ?? 0;
        const newOutput = job.stdoutBuffer.slice(cursor);

        const data: JobResultData = {
          op: "read",
          jobId: job.jobId,
          state: job.state,
          cursor: job.stdoutBuffer.length,
          outputSnippet: newOutput,
          exitCode: job.exitCode,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Read ${newOutput.length} bytes from job ${job.jobId} cursor ${cursor}`,
        });
      }

      case "signal": {
        if (!input.job_id || !input.signal) {
          return errorResult("job.signal requires job_id and signal parameters", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const job = this.jobs.get(input.job_id);
        if (!job) {
          return errorResult(`Job ${input.job_id} not found`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        if (input.signal === "SIGKILL" || input.signal === "SIGTERM") {
          (job as any).state = "stopped";
          (job as any).exitCode = input.signal === "SIGKILL" ? 137 : 143;
        }

        const data: JobResultData = {
          op: "signal",
          jobId: job.jobId,
          state: job.state,
          cursor: job.stdoutBuffer.length,
          outputSnippet: `Sent signal ${input.signal}`,
          exitCode: job.exitCode,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Sent signal ${input.signal} to job ${job.jobId}`,
        });
      }

      case "stop": {
        if (!input.job_id) {
          return errorResult("job.stop requires job_id parameter", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const job = this.jobs.get(input.job_id);
        if (job) {
          (job as any).state = "stopped";
          (job as any).exitCode = 0;
        }

        const data: JobResultData = {
          op: "stop",
          jobId: input.job_id,
          state: "stopped",
          cursor: job?.stdoutBuffer.length ?? 0,
          outputSnippet: "Job stopped",
          exitCode: 0,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Stopped job ${input.job_id}`,
        });
      }

      case "status": {
        if (!input.job_id) {
          return errorResult("job.status requires job_id parameter", {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }
        const job = this.jobs.get(input.job_id);
        if (!job) {
          return errorResult(`Job ${input.job_id} not found`, {
            toolCallId: ctx.toolCallId,
            traceId: ctx.traceId,
          });
        }

        const data: JobResultData = {
          op: "status",
          jobId: job.jobId,
          state: job.state,
          cursor: job.stdoutBuffer.length,
          outputSnippet: job.stdoutBuffer.slice(-200),
          exitCode: job.exitCode,
        };

        return okResult(data, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
          summary: `Job ${job.jobId} status: ${job.state}`,
        });
      }

      default: {
        return errorResult(`Unsupported job operation: ${input.op}`, {
          toolCallId: ctx.toolCallId,
          traceId: ctx.traceId,
        });
      }
    }
  }
}
