/**
 * Provider-neutral admission and evidence contract for governed computer use.
 *
 * This module never captures a screen, drives a browser/desktop, or performs a
 * kernel RPC. It verifies trusted adapter receipts before admitting a typed
 * action and binds any later settlement to the exact effect and observations.
 */
import { canonicalJson, computeContentHash } from "@terminus/context-ir";
import {
  artifactUriSchema,
  computerUseActionSchema,
  contentHashSchema,
  poolLeaseSchema,
  rfc3339Schema,
  uiObservationSchema,
  IntegrityError,
  SandboxUnavailableError,
  ValidationError,
  type ArtifactUri,
  type ComputerUseAction,
  type ComputerUseActionKind,
  type ComputerUseEffectClass,
  type ContentHash,
  type PoolLease,
  type Rfc3339Timestamp,
  type UiObservation,
} from "@terminus/domain";
import { z } from "zod";
import { SemanticTargetVerifier } from "./semantic_target_verifier.js";

const SURFACES = ["browser", "desktop"] as const;
const ACTION_KINDS = [
  "click",
  "double_click",
  "right_click",
  "hover",
  "type_text",
  "key_press",
  "key_combination",
  "scroll",
  "drag_and_drop",
  "navigate",
  "fill",
  "select",
  "upload",
  "download",
  "submit",
  "take_screenshot",
  "extract_dom",
  "focus_element",
  "select_option",
] as const satisfies readonly ComputerUseActionKind[];
const EFFECT_CLASSES = [
  "read_only",
  "bufferable_local",
  "reversible_external",
  "compensable_external",
  "irreversible",
  "unknown_semantics",
] as const satisfies readonly ComputerUseEffectClass[];
const INJECTION_SOURCES = [
  "repository",
  "web",
  "issue",
  "clipboard",
  "mcp",
  "plugin",
  "external_agent",
  "unknown",
] as const;
const INJECTION_RISKS = ["none", "low", "medium", "high"] as const;

export type ComputerUseSurface = (typeof SURFACES)[number];
export type ComputerUseInjectionSource = (typeof INJECTION_SOURCES)[number];
export type ComputerUseInjectionRisk = (typeof INJECTION_RISKS)[number];
export type ComputerUseTaintLabel = UiObservation["taintLabel"];

export interface TrustedObservationReceipt {
  readonly receiptId: string;
  readonly adapterId: string;
  readonly taskId: string;
  readonly observationId: string;
  readonly observationVersion: number;
  readonly observationHash: ContentHash;
  readonly receiptArtifactUri: ArtifactUri;
  readonly receiptArtifactHash: ContentHash;
  readonly observedAt: Rfc3339Timestamp;
}

export const trustedObservationReceiptSchema = z.object({
  receiptId: z.string().min(1),
  adapterId: z.string().min(1),
  taskId: z.string().min(1),
  observationId: z.string().min(1),
  observationVersion: z.number().int().positive(),
  observationHash: contentHashSchema,
  receiptArtifactUri: artifactUriSchema,
  receiptArtifactHash: contentHashSchema,
  observedAt: rfc3339Schema,
}).strict();

export interface TrustedUiObservation {
  readonly observation: UiObservation;
  readonly observationHash: ContentHash;
  readonly receipt: TrustedObservationReceipt;
}

export interface ObservationReceiptVerifier {
  readonly verify: (input: {
    readonly observation: UiObservation;
    readonly observationHash: ContentHash;
    readonly receipt: TrustedObservationReceipt;
  }) => boolean;
}

export interface ActionInfluence {
  readonly influencedByUntrustedContent: boolean;
  readonly injectionRisk: ComputerUseInjectionRisk;
  readonly sources: readonly ComputerUseInjectionSource[];
}

export const actionInfluenceSchema = z.object({
  influencedByUntrustedContent: z.boolean(),
  injectionRisk: z.enum(INJECTION_RISKS),
  sources: z.array(z.enum(INJECTION_SOURCES)).max(8),
}).strict().superRefine((influence, context) => {
  if (influence.influencedByUntrustedContent && influence.sources.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["sources"],
      message: "untrusted influence must name at least one source",
    });
  }
});

