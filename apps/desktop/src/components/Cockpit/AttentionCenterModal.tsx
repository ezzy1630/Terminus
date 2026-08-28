import { X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { attentionItems } from "../../hooks/use-native-attention";
import { useTerminusStore } from "../../hooks/use-terminus";
import { useDialogFocus } from "../../hooks/use-dialog-focus";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../../hooks/use-logical-mutation";
import { arpV2 } from "../../lib/api-v2";
import type { AttentionAssessmentSnapshot, MaterialQuestionSnapshot } from "../../types/v2";
import { Button } from "../../ui/Button";
import { DialogSurface } from "../../ui/Dialog";
import { IconButton } from "../../ui/IconButton";
import {
  CockpitEmptyState,
  CockpitErrorState,
  CockpitLoadingState,
  SemanticBadge,
  StaleDataBanner,
  useCockpitResource,
  type SemanticTone,
} from "./CockpitPrimitives";

interface AttentionData {
  questions: MaterialQuestionSnapshot[];
  assessment: AttentionAssessmentSnapshot | null;
}

function urgencyTone(urgency: AttentionAssessmentSnapshot["urgency"]): SemanticTone {
  if (urgency === "BLOCKING") return "error";
  if (urgency === "HIGH") return "warning";
  if (urgency === "NORMAL") return "info";
  return "neutral";
}

/**
 * What is waiting on a human.
 *
 * Two independent answers used to live here. The sidebar badge counted task
 * lifecycles; this modal read `/v2/attention/questions`, whose writer is a
 * hard 503, so the badge said "3" while the modal said "Nothing needs
 * attention". The lifecycle list is the primary answer now — the same
 * `attentionItems` the badge and the Dock count use — and material questions
 * are shown underneath when the control plane actually has any.
 */
export function AttentionCenterModal({
  isOpen,
  onClose,
  selectedTaskId,
  onOpenTask,
}: {
  isOpen: boolean;
  onClose: () => void;
  selectedTaskId?: string | null;
  onOpenTask?: (taskId: string) => void;
}): JSX.Element | null {
  const tasksBySession = useTerminusStore((state) => state.tasksBySession);
  const runActivityByTask = useTerminusStore((state) => state.runActivityByTask);
  const waiting = useMemo(
    () => attentionItems(tasksBySession, runActivityByTask),
    [runActivityByTask, tasksBySession],
  );
  const [resolvingQuestionId, setResolvingQuestionId] = useState<string | null>(null);
  const [resolvedQuestionIds, setResolvedQuestionIds] = useState<Set<string>>(() => new Set());
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [resolutionAnnouncement, setResolutionAnnouncement] = useState("");
  const questionMutation = useLogicalMutation(`material-question.${selectedTaskId ?? "all"}`);
  const closeModal = useCallback((): void => {
    if (resolvingQuestionId) return;
    setResolutionError(null);
    onClose();
  }, [onClose, resolvingQuestionId]);
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, closeModal);
  const load = useCallback(async (signal: AbortSignal): Promise<AttentionData> => {
    const questionsPromise = arpV2.listMaterialQuestions(selectedTaskId ?? undefined, signal);
    const assessmentPromise = selectedTaskId
      ? arpV2.assessTaskAttention(selectedTaskId, signal)
      : Promise.resolve(null);
    const [questions, assessment] = await Promise.all([questionsPromise, assessmentPromise]);
    return { questions, assessment };
  }, [selectedTaskId]);
  const resource = useCockpitResource(load, `attention:${selectedTaskId ?? "all"}`);

  if (!isOpen) return null;

  const resolveQuestion = async (questionId: string, selectedOption: string): Promise<void> => {
    setResolvingQuestionId(questionId);
    setResolutionError(null);
    let operationKey: string | null = null;
    try {
      operationKey = questionMutation.keyFor(JSON.stringify({ questionId, selectedOption }));
      const result = await arpV2.resolveMaterialQuestion(questionId, selectedOption, { idempotencyKey: operationKey });
      if (!result.success) {
        questionMutation.abandon(operationKey);
        setResolutionError(result.error ?? "The control plane rejected this response.");
        resource.retry();
        return;
      }
      questionMutation.settle(operationKey);
      setResolvedQuestionIds((current) => new Set(current).add(questionId));
      setResolutionAnnouncement(`Response recorded: ${selectedOption}.`);
      resource.retry();
      window.requestAnimationFrame(() => {
        const nextOption = dialogRef.current?.querySelector<HTMLButtonElement>("[data-attention-option]:not([disabled])");
        const closeButton = dialogRef.current?.querySelector<HTMLButtonElement>("[data-attention-close]:not([disabled])");
        (nextOption ?? closeButton ?? dialogRef.current)?.focus();
      });
    } catch (error: unknown) {
      if (operationKey && isDefinitiveMutationFailure(error)) {
        questionMutation.abandon(operationKey);
        resource.retry();
      }
      setResolutionError(error instanceof Error ? error.message : String(error));
    } finally {
      setResolvingQuestionId(null);
    }
  };

  const pendingQuestions = resource.data?.questions.filter((question) => !resolvedQuestionIds.has(question.id)) ?? [];
  const currentQuestion = pendingQuestions[0] ?? null;

  return (
    <DialogSurface
      ref={dialogRef}
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeModal();
      }}
      onPointerDownOutside={(event) => {
        if (resolvingQuestionId) event.preventDefault();
      }}
      accessibleTitle="Attention center"
      aria-describedby="attention-description"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!currentQuestion || resolvingQuestionId || event.metaKey || event.ctrlKey || event.altKey) return;
        const optionIndex = Number(event.key) - 1;
        const option = currentQuestion.options[optionIndex];
        if (!option || optionIndex < 0 || optionIndex > 8) return;
        event.preventDefault();
        void resolveQuestion(currentQuestion.id, option);
      }}
      className="dialog-panel fixed left-1/2 top-1/2 flex max-h-[calc(100%-32px)] w-[min(560px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[10px] border border-default bg-elevated text-primary shadow-lg"
    >
        <header className="flex flex-shrink-0 items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div>
            <h2 id="attention-title" className="text-base font-semibold">Attention center</h2>
            <p id="attention-description" className="mt-1 text-xs text-secondary">
              One decision at a time.
            </p>
            {selectedTaskId ? <span className="sr-only">Task {selectedTaskId}</span> : null}
          </div>
          <IconButton data-attention-close label="Close attention center" icon={<X size={15} aria-hidden />} size="lg" onClick={closeModal} disabled={resolvingQuestionId !== null} data-tooltip={resolvingQuestionId ? "Wait for the current response to finish" : "Close"} className="rounded-md text-tertiary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-45" />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">
          <p className="sr-only" role="status" aria-live="polite">{resolutionAnnouncement}</p>
          {waiting.length > 0 ? (
            <section className="mb-4" aria-label="Tasks waiting on you">
              <h3 className="ui-section-label pb-1.5">Waiting on you</h3>
              <ul className="flex flex-col gap-1">
                {waiting.map((item) => (
                  <li key={item.id}>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => onOpenTask?.(item.id)}
                      disabled={!onOpenTask}
                      aria-label={`Open ${item.title}`}
                      className="h-auto w-full justify-start gap-3 p-2.5 text-left"
                    >
                      <SemanticBadge tone="warning">{item.label}</SemanticBadge>
                      <span className="min-w-0 flex-1 truncate text-sm text-primary">{item.title}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {resource.status === "loading" ? (
            <CockpitLoadingState label="material questions" />
          ) : resource.status === "error" && resource.error ? (
            <CockpitErrorState error={resource.error} retry={resource.retry} />
          ) : resource.data ? (
            <div className="space-y-4">
              {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
              {resource.data.assessment ? (
                <section className="flex items-start justify-between gap-3 rounded-md bg-subtle px-3 py-2.5" aria-label="Attention assessment">
                    <p className="min-w-0 text-xs leading-5 text-secondary">{resource.data.assessment.reason}</p>
                    <SemanticBadge tone={urgencyTone(resource.data.assessment.urgency)}>{resource.data.assessment.urgency}</SemanticBadge>
                </section>
              ) : null}

              {resolutionError ? <p role="alert" className="text-xs text-error">{resolutionError}</p> : null}

              {currentQuestion === null ? (
                waiting.length > 0 ? null : (
                  <CockpitEmptyState
                    title="Nothing needs attention"
                    description="No task is blocked, failed, or waiting for review."
                  />
                )
              ) : (
                  <article key={currentQuestion.id} className="px-1 pb-1">
                    <div className="flex items-center justify-between gap-3">
                      <SemanticBadge tone="warning">{currentQuestion.trigger}</SemanticBadge>
                      {pendingQuestions.length > 1 ? <span className="text-xs text-tertiary">1 of {pendingQuestions.length}</span> : null}
                    </div>
                    <h3 className="mt-3 text-sm font-semibold leading-5 text-primary">{currentQuestion.questionText}</h3>

                    <div className="mt-4 grid grid-cols-1 gap-2">
                      {currentQuestion.options.map((option, index) => (
                        <Button
                          key={option}
                          data-attention-option
                          type="button"
                          variant="secondary"
                          onClick={() => void resolveQuestion(currentQuestion.id, option)}
                          disabled={resolvingQuestionId !== null}
                          aria-label={`Choose ${option} for ${currentQuestion.questionText}`}
                          className="h-auto w-full justify-start gap-3 p-3 text-left"
                        >
                          <kbd className="flex h-5 w-5 flex-none items-center justify-center rounded bg-subtle font-mono text-xs text-tertiary">{index + 1}</kbd>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-primary">{option}</span>
                            <span className="mt-0.5 block whitespace-normal text-xs leading-4 text-secondary">
                              {currentQuestion.consequenceMatrix[option] ?? "No consequence was reported for this option."}
                            </span>
                          </span>
                        </Button>
                      ))}
                    </div>
                  </article>
              )}
            </div>
          ) : null}
        </div>
    </DialogSurface>
  );
}
