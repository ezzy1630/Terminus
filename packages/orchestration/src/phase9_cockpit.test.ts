import { describe, expect, test } from "bun:test";
import {
  OrganizationDirectory,
  AttentionCoordinator,
  INTERVENTION_STATE_PRECONDITIONS,
  InterventionManager,
  CausalReplayEngine,
} from "./index.js";
import { nowTimestamp, type ArtifactUri, type ContentHash, type StructuredInterventionVerb } from "@terminus/domain";

const hash = (character: string): ContentHash => `sha256:${character.repeat(64)}` as ContentHash;
const artifact = (character: string): ArtifactUri => `artifact://sha256/${character.repeat(64)}` as ArtifactUri;

function trustedAttentionCoordinator(): AttentionCoordinator {
  return new AttentionCoordinator({
    verify: (_taskId, candidate) => ({
      assessorId: "materiality-assessor-v1",
      evidenceRefs: [artifact("a")],
      trigger: candidate.trigger,
    }),
  });
}

describe("Phase 9: Operator Cockpit, Attention & Interventions", () => {
  describe("OrganizationDirectory (SPEC §4, §16.1)", () => {
    test("registers organizations, departments, operators, agent rooms and performs deterministic capability matching", () => {
      const dir = new OrganizationDirectory();

      dir.registerOrganization({
        id: "org-1",
        displayName: "Test organization",
        rootPolicyProfile: "test-policy",
        createdAt: nowTimestamp(),
      });
      dir.registerDepartment({
        id: "dept-1",
        organizationId: "org-1",
        displayName: "Test department",
        policyProfile: "test-policy",
        defaultOperatorId: "operator-1",
        createdAt: nowTimestamp(),
      });
      dir.registerOperator({
        id: "operator-1",
        departmentId: "dept-1",
        displayName: "Test operator",
        capabilityScope: ["code_editing"],
        modelProfile: "test-profile",
        active: true,
      });
      dir.registerRoom({
        id: "room-1",
        departmentId: "dept-1",
        name: "Test room",
        operatorId: "operator-1",
        activeWorkerIds: [],
        specialistIds: [],
        reviewerIds: [],
        supervisorId: null,
        createdAt: nowTimestamp(),
      });
      dir.registerCapability({
        id: "capability-entry-1",
        capabilityId: "code_editing",
        category: "software_engineering",
        providerOperatorId: "operator-1",
        resourceDomain: "packages/**",
        authorityRequirement: ["LOCAL_FS_WRITE"],
        status: "AVAILABLE",
      });

      const orgs = dir.listOrganizations();
      expect(orgs.length).toBeGreaterThanOrEqual(1);

      const depts = dir.listDepartments();
      expect(depts.length).toBeGreaterThanOrEqual(1);

      const operators = dir.listOperators();
      expect(operators.length).toBeGreaterThanOrEqual(1);

      const rooms = dir.listRooms();
      expect(rooms.length).toBeGreaterThanOrEqual(1);

      // Deterministic capability resolution
      const match = dir.resolveCapability({
        capabilityId: "code_editing",
        category: "software_engineering",
        requiredAuthority: ["LOCAL_FS_WRITE"],
      });

      expect(match.matched).toBe(true);
      expect(match.operator).not.toBeNull();
      expect(match.department).not.toBeNull();
      expect(match.reason).toContain("Matched capability code_editing");

      // Non-existent capability
      const failMatch = dir.resolveCapability({
        capabilityId: "non_existent_capability",
      });
      expect(failMatch.matched).toBe(false);
      expect(failMatch.operator).toBeNull();

      expect(() =>
        dir.registerCapability({
          id: "capability-entry-out-of-scope",
          capabilityId: "production_deploy",
          category: "operations",
          providerOperatorId: "operator-1",
          resourceDomain: "*",
          authorityRequirement: [],
          status: "AVAILABLE",
        }),
      ).toThrow("exceeds the provider operator scope");

      expect(() =>
        dir.registerOrganization({
          id: "org-1",
          displayName: "Conflicting organization",
          rootPolicyProfile: "other-policy",
          createdAt: nowTimestamp(),
        }),
      ).toThrow("already registered with different content");
    });
  });

  describe("AttentionCoordinator (SPEC §29.3, §16.2)", () => {
    test("rejects questions that can be mechanically derived from workspace context", () => {
      const coordinator = new AttentionCoordinator();

      const res = coordinator.evaluateAndQueueQuestion("task-1", {
        trigger: "interpretation_divergence",
        questionText: "What is the function name?",
        options: ["foo", "bar"],
        consequenceMatrix: { foo: "Use foo", bar: "Use bar" },
        isDerivableFromContext: true,
      });

      expect(res.accepted).toBe(false);
      expect(res.question).toBeNull();
      expect(res.reason).toContain("Immaterial");
    });

    test("accepts material questions across triggers and verifies consequence matrix", () => {
      const coordinator = trustedAttentionCoordinator();

      // Missing consequence for an option
      const badRes = coordinator.evaluateAndQueueQuestion("task-1", {
        trigger: "authority_expansion",
        questionText: "Allow network egress to api.stripe.com?",
        options: ["ALLOW", "DENY"],
        consequenceMatrix: { ALLOW: "Will enable payment API" }, // Missing DENY
      });
      expect(badRes.accepted).toBe(false);
      expect(badRes.reason).toContain("missing explicit consequence documentation");

      // Valid material question
      const goodRes = coordinator.evaluateAndQueueQuestion("task-1", {
        trigger: "authority_expansion",
        questionText: "Allow network egress to api.stripe.com?",
        options: ["ALLOW", "DENY"],
        consequenceMatrix: {
          ALLOW: "Expands egress authority to api.stripe.com for 30s",
          DENY: "Rejects egress and falls back to mock fixture",
        },
        suggestedOption: "ALLOW",
      });
      expect(goodRes.accepted).toBe(true);
      expect(goodRes.question).not.toBeNull();
      expect(goodRes.question?.status).toBe("PENDING");

      // Assess task attention -> should be BLOCKING for authority expansion
      const assessment = coordinator.assessTaskAttention("task-1");
      expect(assessment.requiresAttention).toBe(true);
      expect(assessment.urgency).toBe("BLOCKING");
      expect(assessment.pendingQuestions.length).toBe(1);

      // Resolve the question
      const resolveRes = coordinator.resolveQuestion(goodRes.question!.id, "ALLOW");
      expect(resolveRes.success).toBe(true);
      expect(resolveRes.question?.status).toBe("ANSWERED");
      expect(resolveRes.question?.selectedOption).toBe("ALLOW");

      // Post-resolution assessment -> LOW urgency
      const postAssessment = coordinator.assessTaskAttention("task-1");
      expect(postAssessment.requiresAttention).toBe(false);
      expect(postAssessment.urgency).toBe("LOW");
    });
  });

  describe("InterventionManager (SPEC §16.3)", () => {
    test("proposes and applies all 14 structured intervention verbs", () => {
      const mgr = new InterventionManager();
      const executedVerbs = new Set<string>();
      const checkpointHash = hash("c");

      const payloads: Readonly<Record<StructuredInterventionVerb, Readonly<Record<string, unknown>>>> = {
        focus: { scope: ["packages/orchestration"] },
        ignore: {},
        elaborate: { text: "Preserve the task contract." },
        change_constraint: { constraint: "timeout_seconds", value: 120 },
        edit_plan: { operation: "replace_node", instruction: "Use the bounded verifier." },
        approve_exact_effect: { effectId: "effect-approve" },
        deny_narrow: { effectId: "effect-deny", restrictedCapabilities: ["network.egress"] },
        pause: {},
        resume: {},
        takeover: { humanPrincipal: "human-operator-1" },
        fork: { label: "safe alternative" },
        rewind: { checkpointHash },
        terminate: {},
        request_independent_review: { scope: "full task" },
      };
      const entityTargets: Partial<Record<StructuredInterventionVerb, string>> = {
        focus: "packages/orchestration",
        ignore: "diagnostic-1",
        edit_plan: "plan-node-1",
        approve_exact_effect: "effect-approve",
        deny_narrow: "effect-deny",
        rewind: checkpointHash,
      };
      const verbs = Object.keys(payloads) as StructuredInterventionVerb[];

      for (const verb of verbs) {
        const targetEntityId = entityTargets[verb];
        const intv = mgr.proposeIntervention({
          taskId: "task-100",
          actorPrincipal: "human-operator-1",
          verb,
          ...(targetEntityId === undefined ? {} : { targetEntityId }),
          payload: payloads[verb],
          rationale: "Operator command: " + verb,
        });

        expect(intv.status).toBe("PROPOSED");

        const applied = mgr.applyIntervention(intv.id, {
          getTaskState: () => INTERVENTION_STATE_PRECONDITIONS[verb][0]!,
          apply: (intervention) => {
            executedVerbs.add(intervention.verb);
            return { appliedChanges: { receipt: `fixture:${intervention.id}` } };
          },
        });

        expect(applied.success).toBe(true);
        expect(applied.intervention.status).toBe("APPLIED");

      }
      expect(executedVerbs).toEqual(new Set(verbs));

      const unequipped = mgr.proposeIntervention({
        taskId: "task-100",
        actorPrincipal: "human-operator-1",
        verb: "pause",
        rationale: "prove fail-closed coordination",
      });
      const unequippedResult = mgr.applyIntervention(unequipped.id, null);
      expect(unequippedResult.success).toBe(false);
      expect(unequippedResult.intervention.status).toBe("PROPOSED");
    });
  });

  describe("CausalReplayEngine (SPEC §33, §19)", () => {
    test("records step lineages, diagnoses omissions, and runs counterfactual experiments", () => {
      const replay = new CausalReplayEngine(null, {
        evaluate: (_traceId, candidate) => ({
          causalRelevanceScore: candidate.blockId === "blk-1" ? 0.75 : 0.1,
          evaluatorId: "ablation-evaluator-v1",
          evidenceRefs: [artifact(candidate.blockId === "blk-1" ? "d" : "e")],
        }),
      });

      const trace = replay.createTrace("task-200", "att-1", hash("1"));
      expect(trace.taskId).toBe("task-200");

      replay.recordStep(trace.id, {
        stepIndex: 0,
        component: "context_compiler",
        inputManifestHash: hash("2"),
        modelOutputHash: hash("3"),
        effectId: null,
        verifierResult: "pass",
        durationMs: 120,
        counterfactualAlternative: null,
      });

      replay.recordStep(trace.id, {
        stepIndex: 1,
        component: "patch_engine",
        inputManifestHash: hash("4"),
        modelOutputHash: hash("5"),
        effectId: "eff-1",
        verifierResult: "fail_syntax_error",
        durationMs: 450,
        counterfactualAlternative: "use_hash_anchored_dialect",
      });

      // Context omission diagnosis
      const diagnosed = replay.diagnoseOmissions(
        trace.id,
        [
          {
            blockId: "blk-1",
            sourcePath: "packages/domain/src/aggregates.ts",
            omittedReason: "token_budget_exceeded",
            tokenEstimate: 4500,
          },
          {
            blockId: "blk-2",
            sourcePath: "docs/architecture/legacy.md",
            omittedReason: "low_semantic_rank",
            tokenEstimate: 1200,
          },
        ],
        1,
      );

      expect(diagnosed.omissionDiagnostics.length).toBe(2);
      expect(diagnosed.omissionDiagnostics[0]?.causalRelevanceScore).toBeGreaterThan(0.5);
      expect(diagnosed.omissionDiagnostics[0]?.evaluatorId).toBe("ablation-evaluator-v1");
      expect(diagnosed.omissionDiagnostics[0]?.evidenceRefs).toEqual([artifact("d")]);

      // Counterfactual simulation
      const exp = replay.runCounterfactual("task-200", "profile", {
        targetModelProfile: "claude-3-7-sonnet",
      });

      expect(exp.executionStatus).toBe("planned");
      expect(exp.actualOutcome).toBeNull();
      expect(exp.deltaSuccess).toBeNull();
    });
  });
});
