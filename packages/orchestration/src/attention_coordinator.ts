/**
 * @terminus/orchestration — Attention Coordinator & Materiality Engine (SPEC §29.3, §16.2).
 *
 * Prevents human question fatigue by strictly filtering out questions that can be
 * deterministically resolved from code/policy/context. Prompts human attention only
 * when triggered by verified materiality criteria:
 *  1. interpretation_divergence (conflicting requirements)
 *  2. authority_expansion (requested action exceeds task authority ceiling)
 *  3. irreversible_effect (action cannot be undone/compensated)
 *  4. external_effect (externally visible effect without pre-approval)
 *  5. missing_grant (required OAuth/secret token not provisioned)
 *  6. human_taste (visual/aesthetic/editorial preference is the acceptance oracle)
 *  7. confidence_collapse (model posterior/confidence drops below policy threshold)
 *
 * Questions present an explicit option-to-consequence matrix.
 */
import type {
  MaterialQuestion,
  MaterialityTrigger,
  AttentionAssessment,
} from "@terminus/domain";
import {
  attentionAssessmentSchema,
  generateUuid7,
  materialQuestionSchema,
  nowTimestamp,
} from "@terminus/domain";

export interface CandidateQuestion {
  readonly trigger: MaterialityTrigger;
  readonly questionText: string;
  readonly options: readonly string[];
  readonly consequenceMatrix: Readonly<Record<string, string>>;
  readonly suggestedOption?: string | null;
  /**
   * This flag is only a negative assertion. It can suppress a question, but
   * it can never establish that the question is material.
   */
  readonly isDerivableFromContext?: boolean;
}

export interface MaterialityEvidence {
  /** Stable identity of the trusted materiality assessor. */
  readonly assessorId: string;
  /** Immutable evidence references used by the assessor. */
  readonly evidenceRefs: readonly string[];
  /** Trigger independently established by the assessor. */
  readonly trigger: MaterialityTrigger;
}

export interface MaterialityVerifier {
  /**
   * Returns evidence only when an independent, trusted assessor established
   * the trigger. Returning null is the fail-closed result.
   */
  readonly verify: (
    taskId: string,
    candidate: CandidateQuestion,
  ) => MaterialityEvidence | null;
}

export class AttentionCoordinator {
  private readonly questions = new Map<string, MaterialQuestion>();
  private readonly taskQuestions = new Map<string, string[]>();
  private readonly verification = new Map<string, MaterialityEvidence>();

  public constructor(private readonly materialityVerifier: MaterialityVerifier | null = null) {}

  /**
   * Evaluates a proposed question for materiality.
   * If immaterial or derivable, it is rejected without prompting the user.
   */
  public evaluateAndQueueQuestion(
    taskId: string,
    candidate: CandidateQuestion,
  ): { accepted: boolean; question: MaterialQuestion | null; reason: string } {
    // Immateriality filter: if answer can be mechanically derived, do not ask.
    if (candidate.isDerivableFromContext) {
      return {
        accepted: false,
        question: null,
        reason: "Immaterial: question can be mechanically derived from workspace context and tests without human intervention.",
      };
    }

    if (candidate.options.length < 2) {
      return {
        accepted: false,
        question: null,
        reason: "Invalid candidate question: at least 2 distinct selectable options required.",
      };
    }
    if (new Set(candidate.options).size !== candidate.options.length) {
      return { accepted: false, question: null, reason: "Invalid candidate question: options must be distinct." };
    }
    if (
      candidate.suggestedOption !== undefined
      && candidate.suggestedOption !== null
      && !candidate.options.includes(candidate.suggestedOption)
    ) {
      return { accepted: false, question: null, reason: "Invalid candidate question: suggested option is not selectable." };
    }

    // Verify trigger is valid materiality trigger
    const validTriggers: MaterialityTrigger[] = [
      "interpretation_divergence",
      "authority_expansion",
      "irreversible_effect",
      "external_effect",
      "missing_grant",
      "human_taste",
      "confidence_collapse",
    ];

    if (!validTriggers.includes(candidate.trigger)) {
      return {
        accepted: false,
        question: null,
        reason: `Rejected: trigger ${candidate.trigger} is not an authorized materiality trigger.`,
      };
    }

    // A caller-provided boolean (including `false`) is not evidence of
    // materiality. Only a trusted assessor can establish admission.
    const {
      isDerivableFromContext: _callerDerivabilityAssertion,
      ...candidateForVerification
    } = candidate;
    const evidence = this.materialityVerifier?.verify(taskId, candidateForVerification) ?? null;
    if (evidence === null) {
      return {
        accepted: false,
        question: null,
        reason: "Rejected: a trusted materiality assessment with immutable evidence is required before human attention can be requested.",
      };
    }
    if (
      evidence.assessorId.trim().length === 0
      || evidence.evidenceRefs.length === 0
      || evidence.evidenceRefs.some((ref) => ref.trim().length === 0)
      || evidence.trigger !== candidate.trigger
    ) {
      return {
        accepted: false,
        question: null,
        reason: "Rejected: materiality evidence is incomplete or does not match the proposed trigger.",
      };
    }

    // Ensure consequence matrix covers options
    for (const opt of candidate.options) {
      if (!candidate.consequenceMatrix[opt]) {
        return {
          accepted: false,
          question: null,
          reason: `Rejected: missing explicit consequence documentation for option '${opt}'.`,
        };
      }
    }

    const question: MaterialQuestion = {
      id: generateUuid7(),
      taskId,
      trigger: candidate.trigger,
      questionText: candidate.questionText,
      consequenceMatrix: candidate.consequenceMatrix,
      options: candidate.options,
      status: "PENDING",
      suggestedOption: candidate.suggestedOption ?? candidate.options[0] ?? null,
      selectedOption: null,
      createdAt: nowTimestamp(),
      resolvedAt: null,
    };
    materialQuestionSchema.parse(question);

    this.questions.set(question.id, question);
    this.verification.set(question.id, evidence);
    const existing = this.taskQuestions.get(taskId) ?? [];
    existing.push(question.id);
    this.taskQuestions.set(taskId, existing);

    return {
      accepted: true,
      question: this.copyQuestion(question),
      reason: `Material question accepted under trigger '${candidate.trigger}'.`,
    };
  }

