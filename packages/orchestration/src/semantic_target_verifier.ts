/** Pure semantic target verification. This module never dispatches input. */
import { computeContentHash } from "@terminus/context-ir";
import {
  computerUseActionSchema,
  semanticTargetVerificationSchema,
  uiObservationSchema,
  type ComputerUseAction,
  type SemanticTargetVerification,
  type UiElementTarget,
  type UiObservation,
} from "@terminus/domain";

const FOCUS_BOUND_ACTIONS: ReadonlySet<ComputerUseAction["kind"]> = new Set([
  "key_press",
  "key_combination",
  "type_text",
]);

const KEY_ACTIONS: ReadonlySet<ComputerUseAction["kind"]> = new Set([
  "key_press",
  "key_combination",
]);

const MINIMUM_TARGET_CONFIDENCE = 0.8;

const SENSITIVE_EFFECT_CLASSES: ReadonlySet<ComputerUseAction["effectClass"]> = new Set([
  "reversible_external",
  "compensable_external",
  "irreversible",
  "unknown_semantics",
]);

export class SemanticTargetVerifier {
  public verifyTarget(rawObservation: UiObservation, rawAction: ComputerUseAction): SemanticTargetVerification {
    uiObservationSchema.parse(rawObservation);
    computerUseActionSchema.parse(rawAction);
    const observation = rawObservation;
    const action = rawAction;
    const verificationId = this.verificationId(observation, action);

    if (action.taskId !== observation.taskId) {
      return this.rejected(verificationId, observation, action, "Action task does not match observation task");
    }
    if (action.observationId !== observation.id || action.observationVersion !== observation.version) {
      return this.rejected(
        verificationId,
        observation,
        action,
        `Action references stale UI state ${action.observationId}@${action.observationVersion}; current state is ${observation.id}@${observation.version}`,
      );
    }

    if (action.target === null) {
      return this.rejected(
        verificationId,
        observation,
        action,
        `${action.kind} requires a semantic target identity; coordinates alone cannot authorize dispatch`,
      );
    }

    const current = observation.targetElements.find(
      (candidate) => candidate.elementId === action.target?.elementId,
    );
    if (current === undefined) {
      return this.rejected(verificationId, observation, action, "Target identity is absent from the current observation");
    }
    if (current.semanticHash !== action.target.semanticHash) {
      return this.divergent(
        verificationId,
        observation,
        action,
        current,
        "Target identity exists, but its semantic hash changed",
      );
    }
    if (!this.hasUsableGeometry(current, observation)) {
      return this.rejected(
        verificationId,
        observation,
        action,
        "Target has no complete usable geometry in the current viewport",
      );
    }
    if (!this.sameGeometry(current, action.target)) {
      return this.divergent(
        verificationId,
        observation,
        action,
        current,
        "Target geometry moved after the action was proposed",
      );
    }
    if (current.confidence < MINIMUM_TARGET_CONFIDENCE) {
      return this.rejected(
        verificationId,
        observation,
        action,
        `Target confidence ${current.confidence.toString()} is below ${MINIMUM_TARGET_CONFIDENCE.toString()}`,
      );
    }

    const equivalentTargets = observation.targetElements.filter((candidate) =>
      candidate.role === current.role
      && candidate.name === current.name
      && candidate.selector === current.selector,
    );
    if (equivalentTargets.length > 1) {
      return {
        ...this.divergent(
          verificationId,
          observation,
          action,
          current,
          `Target selector is ambiguous across ${equivalentTargets.length} current elements`,
        ),
        verdict: "ambiguous",
        ambiguityScore: 1 - (1 / equivalentTargets.length),
      };
    }

    const center = {
      x: Math.round(current.boundingBox.x + current.boundingBox.width / 2),
      y: Math.round(current.boundingBox.y + current.boundingBox.height / 2),
    };
    const occludingTargets = observation.targetElements.filter((candidate) =>
      candidate.elementId !== current.elementId
      && this.containsPoint(candidate, center),
    );
    if (occludingTargets.length > 0) {
      return {
        ...this.divergent(
          verificationId,
          observation,
          action,
          current,
          `Target hit point is shared with ${occludingTargets.length.toString()} other observed element(s); occlusion cannot be excluded`,
        ),
        verdict: "ambiguous",
        ambiguityScore: Math.min(1, occludingTargets.length / 2),
      };
    }

    const domConfirmed = current.evidenceSources.includes("dom")
      && observation.domTreeArtifactId !== null;
    const accessibilityNode = observation.accessibilityTree.find(
      (node) => node.nodeId === current.elementId,
    );
    const accessibilityConfirmed = current.evidenceSources.includes("accessibility")
      && accessibilityNode !== undefined
      && !accessibilityNode.disabled;
    const requiresStructuralEvidence = action.requiresSemanticVerification
      || SENSITIVE_EFFECT_CLASSES.has(action.effectClass)
      || KEY_ACTIONS.has(action.kind);
    if (requiresStructuralEvidence && !domConfirmed && !accessibilityConfirmed) {
      return this.rejected(
        verificationId,
        observation,
        action,
        "No current structural evidence confirms the consequential target",
      );
    }
    if (
      FOCUS_BOUND_ACTIONS.has(action.kind)
      && observation.focusedElementId !== current.elementId
    ) {
      return this.rejected(
        verificationId,
        observation,
        action,
        `${action.kind} requires the verified target to be the current focused element`,
      );
    }

    return this.validated({
      verificationId,
      actionId: action.actionId,
      observationId: observation.id,
      target: current,
      matchConfidence: current.confidence,
      visuallyConfirmed: false,
      domConfirmed,
      ambiguityScore: 0,
      verifiedCoordinates: center,
      verdict: "verified",
      reason: "Target identity, geometry, focus, and structural evidence match the versioned observation; pixel confirmation is unavailable",
    });
  }

