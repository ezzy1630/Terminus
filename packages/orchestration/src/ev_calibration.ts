/**
 * Empirical calibration inputs for delegation expected value.
 *
 * The orchestration package does not train or update a policy online. A
 * composition root supplies persisted, already-verified outcomes. Without a
 * matching outcome, the scheduler reports a conservative prior instead of
 * presenting fixed arithmetic as learned evidence.
 */
import { z } from "zod";
import type { DelegationRole, RiskClass } from "@terminus/domain";

export const verifiedDelegationOutcomeSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["scout", "implementer", "reviewer", "specialist"]),
  isWriteWork: z.boolean(),
  riskClass: z.enum(["low", "normal", "high", "critical"]),
  verification: z.object({
    status: z.literal("verified"),
    receiptId: z.string().min(1),
  }),
  outcome: z.enum(["beneficial", "not_beneficial"]),
  observedBenefit: z.number().finite().min(0).max(1),
  observedParallelSpeedup: z.number().finite().min(0).max(1),
  observedTokenCost: z.number().finite().min(0).max(1),
  observedCoordinationCost: z.number().finite().min(0).max(1),
  observedConflictRisk: z.number().finite().min(0).max(1),
  observedReviewCost: z.number().finite().min(0).max(1),
  verifiedAt: z.string().min(1),
});

/** Persisted EV terms are normalized by the verifier before storage. */
export type VerifiedDelegationOutcome = z.infer<typeof verifiedDelegationOutcomeSchema>;

/** Persistence boundary. The store must return durable verified records. */
export interface VerifiedDelegationOutcomeStore {
  readonly loadVerifiedOutcomes: () => readonly unknown[];
}

export type EVCalibrationSource = "persisted_verified_outcomes" | "conservative_prior";

export interface EVCalibrationSnapshot {
  readonly source: EVCalibrationSource;
  readonly sampleCount: number;
  readonly confidence: number;
  readonly beneficialRate: number;
  readonly expectedBenefit: number;
  readonly expectedParallelSpeedup: number;
  readonly expectedTokenCost: number;
  readonly expectedCoordinationCost: number;
  readonly expectedConflictRisk: number;
  readonly expectedReviewCost: number;
}

export interface EVCalibrationQuery {
  readonly role: DelegationRole;
  readonly isWriteWork: boolean;
  readonly riskClass: RiskClass;
}

const CONSERVATIVE_PRIOR: Omit<EVCalibrationSnapshot, "source" | "sampleCount" | "confidence"> = {
  beneficialRate: 0.5,
  expectedBenefit: 0.5,
  expectedParallelSpeedup: 0.5,
  expectedTokenCost: 0,
  expectedCoordinationCost: 0,
  expectedConflictRisk: 0,
  expectedReviewCost: 0,
};

/**
 * Reads verified outcomes at evaluation time so the scheduler never treats
 * an in-memory write or an unverified worker report as training data.
 */
export class VerifiedOutcomeCalibrator {
  constructor(private readonly store: VerifiedDelegationOutcomeStore | null = null) {}

  calibrate(query: EVCalibrationQuery): EVCalibrationSnapshot {
    const records = this.readVerifiedOutcomes();
    const roleMatches = records.filter((record) => record.role === query.role);
    const matches = roleMatches.filter(
      (record) => record.isWriteWork === query.isWriteWork && record.riskClass === query.riskClass,
    );
    const usable = matches.length > 0
      ? matches
      : roleMatches.filter((record) => record.isWriteWork === query.isWriteWork);

    if (usable.length === 0) {
      return {
        source: "conservative_prior",
        sampleCount: 0,
        confidence: 0,
        ...CONSERVATIVE_PRIOR,
      };
    }

    const average = (selector: (record: VerifiedDelegationOutcome) => number): number =>
      usable.reduce((sum, record) => sum + selector(record), 0) / usable.length;
    const sampleCount = usable.length;

    return {
      source: "persisted_verified_outcomes",
      sampleCount,
      confidence: Math.min(1, sampleCount / 8),
      beneficialRate: average((record) => record.outcome === "beneficial" ? 1 : 0),
      expectedBenefit: average((record) =>
        record.outcome === "beneficial" ? record.observedBenefit : 0,
      ),
      expectedParallelSpeedup: average((record) => record.observedParallelSpeedup),
      expectedTokenCost: average((record) => record.observedTokenCost),
      expectedCoordinationCost: average((record) => record.observedCoordinationCost),
      expectedConflictRisk: average((record) => record.observedConflictRisk),
      expectedReviewCost: average((record) => record.observedReviewCost),
    };
  }

  private readVerifiedOutcomes(): readonly VerifiedDelegationOutcome[] {
    if (this.store === null) return [];
    return this.store.loadVerifiedOutcomes().map((record) =>
      verifiedDelegationOutcomeSchema.parse(record) as VerifiedDelegationOutcome,
    );
  }
}
