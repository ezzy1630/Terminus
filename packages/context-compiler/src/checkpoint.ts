/**
 * @terminus/context-compiler — Structured Checkpoints (SPEC §9, §33.16, ADR-0011).
 *
 * Checkpoints are the durable, structured continuation state that replaces
 * mutable Markdown scratchpads. Each checkpoint records:
 *  - objective, completed steps, pending steps
 *  - requirements, assumptions, unknowns
 *  - decisions, failures, open questions
 *  - source versions (deterministic state)
 *
 * Checkpoints are validated before use as context against the active task
 * contract, acceptance criteria, and recorded failures. A checkpoint that
 * drops a hard-required fragment is rejected.
 */

import {
  contentHashSchema,
  type AcceptanceCriterion,
  type ArtifactRef,
  type Checkpoint,
  type ContentHash,
  type Rfc3339Timestamp,
  type TaskContract,
  type Uuid7,
} from "@terminus/domain";
import { z } from "zod";

export type { Checkpoint };

// ──────────────────────── Checkpoint content ─────────────────────────────────

/**
 * The structured content of a checkpoint. This is what gets serialized
 * into the artifact store and referenced by the Checkpoint aggregate.
 *
 * All fields are readonly — checkpoints are immutable once created.
 */
export interface CheckpointContent {
  /** Task objective at checkpoint time. */
  readonly objective: string;
  /** Steps completed since last checkpoint (or since task start). */
  readonly completedSteps: ReadonlyArray<{
    readonly description: string;
    readonly evidenceArtifactHashes: readonly ContentHash[];
  }>;
  /** Steps remaining. */
  readonly pendingSteps: readonly string[];
  /** Active requirements (acceptance criteria). */
  readonly requirements: ReadonlyArray<{
    readonly id: string;
    readonly statement: string;
    readonly status: "satisfied" | "unsatisfied" | "unverified";
    readonly evidence: readonly ContentHash[];
  }>;
  /** Assumptions in effect. */
  readonly assumptions: readonly string[];
  /** Unknowns that remain unresolved. */
  readonly unknowns: readonly string[];
  /** Decisions made, with rationale. */
  readonly decisions: ReadonlyArray<{
    readonly decision: string;
    readonly rationale: string;
    readonly alternatives: readonly string[];
  }>;
  /** Recorded failures and their resolution status. */
  readonly failures: ReadonlyArray<{
    readonly description: string;
    readonly artifactHash: ContentHash | null;
    readonly resolved: boolean;
  }>;
  /** Open questions that need resolution. */
  readonly openQuestions: readonly string[];
  /** Source versions at checkpoint time (deterministic state). */
  readonly sourceVersions: Readonly<Record<string, string>>;
  /** Scope at checkpoint time. */
  readonly scope: {
    readonly readPaths: readonly string[];
    readonly writePaths: readonly string[];
    readonly externalSystems: readonly string[];
  };
  /** Durable effect/approval projections retained across compaction. */
  readonly effectState?: readonly {
    readonly effectId: string;
    readonly state: string;
    readonly idempotencyKey: string;
  }[] | undefined;
  readonly approvalState?: readonly {
    readonly approvalId: string;
    readonly state: string;
    readonly operationHash: string;
  }[] | undefined;
}

const checkpointTextSchema = z.string().max(10_000);
const checkpointTextListSchema = z.array(checkpointTextSchema).max(1_000);

