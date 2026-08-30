import type {
  Rfc3339Timestamp,
  Task,
  Uuid7,
} from "@terminus/domain";
import {
  WorkingMemoryService,
  type WorkingMemoryBlocker,
  type WorkingMemoryBudgetConsumption,
  type WorkingMemoryCriterion,
  type WorkingMemoryDecision,
  type WorkingMemoryDiagnostic,
  type WorkingMemoryDiagnosticState,
  type WorkingMemoryFailedApproach,
  type WorkingMemoryFileChange,
  type WorkingMemoryJobRef,
  type WorkingMemoryRepository,
  type WorkingMemorySnapshot,
} from "@terminus/memory";
import type { CheckpointContent } from "@terminus/context-compiler";
import { excerpt } from "./turn-continuity.js";

export const MAX_WORKING_MEMORY_SECTION_CHARS = 16_000;
export const MAX_CHECKPOINT_SUMMARY_CHARS = 8_000;

const LIMITS = {
  acceptanceCriteria: 24,
  blockers: 8,
  decisions: 8,
  diagnosticsPerSeverity: 8,
  evidencePerItem: 2,
  failedApproaches: 8,
  failingTests: 12,
  modifiedFiles: 24,
  runningJobs: 8,
  sourceVersions: 16,
  idChars: 160,
  pathChars: 512,
  summaryChars: 384,
  versionChars: 256,
} as const;

export interface WorkingMemoryProjectionInput {
  readonly task: Task;
  readonly capturedAt: Rfc3339Timestamp;
  readonly criterionStatuses: ReadonlyMap<string, WorkingMemoryCriterion>;
  readonly decisions: readonly WorkingMemoryDecision[];
  readonly failedApproaches: readonly WorkingMemoryFailedApproach[];
  readonly modifiedFiles: readonly WorkingMemoryFileChange[];
  readonly diagnosticState: WorkingMemoryDiagnosticState;
  readonly runningJobs: readonly WorkingMemoryJobRef[];
  readonly budgetConsumption: WorkingMemoryBudgetConsumption;
  readonly blockers: readonly WorkingMemoryBlocker[];
  readonly sourceVersions: Readonly<Record<string, string>>;
}

interface OmittedWorkingMemory {
  acceptance_criteria: number;
  blockers: number;
  criterion_evidence: number;
  decisions: number;
  diagnostic_errors: number;
  diagnostic_warnings: number;
  failed_approaches: number;
  failure_evidence: number;
  failing_tests: number;
  modified_files: number;
  running_jobs: number;
  source_versions: number;
}

export interface WorkingMemoryContextSection {
  readonly schema_version: "terminus.working-memory.v1";
  readonly captured_at: string;
  readonly phase: string;
  readonly contract_version: number;
  readonly objective: string;
  readonly acceptance_criteria: Array<{
    readonly id: string;
    readonly statement: string;
    readonly required: boolean;
    readonly status: WorkingMemoryCriterion["status"];
    readonly last_observed_at: string | null;
    readonly evidence: string[];
  }>;
  readonly decisions: Array<{
    readonly id: string;
    readonly kind: WorkingMemoryDecision["kind"];
    readonly summary: string;
    readonly decided_at: string;
    readonly decided_by: string | null;
  }>;
  readonly failed_approaches: Array<{
    readonly id: string;
    readonly summary: string;
    readonly reason: string;
    readonly attempted_at: string;
    readonly evidence_refs: string[];
  }>;
  readonly modified_files: Array<{
    readonly path: string;
    readonly change_kind: WorkingMemoryFileChange["changeKind"];
    readonly source_version: string | null;
    readonly observed_at: string;
  }>;
  readonly diagnostic_state: {
    readonly failing_tests: string[];
    readonly errors: Array<{
      readonly path: string;
      readonly message: string;
      readonly observed_at: string;
    }>;
    readonly warnings: Array<{
      readonly path: string;
      readonly message: string;
      readonly observed_at: string;
    }>;
    readonly observed_at: string;
  };
  readonly running_jobs: Array<{
    readonly job_id: string;
    readonly label: string;
    readonly started_at: string;
  }>;
  readonly budget_consumption: {
    readonly model_micros: string;
    readonly model_micros_limit: string;
    readonly compute_seconds: number;
    readonly compute_seconds_limit: number;
    readonly wall_clock_seconds: number;
    readonly wall_clock_seconds_limit: number;
    readonly human_approvals: number;
    readonly human_approvals_limit: number;
  };
  readonly blockers: Array<{
    readonly id: string;
    readonly kind: WorkingMemoryBlocker["kind"];
    readonly summary: string;
    readonly raised_at: string;
  }>;
  readonly source_versions: Array<{
    readonly uri: string;
    readonly version: string;
  }>;
  truncation?: { readonly omitted: OmittedWorkingMemory };
}

