import { canonicalJson, computeContentHash } from "@terminus/context-ir";

/**
 * Bounded verify–repair–admit controller (deep-audit Rank 3 / PR5).
 *
 * An actor response is a PROPOSAL to complete, never completion itself.
 * When required verification fails, this controller normalizes each failure
 * into a durable, comparable repair input, detects stagnation across repair
 * attempts, and decides whether a bounded same-session repair turn can
 * proceed. Independent verification stays outside the actor's write
 * authority: this module only shapes context and policy — it never marks a
 * failing predicate as passing.
 */

export interface NormalizedFailure {
  readonly predicateId: string;
  readonly nodeId: string;
  readonly command: string | null;
  readonly exitCode: number | null;
  /** Focused diagnostic slice (bounded). */
  readonly diagnostic: string;
  /** Relevant source/diff artifact references. */
  readonly artifactRefs: readonly string[];
  /** Immutable workspace/source revision observed by the verifier. */
  readonly sourceRevision: string | null;
  /** Stable class that ignores evidence artifact identity and timestamps. */
  readonly failureClass: string;
  /** Hash of the failure signature used for change detection. */
  readonly signatureHash: string;
}

export interface RawVerificationFailure {
  readonly nodeId: string;
  readonly predicateType: string;
  readonly command?: string | null;
  readonly exitCode?: number | null;
  /** Combined stdout/stderr projection of the failed predicate. */
  readonly output: string;
  readonly artifactRefs?: readonly string[];
  readonly sourceRevision?: string | null | undefined;
}

const MAX_DIAGNOSTIC_CHARS = 4_000;

/** Extract the focused diagnostic tail — the useful failing tail. */
function focusDiagnostic(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= MAX_DIAGNOSTIC_CHARS) return trimmed;
  return `…(earlier output elided)\n${trimmed.slice(-MAX_DIAGNOSTIC_CHARS)}`;
}

export function normalizeFailure(raw: RawVerificationFailure): NormalizedFailure {
  const diagnostic = focusDiagnostic(raw.output);
  // Artifact order is not semantic, but the set is: a new evidence artifact
  // can prove that the verifier observed a different state even when its
  // diagnostic text is unchanged. Keep the signature deterministic across
  // writers while retaining the evidence-change signal for repair policy.
  const artifactRefs = [...new Set(raw.artifactRefs ?? [])].sort();
  const signature = computeContentHash(
    canonicalJson({
      node_id: raw.nodeId,
      exit_code: raw.exitCode ?? null,
      // The signature intentionally excludes timestamps/durations but keeps
      // the diagnostic and evidence identity so "same failure" means the
      // same verifier observation, not merely the same text.
      diagnostic,
      artifact_refs: artifactRefs,
      source_revision: raw.sourceRevision ?? null,
    }),
  );
  const failureClass = computeContentHash(canonicalJson({
    predicate_type: raw.predicateType,
    exit_code: raw.exitCode ?? null,
    diagnostic,
  }));
  return {
    predicateId: raw.predicateType,
    nodeId: raw.nodeId,
    command: raw.command ?? null,
    exitCode: raw.exitCode ?? null,
    diagnostic,
    artifactRefs,
    sourceRevision: raw.sourceRevision ?? null,
    failureClass,
    signatureHash: signature,
  };
}

/**
 * ProgressDetector: stop or replan when nothing changes.
 *
 * A repair attempt makes progress iff (a) any failure signature changed,
 * or (b) the workspace changed since the previous attempt. Repeating the
 * identical verifier input/output without a workspace mutation is
 * stagnation.
 */
export class ProgressDetector {
  private lastSignatures: ReadonlySet<string> = new Set();
  private lastFailureClasses: ReadonlySet<string> = new Set();
  private readonly seenAcrossAttempts: ReadonlySet<string>[] = [];
  private readonly semanticHistory: string[] = [];

