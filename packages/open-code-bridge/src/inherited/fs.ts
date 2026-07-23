/**
 * Inherited Filesystem Writer Bridge — BYPASS-0002 (WRITE_LOCAL)
 * Containment: Worktree-restricted filesystem writes; protects .git and .terminus-state.
 * Target removal milestone: M2
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface InheritedWriteOptions {
  readonly worktreeRoot?: string;
  readonly encoding?: BufferEncoding;
}

export async function inheritedWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: InheritedWriteOptions = {}
): Promise<void> {
  const root = path.resolve(options.worktreeRoot ?? process.cwd());
  const resolvedPath = path.resolve(filePath);

  // Containment 1: Path traversal / outside worktree check
  if (!resolvedPath.startsWith(root)) {
    throw new Error(`[BYPASS-0002] Security Containment Violation: write path '${resolvedPath}' is outside worktree '${root}'`);
  }

  // Containment 2: Protect .git and system dirs
  const relative = path.relative(root, resolvedPath);
  if (relative.startsWith(".git") || relative.startsWith(".terminus-state")) {
    throw new Error(`[BYPASS-0002] Security Containment Violation: write to protected directory '${relative}' denied`);
  }

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, content, { encoding: options.encoding ?? "utf8" });
}

export async function inheritedReadFile(
  filePath: string,
  options: InheritedWriteOptions = {}
): Promise<string> {
  const root = path.resolve(options.worktreeRoot ?? process.cwd());
  const resolvedPath = path.resolve(filePath);

  if (!resolvedPath.startsWith(root)) {
    throw new Error(`[BYPASS-0002] Security Containment Violation: read path '${resolvedPath}' is outside worktree '${root}'`);
  }

  return fs.readFile(resolvedPath, options.encoding ?? "utf8");
}
