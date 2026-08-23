/**
 * @terminus/orchestration — Stagnation & Safety Supervisor.
 *
 * Per SPEC §27.5 (and NVIDIA AVO): An independent supervisor detects loops,
 * diagnostic stagnation, repeated strategies, budget burn, and confidence collapse,
 * triggering escalating structured interventions.
 */
import type { StagnationReport } from "@terminus/domain";
import { stagnationReportSchema, nowTimestamp } from "@terminus/domain";

export interface SupervisorTurnObservation {
  readonly turnIndex: number;
  readonly toolName: string;
  readonly toolArguments: string;
  readonly resultStatus: "success" | "error" | "failed";
  readonly readPath?: string;
  readonly readContentHash?: string;
  readonly patchPath?: string;
  readonly isRevert?: boolean;
  readonly diagnosticCount?: number;
  readonly strategyLabel?: string;
  readonly newEvidenceGathered?: boolean;
  readonly contextTokens?: number;
  readonly taskLedgerMilestoneReached?: boolean;
  readonly budgetBurnRatio: number; // 0..1
  readonly confidenceScore?: number; // 0..1
}

export interface SupervisorConfig {
  readonly identicalFailureThreshold: number; // default: 3
  readonly unchangedReReadThreshold: number; // default: 2
  readonly editRevertThreshold: number; // default: 2
  readonly diagnosticStagnationThreshold: number; // default: 3
  readonly maxTurnsWithoutProgress: number; // default: 6
  readonly budgetBurnWarningRatio: number; // default: 0.75
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  identicalFailureThreshold: 3,
  unchangedReReadThreshold: 2,
  editRevertThreshold: 2,
  diagnosticStagnationThreshold: 3,
  maxTurnsWithoutProgress: 6,
  budgetBurnWarningRatio: 0.75,
};

export class StagnationSupervisor {
  private readonly observations: SupervisorTurnObservation[] = [];

  constructor(private readonly config: SupervisorConfig = DEFAULT_SUPERVISOR_CONFIG) {}

  observe(obs: SupervisorTurnObservation): void {
    this.observations.push(obs);
  }

  evaluate(taskId: string): StagnationReport {
    const detectedSignals: string[] = [];
    const recent = this.observations.slice(-10);

    // 1. Identical failure loop
    const failCounts = new Map<string, number>();
    for (const obs of recent) {
      if (obs.resultStatus === "error" || obs.resultStatus === "failed") {
        const key = `${obs.toolName}:${obs.toolArguments}`;
        failCounts.set(key, (failCounts.get(key) ?? 0) + 1);
      }
    }
    for (const [cmd, count] of failCounts.entries()) {
      if (count >= this.config.identicalFailureThreshold) {
        detectedSignals.push(`identical_failures:${cmd} (${count}x)`);
      }
    }

    // 2. Unchanged re-reads
    const rereadCounts = new Map<string, number>();
    for (const obs of recent) {
      if (obs.readPath && obs.readContentHash) {
        const key = `${obs.readPath}:${obs.readContentHash}`;
        rereadCounts.set(key, (rereadCounts.get(key) ?? 0) + 1);
      }
    }
    for (const [file, count] of rereadCounts.entries()) {
      if (count >= this.config.unchangedReReadThreshold) {
        detectedSignals.push(`unchanged_rereads:${file} (${count}x)`);
      }
    }

    // 3. Edit / revert oscillation
    let revertCount = 0;
    for (const obs of recent) {
      if (obs.isRevert) revertCount++;
    }
    if (revertCount >= this.config.editRevertThreshold) {
      detectedSignals.push(`edit_revert_oscillation (${revertCount}x)`);
    }

    // 4. Diagnostic stagnation
    const diagHistory = recent.map((o) => o.diagnosticCount).filter((d): d is number => d !== undefined);
    if (diagHistory.length >= this.config.diagnosticStagnationThreshold) {
      const nonDecreasing = diagHistory.slice(1).every((val, i) => val >= diagHistory[i]!);
      if (nonDecreasing && diagHistory[diagHistory.length - 1]! > 0) {
        detectedSignals.push(`diagnostic_stagnation (diagnostics unchanged or increasing)`);
      }
    }

    // 5. Strategy repetition without new evidence
    const stratCounts = new Map<string, number>();
    for (const obs of recent) {
      if (obs.strategyLabel && !obs.newEvidenceGathered) {
        stratCounts.set(obs.strategyLabel, (stratCounts.get(obs.strategyLabel) ?? 0) + 1);
      }
    }
    for (const [strat, count] of stratCounts.entries()) {
      if (count >= 2) {
        detectedSignals.push(`repeated_strategy_without_evidence:${strat}`);
      }
    }

    // 6. Budget burn ratio vs progress
    const latestBurn = this.observations.length > 0 ? this.observations[this.observations.length - 1]!.budgetBurnRatio : 0;
    const progressCount = this.observations.filter((o) => o.taskLedgerMilestoneReached).length;
    if (latestBurn >= this.config.budgetBurnWarningRatio && progressCount === 0) {
      detectedSignals.push(`budget_burn_without_progress (${(latestBurn * 100).toFixed(0)}% budget consumed)`);
    }

    // 7. Confidence collapse
    const confScores = recent.map((o) => o.confidenceScore).filter((c): c is number => c !== undefined);
    if (confScores.length >= 2 && confScores[confScores.length - 1]! < 0.3) {
      detectedSignals.push(`confidence_collapse (score: ${confScores[confScores.length - 1]!.toFixed(2)})`);
    }

    // Compute aggregate stagnation score (0..1)
    const rawScore = Math.min(1.0, detectedSignals.length * 0.25);
    const stagnationScore = Number(rawScore.toFixed(2));

    // Determine recommended intervention from ladder
    let recommendedIntervention: StagnationReport["recommendedIntervention"] = "none";
    let rationale = "Execution progressing normally.";

    if (stagnationScore >= 0.75) {
      recommendedIntervention = "request_user_decision";
      rationale = `Critical stagnation detected across ${detectedSignals.length} signals: ${detectedSignals.join(", ")}. Escalating to operator.`;
    } else if (stagnationScore >= 0.5) {
      recommendedIntervention = "change_strategy";
      rationale = `Significant stagnation detected: ${detectedSignals.join(", ")}. Recommending strategy shift and critic review.`;
    } else if (stagnationScore >= 0.25) {
      recommendedIntervention = "warn";
      rationale = `Early stagnation signals observed: ${detectedSignals.join(", ")}.`;
    }

    const report: StagnationReport = {
      taskId,
      stagnationScore,
      detectedSignals,
      turnCount: this.observations.length,
      budgetBurnRatio: latestBurn,
      recommendedIntervention,
      rationale,
      timestamp: nowTimestamp(),
    };

    return stagnationReportSchema.parse(report) as unknown as StagnationReport;
  }
}