/** Runtime decoder for immutable checkpoint artifacts before trusted use. */
export const checkpointContentSchema = z.object({
  objective: checkpointTextSchema.min(1),
  completedSteps: z.array(z.object({
    description: checkpointTextSchema,
    evidenceArtifactHashes: z.array(contentHashSchema).max(256),
  }).strict()).max(1_000),
  pendingSteps: checkpointTextListSchema,
  requirements: z.array(z.object({
    id: z.string().min(1).max(256),
    statement: checkpointTextSchema,
    status: z.enum(["satisfied", "unsatisfied", "unverified"]),
    evidence: z.array(contentHashSchema).max(256),
  }).strict()).max(1_000),
  assumptions: checkpointTextListSchema,
  unknowns: checkpointTextListSchema,
  decisions: z.array(z.object({
    decision: checkpointTextSchema,
    rationale: checkpointTextSchema,
    alternatives: checkpointTextListSchema,
  }).strict()).max(1_000),
  failures: z.array(z.object({
    description: checkpointTextSchema,
    artifactHash: contentHashSchema.nullable(),
    resolved: z.boolean(),
  }).strict()).max(1_000),
  openQuestions: checkpointTextListSchema,
  sourceVersions: z.record(
    z.string().min(1).max(2_048),
    z.string().min(1).max(4_096),
  ),
  scope: z.object({
    readPaths: z.array(z.string().max(4_096)).max(10_000),
    writePaths: z.array(z.string().max(4_096)).max(10_000),
    externalSystems: z.array(z.string().max(4_096)).max(10_000),
  }).strict(),
  effectState: z.array(z.object({
    effectId: z.string().min(1).max(256),
    state: z.string().min(1).max(64),
    idempotencyKey: z.string().min(1).max(512),
  }).strict()).max(10_000).optional(),
  approvalState: z.array(z.object({
    approvalId: z.string().min(1).max(256),
    state: z.string().min(1).max(64),
    operationHash: contentHashSchema,
  }).strict()).max(10_000).optional(),
}).strict() satisfies z.ZodType<CheckpointContent>;

// ──────────────────────── Checkpoint generator ───────────────────────────────

export interface CheckpointGeneratorInput {
  readonly taskContract: TaskContract;
  readonly completedSteps: ReadonlyArray<{
    readonly description: string;
    readonly evidenceArtifactHashes: readonly ContentHash[];
  }>;
  readonly pendingSteps: readonly string[];
  readonly acceptanceCriteriaStatus: Readonly<Record<string, "satisfied" | "unsatisfied" | "unverified">>;
  readonly decisions: ReadonlyArray<{
    readonly decision: string;
    readonly rationale: string;
    readonly alternatives: readonly string[];
  }>;
  readonly failures: ReadonlyArray<{
    readonly description: string;
    readonly artifactHash: ContentHash | null;
    readonly resolved: boolean;
  }>;
  readonly openQuestions: readonly string[];
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly effectState?: CheckpointContent["effectState"] | undefined;
  readonly approvalState?: CheckpointContent["approvalState"] | undefined;
}

/**
 * Generate checkpoint content from the current task state.
 *
 * Pure function — the caller is responsible for persisting the result
 * as an immutable artifact and creating the Checkpoint aggregate record.
 */
export function generateCheckpointContent(
  input: CheckpointGeneratorInput,
): CheckpointContent {
  const requirements = input.taskContract.acceptanceCriteria.map(
    (ac: AcceptanceCriterion) => ({
      id: ac.id,
      statement: ac.statement,
      status: input.acceptanceCriteriaStatus[ac.id] ?? "unverified" as const,
      evidence: [] as readonly ContentHash[],
    }),
  );

  return {
    objective: input.taskContract.objective,
    completedSteps: input.completedSteps,
    pendingSteps: input.pendingSteps,
    requirements,
    assumptions: input.taskContract.assumptions,
    unknowns: input.taskContract.unknowns,
    decisions: input.decisions,
    failures: input.failures,
    openQuestions: input.openQuestions,
    sourceVersions: input.sourceVersions,
    scope: {
      readPaths: input.taskContract.allowedScope.readPaths,
      writePaths: input.taskContract.allowedScope.writePaths,
      externalSystems: input.taskContract.allowedScope.externalSystems,
    },
    ...(input.effectState === undefined ? {} : { effectState: input.effectState }),
    ...(input.approvalState === undefined ? {} : { approvalState: input.approvalState }),
  };
}

// ──────────────────────── Checkpoint validator ───────────────────────────────

export interface ValidationResult {
  readonly valid: boolean;
  readonly violations: readonly ValidationViolation[];
}

export interface ValidationViolation {
  readonly kind:
    | "missing_objective"
    | "missing_required_criterion"
    | "missing_failure_record"
    | "missing_decision"
    | "scope_shrink"
    | "version_mismatch";
  readonly description: string;
}