  private verificationId(observation: UiObservation, action: ComputerUseAction): string {
    const input = JSON.stringify({
      taskId: action.taskId,
      observationId: observation.id,
      observationVersion: observation.version,
      actionId: action.actionId,
      actionKind: action.kind,
      effectClass: action.effectClass,
      targetHash: action.target?.semanticHash ?? null,
      targetGeometry: action.target?.boundingBox ?? null,
    });
    return computeContentHash(input);
  }

  private rejected(
    verificationId: string,
    observation: UiObservation,
    action: ComputerUseAction,
    reason: string,
  ): SemanticTargetVerification {
    return this.validated({
      verificationId,
      actionId: action.actionId,
      observationId: observation.id,
      target: null,
      matchConfidence: 0,
      visuallyConfirmed: false,
      domConfirmed: false,
      ambiguityScore: 0,
      verifiedCoordinates: null,
      verdict: "rejected",
      reason,
    });
  }

  private divergent(
    verificationId: string,
    observation: UiObservation,
    action: ComputerUseAction,
    target: UiElementTarget,
    reason: string,
  ): SemanticTargetVerification {
    return this.validated({
      verificationId,
      actionId: action.actionId,
      observationId: observation.id,
      target,
      matchConfidence: 0,
      visuallyConfirmed: false,
      domConfirmed: target.evidenceSources.includes("dom"),
      ambiguityScore: 0,
      verifiedCoordinates: {
        x: target.boundingBox.x + target.boundingBox.width / 2,
        y: target.boundingBox.y + target.boundingBox.height / 2,
      },
      verdict: "divergent",
      reason,
    });
  }

  private validated(verification: SemanticTargetVerification): SemanticTargetVerification {
    semanticTargetVerificationSchema.parse(verification);
    return verification;
  }

  private hasUsableGeometry(target: UiElementTarget, observation: UiObservation): boolean {
    const box = target.boundingBox;
    return Number.isFinite(box.x)
      && Number.isFinite(box.y)
      && Number.isFinite(box.width)
      && Number.isFinite(box.height)
      && box.width > 0
      && box.height > 0
      && box.x >= 0
      && box.y >= 0
      && box.x + box.width <= observation.viewport.width
      && box.y + box.height <= observation.viewport.height;
  }

  private sameGeometry(left: UiElementTarget, right: UiElementTarget): boolean {
    return left.boundingBox.x === right.boundingBox.x
      && left.boundingBox.y === right.boundingBox.y
      && left.boundingBox.width === right.boundingBox.width
      && left.boundingBox.height === right.boundingBox.height;
  }

  private containsPoint(
    target: UiElementTarget,
    point: { readonly x: number; readonly y: number },
  ): boolean {
    const box = target.boundingBox;
    return point.x >= box.x
      && point.x <= box.x + box.width
      && point.y >= box.y
      && point.y <= box.y + box.height;
  }
}
