import { describe, expect, test } from "bun:test";
import type { ArtifactUri, ContentHash, StructuredInterventionVerb } from "@terminus/domain";
import {
  AttentionCoordinator,
  CausalReplayEngine,
  INTERVENTION_STATE_PRECONDITIONS,
  InterventionManager,
  serializeCounterfactualExperiment,
  type CandidateQuestion,
  type InterventionTaskState,
} from "./index.js";

const hash = (character: string): ContentHash => `sha256:${character.repeat(64)}` as ContentHash;
const artifact = (character: string): ArtifactUri => `artifact://sha256/${character.repeat(64)}` as ArtifactUri;

const candidate: CandidateQuestion = {
  trigger: "authority_expansion",
  questionText: "Allow network egress?",
  options: ["ALLOW", "DENY"],
  consequenceMatrix: { ALLOW: "egress expands", DENY: "egress remains denied" },
  isDerivableFromContext: false,
};

describe("phase 9 semantic safety", () => {
  test("caller assertions cannot establish material attention", () => {
    const unverified = new AttentionCoordinator();
    expect(unverified.evaluateAndQueueQuestion("task-1", candidate).accepted).toBe(false);

    const verifier = new AttentionCoordinator({
      verify: (_taskId, proposed) => ({
        assessorId: "materiality-assessor-v1",
        evidenceRefs: [artifact("a")],
        trigger: proposed.trigger,
      }),
    });
    const accepted = verifier.evaluateAndQueueQuestion("task-1", candidate);
    expect(accepted.accepted).toBe(true);
    expect(verifier.getMaterialityEvidence(accepted.question!.id)?.assessorId).toBe("materiality-assessor-v1");

    const derivable = verifier.evaluateAndQueueQuestion("task-2", { ...candidate, isDerivableFromContext: true });
    expect(derivable.accepted).toBe(false);
  });

  test("all 14 verbs use strict payloads and explicit state preconditions", () => {
    const manager = new InterventionManager();
    const checkpointHash = hash("b");
    const payloads: Readonly<Record<StructuredInterventionVerb, Readonly<Record<string, unknown>>>> = {
      focus: { scope: ["packages/orchestration"] },
      ignore: {},
      elaborate: { text: "Keep the migration reversible." },
      change_constraint: { constraint: "timeout_seconds", value: "120" },
      edit_plan: { operation: "replace_node", instruction: "Use the bounded verifier." },
      approve_exact_effect: { effectId: "effect-1" },
      deny_narrow: { effectId: "effect-2", restrictedCapabilities: ["network.egress"] },
      pause: {},
      resume: {},
      takeover: { humanPrincipal: "operator-1" },
      fork: { label: "safe alternative" },
      rewind: { checkpointHash },
      terminate: {},
      request_independent_review: { scope: "full task" },
    };
    const targets: Partial<Record<StructuredInterventionVerb, string>> = {
      focus: "focus-target",
      ignore: "ignore-target",
      edit_plan: "edit-plan-target",
      approve_exact_effect: "effect-1",
      deny_narrow: "effect-2",
      rewind: checkpointHash,
    };
    const verbs = Object.keys(payloads) as StructuredInterventionVerb[];

    for (const verb of verbs) {
      const targetEntityId = targets[verb];
      const intervention = manager.proposeIntervention({
        taskId: "task-1",
        actorPrincipal: "operator-1",
        verb,
        ...(targetEntityId === undefined ? {} : { targetEntityId }),
        payload: payloads[verb],
        rationale: `Apply ${verb}`,
      });
      expect(intervention.targetEntityId).toBe(targetEntityId ?? "task-1");
      const allowedState = INTERVENTION_STATE_PRECONDITIONS[intervention.verb][0] as InterventionTaskState;
      const applied = manager.applyIntervention(intervention.id, {
        getTaskState: () => allowedState,
        apply: () => ({ appliedChanges: { accepted: true } }),
      });
      expect(applied.success).toBe(true);
      if (verb === "change_constraint") {
        expect(intervention.payload.value).toBe(120);
      }
    }

    expect(() => manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "elaborate",
      payload: { text: "valid", unexpected: true },
      rationale: "reject extra fields",
    })).toThrow("Invalid payload");
    expect(() => manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "approve_exact_effect",
      targetEntityId: "effect-2",
      payload: { effectId: "effect-1" },
      rationale: "reject effect identity mismatch",
    })).toThrow("exactly match payload.effectId");
    expect(() => manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "rewind",
      targetEntityId: hash("c"),
      payload: { checkpointHash },
      rationale: "reject checkpoint identity mismatch",
    })).toThrow("exactly match payload.checkpointHash");
    expect(() => manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "pause",
      targetEntityId: "task-2",
      payload: {},
      rationale: "reject cross-task intervention",
    })).toThrow("must target task 'task-1'");
    expect(() => manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "change_constraint",
      payload: { constraint: "cost_micros", value: "01" },
      rationale: "reject non-canonical cost",
    })).toThrow("Invalid payload");
    expect(() => manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "change_constraint",
      payload: { constraint: "timeout_seconds", value: 0 },
      rationale: "reject non-positive timeout",
    })).toThrow("Invalid payload");
    expect(() => manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "approve_exact_effect",
      targetEntityId: "effect-1",
      payload: {},
      rationale: "reject missing effect id",
    })).toThrow("Invalid payload");

    const pause = manager.proposeIntervention({
      taskId: "task-1",
      actorPrincipal: "operator-1",
      verb: "pause",
      targetEntityId: "task-1",
      payload: {},
      rationale: "pause before review",
    });
    const invalidState = manager.applyIntervention(pause.id, {
      getTaskState: () => "PAUSED",
      apply: () => ({ appliedChanges: {} }),
    });
    expect(invalidState.success).toBe(false);
    expect(invalidState.error).toContain("current state is PAUSED");
  });

  test("causal omission scores require evaluator provenance and never use filenames", () => {
    const traceStep = {
      stepIndex: 0,
      component: "unrelated-component",
      inputManifestHash: hash("d"),
      modelOutputHash: hash("e"),
      effectId: null,
      verifierResult: "failed",
      durationMs: 10,
      counterfactualAlternative: null,
    } as const;
    const noEvaluator = new CausalReplayEngine();
    const trace = noEvaluator.createTrace("task-1", "attempt-1", hash("f"));
    noEvaluator.recordStep(trace.id, traceStep);
    expect(() => noEvaluator.diagnoseOmissions(trace.id, [], 0)).toThrow("evaluator");

    const replay = new CausalReplayEngine(null, {
      evaluate: (_traceId, candidate) => ({
        causalRelevanceScore: candidate.blockId === "block-a" ? 0.75 : 0.1,
        evaluatorId: "ablation-evaluator-v1",
        evidenceRefs: [candidate.blockId === "block-a" ? artifact("1") : hash("2")],
      }),
    });
    const verifiedTrace = replay.createTrace("task-1", "attempt-1", hash("3"));
    replay.recordStep(verifiedTrace.id, traceStep);
    expect(() => replay.diagnoseOmissions(verifiedTrace.id, [], 1)).toThrow("already recorded");
    const diagnosed = replay.diagnoseOmissions(
      verifiedTrace.id,
      [
        { blockId: "block-a", sourcePath: "test/spec.ts", omittedReason: "budget", tokenEstimate: 12 },
        { blockId: "block-b", sourcePath: "same/component.ts", omittedReason: "rank", tokenEstimate: 8 },
      ],
      0,
    );
    expect(diagnosed.omissionDiagnostics.map((item) => item.causalRelevanceScore)).toEqual([0.75, 0.1]);
    expect(diagnosed.omissionDiagnostics[0]?.evidenceRefs).toEqual([artifact("1")]);
    expect(replay.getOmissionEvidence(verifiedTrace.id)?.[0]?.evaluatorId).toBe("ablation-evaluator-v1");

    expect(() => replay.recordStep(verifiedTrace.id, {
      ...traceStep,
      stepIndex: 1,
      inputManifestHash: "not-a-content-hash",
    })).toThrow("Invalid causal replay step");
    expect(() => replay.createTrace("task-1", "attempt-2", "mutable-input-label")).toThrow(
      "immutable pinned-input content hash",
    );

    const invalidEvidenceReplay = new CausalReplayEngine(null, {
      evaluate: () => ({
        causalRelevanceScore: 0.5,
        evaluatorId: "ablation-evaluator-v1",
        evidenceRefs: ["artifact://mutable/evidence" as ArtifactUri],
      }),
    });
    const invalidEvidenceTrace = invalidEvidenceReplay.createTrace("task-1", "attempt-3", hash("4"));
    invalidEvidenceReplay.recordStep(invalidEvidenceTrace.id, traceStep);
    expect(() => invalidEvidenceReplay.diagnoseOmissions(
      invalidEvidenceTrace.id,
      [{ blockId: "block-a", sourcePath: "test/spec.ts", omittedReason: "budget", tokenEstimate: 12 }],
      0,
    )).toThrow("incomplete evidence");
  });

  test("counterfactual serialization converts BigInt values to decimal strings", () => {
    const replay = new CausalReplayEngine({
      evaluate: () => ({
        predictedOutcome: "pass",
        actualOutcome: "pass",
        deltaSuccess: true,
        deltaCostMicros: 900719925474099312345n as never,
        deltaLatencyMs: 3,
      }),
    });
    const experiment = replay.runCounterfactual("task-1", "profile", { budget: 4n });
    const wire = serializeCounterfactualExperiment(experiment);
    expect(wire.deltaCostMicros).toBe("900719925474099312345");
    expect(wire.variationDetails.budget).toBe("4");
  });
});
