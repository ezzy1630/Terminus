/**
 * Review-finding lifecycle (§40.7). Detached reviewer findings are first-class
 * and block completion while OPEN/ACCEPTED/FIXED/DISPUTED.
 */
import type {
  ReviewFinding,
  ReviewFindingLifecycle,
  Uuid7,
  Rfc3339Timestamp,
  ArtifactRef,
} from "@terminus/domain";
import {
  ValidationError,
  isReviewFindingTransitionAllowed,
  findingBlocksCompletion,
  ReviewFindingTerminal,
} from "@terminus/domain";

export interface FindingStore {
  save(finding: ReviewFinding): Promise<ReviewFinding>;
  get(id: Uuid7): Promise<ReviewFinding | null>;
  listForTask(taskId: Uuid7): Promise<readonly ReviewFinding[]>;
}

export class InMemoryFindingStore implements FindingStore {
  private readonly byId = new Map<string, ReviewFinding>();
  private readonly byTask = new Map<string, Set<string>>();

  async save(finding: ReviewFinding): Promise<ReviewFinding> {
    this.byId.set(finding.id, finding);
    const set = this.byTask.get(finding.taskId) ?? new Set<string>();
    set.add(finding.id);
    this.byTask.set(finding.taskId, set);
    return finding;
  }

  async get(id: Uuid7): Promise<ReviewFinding | null> {
    return this.byId.get(id) ?? null;
  }

  async listForTask(taskId: Uuid7): Promise<readonly ReviewFinding[]> {
    const ids = this.byTask.get(taskId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.byId.get(id))
      .filter((f): f is ReviewFinding => f !== undefined);
  }
}

export interface ReviewFindingServiceDeps {
  readonly store: FindingStore;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
}

export class ReviewFindingService {
  constructor(private readonly deps: ReviewFindingServiceDeps) {}

  async open(input: {
    readonly taskId: Uuid7;
    readonly delegationId: Uuid7 | null;
    readonly verificationPlanId: Uuid7 | null;
    readonly title: string;
    readonly body: string;
    readonly severity: ReviewFinding["severity"];
    readonly affectedPaths: readonly string[];
    readonly evidence: readonly ArtifactRef[];
  }): Promise<ReviewFinding> {
    const now = this.deps.clock();
    const finding: ReviewFinding = {
      id: this.deps.idSource(),
      taskId: input.taskId,
      delegationId: input.delegationId,
      verificationPlanId: input.verificationPlanId,
      title: input.title,
      body: input.body,
      severity: input.severity,
      lifecycle: "OPEN",
      affectedPaths: input.affectedPaths,
      evidence: input.evidence,
      createdAt: now,
      updatedAt: now,
    };
    return this.deps.store.save(finding);
  }

  async transition(id: Uuid7, to: ReviewFindingLifecycle): Promise<ReviewFinding> {
    const finding = await this.deps.store.get(id);
    if (finding === null) throw new ValidationError("finding not found", { id });
    if (ReviewFindingTerminal.has(finding.lifecycle)) {
      throw new ValidationError("finding is terminal", { lifecycle: finding.lifecycle });
    }
    if (!isReviewFindingTransitionAllowed(finding.lifecycle, to)) {
      throw new ValidationError("illegal finding lifecycle transition", {
        from: finding.lifecycle,
        to,
      });
    }
    return this.deps.store.save({
      ...finding,
      lifecycle: to,
      updatedAt: this.deps.clock(),
    });
  }

  async blockingForTask(taskId: Uuid7): Promise<readonly ReviewFinding[]> {
    const all = await this.deps.store.listForTask(taskId);
    return all.filter((f) => findingBlocksCompletion(f.lifecycle));
  }

  async completionAllowed(taskId: Uuid7): Promise<boolean> {
    const blockers = await this.blockingForTask(taskId);
    return blockers.length === 0;
  }
}

/**
 * Detached reviewer trigger evaluation — wraps ReviewerPolicy outcome into a
 * spawn decision for a reviewer delegation.
 */
export interface DetachedReviewerTrigger {
  readonly spawn: boolean;
  readonly mandatory: boolean;
  readonly reason: string;
}

export function detachedReviewerTrigger(
  policyResult: { readonly reason: string; readonly mandatory: boolean } | null,
): DetachedReviewerTrigger {
  if (policyResult === null) {
    return { spawn: false, mandatory: false, reason: "no reviewer trigger" };
  }
  return {
    spawn: true,
    mandatory: policyResult.mandatory,
    reason: policyResult.reason,
  };
}