function initialOmissions(): OmittedWorkingMemory {
  return {
    acceptance_criteria: 0,
    blockers: 0,
    criterion_evidence: 0,
    decisions: 0,
    diagnostic_errors: 0,
    diagnostic_warnings: 0,
    failed_approaches: 0,
    failure_evidence: 0,
    failing_tests: 0,
    modified_files: 0,
    running_jobs: 0,
    source_versions: 0,
  };
}

function boundedText(value: string, maxChars: number = LIMITS.summaryChars): string {
  return excerpt(value, maxChars);
}

function boundedItems<T>(
  values: readonly T[],
  limit: number,
  omissions: OmittedWorkingMemory,
  omissionKey: keyof OmittedWorkingMemory,
): readonly T[] {
  omissions[omissionKey] += Math.max(0, values.length - limit);
  return values.slice(0, limit);
}

function boundedDiagnostic(diagnostic: WorkingMemoryDiagnostic): {
  readonly path: string;
  readonly message: string;
  readonly observed_at: string;
} {
  return {
    path: boundedText(diagnostic.path, LIMITS.pathChars),
    message: boundedText(diagnostic.message),
    observed_at: diagnostic.observedAt,
  };
}

function boundedEvidence(
  evidence: readonly string[],
  omissions: OmittedWorkingMemory,
  omissionKey: "criterion_evidence" | "failure_evidence",
): string[] {
  omissions[omissionKey] += Math.max(0, evidence.length - LIMITS.evidencePerItem);
  return evidence
    .slice(0, LIMITS.evidencePerItem)
    .map((reference) => boundedText(reference, LIMITS.versionChars));
}

function hasOmissions(omissions: OmittedWorkingMemory): boolean {
  return Object.values(omissions).some((count) => count > 0);
}

function enforceSectionBound(
  section: WorkingMemoryContextSection,
  omissions: OmittedWorkingMemory,
): WorkingMemoryContextSection {
  if (hasOmissions(omissions)) section.truncation = { omitted: omissions };

  const reducers: ReadonlyArray<{
    readonly items: unknown[];
    readonly key: keyof OmittedWorkingMemory;
    readonly minimum: number;
  }> = [
    { items: section.source_versions, key: "source_versions", minimum: 1 },
    { items: section.diagnostic_state.warnings, key: "diagnostic_warnings", minimum: 0 },
    { items: section.failed_approaches, key: "failed_approaches", minimum: 0 },
    { items: section.decisions, key: "decisions", minimum: 0 },
    { items: section.modified_files, key: "modified_files", minimum: 0 },
    { items: section.diagnostic_state.errors, key: "diagnostic_errors", minimum: 0 },
    { items: section.diagnostic_state.failing_tests, key: "failing_tests", minimum: 0 },
    { items: section.running_jobs, key: "running_jobs", minimum: 0 },
    { items: section.blockers, key: "blockers", minimum: 0 },
    { items: section.acceptance_criteria, key: "acceptance_criteria", minimum: 1 },
  ];

  while (JSON.stringify(section).length > MAX_WORKING_MEMORY_SECTION_CHARS) {
    const reducer = reducers.find((candidate) => candidate.items.length > candidate.minimum);
    if (reducer === undefined) break;
    reducer.items.pop();
    omissions[reducer.key] += 1;
    section.truncation = { omitted: omissions };
  }
  if (JSON.stringify(section).length > MAX_WORKING_MEMORY_SECTION_CHARS) {
    throw new RangeError("working-memory section exceeded its hard context bound");
  }

  return section;
}

