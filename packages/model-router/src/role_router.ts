/**
 * Deterministic role routing.
 *
 * Role names are task-facing profiles. Provider/model selection remains the
 * responsibility of StageRouter and its injected profile registry; this
 * facade only binds a role to the required stage and authority.
 */
import { z } from "zod";
import type { RouteDecisionV2 } from "@terminus/domain";
import type { StageRouteInputs, StageRouter, StageRole } from "./stage_router.js";

export const deterministicRoleProfileSchema = z.enum([
  "primary_implementer",
  "cheap_classifier_scout",
  "read_only_reviewer_oracle",
  "vision_enabled_media",
]);

export type DeterministicRoleProfile = z.infer<typeof deterministicRoleProfileSchema>;

export interface DeterministicRoleDefinition {
  readonly stage: StageRole;
  readonly authority: "write" | "read_only";
  readonly requiresImageInput: boolean;
}

export const DETERMINISTIC_ROLE_DEFINITIONS: Readonly<
  Record<DeterministicRoleProfile, DeterministicRoleDefinition>
> = Object.freeze({
  primary_implementer: {
    stage: "implementer",
    authority: "write",
    requiresImageInput: false,
  },
  cheap_classifier_scout: {
    stage: "classifier",
    authority: "read_only",
    requiresImageInput: false,
  },
  read_only_reviewer_oracle: {
    stage: "reviewer",
    authority: "read_only",
    requiresImageInput: false,
  },
  vision_enabled_media: {
    stage: "vision",
    authority: "read_only",
    requiresImageInput: true,
  },
});

export interface RoleRouteInputs {
  readonly roleProfile: DeterministicRoleProfile;
  readonly confidentiality: StageRouteInputs["confidentiality"];
  readonly allowedAdapterRefs?: readonly string[];
  readonly implementerModelFamilyRef?: string | null;
  readonly budgetMaxMicros?: bigint | null;
  readonly maxLatencyMs?: number | null;
  readonly requireOffline?: boolean;
}

export interface RoleRoutingDecision {
  readonly roleProfile: DeterministicRoleProfile;
  readonly stage: StageRole;
  readonly authority: DeterministicRoleDefinition["authority"];
  readonly requiresImageInput: boolean;
  readonly deterministic: true;
  readonly route: RouteDecisionV2;
}

/**
 * Binds declared task roles to deterministic stage routing.
 *
 * There is intentionally no model-trained policy in this class. A future
 * experimental router may sit beside it, but it cannot silently replace the
 * default path.
 */
export class RoleRouter {
  constructor(private readonly stageRouter: StageRouter) {}

  route(input: RoleRouteInputs): RoleRoutingDecision {
    const definition = DETERMINISTIC_ROLE_DEFINITIONS[input.roleProfile];
    const route = this.stageRouter.route({
      stage: definition.stage,
      confidentiality: input.confidentiality,
      ...(input.allowedAdapterRefs === undefined
        ? {}
        : { allowedAdapterRefs: input.allowedAdapterRefs }),
      ...(input.implementerModelFamilyRef === undefined
        ? {}
        : { implementerModelFamilyRef: input.implementerModelFamilyRef }),
      ...(input.budgetMaxMicros === undefined
        ? {}
        : { budgetMaxMicros: input.budgetMaxMicros }),
      ...(input.maxLatencyMs === undefined
        ? {}
        : { maxLatencyMs: input.maxLatencyMs }),
      ...(input.requireOffline === undefined
        ? {}
        : { requireOffline: input.requireOffline }),
    });

    return {
      roleProfile: input.roleProfile,
      stage: definition.stage,
      authority: definition.authority,
      requiresImageInput: definition.requiresImageInput,
      deterministic: true,
      route,
    };
  }
}

export { RoleRouter as DeterministicRoleRouter };
