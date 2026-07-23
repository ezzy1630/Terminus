/**
 * Kernel process port — the only way TypeScript may spawn extension/MCP/skill
 * subprocesses. Implementations must call terminus.kernel.v1; never Node
 * `child_process` directly from product paths.
 */
export interface KernelProcessRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
  readonly stdin?: string | undefined;
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
  /** Capability token / grant id used by the kernel for this spawn. */
  readonly capabilityGrantId: string;
}

export interface KernelProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface KernelProcessPort {
  exec(request: KernelProcessRequest): Promise<KernelProcessResult>;
}

/**
 * Skill scripts run only through this port (SPEC §35.2). Ambient control-plane
 * authority is never granted.
 */
export interface SkillScriptRequest {
  readonly skillId: string;
  readonly scriptPath: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly capabilityGrantId: string;
  readonly deadlineMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
}

export async function executeSkillScript(
  kernel: KernelProcessPort,
  request: SkillScriptRequest,
): Promise<KernelProcessResult> {
  // Interpreter is chosen by the kernel from the grant; here we only request
  // a capability-bound exec of the pinned script path.
  return kernel.exec({
    program: request.scriptPath,
    args: request.args,
    env: {
      ...request.env,
      TERMINUS_SKILL_ID: request.skillId,
      TERMINUS_NO_AMBIENT: "1",
    },
    deadlineMs: request.deadlineMs,
    maxOutputBytes: request.maxOutputBytes,
    capabilityGrantId: request.capabilityGrantId,
    signal: request.signal,
  });
}
