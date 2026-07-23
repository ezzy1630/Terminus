/**
 * Inherited Git Operations Bridge — BYPASS-0006 (WRITE_LOCAL)
 * Containment: Worktree-constrained git command execution; blocks modifying git hooks or external repos.
 * Target removal milestone: M4
 */
import { inheritedExec, type InheritedExecResult } from "./exec.js";

export async function inheritedGitCommand(
  args: readonly string[],
  worktreeDir: string
): Promise<InheritedExecResult> {
  // Containment 1: Reject write ops targeting hooks or git config files directly
  for (const arg of args) {
    if (arg.includes(".git/hooks") || arg.includes(".git/config")) {
      throw new Error(`[BYPASS-0006] Security Containment Violation: forbidden git path '${arg}'`);
    }
  }

  // Containment 2: Allowed subcommands
  const allowedSubcommands = new Set(["status", "diff", "log", "add", "commit", "rev-parse", "show", "branch"]);
  const subcommand = args[0];
  if (!subcommand || !allowedSubcommands.has(subcommand)) {
    throw new Error(`[BYPASS-0006] Security Containment Violation: un-audited git subcommand '${subcommand}'`);
  }

  return inheritedExec("git", args, { cwd: worktreeDir });
}