async function projectWorkingMemory(input: WorkingMemoryProjectionInput): Promise<WorkingMemorySnapshot> {
  const repository: WorkingMemoryRepository = {
    getTask: async (taskId: Uuid7) => taskId === input.task.id ? input.task : null,
    listDecisions: async () => input.decisions,
    listFailedApproaches: async () => input.failedApproaches,
    listModifiedFiles: async () => input.modifiedFiles,
    getDiagnosticState: async () => input.diagnosticState,
    listRunningJobs: async () => input.runningJobs,
    getBudgetConsumption: async () => input.budgetConsumption,
    listBlockers: async () => input.blockers,
    listCriterionStatuses: async () => input.criterionStatuses,
  };
  return new WorkingMemoryService({ repo: repository, clock: () => input.capturedAt })
    .getWorkingMemory(input.task.id);
}

/** Build a bounded provider-facing projection from deterministic task state. */
export async function buildWorkingMemoryContextSection(
  input: WorkingMemoryProjectionInput,
): Promise<WorkingMemoryContextSection> {
  const snapshot = await projectWorkingMemory(input);
  const omissions = initialOmissions();
  const acceptanceCriteria = boundedItems(
    snapshot.acceptanceCriteria,
    LIMITS.acceptanceCriteria,
    omissions,
    "acceptance_criteria",
  );
  const decisions = boundedItems(snapshot.decisions, LIMITS.decisions, omissions, "decisions");
  const failedApproaches = boundedItems(
    snapshot.failedApproaches,
    LIMITS.failedApproaches,
    omissions,
    "failed_approaches",
  );
  const modifiedFiles = boundedItems(
    snapshot.modifiedFiles,
    LIMITS.modifiedFiles,
    omissions,
    "modified_files",
  );
  const failingTests = boundedItems(
    snapshot.diagnosticState.failingTests,
    LIMITS.failingTests,
    omissions,
    "failing_tests",
  );
  const errors = boundedItems(
    snapshot.diagnosticState.errors,
    LIMITS.diagnosticsPerSeverity,
    omissions,
    "diagnostic_errors",
  );
  const warnings = boundedItems(
    snapshot.diagnosticState.warnings,
    LIMITS.diagnosticsPerSeverity,
    omissions,
    "diagnostic_warnings",
  );
  const runningJobs = boundedItems(
    snapshot.runningJobs,
    LIMITS.runningJobs,
    omissions,
    "running_jobs",
  );
  const blockers = boundedItems(snapshot.blockers, LIMITS.blockers, omissions, "blockers");
  const orderedSourceVersions = boundedItems(
    Object.entries(input.sourceVersions).sort(([left], [right]) => left.localeCompare(right)),
    LIMITS.sourceVersions,
    omissions,
    "source_versions",
  );

  const section: WorkingMemoryContextSection = {
    schema_version: "terminus.working-memory.v1",
    captured_at: snapshot.capturedAt,
    phase: snapshot.phase,
    contract_version: snapshot.contractVersion,
    objective: boundedText(snapshot.objective, 512),
    acceptance_criteria: acceptanceCriteria.map((criterion) => ({
      id: boundedText(criterion.id, LIMITS.idChars),
      statement: boundedText(criterion.statement),
      required: criterion.required,
      status: criterion.status,
      last_observed_at: criterion.lastObservedAt,
      evidence: boundedEvidence(criterion.evidence, omissions, "criterion_evidence"),
    })),
    decisions: decisions.map((decision) => ({
      id: boundedText(decision.id, LIMITS.idChars),
      kind: decision.kind,
      summary: boundedText(decision.summary),
      decided_at: decision.decidedAt,
      decided_by: decision.decidedBy,
    })),
    failed_approaches: failedApproaches.map((failure) => ({
      id: boundedText(failure.id, LIMITS.idChars),
      summary: boundedText(failure.summary),
      reason: boundedText(failure.reason),
      attempted_at: failure.attemptedAt,
      evidence_refs: boundedEvidence(failure.evidenceRefs, omissions, "failure_evidence"),
    })),
    modified_files: modifiedFiles.map((change) => ({
      path: boundedText(change.path, LIMITS.pathChars),
      change_kind: change.changeKind,
      source_version: change.sourceVersion === null
        ? null
        : boundedText(change.sourceVersion, LIMITS.versionChars),
      observed_at: change.observedAt,
    })),
    diagnostic_state: {
      failing_tests: failingTests.map((test) => boundedText(test)),
      errors: errors.map(boundedDiagnostic),
      warnings: warnings.map(boundedDiagnostic),
      observed_at: snapshot.diagnosticState.observedAt,
    },
    running_jobs: runningJobs.map((job) => ({
      job_id: boundedText(job.jobId, LIMITS.idChars),
      label: boundedText(job.label),
      started_at: job.startedAt,
    })),
    budget_consumption: {
      model_micros: snapshot.budgetConsumption.modelMicros.toString(),
      model_micros_limit: snapshot.budgetConsumption.modelMicrosLimit.toString(),
      compute_seconds: snapshot.budgetConsumption.computeSeconds,
      compute_seconds_limit: snapshot.budgetConsumption.computeSecondsLimit,
      wall_clock_seconds: snapshot.budgetConsumption.wallClockSeconds,
      wall_clock_seconds_limit: snapshot.budgetConsumption.wallClockSecondsLimit,
      human_approvals: snapshot.budgetConsumption.humanApprovals,
      human_approvals_limit: snapshot.budgetConsumption.humanApprovalsLimit,
    },
    blockers: blockers.map((blocker) => ({
      id: boundedText(blocker.id, LIMITS.idChars),
      kind: blocker.kind,
      summary: boundedText(blocker.summary),
      raised_at: blocker.raisedAt,
    })),
    source_versions: orderedSourceVersions.map(([uri, version]) => ({
      uri: boundedText(uri, LIMITS.pathChars),
      version: boundedText(version, LIMITS.versionChars),
    })),
  };
  return enforceSectionBound(section, omissions);
}

