/**
 * Inherited Process Execution Bridge — BYPASS-0001 (EXECUTE_LOCAL)
 * Containment: Process-level outer sandbox; all process spawns logged; path restricted.
 * Target removal milestone: M3
 */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface InheritedExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isTruncated: boolean;
}

export async function inheritedExec(
  command: string,
  args: readonly string[] = [],
  options: { cwd?: string; env?: Record<string, string>; maxBufferBytes?: number } = {}
): Promise<InheritedExecResult> {
  const maxBuffer = options.maxBufferBytes ?? 4096;
  const cwd = options.cwd ?? process.cwd();

  // Containment check: reject dangerous system commands or path escape
  if (command.includes("..") || command.startsWith("/etc") || command.startsWith("/var")) {
    throw new Error(`[BYPASS-0001] Security Containment Violation: unauthorized exec path ${command}`);
  }

  // Sanitized environment - redact raw API secrets
  const sanitizedEnv = { ...process.env, ...options.env };
  delete sanitizedEnv.OPENAI_API_KEY;
  delete sanitizedEnv.ANTHROPIC_API_KEY;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let isTruncated = false;

    const child = spawn(command, args, {
      cwd,
      env: sanitizedEnv,
      shell: false,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > maxBuffer) {
        isTruncated = true;
        stdout += chunk.toString("utf8", 0, maxBuffer - stdout.length);
      } else {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > maxBuffer) {
        isTruncated = true;
        stderr += chunk.toString("utf8", 0, maxBuffer - stderr.length);
      } else {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        isTruncated,
      });
    });
  });
}