export interface ComputerUsePolicy {
  readonly policyId: string;
  readonly version: string;
  readonly allowedSurfaces: readonly ComputerUseSurface[];
  readonly allowedActionKinds: readonly ComputerUseActionKind[];
  readonly allowedEffectClasses: readonly ComputerUseEffectClass[];
  readonly requireApprovalFor: readonly ComputerUseEffectClass[];
  readonly denyUntrustedExternalEffects: boolean;
  readonly maxAttempts: number;
}

export const computerUsePolicySchema = z.object({
  policyId: z.string().min(1),
  version: z.string().min(1),
  allowedSurfaces: z.array(z.enum(SURFACES)).min(1),
  allowedActionKinds: z.array(z.enum(ACTION_KINDS)).min(1),
  allowedEffectClasses: z.array(z.enum(EFFECT_CLASSES)).min(1),
  requireApprovalFor: z.array(z.enum(EFFECT_CLASSES)),
  denyUntrustedExternalEffects: z.boolean(),
  maxAttempts: z.number().int().positive().max(8),
}).strict();

export interface ComputerUseApproval {
  readonly approvalId: string;
  readonly taskId: string;
  readonly actionHash: ContentHash;
  readonly effectBindingHash: ContentHash;
  readonly approvedBy: string;
  readonly reviewedUntrustedInfluence: boolean;
  readonly expiresAt: Rfc3339Timestamp;
  readonly status: "approved";
}

export const computerUseApprovalSchema = z.object({
  approvalId: z.string().min(1),
  taskId: z.string().min(1),
  actionHash: contentHashSchema,
  effectBindingHash: contentHashSchema,
  approvedBy: z.string().min(1),
  reviewedUntrustedInfluence: z.boolean(),
  expiresAt: rfc3339Schema,
  status: z.literal("approved"),
}).strict();

export const computerUseAdmissionDenialReasons = [
  "task_mismatch",
  "stale_observation",
  "surface_not_allowed",
  "action_not_allowed",
  "effect_class_not_allowed",
  "lease_unavailable",
  "target_not_verified",
  "untrusted_influence",
  "approval_required",
  "approval_mismatch",
] as const;
export type ComputerUseAdmissionDenialReason = (typeof computerUseAdmissionDenialReasons)[number];

export interface ComputerUseActionAdmission {
  readonly admitted: true;
  readonly taskId: string;
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly surface: ComputerUseSurface;
  readonly action: ComputerUseAction;
  readonly actionHash: ContentHash;
  readonly effectBindingHash: ContentHash;
  readonly observation: TrustedUiObservation;
  readonly lease: PoolLease;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly maxAttempts: number;
  readonly influence: ActionInfluence;
  readonly semanticVerification: ReturnType<SemanticTargetVerifier["verifyTarget"]> | null;
  readonly approvalId: string | null;
  readonly requiresSettlement: boolean;
}

export interface ComputerUseActionDenial {
  readonly admitted: false;
  readonly taskId: string;
  readonly effectId: string;
  readonly actionId: string;
  readonly actionHash: ContentHash;
  readonly effectBindingHash: ContentHash;
  readonly observationHash: ContentHash;
  readonly observationReceiptId: string;
  readonly surface: ComputerUseSurface;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly taintLabel: ComputerUseTaintLabel;
  readonly influence: ActionInfluence;
  readonly reason: ComputerUseAdmissionDenialReason;
}

export type ComputerUseAdmission = ComputerUseActionAdmission | ComputerUseActionDenial;

export interface KernelActionReceipt {
  readonly receiptId: string;
  readonly effectId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly actionHash: ContentHash;
  readonly effectBindingHash: ContentHash;
  readonly idempotencyKey: string;
  readonly beforeObservationHash: ContentHash;
  readonly afterObservationHash: ContentHash | null;
  readonly outcome: "committed" | "failed" | "unknown";
  readonly receiptArtifactUri: ArtifactUri;
  readonly receiptArtifactHash: ContentHash;
  readonly observedAt: Rfc3339Timestamp;
}

export const kernelActionReceiptSchema = z.object({
  receiptId: z.string().min(1),
  effectId: z.string().min(1),
  taskId: z.string().min(1),
  actionId: z.string().min(1),
  actionHash: contentHashSchema,
  effectBindingHash: contentHashSchema,
  idempotencyKey: z.string().min(1),
  beforeObservationHash: contentHashSchema,
  afterObservationHash: contentHashSchema.nullable(),
  outcome: z.enum(["committed", "failed", "unknown"]),
  receiptArtifactUri: artifactUriSchema,
  receiptArtifactHash: contentHashSchema,
  observedAt: rfc3339Schema,
}).strict().superRefine((receipt, context) => {
  if (receipt.outcome !== "unknown" && receipt.afterObservationHash === null) {
    context.addIssue({
      code: "custom",
      path: ["afterObservationHash"],
      message: "settled action receipts require a trusted after-observation hash",
    });
  }
});

