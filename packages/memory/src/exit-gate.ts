/**
 * M10 exit gate evaluation (SPEC §48.13, ADR-0023).
 *
 * Gate passes only when held-out utility is positive, harmful retrieval is
 * low, and provenance is complete. Even when the gate function returns
 * passed=true for a fixture corpus, product config remains
 * `context.memory.enabled: false` until an explicit promotion decision.
 */
import type { ExperimentReport } from "./experiments.js";

export interface ExitGateThresholds {
  /** Minimum utility delta (withMemory - baseline). */
  readonly minUtilityDelta: number;
  /** Maximum harmful retrieval rate. */
  readonly maxHarmfulRetrievalRate: number;
  /** Minimum provenance completeness rate. */
  readonly minProvenanceCompleteRate: number;
  /** Minimum precision. */
  readonly minPrecision: number;
  /** Maximum stale-injection harm rate. */
  readonly maxStaleHarmRate: number;
  /** Minimum contradiction detection rate. */
  readonly minContradictionDetectionRate: number;
}

export const DEFAULT_EXIT_GATE_THRESHOLDS: ExitGateThresholds = {
  minUtilityDelta: 0.05,
  maxHarmfulRetrievalRate: 0.05,
  minProvenanceCompleteRate: 1.0,
  minPrecision: 0.5,
  maxStaleHarmRate: 0.0,
  minContradictionDetectionRate: 0.8,
};

export interface ExitGateVerdict {
  readonly passed: boolean;
  /** Product default must stay disabled until an explicit promotion. */
  readonly remainsDisabledByDefault: true;
  readonly reasons: readonly string[];
  readonly report: ExperimentReport;
  readonly thresholds: ExitGateThresholds;
}

export function evaluateExitGate(
  report: ExperimentReport,
  thresholds: ExitGateThresholds = DEFAULT_EXIT_GATE_THRESHOLDS,
): ExitGateVerdict {
  const reasons: string[] = [];

  if (!report.utility.positive || report.utility.delta < thresholds.minUtilityDelta) {
    reasons.push(
      `utility delta ${report.utility.delta.toFixed(4)} < ${thresholds.minUtilityDelta}`,
    );
  }
  if (report.harm.harmfulRetrievalRate > thresholds.maxHarmfulRetrievalRate) {
    reasons.push(
      `harmful retrieval rate ${report.harm.harmfulRetrievalRate.toFixed(4)} > ${thresholds.maxHarmfulRetrievalRate}`,
    );
  }
  if (report.provenance.completeRate < thresholds.minProvenanceCompleteRate) {
    reasons.push(
      `provenance complete rate ${report.provenance.completeRate.toFixed(4)} < ${thresholds.minProvenanceCompleteRate}`,
    );
  }
  if (report.precision.precision < thresholds.minPrecision) {
    reasons.push(
      `precision ${report.precision.precision.toFixed(4)} < ${thresholds.minPrecision}`,
    );
  }
  if (report.stale.harmRate > thresholds.maxStaleHarmRate) {
    reasons.push(
      `stale harm rate ${report.stale.harmRate.toFixed(4)} > ${thresholds.maxStaleHarmRate}`,
    );
  }
  if (report.contradiction.detectionRate < thresholds.minContradictionDetectionRate) {
    reasons.push(
      `contradiction detection ${report.contradiction.detectionRate.toFixed(4)} < ${thresholds.minContradictionDetectionRate}`,
    );
  }

  return {
    passed: reasons.length === 0,
    remainsDisabledByDefault: true,
    reasons,
    report,
    thresholds,
  };
}
