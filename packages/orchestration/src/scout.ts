/**
 * Read-only scout workers (§37.7, §37.8). Scouts may not write, spawn
 * processes with write effects, or hold write path capabilities.
 */
import type {
  AllowedScope,
  Delegation,
  DelegationResult,
  Uuid7,
  ArtifactRef,
} from "@terminus/domain";
import { ValidationError } from "@terminus/domain";

export const SCOUT_FORBIDDEN_CAPABILITIES: readonly string[] = Object.freeze([
  "filesystem.write",
  "filesystem.patch",
  "git.commit",
  "git.push",
  "process.exec_write",
  "secrets.write",
]);

export interface ScoutSpawnInput {
  readonly parentTaskId: Uuid7;
  readonly objective: string;
  readonly readPaths: readonly string[];
  readonly startingReferences: readonly ArtifactRef[];
  readonly budgets: Delegation["budgets"];
  readonly stopConditions?: readonly string[];
}

export interface ScoutDelegationPort {
  create(input: {
    readonly parentTaskId: Uuid7;
    readonly role: "scout";
    readonly objective: string;
    readonly scope: AllowedScope;
    readonly nonGoals: readonly string[];
    readonly startingReferences: readonly ArtifactRef[];
    readonly requiredCapabilities: readonly string[];
    readonly forbiddenCapabilities: readonly string[];
    readonly acceptanceTests: readonly string[];
    readonly resultSchemaVersion: string;
    readonly budgets: Delegation["budgets"];
    readonly stopConditions: readonly string[];
    readonly worktreeId: string | null;
  }): Promise<Delegation>;
}

export class ReadOnlyScoutService {
  constructor(private readonly delegations: ScoutDelegationPort) {}

  async spawn(input: ScoutSpawnInput): Promise<Delegation> {
    if (input.readPaths.length === 0) {
      throw new ValidationError("scout requires at least one read path");
    }
    const scope: AllowedScope = {
      readPaths: input.readPaths,
      writePaths: [],
      externalSystems: [],
    };
    return this.delegations.create({
      parentTaskId: input.parentTaskId,
      role: "scout",
      objective: input.objective,
      scope,
      nonGoals: ["mutate workspace", "commit changes", "merge branches"],
      startingReferences: input.startingReferences,
      requiredCapabilities: ["filesystem.read"],
      forbiddenCapabilities: SCOUT_FORBIDDEN_CAPABILITIES,
      acceptanceTests: [],
      resultSchemaVersion: "1",
      budgets: input.budgets,
      stopConditions: input.stopConditions ?? ["budget_exhausted", "objective_answered"],
      worktreeId: null,
    });
  }

  assertReadOnlyResult(delegation: Delegation, result: DelegationResult): void {
    if (delegation.role !== "scout") {
      throw new ValidationError("not a scout delegation", { role: delegation.role });
    }
    if (delegation.allowedWritePaths.length > 0) {
      throw new ValidationError("scout must have empty writePaths");
    }
    if (result.changedFiles.length > 0) {
      throw new ValidationError("scout result reports changed files", {
        changedFiles: result.changedFiles,
      });
    }
    if (result.commit !== null) {
      throw new ValidationError("scout result must not include a commit");
    }
    for (const cap of delegation.forbiddenCapabilities) {
      if (delegation.requiredCapabilities.includes(cap)) {
        throw new ValidationError("scout required a forbidden capability", { cap });
      }
    }
  }
}
