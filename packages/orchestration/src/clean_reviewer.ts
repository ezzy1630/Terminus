/**
 * @terminus/orchestration — Clean-Context Independent Reviewer.
 *
 * Per SPEC §27.4 & §15.3: Reviewers receive clean context (task contract,
 * candidate diff/artifact, evidence) without inheriting actor biases or
 * ambient merge authority. Independent model family is preferred.
 */
import type { TaskContractV2, RiskClass } from "@terminus/domain";

export interface CleanReviewContext {
  readonly taskId: string;
  readonly contract: TaskContractV2;
  readonly candidateDiff: string;
  readonly changedFiles: readonly string[];
  readonly verificationEvidence: readonly {
    readonly claimId: string;
    readonly verifierKind: string;
    readonly passed: boolean;
    readonly summary: string;
  }[];
  readonly riskClass: RiskClass;
  readonly implementerModelFamilyRef: string;
}

export interface ReviewFinding {
  readonly id: string;
  readonly path: string;
  readonly line?: number;
  readonly severity: "critical" | "high" | "medium" | "low" | "suggestion";
  readonly title: string;
  readonly description: string;
  readonly proposedRemediation?: string;
}

export interface CleanReviewReport {
  readonly taskId: string;
  readonly reviewerModelFamilyRef: string;
  readonly isDiverseFamily: boolean;
  readonly passed: boolean;
  readonly findings: readonly ReviewFinding[];
  readonly summary: string;
  readonly timestamp: string;
}

export class CleanContextReviewer {
  /**
   * Build clean context prompt/payload stripping actor self-justifications.
   */
  buildCleanReviewPayload(ctx: CleanReviewContext): {
    readonly systemPrompt: string;
    readonly contextPayload: Record<string, unknown>;
  } {
    const systemPrompt =
      "You are an independent, adversarial code reviewer. You evaluate whether the candidate diff satisfies the task contract and acceptance criteria. You have no merge authority. Identify defects, invariant violations, regressions, security risks, or missing test coverage.";

    const contextPayload = {
      task: {
        mission: ctx.contract.mission,
        acceptanceCriteria: ctx.contract.acceptance,
        allowedScope: ctx.contract.scope,
      },
      candidate: {
        diff: ctx.candidateDiff,
        changedFiles: ctx.changedFiles,
      },
      evidence: ctx.verificationEvidence,
      risk: {
        riskClass: ctx.riskClass,
      },
    };

    return { systemPrompt, contextPayload };
  }

  /**
   * Evaluate candidate review findings and determine admission readiness.
   */
  evaluateFindings(
    taskId: string,
    reviewerModelFamilyRef: string,
    implementerModelFamilyRef: string,
    findings: readonly ReviewFinding[],
  ): CleanReviewReport {
    const isDiverseFamily = reviewerModelFamilyRef !== implementerModelFamilyRef;
    const hasBlockers = findings.some(
      (f) => f.severity === "critical" || f.severity === "high",
    );

    const passed = !hasBlockers;
    const summary = passed
      ? `Clean-context review passed with ${findings.length} non-blocking suggestions.`
      : `Clean-context review rejected candidate due to ${findings.filter((f) => f.severity === "critical" || f.severity === "high").length} blocking findings.`;

    return {
      taskId,
      reviewerModelFamilyRef,
      isDiverseFamily,
      passed,
      findings,
      summary,
      timestamp: new Date().toISOString(),
    };
  }
}