  /**
   * Resolves a pending material question with the user's decision.
   */
  public resolveQuestion(
    questionId: string,
    selectedOption: string,
  ): { success: boolean; question: MaterialQuestion | null; error?: string } {
    const q = this.questions.get(questionId);
    if (!q) {
      return { success: false, question: null, error: `Question ${questionId} not found.` };
    }
    if (q.status !== "PENDING") {
      return { success: false, question: this.copyQuestion(q), error: `Question ${questionId} is already resolved (${q.status}).` };
    }
    if (!q.options.includes(selectedOption)) {
      return {
        success: false,
        question: this.copyQuestion(q),
        error: `Selected option '${selectedOption}' is not in the allowed option set: ${q.options.join(", ")}`,
      };
    }

    const updated: MaterialQuestion = {
      ...q,
      status: "ANSWERED",
      selectedOption,
      resolvedAt: nowTimestamp(),
    };
    this.questions.set(questionId, updated);
    return { success: true, question: this.copyQuestion(updated) };
  }

  /**
   * Dismisses a question without answering (e.g. if the task replanned).
   */
  public dismissQuestion(questionId: string): boolean {
    const q = this.questions.get(questionId);
    if (!q || q.status !== "PENDING") return false;
    this.questions.set(questionId, {
      ...q,
      status: "DISMISSED",
      resolvedAt: nowTimestamp(),
    });
    return true;
  }

  public getQuestion(id: string): MaterialQuestion | null {
    const question = this.questions.get(id);
    return question === undefined ? null : this.copyQuestion(question);
  }

  public listPendingQuestions(taskId?: string): readonly MaterialQuestion[] {
    const all = Array.from(this.questions.values()).filter((q) => q.status === "PENDING");
    if (taskId) {
      return all.filter((q) => q.taskId === taskId).map((question) => this.copyQuestion(question));
    }
    return all.map((question) => this.copyQuestion(question));
  }

  public getMaterialityEvidence(questionId: string): MaterialityEvidence | null {
    const evidence = this.verification.get(questionId);
    return evidence === undefined
      ? null
      : { ...evidence, evidenceRefs: [...evidence.evidenceRefs] };
  }

  /**
   * Generates a holistic attention assessment for a task.
   */
  public assessTaskAttention(taskId: string): AttentionAssessment {
    const pending = this.listPendingQuestions(taskId);
    if (pending.length === 0) {
      const assessment: AttentionAssessment = {
        taskId,
        requiresAttention: false,
        urgency: "LOW",
        pendingQuestions: [],
        reason: "Autonomous progress active; no pending material questions or blocking interventions.",
        timestamp: nowTimestamp(),
      };
      attentionAssessmentSchema.parse(assessment);
      return assessment;
    }

    const hasBlockingTrigger = pending.some(
      (q) =>
        q.trigger === "authority_expansion" ||
        q.trigger === "irreversible_effect" ||
        q.trigger === "missing_grant",
    );

    const hasHighTrigger = pending.some(
      (q) => q.trigger === "external_effect" || q.trigger === "confidence_collapse",
    );

    const urgency = hasBlockingTrigger ? "BLOCKING" : hasHighTrigger ? "HIGH" : "NORMAL";

    const assessment: AttentionAssessment = {
      taskId,
      requiresAttention: true,
      urgency,
      pendingQuestions: pending,
      reason: `Task requires human input for ${pending.length} pending material item(s) (${urgency} priority).`,
      timestamp: nowTimestamp(),
    };
    attentionAssessmentSchema.parse(assessment);
    return assessment;
  }

  private copyQuestion(question: MaterialQuestion): MaterialQuestion {
    return {
      ...question,
      options: [...question.options],
      consequenceMatrix: { ...question.consequenceMatrix },
    };
  }
}
