/**
 * @terminus/task-runtime — Compiled Sequence Policy Engine (SPEC §13.2, §13.3).
 *
 * Enforces temporal / multi-step sequence invariants, state-dependent preconditions,
 * and separation of duties before allowing effect preparation or commits.
 *
 * Example invariant:
 * `secret_scan_passed AND required_tests_passed AND reviewer_principal != actor_principal BEFORE repository.merge`
 */
import type { SequencePolicyRule } from "@terminus/domain";
import { sequencePolicyRuleSchema } from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";

export interface SequenceEvaluationInput {
  readonly taskId: string;
  readonly effectType: string;
  readonly actorPrincipal: string;
  readonly reviewerPrincipal?: string | null;
  readonly precedingEvents: readonly string[];
  readonly admittedClaims: readonly string[];
}

export interface SequenceEvaluationResult {
  readonly decision: "ALLOWED" | "AUTHORIZATION_REQUIRED" | "DENIED";
  readonly violatedRuleId?: string;
  readonly reason: string;
  readonly matchedRules: readonly string[];
}

export class SequencePolicyEvaluator {
  private readonly defaultRules: SequencePolicyRule[] = [
    {
      id: "SEQ-001-git-merge-preconditions",
      description: "Git merge requires prior test passage, secret scan verification, and separation of duties",
      targetEffectType: "git.merge",
      requiredPrecedingEvents: ["evidence.verified", "claim.satisfied"],
      requiredAdmittedClaims: ["security.secret_scan_passed", "tests.unit_passed"],
      separationOfDuty: true,
      enforcement: "HARD_DENY",
    },
    {
      id: "SEQ-002-deploy-production-review",
      description: "Production deployment requires external verification and separate reviewer",
      targetEffectType: "cloud.deploy",
      requiredPrecedingEvents: ["claim.satisfied"],
      requiredAdmittedClaims: ["verification.all_criteria_met"],
      separationOfDuty: true,
      enforcement: "HARD_DENY",
    },
  ];

  constructor(private readonly repo?: DurableTaskRepository) {}

  /**
   * Register a new sequence policy rule.
   */
  async registerRule(rule: SequencePolicyRule): Promise<void> {
    sequencePolicyRuleSchema.parse(rule);
    if (this.repo) {
      await this.repo.saveSequencePolicyRule(rule);
    } else {
      this.defaultRules.push(rule);
    }
  }

  /**
   * Evaluate sequence policy for an effect attempt.
   */
  async evaluate(input: SequenceEvaluationInput): Promise<SequenceEvaluationResult> {
    const rules = this.repo ? await this.repo.listSequencePolicyRules() : this.defaultRules;
    const effectiveRules = rules.length > 0 ? rules : this.defaultRules;

    const matchedRuleIds: string[] = [];

    for (const rule of effectiveRules) {
      if (rule.targetEffectType !== input.effectType && rule.targetEffectType !== "*") {
        continue;
      }
      matchedRuleIds.push(rule.id);

      // 1. Check required preceding events
      for (const reqEvent of rule.requiredPrecedingEvents) {
        if (!input.precedingEvents.includes(reqEvent)) {
          const reason = `Sequence policy '${rule.id}' violation: missing required preceding event '${reqEvent}' before '${input.effectType}'`;
          if (rule.enforcement === "HARD_DENY") {
            return { decision: "DENIED", violatedRuleId: rule.id, reason, matchedRules: matchedRuleIds };
          }
          if (rule.enforcement === "PROMPT") {
            return { decision: "AUTHORIZATION_REQUIRED", violatedRuleId: rule.id, reason, matchedRules: matchedRuleIds };
          }
        }
      }

      // 2. Check required admitted claims
      for (const reqClaim of rule.requiredAdmittedClaims) {
        if (!input.admittedClaims.includes(reqClaim)) {
          const reason = `Sequence policy '${rule.id}' violation: missing required admitted claim '${reqClaim}' before '${input.effectType}'`;
          if (rule.enforcement === "HARD_DENY") {
            return { decision: "DENIED", violatedRuleId: rule.id, reason, matchedRules: matchedRuleIds };
          }
          if (rule.enforcement === "PROMPT") {
            return { decision: "AUTHORIZATION_REQUIRED", violatedRuleId: rule.id, reason, matchedRules: matchedRuleIds };
          }
        }
      }

      // 3. Separation of duties
      if (rule.separationOfDuty) {
        if (!input.reviewerPrincipal) {
          const reason = `Sequence policy '${rule.id}' violation: separation of duty requires an independent reviewer for '${input.effectType}'`;
          if (rule.enforcement === "HARD_DENY") {
            return { decision: "DENIED", violatedRuleId: rule.id, reason, matchedRules: matchedRuleIds };
          }
          if (rule.enforcement === "PROMPT") {
            return { decision: "AUTHORIZATION_REQUIRED", violatedRuleId: rule.id, reason, matchedRules: matchedRuleIds };
          }
        } else if (input.reviewerPrincipal === input.actorPrincipal) {
          const reason = `Sequence policy '${rule.id}' violation: actor '${input.actorPrincipal}' cannot approve or review their own effect '${input.effectType}'`;
          return { decision: "DENIED", violatedRuleId: rule.id, reason, matchedRules: matchedRuleIds };
        }
      }
    }

    return {
      decision: "ALLOWED",
      reason: "All sequence policy rules and temporal preconditions satisfied",
      matchedRules: matchedRuleIds,
    };
  }
}
