/** Verify-before-retry reconciliation for timed-out submit effects. */
import { computeContentHash } from "@terminus/context-ir";
import {
  ValidationError,
  ambiguousSubmitReconciliationSchema,
  nowTimestamp,
  uiObservationSchema,
  type AmbiguousSubmitReconciliation,
  type ContentHash,
  type Rfc3339Timestamp,
  type UiObservation,
} from "@terminus/domain";

export interface SubmitSettlementReceipt {
  readonly receiptId: string;
  readonly effectId: string;
  readonly taskId: string;
  readonly semanticIdempotencyKey: string;
  readonly settlement: "executed" | "not_executed";
  readonly observedAt: Rfc3339Timestamp;
  readonly integrityHash: ContentHash;
}

export interface ReconcileSubmitParams {
  readonly effectId: string;
  readonly taskId: string;
  readonly semanticIdempotencyKey: string;
  readonly previousObservation: UiObservation;
  readonly postTimeoutObservation: UiObservation;
  readonly expectedConfirmationSnippet?: string;
  readonly expectedUrlSubstring?: string;
  readonly submitButtonSelector?: string;
  readonly settlementReceipt?: SubmitSettlementReceipt;
}

export type SettlementReceiptVerifier = (
  receipt: SubmitSettlementReceipt,
  effectId: string,
) => boolean;

export class AmbiguousSubmitReconciler {
  public constructor(private readonly verifyReceipt: SettlementReceiptVerifier | null = null) {}

  public reconcileSubmit(params: ReconcileSubmitParams): AmbiguousSubmitReconciliation {
    uiObservationSchema.parse(params.previousObservation);
    uiObservationSchema.parse(params.postTimeoutObservation);
    const before = params.previousObservation;
    const after = params.postTimeoutObservation;
    this.validateObservationSequence(params.taskId, before, after);
    const reconciliationId = this.reconciliationId(params.effectId, before, after);

    const receipt = params.settlementReceipt;
    if (
      receipt !== undefined
      && this.receiptMatchesRequest(receipt, params, before)
      && this.verifyReceipt?.(receipt, params.effectId) === true
    ) {
      const confirmedExecuted = receipt.settlement === "executed";
      return this.validated({
        reconciliationId,
        effectId: params.effectId,
        taskId: params.taskId,
        previousObservationId: before.id,
        postTimeoutObservationId: after.id,
        submitState: confirmedExecuted ? "confirmed_executed" : "confirmed_not_executed",
        reconciliationEvidence: `Trusted settlement receipt ${receipt.receiptId} reports ${receipt.settlement}`,
        receiptId: receipt.receiptId,
        safeToRetry: !confirmedExecuted,
        reconciledAt: nowTimestamp(),
      });
    }

    const hypotheses: string[] = [];
    if (receipt !== undefined) {
      hypotheses.push(`settlement receipt ${receipt.receiptId} was not admitted as trusted evidence`);
    }
    if (params.expectedConfirmationSnippet !== undefined) {
      const snippet = params.expectedConfirmationSnippet.trim().toLowerCase();
      if (snippet.length > 0 && !this.observationContains(before, snippet) && this.observationContains(after, snippet)) {
        hypotheses.push(`confirmation text appeared: ${params.expectedConfirmationSnippet}`);
      }
    }
    if (params.expectedUrlSubstring !== undefined) {
      const expected = params.expectedUrlSubstring.toLowerCase();
      const beforeMatches = before.documentUri?.toLowerCase().includes(expected) ?? false;
      const afterMatches = after.documentUri?.toLowerCase().includes(expected) ?? false;
      if (!beforeMatches && afterMatches) {
        hypotheses.push(`document URI changed to the expected destination: ${params.expectedUrlSubstring}`);
      }
    }

    const buttonState = params.submitButtonSelector === undefined
      ? "submit target was not supplied"
      : this.buttonChangeSummary(before, after, params.submitButtonSelector);
    return this.validated({
      reconciliationId,
      effectId: params.effectId,
      taskId: params.taskId,
      previousObservationId: before.id,
      postTimeoutObservationId: after.id,
      submitState: "ambiguous_manual_required",
      reconciliationEvidence: hypotheses.length === 0
        ? `No trusted settlement receipt exists; ${buttonState}. UI similarity never makes retry safe`
        : `UI hypothesis only: ${hypotheses.join("; ")}; ${buttonState}. Only a trusted settlement receipt can confirm execution or make retry safe`,
      receiptId: null,
      safeToRetry: false,
      reconciledAt: nowTimestamp(),
    });
  }

  private validateObservationSequence(taskId: string, before: UiObservation, after: UiObservation): void {
    if (before.taskId !== taskId || after.taskId !== taskId) {
      throw new ValidationError("Submit reconciliation observations must belong to the effect task", {
        taskId,
        beforeTaskId: before.taskId,
        afterTaskId: after.taskId,
      });
    }
    if (before.sessionId !== after.sessionId) {
      throw new ValidationError("Submit reconciliation observations must belong to the same session");
    }
    if (after.version <= before.version || Date.parse(after.timestamp) < Date.parse(before.timestamp)) {
      throw new ValidationError("Post-timeout observation must be newer than the pre-submit observation", {
        beforeVersion: before.version,
        afterVersion: after.version,
      });
    }
  }

  private receiptMatchesRequest(
    receipt: SubmitSettlementReceipt,
    params: ReconcileSubmitParams,
    before: UiObservation,
  ): boolean {
    const observedAtMs = Date.parse(receipt.observedAt);
    return receipt.receiptId.trim().length > 0
      && receipt.effectId === params.effectId
      && receipt.taskId === params.taskId
      && receipt.semanticIdempotencyKey === params.semanticIdempotencyKey
      && /^sha256:[0-9a-f]{64}$/.test(receipt.integrityHash)
      && Number.isFinite(observedAtMs)
      && observedAtMs >= Date.parse(before.timestamp);
  }

  private observationContains(observation: UiObservation, snippet: string): boolean {
    return observation.targetElements.some((target) =>
      target.name.toLowerCase().includes(snippet)
      || target.textSnippet?.toLowerCase().includes(snippet),
    ) || observation.accessibilityTree.some((node) =>
      node.name.toLowerCase().includes(snippet)
      || node.description?.toLowerCase().includes(snippet),
    );
  }

  private buttonChangeSummary(before: UiObservation, after: UiObservation, selector: string): string {
    const beforeButton = before.targetElements.find((target) => target.selector === selector);
    const afterButton = after.targetElements.find((target) => target.selector === selector);
    if (beforeButton !== undefined && afterButton === undefined) return "submit target disappeared, which is not proof of settlement";
    if (beforeButton?.semanticHash !== afterButton?.semanticHash) return "submit target changed, which is not proof of settlement";
    return "submit target did not provide settlement evidence";
  }

  private reconciliationId(effectId: string, before: UiObservation, after: UiObservation): string {
    const input = `${effectId}:${before.id}:${before.version}:${after.id}:${after.version}`;
    return computeContentHash(input);
  }

  private validated(result: AmbiguousSubmitReconciliation): AmbiguousSubmitReconciliation {
    ambiguousSubmitReconciliationSchema.parse(result);
    return result;
  }
}
