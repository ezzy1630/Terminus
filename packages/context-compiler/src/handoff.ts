/**
 * Reviewable context handoffs.
 *
 * A handoff is a structured transfer record, not a prose summary. The
 * builder copies every claim and status supplied by the caller, keeps failed
 * and unverified work visible, and gives the bundle a deterministic content
 * hash for review or persistence by a higher-level store.
 */

import type { ContentHash, Rfc3339Timestamp, Uuid7 } from "@terminus/domain";
import { canonicalJson, computeContentHash } from "@terminus/context-ir";

export type HandoffAcceptanceStatus = "satisfied" | "unsatisfied" | "unverified";
export type HandoffActionStatus = "completed" | "failed" | "blocked";
export type HandoffFileChange = "added" | "modified" | "deleted" | "renamed" | "unknown";
export type HandoffVerificationStatus =
  | "unverified"
  | "in_progress"
  | "passed"
  | "failed"
  | "blocked";
export type HandoffCheckStatus = "pass" | "fail" | "error" | "skipped" | "blocked" | "unverified";

export interface HandoffEvidenceHandle {
  readonly kind: "artifact" | "manifest" | "verification" | "revision" | "command" | "other";
  readonly uri: string;
  readonly hash: ContentHash | null;
  readonly label: string;
}

export interface HandoffAcceptance {
  readonly id: string;
  readonly statement: string;
  readonly status: HandoffAcceptanceStatus;
  readonly evidenceHandles: readonly HandoffEvidenceHandle[];
}

export interface HandoffCompletedAction {
  readonly id: string;
  readonly description: string;
  readonly status: HandoffActionStatus;
  readonly evidenceHandles: readonly HandoffEvidenceHandle[];
}

export interface HandoffChangedFile {
  readonly path: string;
  readonly change: HandoffFileChange;
  readonly revision: string | null;
  readonly evidenceHandles: readonly HandoffEvidenceHandle[];
}

export interface HandoffVerificationCheck {
  readonly id: string;
  readonly description: string;
  readonly status: HandoffCheckStatus;
  readonly command: string | null;
  readonly evidenceHandles: readonly HandoffEvidenceHandle[];
}

export interface HandoffVerificationState {
  readonly status: HandoffVerificationStatus;
  readonly summary: string | null;
  readonly checks: readonly HandoffVerificationCheck[];
}

export interface HandoffBundle {
  readonly version: "terminus.handoff.v1";
  readonly contentHash: ContentHash;
  readonly taskId: Uuid7 | null;
  readonly objective: string;
  /** Canonical acceptance field. `acceptanceCriteria` is a compatibility alias. */
  readonly acceptance: readonly HandoffAcceptance[];
  readonly acceptanceCriteria: readonly HandoffAcceptance[];
  readonly completedActions: readonly HandoffCompletedAction[];
  readonly changedFiles: readonly HandoffChangedFile[];
  readonly openQuestions: readonly string[];
  readonly verificationState: HandoffVerificationState;
  readonly evidenceHandles: readonly HandoffEvidenceHandle[];
  readonly sourceRevision: string | null;
  readonly recommendedNextRole: string | null;
  readonly createdAt: Rfc3339Timestamp;
}

export interface HandoffBundleInput {
  readonly taskId?: Uuid7 | null | undefined;
  readonly objective: string;
  readonly acceptance?: readonly HandoffAcceptance[] | undefined;
  readonly acceptanceCriteria?: readonly HandoffAcceptance[] | undefined;
  readonly completedActions: readonly HandoffCompletedAction[];
  readonly changedFiles: readonly HandoffChangedFile[];
  readonly openQuestions: readonly string[];
  readonly verificationState: HandoffVerificationState;
  readonly evidenceHandles: readonly HandoffEvidenceHandle[];
  readonly sourceRevision?: string | null | undefined;
  readonly recommendedNextRole?: string | null | undefined;
  readonly createdAt: Rfc3339Timestamp;
}

function requireText(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`handoff ${label} must not be empty`);
  return value;
}

function copyEvidenceHandles(
  handles: readonly HandoffEvidenceHandle[],
  owner: string,
): readonly HandoffEvidenceHandle[] {
  return handles.map((handle, index) => ({
    kind: handle.kind,
    uri: requireText(handle.uri, `${owner} evidence handle ${index} uri`),
    hash: handle.hash,
    label: requireText(handle.label, `${owner} evidence handle ${index} label`),
  }));
}

function copyAcceptance(items: readonly HandoffAcceptance[]): readonly HandoffAcceptance[] {
  const ids = new Set<string>();
  return items.map((item) => {
    const id = requireText(item.id, "acceptance id");
    if (ids.has(id)) throw new Error(`handoff acceptance id is duplicated: ${id}`);
    ids.add(id);
    return {
      id,
      statement: requireText(item.statement, `acceptance ${id} statement`),
      status: item.status,
      evidenceHandles: copyEvidenceHandles(item.evidenceHandles, `acceptance ${id}`),
    };
  });
}

function copyCompletedActions(
  items: readonly HandoffCompletedAction[],
): readonly HandoffCompletedAction[] {
  const ids = new Set<string>();
  return items.map((item) => {
    const id = requireText(item.id, "completed action id");
    if (ids.has(id)) throw new Error(`handoff completed action id is duplicated: ${id}`);
    ids.add(id);
    return {
      id,
      description: requireText(item.description, `completed action ${id} description`),
      status: item.status,
      evidenceHandles: copyEvidenceHandles(item.evidenceHandles, `completed action ${id}`),
    };
  });
}