  /** Restore the last durable failure set before evaluating a new turn. */
  seed(signatures: readonly string[]): void {
    if (signatures.length === 0) return;
    const seeded = new Set(signatures);
    this.lastSignatures = seeded;
    this.seenAcrossAttempts.push(seeded);
  }

  /**
   * Record one attempt's normalized failures and whether the workspace
   * changed since the previous attempt. Returns progress analysis.
   */
  recordAttempt(
    failures: readonly NormalizedFailure[],
    workspaceChanged: boolean,
  ): {
    readonly progressed: boolean;
    readonly repeatedAll: boolean;
    readonly semanticFailureRepeat: boolean;
    readonly oscillating: boolean;
  } {
    const signatures = new Set(failures.map((failure) => failure.signatureHash));
    const failureClasses = new Set(failures.map((failure) => failure.failureClass));
    let repeatedAll =
      signatures.size > 0 && signatures.size === this.lastSignatures.size;
    if (repeatedAll) {
      for (const signature of signatures) {
        if (!this.lastSignatures.has(signature)) {
          repeatedAll = false;
          break;
        }
      }
    }
    const semanticFailureRepeat = failureClasses.size > 0
      && failureClasses.size === this.lastFailureClasses.size
      && [...failureClasses].every((failureClass) => this.lastFailureClasses.has(failureClass))
      && !workspaceChanged;
    const semanticKey = [...failures]
      .map((failure) => `${failure.nodeId}:${failure.failureClass}`)
      .sort()
      .join("|");
    const historyLength = this.semanticHistory.length;
    const oscillating = historyLength >= 3
      && this.semanticHistory[historyLength - 3] === this.semanticHistory[historyLength - 1]
      && this.semanticHistory[historyLength - 2] === semanticKey
      && this.semanticHistory[historyLength - 3] !== semanticKey
      && !workspaceChanged;
    const progressed = (!repeatedAll && !semanticFailureRepeat && !oscillating) || workspaceChanged;
    this.lastSignatures = signatures;
    this.lastFailureClasses = failureClasses;
    this.seenAcrossAttempts.push(signatures);
    this.semanticHistory.push(semanticKey);
    if (this.semanticHistory.length > 32) this.semanticHistory.shift();
    return {
      progressed,
      repeatedAll: repeatedAll && !workspaceChanged,
      semanticFailureRepeat,
      oscillating,
    };
  }

  get attempts(): number {
    return this.seenAcrossAttempts.length;
  }
}

export type RepairDecision =
  | {
      readonly action: "repair";
      readonly attemptNumber: number;
      readonly maxAttempts: number;
      readonly hypothesisId: string;
    }
  | { readonly action: "stop"; readonly reason: StopReason };

export type StopReason =
  | "repair_budget_exhausted"
  | "no_progress_repeated_failure"
  | "actor_reports_blocker"
  | "requires_user_authority";

export interface RepairPolicyOptions {
  /** Maximum bounded repair turns per task completion proposal. */
  readonly maxRepairAttempts?: number;
  /**
   * Repairs already spent on this task in earlier turns (durable count).
   * Without seeding this, a fresh controller per turn would reset the budget
   * and allow unbounded repair loops across turns.
   */
  readonly priorAttemptsUsed?: number;
  /** Failure signatures persisted by the preceding repair evaluation. */
  readonly priorFailureSignatures?: readonly string[];
  readonly now?: () => number;
}

export class VerificationRepairController {
  private readonly detector = new ProgressDetector();
  private readonly maxRepairAttempts: number;
  private repairAttemptsUsed: number;

  constructor(options: RepairPolicyOptions = {}) {
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
    if (!Number.isInteger(this.maxRepairAttempts) || this.maxRepairAttempts < 0) {
      throw new Error("maxRepairAttempts must be a non-negative integer");
    }
    const prior = options.priorAttemptsUsed ?? 0;
    if (prior < 0) throw new Error("priorAttemptsUsed must be non-negative");
    this.repairAttemptsUsed = prior;
    this.detector.seed(options.priorFailureSignatures ?? []);
  }

