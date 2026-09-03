export type VerificationTier = 0 | 1 | 2 | 3;

export interface VerificationTierInput {
  readonly riskClass: "low" | "normal" | "high" | "critical";
  readonly changedFiles: readonly string[];
}

export interface VerificationTierDecision {
  readonly tier: VerificationTier;
  readonly reason: string;
}

const HIGH_RISK_PATH = /(^|[/_.-])(auth|credential|migration|migrations|permission|policy|proto|release|sandbox|schema|secret|security|token)([/_.-]|$)|\.sql$/i;
const LOW_RISK_PATH = /(^|\/)(docs?|examples?|tests?|fixtures?)(\/|$)|\.(md|mdx|txt|snap)$/i;

/**
 * Conservatively select the smallest verification tier justified by the
 * observed mutation surface. Ambiguous mutations are ordinary code (Tier 2),
 * never Tier 1.
 */
// skipcq: JS-R1005
export const classifyVerificationTier = (input: VerificationTierInput): VerificationTierDecision => {
  const paths = [...new Set(input.changedFiles.filter((path) => path.trim().length > 0))];
  if (paths.length === 0) {
    return { tier: 0, reason: "no workspace mutation was observed" };
  }
  if (
    input.riskClass === "high"
    || input.riskClass === "critical"
    || paths.some((path) => HIGH_RISK_PATH.test(path))
  ) {
    return { tier: 3, reason: "risk class or changed path requires adversarial verification" };
  }
  if (input.riskClass === "low" && paths.every((path) => LOW_RISK_PATH.test(path))) {
    return { tier: 1, reason: "all observed mutations are isolated low-risk support files" };
  }
  return { tier: 2, reason: "ordinary or ambiguous code mutation requires targeted behavioral proof" };
}