export interface ComputerUseSettlement {
  readonly status: KernelActionReceipt["outcome"];
  readonly effectId: string;
  readonly actionId: string;
  readonly beforeObservationHash: ContentHash;
  readonly afterObservationHash: ContentHash | null;
  readonly receiptId: string;
  readonly receiptArtifactUri: ArtifactUri;
  readonly observedAt: Rfc3339Timestamp;
}

export interface KernelReconciliationReceipt {
  readonly receiptId: string;
  readonly effectId: string;
  readonly taskId: string;
  readonly actionHash: ContentHash;
  readonly effectBindingHash: ContentHash;
  readonly idempotencyKey: string;
  readonly settlement: "executed" | "not_executed";
  readonly afterObservationHash: ContentHash | null;
  readonly receiptArtifactUri: ArtifactUri;
  readonly receiptArtifactHash: ContentHash;
  readonly reconciledAt: Rfc3339Timestamp;
}

export const kernelReconciliationReceiptSchema = z.object({
  receiptId: z.string().min(1),
  effectId: z.string().min(1),
  taskId: z.string().min(1),
  actionHash: contentHashSchema,
  effectBindingHash: contentHashSchema,
  idempotencyKey: z.string().min(1),
  settlement: z.enum(["executed", "not_executed"]),
  afterObservationHash: contentHashSchema.nullable(),
  receiptArtifactUri: artifactUriSchema,
  receiptArtifactHash: contentHashSchema,
  reconciledAt: rfc3339Schema,
}).strict();

export interface KernelReceiptVerifier {
  readonly verifyActionReceipt: (input: {
    readonly receipt: KernelActionReceipt;
    readonly admission: ComputerUseActionAdmission;
  }) => boolean;
  readonly verifyReconciliationReceipt: (input: {
    readonly receipt: KernelReconciliationReceipt;
    readonly admission: ComputerUseActionAdmission;
  }) => boolean;
}

export type ComputerUseRecoveryStatus =
  | "already_committed"
  | "retry_allowed"
  | "manual_review_required";

export interface ComputerUseRecovery {
  readonly status: ComputerUseRecoveryStatus;
  readonly effectId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttempt: number | null;
  readonly requiresFreshObservation: boolean;
  readonly reason:
    | "settlement_already_confirmed"
    | "missing_reconciliation_receipt"
    | "untrusted_reconciliation_receipt"
    | "reconciliation_confirmed_executed"
    | "fresh_observation_required"
    | "retry_budget_exhausted"
    | "reconciliation_confirmed_not_executed";
  readonly reconciliationReceiptId: string | null;
  readonly afterObservationHash: ContentHash | null;
}

export type CompactComputerUseEvidenceStatus =
  | "admitted"
  | "denied"
  | "committed"
  | "failed"
  | "unknown"
  | ComputerUseRecoveryStatus;

export interface CompactComputerUseEvidence {
  readonly schemaVersion: "computer-use-evidence/v1";
  readonly status: CompactComputerUseEvidenceStatus;
  readonly taskId: string;
  readonly effectId: string;
  readonly actionId: string;
  readonly surface: ComputerUseSurface;
  readonly actionHash: ContentHash;
  readonly effectBindingHash: ContentHash;
  readonly beforeObservationHash: ContentHash;
  readonly afterObservationHash: ContentHash | null;
  readonly observationReceiptId: string;
  readonly kernelReceiptId: string | null;
  readonly receiptArtifactUri: ArtifactUri | null;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly taintLabel: ComputerUseTaintLabel;
  readonly influencedByUntrustedContent: boolean;
  readonly injectionRisk: ComputerUseInjectionRisk;
  readonly attempts: number | null;
  readonly maxAttempts: number | null;
  readonly reason: string;
}

