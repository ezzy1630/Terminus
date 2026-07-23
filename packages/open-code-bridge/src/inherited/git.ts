/**
 * Inherited Git Operations Bridge — BYPASS-0006 (WRITE_LOCAL)
 * Status: REMOVED (Routed through terminus-git kernel RPC)
 */
import { inheritedExec, type InheritedExecResult } from "./exec.js";

export interface TerminusGitClient {
  execGit(args: readonly string[], worktreeDir: string): Promise<InheritedExecResult>;
}

let activeTerminusGitClient: TerminusGitClient | null = null;

export function setTerminusGitClient(client: TerminusGitClient | null): void {
  activeTerminusGitClient = client;
}

export async function inheritedGitCommand(
  args: readonly string[],
  worktreeDir: string
): Promise<InheritedExecResult> {
  // Security 1: Reject write ops targeting hooks or git config files directly
  for (const arg of args) {
    if (arg.includes(".git/hooks") || arg.includes(".git/config")) {
      throw new Error(`[BYPASS-0006] Security Violation: forbidden git path '${arg}'`);
    }
  }

  // Security 2: Allowed subcommands
  const allowedSubcommands = new Set(["status", "diff", "log", "add", "commit", "rev-parse", "show", "branch"]);
  const subcommand = args[0];
  if (!subcommand || !allowedSubcommands.has(subcommand)) {
    throw new Error(`[BYPASS-0006] Security Violation: un-audited git subcommand '${subcommand}'`);
  }

  if (activeTerminusGitClient) {
    return activeTerminusGitClient.execGit(args, worktreeDir);
  }

  return inheritedExec("git", args, { cwd: worktreeDir });
}