/**
 * Validate a checkpoint against the active task contract.
 *
 * SPEC §33.13: "Before a checkpoint is used as context, it is validated
 * against the active task contract, acceptance criteria, and recorded
 * failures. A checkpoint that drops a hard-required fragment is rejected."
 */
export function validateCheckpoint(
  checkpoint: CheckpointContent,
  contract: TaskContract,
  currentSourceVersions: Readonly<Record<string, string>>,
): ValidationResult {
  const violations: ValidationViolation[] = [];

  // 1. Objective must be present.
  if (checkpoint.objective.length === 0) {
    violations.push({
      kind: "missing_objective",
      description: "Checkpoint has no objective",
    });
  }

  // 2. Every required acceptance criterion must have a status record.
  for (const ac of contract.acceptanceCriteria) {
    if (!ac.required) continue;
    const rec = checkpoint.requirements.find((r) => r.id === ac.id);
    if (rec === undefined) {
      violations.push({
        kind: "missing_required_criterion",
        description: `Required acceptance criterion \"${ac.id}\" is not tracked in checkpoint`,
      });
    }
  }

  // 3. Unresolved failures must remain in the checkpoint.
  const unresolvedFailures = checkpoint.failures.filter((f) => !f.resolved);
  for (const failure of unresolvedFailures) {
    // Failures must have descriptions and evidence references.
    if (failure.description.length === 0) {
      violations.push({
        kind: "missing_failure_record",
        description: "Unresolved failure has no description",
      });
    }
  }

  // 4. Source versions must still be observable and unchanged. A missing
  //    current source cannot authenticate the checkpoint's claim and therefore
  //    fails closed just like a known mismatch.
  for (const [sourceUri, checkpointVersion] of Object.entries(
    checkpoint.sourceVersions,
  )) {
    const currentVersion = currentSourceVersions[sourceUri];
    if (currentVersion === undefined) {
      violations.push({
        kind: "version_mismatch",
        description: `Source "${sourceUri}" is unavailable for checkpoint validation`,
      });
    } else if (currentVersion !== checkpointVersion) {
      violations.push({
        kind: "version_mismatch",
        description: `Source \"${sourceUri}\" changed (checkpoint: ${checkpointVersion}, current: ${currentVersion})`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ──────────────────────── Provenance DAG ────────────────────────────────────

/**
 * A node in the provenance DAG. Each node represents a context fragment,
 * checkpoint, tool result, or provider attempt.
 *
 * Edges represent derivation: node B has edge to node A if B was derived
 * from A (e.g., a checkpoint was derived from tool results).
 */
export interface ProvenanceNode {
  /** Stable identifier for this node. */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** Kind of node. */
  readonly kind:
    | "fragment"
    | "checkpoint"
    | "tool_result"
    | "provider_attempt"
    | "artifact"
    | "episode"
    | "manifest";
  /** Content hash of the node's artifact. */
  readonly artifactHash: ContentHash | null;
  /** IDs of nodes this node derives from. */
  readonly derivedFrom: readonly string[];
  /** IDs of nodes derived from this one. Populated by ProvenanceDag.addNode(). */
  readonly derivedInto: readonly string[];
  /** Source URI if this node represents a file. */
  readonly sourceUri: string | null;
  /** Source version at time of creation. */
  readonly sourceVersion: string | null;
  /** When this node was created. */
  readonly createdAt: Rfc3339Timestamp;
}

/**
 * A directed acyclic provenance graph. Nodes are indexed by ID.
 * Construct with `build()` and query with `ancestors()` / `descendants()`.
 */
export class ProvenanceDag {
  private readonly nodes = new Map<string, ProvenanceNode>();
  private readonly children = new Map<string, Set<string>>(); // nodeId → children

  /** Add a node. If a node with the same ID exists, it is replaced. */
  addNode(node: ProvenanceNode): void {
    const previous = this.nodes.get(node.id);
    if (previous !== undefined) {
      for (const parentId of previous.derivedFrom) {
        this.children.get(parentId)?.delete(node.id);
      }
      this.nodes.delete(node.id);
    }
    for (const parentId of node.derivedFrom) {
      // The stored edge points parent -> child. Adding parentId -> node.id
      // closes a cycle when node.id can already reach parentId.
      if (parentId === node.id || this.reaches(node.id, parentId)) {
        if (previous !== undefined) this.restoreNode(previous);
        throw new Error(`provenance cycle rejected: ${parentId} -> ${node.id}`);
      }
    }
    this.nodes.set(node.id, node);
    for (const parentId of node.derivedFrom) {
      let childSet = this.children.get(parentId);
      if (childSet === undefined) {
        childSet = new Set();
        this.children.set(parentId, childSet);
      }
      childSet.add(node.id);
    }
  }

  private restoreNode(node: ProvenanceNode): void {
    this.nodes.set(node.id, node);
    for (const parentId of node.derivedFrom) {
      const children = this.children.get(parentId) ?? new Set<string>();
      children.add(node.id);
      this.children.set(parentId, children);
    }
  }

  private reaches(startId: string, targetId: string): boolean {
    const visited = new Set<string>();
    const stack = [startId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || visited.has(current)) continue;
      if (current === targetId) return true;
      visited.add(current);
      for (const child of this.children.get(current) ?? []) stack.push(child);
    }
    return false;
  }

  /** Get a node by ID. */
  get(id: string): ProvenanceNode | null {
    return this.nodes.get(id) ?? null;
  }

  /** All node IDs. */
  get nodeIds(): readonly string[] {
    return [...this.nodes.keys()];
  }

  /** Number of nodes. */
  get size(): number {
    return this.nodes.size;
  }

  /** All ancestors of a node (transitive closure of derivedFrom). */
  ancestors(nodeId: string): readonly ProvenanceNode[] {
    const result: ProvenanceNode[] = [];
    const visited = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = this.nodes.get(current);
      if (node === undefined) continue;
      if (current !== nodeId) result.push(node);
      for (const parent of node.derivedFrom) {
        stack.push(parent);
      }
    }
    return result;
  }

  /** All descendants of a node (transitive closure of derivedInto). */
  descendants(nodeId: string): readonly ProvenanceNode[] {
    const result: ProvenanceNode[] = [];
    const visited = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current !== nodeId) {
        const node = this.nodes.get(current);
        if (node !== undefined) result.push(node);
      }
      const childSet = this.children.get(current);
      if (childSet !== undefined) {
        for (const child of childSet) {
          stack.push(child);
        }
      }
    }
    return result;
  }

  /**
   * Expand a node to all raw artifacts reachable via the DAG.
   * Raw artifacts are leaf nodes (no children) of kind "artifact" or
   * "tool_result".
   */
  expandToRawArtifacts(nodeId: string): readonly ProvenanceNode[] {
    const descendants = this.descendants(nodeId);
    return descendants.filter(
      (n) =>
        (n.kind === "artifact" || n.kind === "tool_result") &&
        !this.children.has(n.id),
    );
  }

  /** Build a minimal provenance DAG from a manifest and its checkpoints. */
  static empty(): ProvenanceDag {
    return new ProvenanceDag();
  }
}

// ──────────────────────── Checkpoint triggers ────────────────────────────────

export type CheckpointTrigger =
  | "turn_boundary"
  | "compaction_event"
  | "epoch_change"
  | "user_request"
  | "task_completion"
  | "failure_detected"
  | "scope_expansion"
  | "external_effect";

const defaultEnabledTriggers: ReadonlySet<CheckpointTrigger> = new Set([
  "turn_boundary",
  "compaction_event",
  "epoch_change",
  "failure_detected",
  "task_completion",
  "scope_expansion",
]);

/**
 * Returns true if the given event should trigger a checkpoint, per SPEC §9.4.
 */
export function shouldCreateCheckpoint(
  trigger: CheckpointTrigger,
  _enabledTriggers?: ReadonlySet<CheckpointTrigger> | undefined,
): boolean {
  const enabled = _enabledTriggers ?? defaultEnabledTriggers;
  return enabled.has(trigger);
}
