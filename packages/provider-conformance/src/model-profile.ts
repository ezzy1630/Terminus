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

export const IMMUTABLE_ARTIFACT_REF_PATTERN =
  /^(?:artifact:\/\/sha256\/[0-9a-f]{64}(?:#[a-zA-Z0-9_.-]+)?|sha256:[0-9a-f]{64})$/i;

export const isImmutableArtifactRef = (ref: string): boolean =>
  IMMUTABLE_ARTIFACT_REF_PATTERN.test(ref.trim());

const requireText = (name: string, value: string): void => {
  if (value.trim().length === 0) throw new Error(`${name} must be non-empty`);
};

/** Build a complete, identity-bound conformance report from observed checks. */
// skipcq: JS-R1005
export const buildModelProfileConformanceReport = (
  input: ModelProfileReportInput,
): ModelProfileConformanceReport => {
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
    if (!isImmutableArtifactRef(check.artifactRef)) {
      throw new Error(
        `${check.checkId}.artifactRef must be an immutable content-addressed artifact reference`,
      );
    }
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

export interface ModelProfileExpectation {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly providerId: string;
}

/**
 * Fail closed unless every expected versioned profile has one complete report
 * from the requested evidence class. Caller-supplied booleans cannot satisfy
 * this gate.
 */
// skipcq: JS-R1005
export const runModelProfileExitGate = (input: {
  readonly expectedProfiles: readonly ModelProfileExpectation[];
  readonly requiredEvidenceClass: ConformanceEvidenceClass;
  readonly reports: readonly unknown[];
}): ModelProfileExitGateResult => {
  if (input.expectedProfiles.length === 0) throw new Error("expectedProfiles must be non-empty");
  const expectedIds = input.expectedProfiles.map((profile) => profile.profileId);
  if (new Set(expectedIds).size !== expectedIds.length) {
    throw new Error("expectedProfiles contains duplicate profileId values");
  }
  const failures: string[] = [];
  const reports: ModelProfileConformanceReport[] = [];
  for (const [index, candidate] of input.reports.entries()) {
    try {
      reports.push(validateModelProfileConformanceReport(candidate));
    } catch (error: unknown) {
      failures.push(
        `report[${index}]: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const expected of input.expectedProfiles) {
    for (const [field, value] of Object.entries(expected)) requireText(`expected.${field}`, value);
    const matches = reports.filter((report) => report.profileId === expected.profileId);
    if (matches.length !== 1) {
      failures.push(`${expected.profileId}: expected exactly one report, received ${matches.length}`);
      continue;
    }
    const [report] = matches;
    if (report?.providerId !== expected.providerId) {
      failures.push(`${expected.profileId}: provider does not match ${expected.providerId}`);
    }
    if (report?.profileVersion !== expected.profileVersion) {
      failures.push(`${expected.profileId}: profile version does not match ${expected.profileVersion}`);
    }
    if (report?.evidenceClass !== input.requiredEvidenceClass) {
      failures.push(`${expected.profileId}: requires ${input.requiredEvidenceClass} evidence`);
    }
    if (report?.passed !== true) failures.push(`${expected.profileId}: conformance checks did not pass`);
  }
  const unexpected = reports.filter((report) => !expectedIds.includes(report.profileId));
  for (const report of unexpected) failures.push(`${report.profileId}: unexpected profile report`);
  return {
    passed: failures.length === 0,
    requiredEvidenceClass: input.requiredEvidenceClass,
    expectedProfileIds: expectedIds,
    failures,
    reports,
  };
};

/** Validate an untrusted report object at boundary transitions. */
// skipcq: JS-R1005
export const validateModelProfileConformanceReport = (
  value: unknown,
): ModelProfileConformanceReport => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("model profile conformance report must be an object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== MODEL_PROFILE_CONFORMANCE_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion: ${String(obj.schemaVersion)}`);
  }
  for (const field of [
    "providerId",
    "modelSnapshot",
    "apiVersion",
    "profileId",
    "profileVersion",
    "testedAt",
    "terminusCommit",
  ]) {
    if (typeof obj[field] !== "string" || (obj[field] as string).trim().length === 0) {
      throw new Error(`report.${field} must be a non-empty string`);
    }
  }
  if (obj.evidenceClass !== "deterministic_adapter" && obj.evidenceClass !== "external_live") {
    throw new Error(`invalid evidenceClass: ${String(obj.evidenceClass)}`);
  }
  if (Number.isNaN(Date.parse(obj.testedAt as string))) {
    throw new Error("report.testedAt must be an RFC3339 timestamp");
  }
  if (!/^[0-9a-f]{40,64}$/i.test(obj.terminusCommit as string)) {
    throw new Error("report.terminusCommit must be a full Git revision");
  }
  if (!Array.isArray(obj.checks)) {
    throw new Error("report.checks must be an array");
  }
  const checks = obj.checks.map((value, index): ModelProfileCheckResult => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`report.checks[${index}] must be an object`);
    }
    const check = value as Record<string, unknown>;
    if (
      typeof check.checkId !== "string"
      || !MODEL_PROFILE_CHECK_IDS.includes(check.checkId as ModelProfileCheckId)
    ) {
      throw new Error(`report.checks[${index}].checkId is invalid`);
    }
    if (check.status !== "passed" && check.status !== "failed" && check.status !== "blocked") {
      throw new Error(`report.checks[${index}].status is invalid`);
    }
    if (typeof check.artifactRef !== "string") {
      throw new Error(`report.checks[${index}].artifactRef must be a string`);
    }
    if (check.diagnostic !== null && typeof check.diagnostic !== "string") {
      throw new Error(`report.checks[${index}].diagnostic must be a string or null`);
    }
    return {
      checkId: check.checkId as ModelProfileCheckId,
      status: check.status,
      artifactRef: check.artifactRef,
      diagnostic: check.diagnostic,
    };
  });
  return buildModelProfileConformanceReport({
    providerId: obj.providerId as string,
    modelSnapshot: obj.modelSnapshot as string,
    apiVersion: obj.apiVersion as string,
    profileId: obj.profileId as string,
    profileVersion: obj.profileVersion as string,
    evidenceClass: obj.evidenceClass as ConformanceEvidenceClass,
    testedAt: obj.testedAt as string,
    terminusCommit: obj.terminusCommit as string,
    checks,
  });
}