  /**
   * Decide what happens after a verification evaluation that produced
   * failures. `workspaceChangedSinceLastAttempt` is derived from the world
   * state digest; the first evaluation after an actor turn is always
   * considered changed.
   */
  decideAfterFailure(input: {
    readonly failures: readonly NormalizedFailure[];
    readonly workspaceChangedSinceLastAttempt: boolean;
    readonly actorReportedBlocker: boolean;
    readonly requiresUserAuthority: boolean;
  }): RepairDecision {
    if (input.requiresUserAuthority || input.actorReportedBlocker) {
      return {
        action: "stop",
        reason: input.requiresUserAuthority
          ? "requires_user_authority"
          : "actor_reports_blocker",
      };
    }
    if (this.repairAttemptsUsed >= this.maxRepairAttempts) {
      return { action: "stop", reason: "repair_budget_exhausted" };
    }
    if (this.detector.attempts > 0) {
      const progress = this.detector.recordAttempt(
        input.failures,
        input.workspaceChangedSinceLastAttempt,
      );
      if (!progress.progressed) {
        return { action: "stop", reason: "no_progress_repeated_failure" };
      }
    } else {
      this.detector.recordAttempt(input.failures, true);
    }
    this.repairAttemptsUsed += 1;
    const hypothesisId = computeContentHash(canonicalJson({
      attempt: this.repairAttemptsUsed,
      failures: input.failures.map((failure) => ({
        node_id: failure.nodeId,
        failure_class: failure.failureClass,
        signature: failure.signatureHash,
      })),
    }));
    return {
      action: "repair",
      attemptNumber: this.repairAttemptsUsed,
      maxAttempts: this.maxRepairAttempts,
      hypothesisId,
    };
  }

  get attemptsUsed(): number {
    return this.repairAttemptsUsed;
  }

  get observedEvaluations(): number {
    return this.detector.attempts;
  }
}

/**
 * Compile the repair directive injected as the next turn's volatile context:
 * failed claims, exact changed files, minimal diagnostic slices, and the
 * previously attempted fix with why it failed. Deterministic and bounded.
 */
export function buildRepairContext(input: {
  readonly failures: readonly NormalizedFailure[];
  readonly changedFiles: readonly string[];
  readonly previousAttemptSummary: string | null;
  readonly hypothesisId?: string | null | undefined;
}): string {
  const sections: string[] = ["# Verification failed — repair required"];
  sections.push(
    input.failures
      .map(
        (failure, index) =>
          [
            `## Failure ${index + 1}: ${failure.nodeId}`,
            `- predicate: ${failure.predicateId}`,
            `- exit: ${failure.exitCode ?? "unknown"}`,
            failure.command !== null ? `- command: ${failure.command}` : null,
            `- source revision: ${failure.sourceRevision ?? "unknown"}`,
            failure.artifactRefs.length > 0
              ? `- evidence artifacts: ${failure.artifactRefs.join(", ")}`
              : null,
            "",
            "```",
            failure.diagnostic,
            "```",
          ]
            .filter((part): part is string => part !== null)
            .join("\n"),
      )
      .join("\n\n"),
  );
  if (input.changedFiles.length > 0) {
    sections.push(`## Files changed in this task\n${input.changedFiles.map((file) => `- ${file}`).join("\n")}`);
  }
  if (input.previousAttemptSummary !== null) {
    const previousSummary = input.previousAttemptSummary.length > 2_000
      ? `${input.previousAttemptSummary.slice(0, 2_000)}\n[earlier repair summary omitted; consult the prior verification artifact]`
      : input.previousAttemptSummary;
    sections.push(
      `## Previous repair attempt\n${previousSummary}\nFixing the same way will fail identically; change the hypothesis.`,
    );
  }
  if (input.hypothesisId !== undefined && input.hypothesisId !== null) {
    sections.push(`## Repair hypothesis\n${input.hypothesisId}\nUse a materially different hypothesis and verify the expected criterion delta.`);
  }
  return sections.join("\n\n");
}
