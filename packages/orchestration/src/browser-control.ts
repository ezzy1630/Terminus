/**
 * Browser control admission contracts.
 *
 * This module plans a typed browser action against the strongest available
 * control surface. It does not open a browser, speak CDP, or dispatch input;
 * those effects remain kernel-backed adapter responsibilities.
 */
import { computeContentHash } from "@terminus/context-ir";
import {
  computerUseActionSchema,
  type ComputerUseAction,
  type ComputerUseActionKind,
  type UiObservation,
} from "@terminus/domain";
import { z } from "zod";
import { SemanticTargetVerifier } from "./semantic_target_verifier.js";

export type BrowserActionKind = Extract<
  ComputerUseActionKind,
  "navigate" | "click" | "fill" | "select" | "upload" | "download" | "submit"
>;

const BROWSER_ACTION_KINDS = [
  "navigate",
  "click",
  "fill",
  "select",
  "upload",
  "download",
  "submit",
] as const satisfies readonly BrowserActionKind[];

export const typedBrowserActionSchema = computerUseActionSchema.extend({
  kind: z.enum(BROWSER_ACTION_KINDS),
});

export type TypedBrowserAction = ComputerUseAction & { readonly kind: BrowserActionKind };

export type BrowserControlPath = "api" | "mcp" | "dom" | "accessibility" | "cdp" | "vision";

export interface BrowserControlCapabilities {
  readonly apiActions: readonly BrowserActionKind[];
  readonly mcpActions: readonly BrowserActionKind[];
  readonly dom: boolean;
  readonly accessibility: boolean;
  readonly cdp: boolean;
  readonly vision: boolean;
}

export interface ExternalEffectApproval {
  readonly approvalId: string;
  readonly taskId: string;
  readonly actionId: string;
  readonly bindingHash: string;
  readonly status: "approved";
}

export interface BrowserActionPlan {
  readonly admitted: true;
  readonly action: TypedBrowserAction;
  readonly observationId: string;
  readonly observationVersion: number;
  readonly controlPath: BrowserControlPath;
  readonly semanticVerification: ReturnType<SemanticTargetVerifier["verifyTarget"]> | null;
  readonly settlementRequired: boolean;
  readonly effectBindingHash: string;
}

export interface BrowserActionRejection {
  readonly admitted: false;
  readonly actionId: string;
  readonly reason:
    | "unsupported_action"
    | "no_control_path"
    | "stale_observation"
    | "target_not_verified"
    | "approval_required"
    | "approval_mismatch";
  readonly detail: string;
}

const TARGETED_ACTIONS: ReadonlySet<BrowserActionKind> = new Set([
  "click",
  "fill",
  "select",
  "upload",
  "download",
  "submit",
]);

const IRREVERSIBLE_EFFECTS: ReadonlySet<TypedBrowserAction["effectClass"]> = new Set([
  "irreversible",
  "unknown_semantics",
]);

/** Stable identity for an approval/effect binding. */
export function browserEffectBindingHash(
  action: TypedBrowserAction,
  observation: Pick<UiObservation, "id" | "taskId" | "version">,
): string {
  return computeContentHash(JSON.stringify({
    actionId: action.actionId,
    taskId: action.taskId,
    observationId: observation.id,
    observationTaskId: observation.taskId,
    observationVersion: observation.version,
    kind: action.kind,
    target: action.target,
    coordinate: action.coordinate,
    text: action.text,
    keys: action.keys,
    scrollDelta: action.scrollDelta,
    effectClass: action.effectClass,
    intent: action.intent,
    requiresSemanticVerification: action.requiresSemanticVerification,
  }));
}

/** Select the first usable path in the required API/MCP/DOM/CDP/vision order. */
export function selectBrowserControlPath(
  action: BrowserActionKind,
  capabilities: BrowserControlCapabilities,
): BrowserControlPath | null {
  if (capabilities.apiActions.includes(action)) return "api";
  if (capabilities.mcpActions.includes(action)) return "mcp";
  if (capabilities.dom) return "dom";
  if (capabilities.accessibility) return "accessibility";
  if (capabilities.cdp) return "cdp";
  if (capabilities.vision) return "vision";
  return null;
}

/**
 * Admit a browser action for a kernel-backed adapter.
 *
 * The returned plan is a settlement boundary, not a success receipt. The
 * adapter must execute it and return a trusted receipt before the effect can
 * advance to settled.
 */
export class BrowserControlCoordinator {
  constructor(private readonly verifier = new SemanticTargetVerifier()) {}

  plan(
    rawAction: TypedBrowserAction,
    observation: UiObservation,
    capabilities: BrowserControlCapabilities,
    approval: ExternalEffectApproval | null,
  ): BrowserActionPlan | BrowserActionRejection {
    const parsed = typedBrowserActionSchema.safeParse(rawAction);
    if (!parsed.success) {
      return {
        admitted: false,
        actionId: rawAction.actionId,
        reason: "unsupported_action",
        detail: parsed.error.message,
      };
    }
    const action = parsed.data as TypedBrowserAction;
    const path = selectBrowserControlPath(action.kind, capabilities);
    if (path === null) {
      return {
        admitted: false,
        actionId: action.actionId,
        reason: "no_control_path",
        detail: "no API, MCP, DOM, accessibility, CDP, or grounded-vision adapter is available",
      };
    }
    if (
      action.taskId !== observation.taskId
      || action.observationId !== observation.id
      || action.observationVersion !== observation.version
    ) {
      return {
        admitted: false,
        actionId: action.actionId,
        reason: "stale_observation",
        detail: `action references ${action.observationId}@${action.observationVersion}, current observation is ${observation.id}@${observation.version}`,
      };
    }

    const semanticVerification = TARGETED_ACTIONS.has(action.kind)
      ? this.verifier.verifyTarget(observation, action)
      : null;
    if (semanticVerification !== null && semanticVerification.verdict !== "verified") {
      return {
        admitted: false,
        actionId: action.actionId,
        reason: "target_not_verified",
        detail: semanticVerification.reason,
      };
    }

    const settlementRequired = IRREVERSIBLE_EFFECTS.has(action.effectClass);
    const effectBindingHash = browserEffectBindingHash(action, observation);
    if (settlementRequired && approval === null) {
      return {
        admitted: false,
        actionId: action.actionId,
        reason: "approval_required",
        detail: "irreversible browser effects require a human approval bound to this action and observation",
      };
    }
    if (
      settlementRequired
      && approval !== null
      && (approval.status !== "approved"
        || approval.taskId !== action.taskId
        || approval.actionId !== action.actionId
        || approval.bindingHash !== effectBindingHash)
    ) {
      return {
        admitted: false,
        actionId: action.actionId,
        reason: "approval_mismatch",
        detail: "human approval does not bind to the exact task, action, and observation",
      };
    }

    return {
      admitted: true,
      action,
      observationId: observation.id,
      observationVersion: observation.version,
      controlPath: path,
      semanticVerification,
      settlementRequired,
      effectBindingHash,
    };
  }
}
