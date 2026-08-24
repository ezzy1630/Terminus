/**
 * @terminus/orchestration — Causal Replay & Counterfactual Engine (SPEC §33, §19).
 *
 * Implements:
 *  - Step lineage recording & deterministic non-model step replay
 *  - Pinned input model re-execution under exact manifests
 *  - Context omission diagnostics (identifies whether an omitted context block caused failure)
 *  - Counterfactual simulation (evaluates alternative profile/intervention trajectories)
 */
import type {
  ArtifactUri,
  CausalStep,
  CausalReplayTrace,
  ContentHash,
  CounterfactualExperiment,
} from "@terminus/domain";
import {
  artifactUriSchema,
  causalStepSchema,
  ConflictError,
  contentHashSchema,
  NotFoundError,
  ValidationError,
  causalReplayTraceSchema,
  counterfactualExperimentSchema,
  generateUuid7,
  nowTimestamp,
  type Micros,
} from "@terminus/domain";
import { z } from "zod";

const immutableEvidenceRefSchema = z.union([artifactUriSchema, contentHashSchema]);
const contextOmissionCandidateSchema = z.object({
  blockId: z.string().trim().min(1),
  sourcePath: z.string().trim().min(1),
  omittedReason: z.string().trim().min(1),
  tokenEstimate: z.number().int().nonnegative(),
}).strict();
const omissionEvaluationSchema = z.object({
  causalRelevanceScore: z.number().min(0).max(1),
  evaluatorId: z.string().trim().min(1),
  evidenceRefs: z.array(immutableEvidenceRefSchema).min(1),
}).strict();

export type CausalStepInput = z.input<typeof causalStepSchema>;

export interface ContextOmissionCandidate {
  readonly blockId: string;
  readonly sourcePath: string;
  readonly omittedReason: string;
  readonly tokenEstimate: number;
}

export interface OmissionEvaluation {
  readonly causalRelevanceScore: number;
  /** Stable identity of the evaluator that produced this assessment. */
  readonly evaluatorId: string;
  /** Immutable artifact or evidence references supporting the assessment. */
  readonly evidenceRefs: readonly (ArtifactUri | ContentHash)[];
}

export interface OmissionEvaluator {
  readonly evaluate: (
    traceId: string,
    candidate: ContextOmissionCandidate,
    failureStep: CausalStep,
  ) => OmissionEvaluation | null;
}

export interface OmissionEvidenceRecord extends OmissionEvaluation {
  readonly blockId: string;
  readonly traceId: string;
}

export interface CounterfactualEvaluator {
  readonly evaluate: (
    sourceTaskId: string,
    variationType: CounterfactualExperiment["variationType"],
    variationDetails: Readonly<Record<string, unknown>>,
  ) => {
    readonly predictedOutcome: string;
    readonly actualOutcome: string;
    readonly deltaSuccess: boolean;
    readonly deltaCostMicros: Micros;
    readonly deltaLatencyMs: number;
  };
}

export interface CounterfactualExperimentWire
  extends Omit<CounterfactualExperiment, "deltaCostMicros" | "variationDetails"> {
  readonly variationDetails: Readonly<Record<string, unknown>>;
  readonly deltaCostMicros: string | null;
}

/** JSON-safe representation for public/API boundaries. */
export function serializeCounterfactualExperiment(
  experiment: CounterfactualExperiment,
): CounterfactualExperimentWire {
  return {
    ...experiment,
    variationDetails: jsonSafeRecord(experiment.variationDetails),
    deltaCostMicros: experiment.deltaCostMicros === null
      ? null
      : experiment.deltaCostMicros.toString(),
  };
}

export class CausalReplayEngine {
  private readonly traces = new Map<string, CausalReplayTrace>();
  private readonly experiments = new Map<string, CounterfactualExperiment>();

  public constructor(
    private readonly evaluator: CounterfactualEvaluator | null = null,
    private readonly omissionEvaluator: OmissionEvaluator | null = null,
  ) {}