function checkpointItems<T>(values: readonly T[], limit = 20): readonly T[] {
  return values.slice(0, limit);
}

/** Render the facts from a validated immutable checkpoint for provider use. */
export function renderCheckpointSummary(content: CheckpointContent): string {
  const lines = ["# Validated task checkpoint", "", `Objective: ${boundedText(content.objective, 1_000)}`];
  const appendList = (heading: string, values: readonly string[]): void => {
    if (values.length === 0) return;
    lines.push("", `## ${heading}`);
    for (const value of checkpointItems(values)) lines.push(`- ${boundedText(value, 512)}`);
    if (values.length > 20) lines.push(`- … ${values.length - 20} more omitted`);
  };

  appendList("Completed steps", content.completedSteps.map((step) => step.description));
  appendList("Pending steps", content.pendingSteps);
  appendList(
    "Acceptance criteria",
    content.requirements.map((requirement) =>
      `[${requirement.status}] ${requirement.id}: ${requirement.statement}`,
    ),
  );
  appendList(
    "Decisions",
    content.decisions.map((decision) => `${decision.decision} Reason: ${decision.rationale}`),
  );
  appendList(
    "Unresolved failures",
    content.failures.filter((failure) => !failure.resolved).map((failure) => failure.description),
  );
  appendList("Assumptions", content.assumptions);
  appendList("Unknowns", content.unknowns);
  appendList("Open questions", content.openQuestions);
  appendList(
    "Active effects",
    (content.effectState ?? []).map((effect) => `${effect.effectId}: ${effect.state}`),
  );
  appendList(
    "Approval state",
    (content.approvalState ?? []).map((approval) => `${approval.approvalId}: ${approval.state}`),
  );

  return excerpt(lines.join("\n"), MAX_CHECKPOINT_SUMMARY_CHARS);
}