export const compactComputerUseEvidenceSchema = z.object({
  schemaVersion: z.literal("computer-use-evidence/v1"),
  status: z.enum([
    "admitted",
    "denied",
    "committed",
    "failed",
    "unknown",
    "already_committed",
    "retry_allowed",
    "manual_review_required",
  ]),
  taskId: z.string().min(1),
  effectId: z.string().min(1),
  actionId: z.string().min(1),
  surface: z.enum(SURFACES),
  actionHash: contentHashSchema,
  effectBindingHash: contentHashSchema,
  beforeObservationHash: contentHashSchema,
  afterObservationHash: contentHashSchema.nullable(),
  observationReceiptId: z.string().min(1),
  kernelReceiptId: z.string().min(1).nullable(),
  receiptArtifactUri: artifactUriSchema.nullable(),
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  taintLabel: z.enum(["SYSTEM_TRUSTED", "USER_TRUSTED", "UNTRUSTED_UI", "UNTRUSTED_WEB"]),
  influencedByUntrustedContent: z.boolean(),
  injectionRisk: z.enum(INJECTION_RISKS),
  attempts: z.number().int().positive().nullable(),
  maxAttempts: z.number().int().positive().nullable(),
  reason: z.string().min(1).max(96),
}).strict();

const TARGETED_ACTIONS: ReadonlySet<ComputerUseActionKind> = new Set([
  "click",
  "double_click",
  "right_click",
  "hover",
  "type_text",
  "key_press",
  "key_combination",
  "drag_and_drop",
  "fill",
  "select",
  "upload",
  "download",
  "submit",
  "focus_element",
  "select_option",
]);

const EXTERNAL_EFFECTS: ReadonlySet<ComputerUseEffectClass> = new Set([
  "reversible_external",
  "compensable_external",
  "irreversible",
  "unknown_semantics",
]);

const INJECTION_RISK_ORDER: Readonly<Record<ComputerUseInjectionRisk, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function maxInjectionRisk(
  left: ComputerUseInjectionRisk,
  right: ComputerUseInjectionRisk,
): ComputerUseInjectionRisk {
  return INJECTION_RISK_ORDER[left] >= INJECTION_RISK_ORDER[right] ? left : right;
}

function artifactContentHash(uri: ArtifactUri): ContentHash {
  return `sha256:${uri.slice("artifact://sha256/".length)}` as ContentHash;
}

function validateArtifactBinding(uri: ArtifactUri, hash: ContentHash, label: string): void {
  if (artifactContentHash(uri) !== hash) {
    throw new IntegrityError(`${label} artifact hash does not match its immutable URI`);
  }
}

export function computeUiObservationHash(observation: UiObservation): ContentHash {
  if (!uiObservationSchema.safeParse(observation).success) {
    throw new ValidationError("UI observation does not satisfy the canonical schema");
  }
  return computeContentHash(canonicalJson(observation));
}

export function computeComputerUseActionHash(
  action: ComputerUseAction,
  observationHash: ContentHash,
): ContentHash {
  if (!computerUseActionSchema.safeParse(action).success) {
    throw new ValidationError("Computer-use action does not satisfy the canonical schema");
  }
  contentHashSchema.parse(observationHash);
  return computeContentHash(canonicalJson({ action, observationHash }));
}

export function computeComputerUseEffectBindingHash(input: {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly surface: ComputerUseSurface;
  readonly leaseId: string;
  readonly poolId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly actionHash: ContentHash;
}): ContentHash {
  if (input.effectId.trim().length === 0 || input.idempotencyKey.trim().length === 0) {
    throw new ValidationError("Computer-use effect and idempotency identities are required");
  }
  return computeContentHash(canonicalJson(input));
}

export function admitTrustedObservation(
  rawObservation: UiObservation,
  rawReceipt: TrustedObservationReceipt,
  verifier: ObservationReceiptVerifier | null,
): TrustedUiObservation {
  if (verifier === null) {
    throw new SandboxUnavailableError(
      "Trusted computer-use observation verification is unavailable",
    );
  }
  if (!uiObservationSchema.safeParse(rawObservation).success) {
    throw new ValidationError("UI observation does not satisfy the canonical schema");
  }
  if (!trustedObservationReceiptSchema.safeParse(rawReceipt).success) {
    throw new ValidationError("Trusted observation receipt does not satisfy the canonical schema");
  }
  const observation = rawObservation;
  const receipt = rawReceipt;
  const observationHash = computeUiObservationHash(observation);
  validateArtifactBinding(receipt.receiptArtifactUri, receipt.receiptArtifactHash, "Observation receipt");
  if (
    receipt.taskId !== observation.taskId
    || receipt.observationId !== observation.id
    || receipt.observationVersion !== observation.version
    || receipt.observationHash !== observationHash
  ) {
    throw new IntegrityError("Trusted observation receipt does not bind the exact observation");
  }
  if (!verifier.verify({ observation, observationHash, receipt })) {
    throw new IntegrityError("Trusted observation receipt was rejected by its verifier");
  }
  return { observation, observationHash, receipt };
}

