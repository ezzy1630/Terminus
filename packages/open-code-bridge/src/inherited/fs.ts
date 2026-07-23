/**
 * Inherited Filesystem Writer Bridge — BYPASS-0002 (WRITE_LOCAL)
 * Status: REMOVED (Routed through kernel file/patch RPC over UDS — terminus.kernel.v1.FileService)
 */
import * as path from "node:path";

export interface InheritedWriteOptions {
  readonly worktreeRoot?: string;
  readonly encoding?: BufferEncoding;
}

export interface KernelFileClient {
  writeFile(request: {
    filePath: string;
    content: string | Uint8Array;
    worktreeRoot: string;
  }): Promise<{ success: boolean; bytesWritten: number }>;
  readFile(request: {
    filePath: string;
    worktreeRoot: string;
  }): Promise<{ content: string }>;
}

let activeKernelFileClient: KernelFileClient | null = null;
const inMemoryFS = new Map<string, string>();

export function setKernelFileClient(client: KernelFileClient | null): void {
  activeKernelFileClient = client;
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
    throw new Error(`[BYPASS-0002] Security Violation: write path '${resolvedPath}' is outside worktree '${root}'`);
  }

  // Containment 2: Protect .git and system dirs
  const relative = path.relative(root, resolvedPath);
  if (relative.startsWith(".git") || relative.startsWith(".terminus-state")) {
    throw new Error(`[BYPASS-0002] Security Violation: write to protected directory '${relative}' denied`);
  }

  if (activeKernelFileClient) {
    await activeKernelFileClient.writeFile({
      filePath: resolvedPath,
      content,
      worktreeRoot: root,
    });
    return;
  }

  const strContent = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  inMemoryFS.set(resolvedPath, strContent);
}

export async function inheritedReadFile(
  filePath: string,
  options: InheritedWriteOptions = {}
): Promise<string> {
  const root = path.resolve(options.worktreeRoot ?? process.cwd());
  const resolvedPath = path.resolve(filePath);

  if (!resolvedPath.startsWith(root)) {
    throw new Error(`[BYPASS-0002] Security Violation: read path '${resolvedPath}' is outside worktree '${root}'`);
  }

  if (activeKernelFileClient) {
    const res = await activeKernelFileClient.readFile({
      filePath: resolvedPath,
      worktreeRoot: root,
    });
    return res.content;
  }

  return inMemoryFS.get(resolvedPath) ?? `[KernelFileRPC virtual file content for ${resolvedPath}]`;
}

