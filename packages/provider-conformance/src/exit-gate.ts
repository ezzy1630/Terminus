/**
 * @terminus/provider-conformance — Exit gate types and logic (§38.19).
 */
export interface ExitGateResult {
  readonly passed: boolean;
  readonly totalTests: number;
  readonly passedTests: number;
  readonly failedTests: readonly string[];
  readonly warnings: readonly string[];
  readonly providerResults: Readonly<Record<string, ProviderGateResult>>;
}

export interface ProviderGateResult {
  readonly providerId: string;
  readonly rendersParseable: boolean;
  readonly costsReconcile: boolean;
  readonly cacheBehavesUnderFailure: boolean;
  readonly fallbackPolicyCompliant: boolean;
  readonly confidentialityEnforced: boolean;
  readonly errorsProjectCorrectly: boolean;
  readonly issues: readonly string[];
}

export async function runExitGate(
  results: Readonly<Record<string, ProviderGateResult>>,
): Promise<ExitGateResult> {
  const warnings: string[] = [];
  const failedTests: string[] = [];
  let passedTests = 0;
  let totalTests = 0;

  if (Object.keys(results).length === 0) {
    failedTests.push("no provider conformance results supplied");
  }

  for (const [providerId, result] of Object.entries(results)) {
    totalTests += 6;
    if (!result.rendersParseable) {
      failedTests.push(`${providerId}: renders not parseable`);
    } else {
      passedTests++;
    }
    if (!result.costsReconcile) {
      failedTests.push(`${providerId}: costs did not reconcile`);
      warnings.push(`${providerId}: cost reconciliation gap — check pricing model`);
    } else {
      passedTests++;
    }
    if (!result.cacheBehavesUnderFailure) {
      failedTests.push(`${providerId}: cache does not behave under failure`);
    } else {
      passedTests++;
    }
    if (!result.fallbackPolicyCompliant) {
      failedTests.push(`${providerId}: fallback not policy compliant`);
    } else {
      passedTests++;
    }
    if (!result.confidentialityEnforced) {
      failedTests.push(`${providerId}: confidentiality not enforced`);
    } else {
      passedTests++;
    }
    if (!result.errorsProjectCorrectly) {
      failedTests.push(`${providerId}: errors not projected correctly`);
    } else {
      passedTests++;
    }
  }

  return {
    passed: failedTests.length === 0,
    totalTests,
    passedTests,
    failedTests,
    warnings,
    providerResults: results,
  };
}

export function buildProviderGateResult(
  providerId: string,
  checks: {
    readonly rendersParseable: boolean;
    readonly costsReconcile: boolean;
    readonly cacheBehavesUnderFailure: boolean;
    readonly fallbackPolicyCompliant: boolean;
    readonly confidentialityEnforced: boolean;
    readonly errorsProjectCorrectly: boolean;
  },
  issues: readonly string[] = [],
): ProviderGateResult {
  return {
    providerId,
    rendersParseable: checks.rendersParseable,
    costsReconcile: checks.costsReconcile,
    cacheBehavesUnderFailure: checks.cacheBehavesUnderFailure,
    fallbackPolicyCompliant: checks.fallbackPolicyCompliant,
    confidentialityEnforced: checks.confidentialityEnforced,
    errorsProjectCorrectly: checks.errorsProjectCorrectly,
    issues: [...issues],
  };
}