export interface ComputerUseAdmissionInput {
  readonly taskId: string;
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly surface: ComputerUseSurface;
  readonly action: ComputerUseAction;
  readonly observation: TrustedUiObservation;
  readonly lease: PoolLease;
  readonly policy: ComputerUsePolicy;
  readonly influence: ActionInfluence;
  readonly approval: ComputerUseApproval | null;
}

export interface GovernedComputerUseCoordinatorDeps {
  readonly observationReceipts: ObservationReceiptVerifier | null;
  readonly kernelReceipts: KernelReceiptVerifier | null;
  readonly nowMs?: (() => number) | undefined;
}

export class GovernedComputerUseCoordinator {
  public constructor(
    private readonly deps: GovernedComputerUseCoordinatorDeps,
    private readonly targetVerifier: SemanticTargetVerifier = new SemanticTargetVerifier(),
  ) {}

  public admitTrustedObservation(
    observation: UiObservation,
    receipt: TrustedObservationReceipt,
  ): TrustedUiObservation {
    return admitTrustedObservation(observation, receipt, this.deps.observationReceipts);
  }

  public admitAction(input: ComputerUseAdmissionInput): ComputerUseAdmission {
    const parsedAction = computerUseActionSchema.safeParse(input.action);
    const parsedLease = poolLeaseSchema.safeParse(input.lease);
    const parsedPolicy = computerUsePolicySchema.safeParse(input.policy);
    const parsedInfluence = actionInfluenceSchema.safeParse(input.influence);
    if (!parsedAction.success || !parsedLease.success || !parsedPolicy.success || !parsedInfluence.success) {
      throw new ValidationError("Computer-use admission input does not satisfy its contract");
    }
    const action = input.action;
    const observation = this.admitTrustedObservation(
      input.observation.observation,
      input.observation.receipt,
    );
    if (observation.observationHash !== input.observation.observationHash) {
      throw new IntegrityError("Computer-use admission received a tampered observation hash");
    }
    const policy = input.policy;
    const influence = this.deriveInfluence(observation.observation, input.influence);
    const actionHash = computeComputerUseActionHash(action, observation.observationHash);
    const effectBindingHash = computeComputerUseEffectBindingHash({
      effectId: input.effectId,
      idempotencyKey: input.idempotencyKey,
      taskId: input.taskId,
      surface: input.surface,
      leaseId: input.lease.leaseId,
      poolId: input.lease.poolId,
      policyId: policy.policyId,
      policyVersion: policy.version,
      actionHash,
    });
    const base = {
      taskId: input.taskId,
      effectId: input.effectId,
      actionId: action.actionId,
      actionHash,
      effectBindingHash,
      observationHash: observation.observationHash,
      observationReceiptId: observation.receipt.receiptId,
      surface: input.surface,
      policyId: policy.policyId,
      policyVersion: policy.version,
      taintLabel: observation.observation.taintLabel,
      influence,
    } as const;

    if (input.taskId !== action.taskId || input.taskId !== observation.observation.taskId) {
      return { ...base, admitted: false, reason: "task_mismatch" };
    }
    if (
      action.observationId !== observation.observation.id
      || action.observationVersion !== observation.observation.version
    ) {
      return { ...base, admitted: false, reason: "stale_observation" };
    }
    if (!policy.allowedSurfaces.includes(input.surface)) {
      return { ...base, admitted: false, reason: "surface_not_allowed" };
    }
    if (!policy.allowedActionKinds.includes(action.kind)) {
      return { ...base, admitted: false, reason: "action_not_allowed" };
    }
    if (!policy.allowedEffectClasses.includes(action.effectClass)) {
      return { ...base, admitted: false, reason: "effect_class_not_allowed" };
    }
    if (
      input.lease.status !== "active"
      || input.lease.taskId !== input.taskId
      || Date.parse(input.lease.expiresAt) <= (this.deps.nowMs?.() ?? Date.now())
    ) {
      return { ...base, admitted: false, reason: "lease_unavailable" };
    }

    const semanticVerification = TARGETED_ACTIONS.has(action.kind)
      ? this.targetVerifier.verifyTarget(observation.observation, action)
      : null;
    if (semanticVerification !== null && semanticVerification.verdict !== "verified") {
      return { ...base, admitted: false, reason: "target_not_verified" };
    }

    const externalEffect = EXTERNAL_EFFECTS.has(action.effectClass);
    if (externalEffect && influence.influencedByUntrustedContent && policy.denyUntrustedExternalEffects) {
      return { ...base, admitted: false, reason: "untrusted_influence" };
    }
    const approvalRequired = policy.requireApprovalFor.includes(action.effectClass)
      || (externalEffect && influence.influencedByUntrustedContent);
    if (approvalRequired && input.approval === null) {
      return { ...base, admitted: false, reason: "approval_required" };
    }
    if (approvalRequired && input.approval !== null && !this.approvalMatches(input, effectBindingHash, actionHash, influence)) {
      return { ...base, admitted: false, reason: "approval_mismatch" };
    }

    return {
      admitted: true,
      taskId: input.taskId,
      effectId: input.effectId,
      idempotencyKey: input.idempotencyKey,
      surface: input.surface,
      action,
      actionHash,
      effectBindingHash,
      observation,
      lease: input.lease,
      policyId: policy.policyId,
      policyVersion: policy.version,
      maxAttempts: policy.maxAttempts,
      influence,
      semanticVerification,
      approvalId: input.approval?.approvalId ?? null,
      requiresSettlement: action.effectClass !== "read_only",
    };
  }