  public createTrace(
    taskId: string,
    attemptId: string,
    pinnedInputsHash: string,
  ): CausalReplayTrace {
    const parsedPinnedInputsHash = contentHashSchema.safeParse(pinnedInputsHash);
    if (!parsedPinnedInputsHash.success) {
      throw new ValidationError("Causal replay requires an immutable pinned-input content hash", {
        pinnedInputsHash,
      });
    }
    const trace: CausalReplayTrace = {
      id: generateUuid7(),
      taskId,
      attemptId,
      pinnedInputsHash: parsedPinnedInputsHash.data,
      steps: [],
      divergencePoints: [],
      omissionDiagnostics: [],
      createdAt: nowTimestamp(),
    };
    causalReplayTraceSchema.parse(trace);

    this.traces.set(trace.id, trace);
    return this.copyTrace(trace);
  }

  public recordStep(traceId: string, rawStep: CausalStepInput): CausalReplayTrace {
    const trace = this.traces.get(traceId);
    if (!trace) throw new NotFoundError("causal trace", traceId);
    const parsedStep = causalStepSchema.safeParse(rawStep);
    if (!parsedStep.success) {
      throw new ValidationError("Invalid causal replay step", {
        traceId,
        validationIssues: parsedStep.error.issues,
      });
    }
    const step = parsedStep.data;
    const expectedStepIndex = trace.steps.length;
    if (step.stepIndex !== expectedStepIndex) {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        `Causal step index ${step.stepIndex} does not follow ${expectedStepIndex - 1}`,
        { traceId, expectedStepIndex, actualStepIndex: step.stepIndex },
      );
    }