function copyChangedFiles(items: readonly HandoffChangedFile[]): readonly HandoffChangedFile[] {
  const paths = new Set<string>();
  return items.map((item) => {
    const path = requireText(item.path, "changed file path");
    if (paths.has(path)) throw new Error(`handoff changed file is duplicated: ${path}`);
    paths.add(path);
    return {
      path,
      change: item.change,
      revision: item.revision,
      evidenceHandles: copyEvidenceHandles(item.evidenceHandles, `changed file ${path}`),
    };
  });
}

function copyVerificationState(state: HandoffVerificationState): HandoffVerificationState {
  const ids = new Set<string>();
  const checks = state.checks.map((check) => {
    const id = requireText(check.id, "verification check id");
    if (ids.has(id)) throw new Error(`handoff verification check id is duplicated: ${id}`);
    ids.add(id);
    return {
      id,
      description: requireText(check.description, `verification check ${id} description`),
      status: check.status,
      command: check.command,
      evidenceHandles: copyEvidenceHandles(check.evidenceHandles, `verification check ${id}`),
    };
  });
  return {
    status: state.status,
    summary: state.summary,
    checks,
  };
}

/** Build an immutable-shaped, deterministic handoff record without inferring success. */
export function buildHandoffBundle(input: HandoffBundleInput): HandoffBundle {
  const objective = requireText(input.objective, "objective");
  if (input.acceptance !== undefined && input.acceptanceCriteria !== undefined) {
    throw new Error("handoff must provide either acceptance or acceptanceCriteria, not both");
  }
  const acceptance = copyAcceptance(input.acceptance ?? input.acceptanceCriteria ?? []);
  const completedActions = copyCompletedActions(input.completedActions);
  const changedFiles = copyChangedFiles(input.changedFiles);
  const openQuestions = input.openQuestions.map((question, index) =>
    requireText(question, `open question ${index}`),
  );
  const verificationState = copyVerificationState(input.verificationState);
  const evidenceHandles = copyEvidenceHandles(input.evidenceHandles, "bundle");
  const content = {
    version: "terminus.handoff.v1" as const,
    taskId: input.taskId ?? null,
    objective,
    acceptance,
    completedActions,
    changedFiles,
    openQuestions,
    verificationState,
    evidenceHandles,
    sourceRevision: input.sourceRevision ?? null,
    recommendedNextRole: input.recommendedNextRole ?? null,
    createdAt: input.createdAt,
  };
  const contentHash = computeContentHash(canonicalJson(content));
  return {
    ...content,
    contentHash,
    acceptanceCriteria: acceptance,
  };
}

function formatHandles(handles: readonly HandoffEvidenceHandle[]): string {
  if (handles.length === 0) return "none";
  return handles.map((handle) => {
    const hash = handle.hash === null ? "" : ` (${handle.hash})`;
    return `${handle.label} <${handle.uri}>${hash}`;
  }).join(", ");
}

/** Render the structured bundle for human review without changing its claims. */
export function formatHandoffBundle(bundle: HandoffBundle): string {
  const lines: string[] = [
    "# Context handoff",
    "",
    `Bundle: ${bundle.contentHash}`,
    `Task: ${bundle.taskId ?? "unknown"}`,
    `Created: ${bundle.createdAt}`,
    "",
    "## Objective",
    bundle.objective,
    "",
    "## Acceptance",
  ];
  for (const criterion of bundle.acceptance) {
    lines.push(`- [${criterion.status}] ${criterion.id}: ${criterion.statement}`);
    lines.push(`  evidence: ${formatHandles(criterion.evidenceHandles)}`);
  }
  lines.push("", "## Completed actions");
  for (const action of bundle.completedActions) {
    lines.push(`- [${action.status}] ${action.id}: ${action.description}`);
    lines.push(`  evidence: ${formatHandles(action.evidenceHandles)}`);
  }
  lines.push("", "## Changed files");
  for (const file of bundle.changedFiles) {
    const revision = file.revision === null ? "" : ` @ ${file.revision}`;
    lines.push(`- [${file.change}] ${file.path}${revision}`);
    lines.push(`  evidence: ${formatHandles(file.evidenceHandles)}`);
  }
  lines.push("", "## Open questions");
  for (const question of bundle.openQuestions) lines.push(`- ${question}`);
  lines.push(
    "",
    "## Verification",
    `Status: ${bundle.verificationState.status}`,
    bundle.verificationState.summary === null ? "Summary: none" : `Summary: ${bundle.verificationState.summary}`,
  );
  for (const check of bundle.verificationState.checks) {
    const command = check.command === null ? "" : `, command: ${check.command}`;
    lines.push(`- [${check.status}] ${check.id}: ${check.description}${command}`);
    lines.push(`  evidence: ${formatHandles(check.evidenceHandles)}`);
  }
  lines.push("", "## Evidence handles", `- ${formatHandles(bundle.evidenceHandles)}`);
  if (bundle.sourceRevision !== null) lines.push("", `Source revision: ${bundle.sourceRevision}`);
  if (bundle.recommendedNextRole !== null) lines.push(`Next role: ${bundle.recommendedNextRole}`);
  return lines.join("\n");
}