  public settleAction(input: {
    readonly admission: ComputerUseActionAdmission;
    readonly receipt: KernelActionReceipt;
    readonly afterObservation: TrustedUiObservation | null;
  }): ComputerUseSettlement {
    if (this.deps.kernelReceipts === null) {
      throw new SandboxUnavailableError("Kernel computer-use receipt verification is unavailable");
    }
    if (!kernelActionReceiptSchema.safeParse(input.receipt).success) {
      throw new ValidationError("Kernel action receipt does not satisfy the canonical schema");
    }
    const receipt = input.receipt;
    validateArtifactBinding(receipt.receiptArtifactUri, receipt.receiptArtifactHash, "Kernel action receipt");
    if (
      receipt.effectId !== input.admission.effectId
      || receipt.taskId !== input.admission.taskId
      || receipt.actionId !== input.admission.action.actionId
      || receipt.actionHash !== input.admission.actionHash
      || receipt.effectBindingHash !== input.admission.effectBindingHash
      || receipt.idempotencyKey !== input.admission.idempotencyKey
      || receipt.beforeObservationHash !== input.admission.observation.observationHash
    ) {
      throw new IntegrityError("Kernel action receipt does not bind the admitted effect");
    }
    if (receipt.afterObservationHash !== null && input.afterObservation === null) {
      throw new IntegrityError("Kernel action receipt has an after hash without a trusted observation");
    }
    if (input.afterObservation !== null) {
      this.verifyAfterObservation(input.admission.observation, input.afterObservation);
      if (
        receipt.afterObservationHash !== null
        && receipt.afterObservationHash !== input.afterObservation.observationHash
      ) {
        throw new IntegrityError("Kernel action receipt does not bind the trusted after observation");
      }
    } else if (receipt.outcome !== "unknown") {
      throw new IntegrityError("Settled computer-use effects require a trusted after observation");
    }
    if (!this.deps.kernelReceipts.verifyActionReceipt({ receipt, admission: input.admission })) {
      throw new IntegrityError("Kernel action receipt was rejected by its verifier");
    }
    return {
      status: receipt.outcome,
      effectId: receipt.effectId,
      actionId: receipt.actionId,
      beforeObservationHash: receipt.beforeObservationHash,
      afterObservationHash: receipt.afterObservationHash,
      receiptId: receipt.receiptId,
      receiptArtifactUri: receipt.receiptArtifactUri,
      observedAt: receipt.observedAt,
    };
  }

