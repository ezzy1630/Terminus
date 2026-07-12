/**
 * @forge/policy-coordinator — high-level policy coordinator.
 *
 * Per SPEC §13, §36: translates task contracts into kernel capability
 * requests. `PolicyCoordinator` with `authorizeEffect(intent, task, scope)`,
 * `requestApproval(operationHash, scope, risk)`, `resolveApproval(id,
 * decision)`. Bridges `@forge/task-runtime` and the kernel RPC client.
 */
import type {
  Uuid7,
  Rfc3339Timestamp,
  RiskClass,
  Approval,
  ApprovalDecision,
  PolicyDecision,
  PrincipalId,
  AllowedScope,
} from "@forge/domain";
import {
  ApprovalRequiredError,
  PolicyDeniedError,
  ValidationError,
  ConflictError,
} from "@forge/domain";

// ────────────────────────── Effect intent ────────────────────────────────────

export interface EffectIntent {
  readonly effectType: string;
  readonly normalizedCommand: string | null;
  readonly targetPath: string | null;
  readonly externalSystem: string | null;
  readonly userIntentRef: string;
  readonly taskContractHash: string;
  readonly trustLabel: "trusted" | "derived" | "untrusted";
  readonly confidentialityLabel: "public" | "workspace" | "secret_adjacent" | "secret";
  readonly taintSources: readonly string[];
  readonly requestedPolicyProfile: string;
}

// ────────────────────────── Kernel client ────────────────────────────────────

export interface KernelPolicyClient {
  authorize(
    intent: EffectIntent,
    scope: AllowedScope,
    profile: string,
  ): Promise<{ readonly decision: "allow" | "deny" | "prompt"; readonly matchedRules: readonly string[]; readonly reason: string }>;
  recordApproval(approval: Approval): Promise<void>;
  mintCapabilityToken(
    intent: EffectIntent,
    decision: PolicyDecision,
  ): Promise<string>;
}

// ────────────────────────── Repository ───────────────────────────────────────

export interface PolicyRepository {
  createPolicyDecision(d: PolicyDecision): Promise<PolicyDecision>;
  createApproval(a: Approval): Promise<Approval>;
  getApproval(id: Uuid7): Promise<Approval | null>;
  updateApproval(a: Approval): Promise<Approval>;
}

// ────────────────────────── Service ──────────────────────────────────────────

export interface PolicyCoordinatorDeps {
  readonly repo: PolicyRepository;
  readonly kernel: KernelPolicyClient;
  readonly idSource: () => Uuid7;
  readonly clock: () => Rfc3339Timestamp;
}

/**
 * Result of `authorizeEffect`. Per SPEC §31.6 / §13.2, authorized effects
 * MUST carry a capability token; the coordinator mints one via the kernel
 * and returns it alongside the persisted decision so the caller can pass it
 * to the kernel effect dispatcher.
 */
export interface AuthorizeEffectResult {
  readonly decision: PolicyDecision;
  /** Minted capability token; null only when the decision is not `allow`. */
  readonly capabilityToken: string;
}

export class PolicyCoordinator {
  constructor(private readonly deps: PolicyCoordinatorDeps) {}

