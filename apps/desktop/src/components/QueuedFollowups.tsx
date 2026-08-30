import { memo } from "react";
import { Clock3, X } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "../ui/Button";

export type QueuedFollowupState = "queued" | "stalled" | "terminal";

export interface QueuedFollowupsProps {
  message: string;
  state: QueuedFollowupState;
  onEdit: () => void;
  onRemove: () => void;
  onSendNow?: () => void;
  editDisabled?: boolean;
  sending?: boolean;
  className?: string;
}

function QueuedFollowupsImpl({
  message,
  state,
  onEdit,
  onRemove,
  onSendNow,
  editDisabled = false,
  sending = false,
  className,
}: QueuedFollowupsProps): JSX.Element {
  const status = state === "terminal" ? "Not sent." : state === "stalled" ? "Still waiting." : "Queued.";
  const detail = state === "terminal"
    ? "The task finished before this message could run."
    : state === "stalled"
      ? "The current run has not released this message."
      : "This goes as a new turn after the current turn.";

  return (
    <section
      aria-label="Queued follow-up"
      role="status"
      aria-live="polite"
      className={cn(
        "mb-2 rounded-lg border bg-elevated px-3 py-2",
        state === "terminal" ? "border-warning/45" : "border-subtle",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Clock3
          size={13}
          strokeWidth={1.8}
          className={cn("shrink-0", state === "terminal" ? "text-warning" : "text-tertiary")}
          aria-hidden
        />
        <span className="ui-meta font-medium text-primary">Queued next</span>
        <span className={cn("ui-meta", state === "terminal" ? "text-warning" : "text-tertiary")}>{status}</span>
        <span className="ui-meta min-w-0 flex-1 truncate text-tertiary">{detail}</span>
        <Button
          type="button"
          variant="bare"
          onClick={onEdit}
          disabled={editDisabled}
          data-tooltip={editDisabled ? "Finish the current draft before editing the queued message" : undefined}
          className="h-6 rounded-md px-1.5 text-xs font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          {state === "terminal" ? "Put back" : "Edit"}
        </Button>
        {onSendNow ? (
          <Button
            type="button"
            variant="bare"
            onClick={onSendNow}
            disabled={sending}
            className="h-6 rounded-md px-1.5 text-xs font-medium text-primary hover:bg-hover"
          >
            Send now
          </Button>
        ) : null}
        <Button
          type="button"
          variant="bare"
          onClick={onRemove}
          aria-label="Discard the queued message"
          data-tooltip="Remove queued message"
          className="flex h-6 w-6 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
        >
          <X size={12} aria-hidden />
        </Button>
      </div>
      <p className="ui-body mt-1 truncate pl-5 text-secondary">{message}</p>
    </section>
  );
}

export const QueuedFollowups = memo(QueuedFollowupsImpl);
