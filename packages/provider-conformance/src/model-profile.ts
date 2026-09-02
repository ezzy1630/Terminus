export const MODEL_PROFILE_CONFORMANCE_SCHEMA_VERSION = 1 as const;

export const MODEL_PROFILE_CHECK_IDS = [
  "structured_tool_calls",
  "parallel_tool_semantics",
  "reasoning_replay",
  "truncation",
  "instruction_role_ordering",
  "cache_semantics",
  "usage_accounting",
  "cancellation",
  "retry_idempotency",
  "empty_response",
  "refusal",
  "large_tool_result",
  "tool_error_continuation",
  "reasoning_effort_verbosity",
] as const;

export type ModelProfileCheckId = (typeof MODEL_PROFILE_CHECK_IDS)[number];
export type ConformanceEvidenceClass = "deterministic_adapter" | "external_live";
export type ModelProfileCheckStatus = "passed" | "failed" | "blocked";

export interface ModelProfileCheckResult {
  readonly checkId: ModelProfileCheckId;
  readonly status: ModelProfileCheckStatus;
  readonly artifactRef: string;
  readonly diagnostic: string | null;
}

export interface ModelProfileConformanceReport {
  readonly schemaVersion: typeof MODEL_PROFILE_CONFORMANCE_SCHEMA_VERSION;
  readonly providerId: string;
  readonly modelSnapshot: string;
  readonly apiVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly evidenceClass: ConformanceEvidenceClass;
  readonly testedAt: string;
  readonly terminusCommit: string;
  readonly checks: readonly ModelProfileCheckResult[];
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface ModelProfileReportInput {
  readonly providerId: string;
  readonly modelSnapshot: string;
  readonly apiVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly evidenceClass: ConformanceEvidenceClass;
  readonly testedAt: string;
  readonly terminusCommit: string;
  readonly checks: readonly ModelProfileCheckResult[];
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

/** Build a complete, identity-bound conformance report from observed checks. */
export function buildModelProfileConformanceReport(
  input: ModelProfileReportInput,
): ModelProfileConformanceReport {
  for (const [name, value] of Object.entries({
    providerId: input.providerId,
    modelSnapshot: input.modelSnapshot,
    apiVersion: input.apiVersion,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    testedAt: input.testedAt,
    terminusCommit: input.terminusCommit,
  })) requireText(name, value);

  const byId = new Map<ModelProfileCheckId, ModelProfileCheckResult>();
  for (const check of input.checks) {
    if (!MODEL_PROFILE_CHECK_IDS.includes(check.checkId)) {
      throw new Error(`unknown model-profile check: ${check.checkId}`);
    }
    if (byId.has(check.checkId)) throw new Error(`duplicate model-profile check: ${check.checkId}`);
    requireText(`${check.checkId}.artifactRef`, check.artifactRef);
    if (check.status !== "passed" && (check.diagnostic === null || check.diagnostic.trim().length === 0)) {
      throw new Error(`${check.checkId} ${check.status} result requires a diagnostic`);
    }
    byId.set(check.checkId, check);
  }
  const missing = MODEL_PROFILE_CHECK_IDS.filter((checkId) => !byId.has(checkId));
  if (missing.length > 0) throw new Error(`missing model-profile checks: ${missing.join(", ")}`);

  const checks = MODEL_PROFILE_CHECK_IDS.map((checkId) => byId.get(checkId)!);
  const failures = checks
    .filter((check) => check.status !== "passed")
    .map((check) => `${check.checkId}: ${check.status}: ${check.diagnostic}`);
  return {
    schemaVersion: MODEL_PROFILE_CONFORMANCE_SCHEMA_VERSION,
    providerId: input.providerId,
    modelSnapshot: input.modelSnapshot,
    apiVersion: input.apiVersion,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    evidenceClass: input.evidenceClass,
    testedAt: input.testedAt,
    terminusCommit: input.terminusCommit,
    checks,
    passed: failures.length === 0,
    failures,
  };
}

export interface ModelProfileExitGateResult {
  readonly passed: boolean;
  readonly requiredEvidenceClass: ConformanceEvidenceClass;
  readonly expectedProfileIds: readonly string[];
  readonly failures: readonly string[];
  readonly reports: readonly ModelProfileConformanceReport[];
}

/**
 * Fail closed unless every expected versioned profile has one complete report
 * from the requested evidence class. Caller-supplied booleans cannot satisfy
 * this gate.
 */
export function runModelProfileExitGate(input: {
  readonly expectedProfileIds: readonly string[];
  readonly requiredEvidenceClass: ConformanceEvidenceClass;
  readonly reports: readonly ModelProfileConformanceReport[];
}): ModelProfileExitGateResult {
  const expected = [...new Set(input.expectedProfileIds)];
  if (expected.length === 0) throw new Error("expectedProfileIds must be non-empty");
  const failures: string[] = [];
  for (const profileId of expected) {
    const matches = input.reports.filter((report) => report.profileId === profileId);
    if (matches.length !== 1) {
      failures.push(`${profileId}: expected exactly one report, received ${matches.length}`);
      continue;
    }
    const [report] = matches;
    if (report?.evidenceClass !== input.requiredEvidenceClass) {
      failures.push(`${profileId}: requires ${input.requiredEvidenceClass} evidence`);
    }
    if (report?.passed !== true) failures.push(`${profileId}: conformance checks did not pass`);
  }
  const unexpected = input.reports.filter((report) => !expected.includes(report.profileId));
  for (const report of unexpected) failures.push(`${report.profileId}: unexpected profile report`);
  return {
    passed: failures.length === 0,
    requiredEvidenceClass: input.requiredEvidenceClass,
    expectedProfileIds: expected,
    failures,
    reports: input.reports,
  };
}
