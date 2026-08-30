/**
 * Terminus Desktop — answering a material question, where the task is.
 *
 * This was a modal called the "Attention center", reachable only from a
 * hover-revealed `⋯` in the sidebar or from ⌘K, which rendered a list the rail
 * already renders and then made the rest of the window `inert` so you could
 * not look at the task you were being asked about. It was also the only place
 * in the app a material question could be answered, which is why the surface
 * survived as long as it did.
 *
 * Per SPEC §17: "Render approvals inline at the point where they occur. Not a
 * modal." and "Avoid modal dialogs unless macOS itself requires one or the
 * action is impossible to contextualize inline." A question about a task is
 * exactly contextualizable inline — it belongs beside the task, in the panel
 * that already exists to say what the task is doing.
 *
 * Per SPEC §11, it renders nothing at all when there is no question. A section
 * that is present-but-empty is itself a claim, and this one would be claiming
 * that the agent is waiting on something when it is not.
 *
 * Each option carries its consequence, because that is the whole point of the
 * control plane sending a consequence matrix: choosing between "Retry" and
 * "Skip" without knowing what either does is not a decision, it is a guess.
 */
import { useCallback, useState } from "react";
import { CircleDot } from "lucide-react";
import { arpV2 } from "../lib/api-v2";
import { cn } from "../lib/cn";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../hooks/use-logical-mutation";
import { useCockpitResource } from "./Cockpit/CockpitPrimitives";
import { Button } from "../ui/Button";
import type { MaterialQuestionSnapshot } from "../types/v2";

/** Number keys reach the first nine options; past that the mouse is the route. */
const MAX_KEYED_OPTIONS = 9;

export function MaterialQuestionCard({
  taskId,
  surface = "embedded",
}: {
  taskId: string;
  surface?: "embedded" | "intervention";
}): JSX.Element | null {
  const [resolvingOption, setResolvingOption] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const mutation = useLogicalMutation(`material-question.${taskId}`);

  const load = useCallback(
    (signal: AbortSignal): Promise<MaterialQuestionSnapshot[]> =>
      arpV2.listMaterialQuestions(taskId, signal),
    [taskId],
  );
  const resource = useCockpitResource(load, `material-question:${taskId}`);

  const pending = (resource.data ?? []).filter(
    (question) => question.status === "PENDING" && !resolvedIds.has(question.id),
  );
  const question = pending[0] ?? null;

  const resolve = async (questionId: string, option: string): Promise<void> => {
    setResolvingOption(option);
    setError(null);
    let operationKey: string | null = null;
    try {
      operationKey = mutation.keyFor(JSON.stringify({ questionId, selectedOption: option }));
      const result = await arpV2.resolveMaterialQuestion(questionId, option, { idempotencyKey: operationKey });
      if (!result.success) {
        mutation.abandon(operationKey);
        setError(result.error ?? "The control plane rejected this response.");
        resource.retry();
        return;
      }
      mutation.settle(operationKey);
      setResolvedIds((current) => new Set(current).add(questionId));
      setAnnouncement(`Response recorded: ${option}.`);
      resource.retry();
    } catch (cause: unknown) {
      if (operationKey && isDefinitiveMutationFailure(cause)) {
        mutation.abandon(operationKey);
        resource.retry();
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResolvingOption(null);
    }
  };

  // Nothing to ask, nothing to draw. A loading or failed question fetch is
  // also silent: the panel must not announce an obligation it cannot show, and
  // the queue in the rail is already the authority on whether one exists.
  if (question === null) return null;

  return (
    <section
      aria-labelledby={`material-question-${question.id}`}
      className={cn(
        "px-3.5 py-2.5",
        surface === "intervention"
          ? "rounded-lg border border-subtle bg-elevated"
          : "border-b border-subtle",
      )}
      onKeyDown={(event) => {
        if (resolvingOption !== null || event.metaKey || event.ctrlKey || event.altKey) return;
        const index = Number(event.key) - 1;
        const option = question.options[index];
        if (!option || index < 0 || index >= MAX_KEYED_OPTIONS) return;
        event.preventDefault();
        void resolve(question.id, option);
      }}
    >
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <div className="flex items-center gap-1.5">
        <CircleDot size={12} className="shrink-0 text-warning" aria-hidden />
        <h3 className="ui-meta font-medium text-warning">Decision needed</h3>
        {pending.length > 1 ? (
          <span className="ui-meta ml-auto tabular-nums">1 of {pending.length}</span>
        ) : null}
      </div>

      {/* A question drawn from a snapshot that failed to refresh may already
          have been answered elsewhere. Saying so costs one line; not saying so
          means the first the operator hears of it is a rejected response. */}
      {resource.status === "stale" ? (
        <p className="ui-meta mt-1 text-warning" role="status" data-cockpit-state="stale">
          Showing the last successful snapshot.
        </p>
      ) : null}

      <p id={`material-question-${question.id}`} className="ui-body mt-1.5 text-primary">
        {question.questionText}
      </p>

      <div className="mt-2 flex flex-col gap-1">
        {question.options.map((option, index) => (
          <Button
            key={option}
            data-attention-option
            type="button"
            variant="secondary"
            onClick={() => void resolve(question.id, option)}
            disabled={resolvingOption !== null}
            aria-label={`Choose ${option} for ${question.questionText}`}
            aria-busy={resolvingOption === option || undefined}
            className={cn(
              "h-auto min-h-9 w-full items-start justify-start gap-2 px-2 py-1.5 text-left",
              resolvingOption === option && "opacity-70",
            )}
          >
            {index < MAX_KEYED_OPTIONS ? (
              <kbd className="ui-code mt-px flex h-4 w-4 flex-none items-center justify-center rounded-sm bg-subtle text-tertiary">
                {index + 1}
              </kbd>
            ) : null}
            <span className="min-w-0">
              <span className="ui-body block font-medium text-primary">{option}</span>
              {/* The consequence, in the control plane's words. Absent rather
                  than invented: a made-up reassurance next to a real choice is
                  the one thing worse than no explanation at all. */}
              {question.consequenceMatrix[option] ? (
                <span className="ui-meta mt-0.5 block whitespace-normal">
                  {question.consequenceMatrix[option]}
                </span>
              ) : null}
            </span>
          </Button>
        ))}
      </div>

      {error ? <p role="alert" className="ui-meta mt-2 text-error">{error}</p> : null}
    </section>
  );
}
