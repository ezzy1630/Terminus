/**
 * @terminus/orchestration — Candidate Workspace Manager.
 *
 * Per SPEC §27.3 & §14.2: Concurrent writers operate in isolated candidate workspaces.
 * Speculative branches cannot commit external effects; losing branches are discarded
 * cleanly, and only the admission service merges into the authoritative workspace.
 */
import type { Uuid7 } from "@terminus/domain";

export interface CandidateWorkspace {
  readonly id: string;
  readonly parentTaskId: string;
  readonly workerId: string;
  readonly branchName: string;
  readonly isolatedPath: string;
  readonly status: "active" | "discarded" | "admitted";
  readonly modifiedFiles: readonly string[];
  readonly createdAt: string;
}

export class CandidateWorkspaceManager {
  private readonly workspaces = new Map<string, CandidateWorkspace>();

  /**
   * Create an isolated candidate workspace for a speculative writer.
   */
  createCandidateWorkspace(input: {
    readonly parentTaskId: string;
    readonly workerId: string;
    readonly baseWorkspacePath: string;
  }): CandidateWorkspace {
    const id = `cand-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const branchName = `terminus/candidate/${input.parentTaskId}/${input.workerId}`;
    const isolatedPath = `${input.baseWorkspacePath}/.terminus/candidates/${id}`;

    const ws: CandidateWorkspace = {
      id,
      parentTaskId: input.parentTaskId,
      workerId: input.workerId,
      branchName,
      isolatedPath,
      status: "active",
      modifiedFiles: [],
      createdAt: new Date().toISOString(),
    };

    this.workspaces.set(id, ws);
    return ws;
  }

  /**
   * Record modified file in candidate workspace.
   */
  recordFileModification(workspaceId: string, filePath: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws || ws.status !== "active") return;

    if (!ws.modifiedFiles.includes(filePath)) {
      this.workspaces.set(workspaceId, {
        ...ws,
        modifiedFiles: [...ws.modifiedFiles, filePath],
      });
    }
  }

  /**
   * Discard losing speculative branch safely.
   */
  discard(workspaceId: string, reason: string): void {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;

    this.workspaces.set(workspaceId, {
      ...ws,
      status: "discarded",
    });
    void reason;
  }

  /**
   * Mark candidate workspace admitted for merge by admission service.
   */
  admit(workspaceId: string): CandidateWorkspace {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      throw new Error(`Candidate workspace '${workspaceId}' not found`);
    }

    const admitted: CandidateWorkspace = {
      ...ws,
      status: "admitted",
    };
    this.workspaces.set(workspaceId, admitted);
    return admitted;
  }

  /**
   * Retrieve workspace by ID.
   */
  get(workspaceId: string): CandidateWorkspace | null {
    return this.workspaces.get(workspaceId) ?? null;
  }
}