    const updated: CausalReplayTrace = {
      ...trace,
      steps: [...trace.steps, step],
    };
    causalReplayTraceSchema.parse(updated);
    this.traces.set(traceId, updated);
    return this.copyTrace(updated);
  }

  /**
   * Diagnoses whether omitted context blocks causally contributed to a step failure.
   */
  public diagnoseOmissions(
    traceId: string,
    rawOmittedCandidates: readonly ContextOmissionCandidate[],
    failureStepIndex: number,
  ): CausalReplayTrace {
    const trace = this.traces.get(traceId);
    if (!trace) throw new NotFoundError("causal trace", traceId);

    if (this.omissionEvaluator === null) {
      throw new ValidationError(
        "Omission diagnostics require a configured evaluator with immutable evidence provenance",
        { traceId },
      );
    }
    if (!Number.isSafeInteger(failureStepIndex) || failureStepIndex < 0) {
      throw new ValidationError("Omission diagnostics require a non-negative failure step index", {
        traceId,
        failureStepIndex,
      });
    }
    const failureStep = trace.steps[failureStepIndex];
    if (failureStep === undefined) {
      throw new ValidationError(
        "Omission diagnostics require a failure step already recorded in the trace",
        { traceId, failureStepIndex, recordedStepCount: trace.steps.length },
      );
    }
    const parsedCandidates = z.array(contextOmissionCandidateSchema).safeParse(rawOmittedCandidates);
    if (!parsedCandidates.success) {
      throw new ValidationError("Invalid context omission candidates", {
        traceId,
        validationIssues: parsedCandidates.error.issues,
      });
    }
    const omittedCandidates = parsedCandidates.data;
    if (new Set(omittedCandidates.map((candidate) => candidate.blockId)).size !== omittedCandidates.length) {
      throw new ValidationError("Omission diagnostics require unique context block IDs", { traceId });
    }

    const evaluator = this.omissionEvaluator;
    const evaluations = omittedCandidates.map((candidate) => {
      const evaluation = evaluator.evaluate(traceId, candidate, failureStep);
      if (evaluation === null) {
        throw new ValidationError(
          `Omission evaluator did not produce evidence for block '${candidate.blockId}'`,
          { traceId, blockId: candidate.blockId },
        );
      }
      const parsedEvaluation = omissionEvaluationSchema.safeParse(evaluation);
      if (!parsedEvaluation.success) {
        throw new ValidationError(
          `Omission evaluator returned incomplete evidence for block '${candidate.blockId}'`,
          {
            traceId,
            blockId: candidate.blockId,
            validationIssues: parsedEvaluation.error.issues,
          },
        );
      }
      return {
        blockId: candidate.blockId,
        traceId,
        ...parsedEvaluation.data,
      } satisfies OmissionEvidenceRecord;
    });

    const diagnostics = evaluations.map(({ blockId, traceId: _traceId, ...evaluation }) => {
      const candidate = omittedCandidates.find((item) => item.blockId === blockId);
      if (candidate === undefined) {
        throw new ValidationError(`Omission evidence references unknown block '${blockId}'`, { traceId });
      }
      return {
        blockId,
        sourcePath: candidate.sourcePath,
        omittedReason: candidate.omittedReason,
        causalRelevanceScore: evaluation.causalRelevanceScore,
        evaluatorId: evaluation.evaluatorId,
        evidenceRefs: evaluation.evidenceRefs,
      };
    });

    const updated: CausalReplayTrace = {
      ...trace,
      omissionDiagnostics: diagnostics,
    };
    causalReplayTraceSchema.parse(updated);
    this.traces.set(traceId, updated);
    return this.copyTrace(updated);
  }

  public getOmissionEvidence(traceId: string): readonly OmissionEvidenceRecord[] | null {
    const trace = this.traces.get(traceId);
    if (trace === undefined || trace.omissionDiagnostics.length === 0) return null;
    return trace.omissionDiagnostics.map((diagnostic) => ({
      traceId,
      blockId: diagnostic.blockId,
      causalRelevanceScore: diagnostic.causalRelevanceScore,
      evaluatorId: diagnostic.evaluatorId,
      evidenceRefs: [...diagnostic.evidenceRefs],
    }));
  }

  /**
   * Simulates a counterfactual experiment with an alternate model profile or intervention.
   */
  public runCounterfactual(
    sourceTaskId: string,
    variationType: "profile" | "prompt" | "retrieval" | "intervention",
    variationDetails: Readonly<Record<string, unknown>>,
  ): CounterfactualExperiment {
    const evaluation = this.evaluator?.evaluate(sourceTaskId, variationType, variationDetails) ?? null;
    if (evaluation !== null && typeof evaluation.deltaCostMicros !== "bigint") {
      throw new ValidationError(
        "Counterfactual evaluator must return deltaCostMicros as bigint; serialize it only at the public boundary",
        { sourceTaskId },
      );
    }
    const exp: CounterfactualExperiment = {
      id: generateUuid7(),
      sourceTaskId,
      variationType,
      variationDetails,
      executionStatus: evaluation === null ? "planned" : "completed",
      predictedOutcome: evaluation?.predictedOutcome ?? "Not evaluated: no counterfactual evaluator is configured",
      actualOutcome: evaluation?.actualOutcome ?? null,
      deltaSuccess: evaluation?.deltaSuccess ?? null,
      deltaCostMicros: evaluation?.deltaCostMicros ?? null,
      deltaLatencyMs: evaluation?.deltaLatencyMs ?? null,
    };
    counterfactualExperimentSchema.parse(exp);

    this.experiments.set(exp.id, exp);
    return { ...exp, variationDetails: { ...exp.variationDetails } };
  }

  public getTrace(id: string): CausalReplayTrace | null {
    const trace = this.traces.get(id);
    return trace === undefined ? null : this.copyTrace(trace);
  }

  public getTraceForTask(taskId: string): CausalReplayTrace | null {
    for (const t of this.traces.values()) {
      if (t.taskId === taskId) return this.copyTrace(t);
    }
    return null;
  }

  public listTraces(): readonly CausalReplayTrace[] {
    return [...this.traces.values()].map((trace) => this.copyTrace(trace));
  }

  public listExperiments(sourceTaskId?: string): readonly CounterfactualExperiment[] {
    const all = Array.from(this.experiments.values());
    if (sourceTaskId) {
      return all.filter((e) => e.sourceTaskId === sourceTaskId).map((experiment) => ({
        ...experiment,
        variationDetails: { ...experiment.variationDetails },
      }));
    }
    return all.map((experiment) => ({ ...experiment, variationDetails: { ...experiment.variationDetails } }));
  }

  private copyTrace(trace: CausalReplayTrace): CausalReplayTrace {
    return {
      ...trace,
      steps: trace.steps.map((step) => ({ ...step })),
      divergencePoints: [...trace.divergencePoints],
      omissionDiagnostics: trace.omissionDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        evidenceRefs: [...diagnostic.evidenceRefs],
      })),
    };
  }
}

function jsonSafeRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafeValue(item)]));
}

function jsonSafeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value !== null && typeof value === "object") {
    return jsonSafeRecord(value as Readonly<Record<string, unknown>>);
  }
  return value;
}