  public recoverUnknown(input: {
    readonly admission: ComputerUseActionAdmission;
    readonly settlement: ComputerUseSettlement;
    readonly attempts: number;
    readonly reconciliation: KernelReconciliationReceipt | null;
    readonly afterReconciliationObservation: TrustedUiObservation | null;
  }): ComputerUseRecovery {
    const maxAttempts = input.admission.action.effectClass === "read_only"
      ? 1
      : this.policyMaxAttempts(input.admission);
    if (!Number.isSafeInteger(input.attempts) || input.attempts <= 0) {
      throw new ValidationError("Computer-use recovery attempts must be a positive safe integer");
    }
    if (input.settlement.status !== "unknown") {
      this.verifySettlementBinding(input.admission, input.settlement);
      return {
        status: "already_committed",
        effectId: input.admission.effectId,
        attempts: input.attempts,
        maxAttempts,
        nextAttempt: null,
        requiresFreshObservation: false,
        reason: "settlement_already_confirmed",
        reconciliationReceiptId: null,
        afterObservationHash: input.settlement.afterObservationHash,
      };
    }
    const receipt = input.reconciliation;
    if (receipt === null) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "missing_reconciliation_receipt");
    }
    if (!kernelReconciliationReceiptSchema.safeParse(receipt).success) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "untrusted_reconciliation_receipt", receipt.receiptId);
    }
    if (artifactContentHash(receipt.receiptArtifactUri) !== receipt.receiptArtifactHash) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "untrusted_reconciliation_receipt", receipt.receiptId);
    }
    if (
      receipt.effectId !== input.admission.effectId
      || receipt.taskId !== input.admission.taskId
      || receipt.actionHash !== input.admission.actionHash
      || receipt.effectBindingHash !== input.admission.effectBindingHash
      || receipt.idempotencyKey !== input.admission.idempotencyKey
    ) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "untrusted_reconciliation_receipt", receipt.receiptId);
    }
    if (this.deps.kernelReceipts === null || !this.deps.kernelReceipts.verifyReconciliationReceipt({ receipt, admission: input.admission })) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "untrusted_reconciliation_receipt", receipt.receiptId);
    }
    if (receipt.settlement === "executed") {
      return {
        status: "already_committed",
        effectId: input.admission.effectId,
        attempts: input.attempts,
        maxAttempts,
        nextAttempt: null,
        requiresFreshObservation: false,
        reason: "reconciliation_confirmed_executed",
        reconciliationReceiptId: receipt.receiptId,
        afterObservationHash: receipt.afterObservationHash,
      };
    }
    if (input.afterReconciliationObservation === null) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "fresh_observation_required", receipt.receiptId);
    }
    this.verifyAfterObservation(input.admission.observation, input.afterReconciliationObservation);
    if (
      receipt.afterObservationHash !== null
      && receipt.afterObservationHash !== input.afterReconciliationObservation.observationHash
    ) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "untrusted_reconciliation_receipt", receipt.receiptId);
    }
    if (input.attempts >= maxAttempts) {
      return this.manualRecovery(input.admission.effectId, input.attempts, maxAttempts, "retry_budget_exhausted", receipt.receiptId, input.afterReconciliationObservation.observationHash);
    }
    return {
      status: "retry_allowed",
      effectId: input.admission.effectId,
      attempts: input.attempts,
      maxAttempts,
      nextAttempt: input.attempts + 1,
      requiresFreshObservation: true,
      reason: "reconciliation_confirmed_not_executed",
      reconciliationReceiptId: receipt.receiptId,
      afterObservationHash: input.afterReconciliationObservation.observationHash,
    };
  }

  public compactEvidence(input: {
    readonly admission: ComputerUseAdmission;
    readonly settlement?: ComputerUseSettlement | undefined;
    readonly recovery?: ComputerUseRecovery | undefined;
  }): CompactComputerUseEvidence {
    const admission = input.admission;
    const isAdmitted = admission.admitted;
    const settlement = input.settlement;
    const recovery = input.recovery;
    const actionId = isAdmitted ? admission.action.actionId : admission.actionId;
    const observationHash = isAdmitted ? admission.observation.observationHash : admission.observationHash;
    const observationReceiptId = isAdmitted
      ? admission.observation.receipt.receiptId
      : admission.observationReceiptId;
    const status: CompactComputerUseEvidenceStatus = !isAdmitted
      ? "denied"
      : recovery?.status ?? settlement?.status ?? "admitted";
    const afterObservationHash = recovery?.afterObservationHash
      ?? settlement?.afterObservationHash
      ?? null;
    const compact: CompactComputerUseEvidence = {
      schemaVersion: "computer-use-evidence/v1",
      status,
      taskId: admission.taskId,
      effectId: admission.effectId,
      actionId,
      surface: admission.surface,
      actionHash: admission.actionHash,
      effectBindingHash: admission.effectBindingHash,
      beforeObservationHash: observationHash,
      afterObservationHash,
      observationReceiptId,
      kernelReceiptId: settlement?.receiptId ?? null,
      receiptArtifactUri: settlement?.receiptArtifactUri ?? null,
      policyId: admission.policyId,
      policyVersion: admission.policyVersion,
      taintLabel: isAdmitted ? admission.observation.observation.taintLabel : admission.taintLabel,
      influencedByUntrustedContent: admission.influence.influencedByUntrustedContent,
      injectionRisk: admission.influence.injectionRisk,
      attempts: recovery?.attempts ?? null,
      maxAttempts: recovery?.maxAttempts ?? null,
      reason: !isAdmitted
        ? admission.reason
        : recovery?.reason ?? settlement?.status ?? "admitted_pending_kernel_receipt",
    };
    compactComputerUseEvidenceSchema.parse(compact);
    return compact;
  }

  private deriveInfluence(observation: UiObservation, input: ActionInfluence): ActionInfluence {
    const observationUntrusted = observation.taintLabel === "UNTRUSTED_UI"
      || observation.taintLabel === "UNTRUSTED_WEB";
    return {
      influencedByUntrustedContent: input.influencedByUntrustedContent || observationUntrusted,
      injectionRisk: maxInjectionRisk(input.injectionRisk, observationUntrusted ? "medium" : "none"),
      sources: input.sources.length > 0
        ? input.sources
        : observationUntrusted ? ["web"] : [],
    };
  }

  private approvalMatches(
    input: ComputerUseAdmissionInput,
    effectBindingHash: ContentHash,
    actionHash: ContentHash,
    influence: ActionInfluence,
  ): boolean {
    const approval = input.approval;
    if (approval === null || !computerUseApprovalSchema.safeParse(approval).success) return false;
    const expiresAtMs = Date.parse(approval.expiresAt);
    return approval.status === "approved"
      && approval.taskId === input.taskId
      && approval.actionHash === actionHash
      && approval.effectBindingHash === effectBindingHash
      && approval.approvedBy.trim().length > 0
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > (this.deps.nowMs?.() ?? Date.now())
      && (!influence.influencedByUntrustedContent || approval.reviewedUntrustedInfluence);
  }

  private verifyAfterObservation(
    before: TrustedUiObservation,
    after: TrustedUiObservation,
  ): void {
    if (this.deps.observationReceipts === null) {
      throw new SandboxUnavailableError("Trusted computer-use observation verification is unavailable");
    }
    const verifiedAfter = admitTrustedObservation(after.observation, after.receipt, this.deps.observationReceipts);
    if (
      verifiedAfter.observation.sessionId !== before.observation.sessionId
      || verifiedAfter.observation.taskId !== before.observation.taskId
      || verifiedAfter.observation.version <= before.observation.version
      || Date.parse(verifiedAfter.observation.timestamp) < Date.parse(before.observation.timestamp)
    ) {
      throw new IntegrityError("After observation is not a fresh observation from the same task session");
    }
  }

  private verifySettlementBinding(
    admission: ComputerUseActionAdmission,
    settlement: ComputerUseSettlement,
  ): void {
    if (
      settlement.effectId !== admission.effectId
      || settlement.actionId !== admission.action.actionId
      || settlement.beforeObservationHash !== admission.observation.observationHash
    ) {
      throw new IntegrityError("Computer-use settlement does not bind the admitted effect");
    }
  }

  private policyMaxAttempts(admission: ComputerUseActionAdmission): number {
    return admission.action.effectClass === "read_only"
      ? 1
      : admission.maxAttempts;
  }

  private manualRecovery(
    effectId: string,
    attempts: number,
    maxAttempts: number,
    reason: ComputerUseRecovery["reason"],
    reconciliationReceiptId: string | null = null,
    afterObservationHash: ContentHash | null = null,
  ): ComputerUseRecovery {
    return {
      status: "manual_review_required",
      effectId,
      attempts,
      maxAttempts,
      nextAttempt: null,
      requiresFreshObservation: true,
      reason,
      reconciliationReceiptId,
      afterObservationHash,
    };
  }
}