  /**
   * Authorize an effect against policy. Returns the persisted PolicyDecision
   * and the minted capability token (SPEC §31.6 / §13.2) so the caller can
   * pass it to the kernel effect. If policy returns `prompt`, throws
   * `ApprovalRequiredError` with the pending approval id so the caller can
   * surface it to the user.
   */
  async authorizeEffect(
    intent: EffectIntent,
    taskId: Uuid7,
    scope: AllowedScope,
    principal: PrincipalId,
  ): Promise<AuthorizeEffectResult> {
    const kernelDecision = await this.deps.kernel.authorize(
      intent,
      scope,
      intent.requestedPolicyProfile,
    );
    const decision: PolicyDecision = {
      id: this.deps.idSource(),
      effectType: intent.effectType,
      normalizedCommand: intent.normalizedCommand,
      decision: kernelDecision.decision,
      matchedRules: kernelDecision.matchedRules,
      reason: kernelDecision.reason,
      sandboxProfile: intent.requestedPolicyProfile,
      approvalRequired: kernelDecision.decision === "prompt",
      decidedAt: this.deps.clock(),
    };
    const saved = await this.deps.repo.createPolicyDecision(decision);
    if (saved.decision === "deny") {
      throw new PolicyDeniedError(saved.reason, {
        decisionId: saved.id,
        effectType: intent.effectType,
      });
    }
    if (saved.decision === "prompt") {
      const approval = await this.requestApproval(
        `${intent.effectType}:${intent.normalizedCommand ?? intent.targetPath ?? intent.externalSystem}`,
        scope,
        riskFromIntent(intent),
        taskId,
        principal,
        saved,
      );
      throw new ApprovalRequiredError(
        `effect requires approval: ${approval.operationSummary}`,
        { approvalId: approval.id, decisionId: saved.id },
      );
    }
    // Mint a capability token for the kernel. SPEC §31.6 / §13.2 require
    // that authorized effects carry the token; we return it so the caller
    // can forward it to the kernel effect dispatcher.
    const capabilityToken = await this.deps.kernel.mintCapabilityToken(intent, saved);
    return { decision: saved, capabilityToken };
  }

  /** Request approval for an operation. */
  async requestApproval(
    operationSummary: string,
    scope: AllowedScope,
    risk: RiskClass,
    taskId: Uuid7,
    requestedBy: PrincipalId,
    policyDecision: PolicyDecision,
  ): Promise<Approval> {
    const now = this.deps.clock();
    const approval: Approval = {
      id: this.deps.idSource(),
      taskId,
      operationSummary,
      exactAction: policyDecision.normalizedCommand ?? operationSummary,
      resolvedResources: scope.writePaths,
      reason: policyDecision.reason,
      risk,
      reversibility: risk === "critical" ? "irreversible" : "reversible",
      externalEffect: policyDecision.effectType.startsWith("external."),
      originatingUserIntent: policyDecision.reason,
      untrustedInfluence: false,
      policyRules: policyDecision.matchedRules,
      previewArtifactHashes: [],
      state: "pending",
      decision: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: now,
    };
    void requestedBy;
    return this.deps.repo.createApproval(approval);
  }

  /** Resolve a pending approval. */
  async resolveApproval(
    approvalId: Uuid7,
    decision: ApprovalDecision,
    decidedBy: PrincipalId,
  ): Promise<Approval> {
    const a = await this.requireApproval(approvalId);
    if (a.state !== "pending") {
      throw new ConflictError(
        "ALREADY_EXISTS",
        `approval ${approvalId} already ${a.state}`,
        { approvalId, state: a.state },
      );
    }
    const state: Approval["state"] =
      decision === "stop_task"
        ? "cancelled"
        : decision.startsWith("allow")
          ? "approved"
          : "denied";
    const resolved: Approval = {
      ...a,
      state,
      decision,
      decidedBy,
      decidedAt: this.deps.clock(),
    };
    const saved = await this.deps.repo.updateApproval(resolved);
    await this.deps.kernel.recordApproval(saved);
    return saved;
  }

  private async requireApproval(id: Uuid7): Promise<Approval> {
    const a = await this.deps.repo.getApproval(id);
    if (a === null) throw new ValidationError("approval not found", { approvalId: id });
    return a;
  }
}

function riskFromIntent(intent: EffectIntent): RiskClass {
  if (intent.confidentialityLabel === "secret") return "critical";
  if (intent.taintSources.length > 0) return "high";
  if (intent.effectType.startsWith("external.")) return "high";
  if (intent.trustLabel === "untrusted") return "high";
  return "normal";
}

export type { Uuid7, RiskClass, Approval, ApprovalDecision, PolicyDecision, PrincipalId, AllowedScope };
