/**
 * Read-only progress for one conversation work block.
 *
 * The drawer presents only fields already carried by ActivityBlock. Missing
 * working directories, exit codes, durations, artifacts, and effect receipts
 * stay absent rather than being inferred from display copy.
 */
import { ChevronRight, X } from "lucide-react";
import { clockTimestamp } from "../lib/time";
import { cn } from "../lib/cn";
import type { ActivityBlock, ActivityEntry } from "../types";
import { Button } from "../ui/Button";
import { DialogSurface } from "../ui/Dialog";
import { StatusIndicator } from "./StatusIndicator";
import type { TaskLifecycle } from "../lib/task-lifecycle";

const MAX_RENDERED_ACTIVITY_DETAIL_CHARS = 16_000;

export function boundedActivityDetail(detail: string): string {
  if (detail.length <= MAX_RENDERED_ACTIVITY_DETAIL_CHARS) return detail;
  return `[Activity detail omitted: ${detail.length} characters exceeds the ${MAX_RENDERED_ACTIVITY_DETAIL_CHARS}-character presentation limit.]`;
}

function statusKind(status: ActivityBlock["status"]): TaskLifecycle {
  switch (status) {
    case "working": return "working";
    case "done": return "done";
    case "failed": return "failed";
    case "waiting": return "needs_you";
    case "interrupted": return "cancelled";
    case "unknown": return "unknown";
  }
}

function phaseLabel(entry: ActivityEntry): string {
  if (entry.phase === "proposed") return "Proposed";
  if (entry.phase === "authorized") return "Authorized";
  if (entry.outcome === "succeeded") return "Succeeded";
  if (entry.outcome === "failed") return "Failed";
  if (entry.outcome === "denied") return "Denied";
  if (entry.outcome === "unknown") return "Settlement unknown";
  return "Settled";
}

interface ProgressDrawerProps {
  block: ActivityBlock;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProgressDrawer({ block, open, onOpenChange }: ProgressDrawerProps): JSX.Element {
  return (
    <DialogSurface
      open={open}
      onOpenChange={onOpenChange}
      accessibleTitle={`Progress for ${block.title}`}
      overlayClassName="bg-black/25"
      className="fixed inset-y-3 right-3 flex w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-subtle bg-inspector text-primary shadow-lg"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-subtle px-3">
        <span className="ui-body font-semibold">Progress</span>
        <Button
          variant="bare"
          onClick={() => onOpenChange(false)}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary"
          aria-label="Close progress"
        >
          <X size={14} aria-hidden />
        </Button>
      </header>

      <div className="border-b border-subtle px-4 py-3">
        <div className="flex items-start gap-2">
          <span className="mt-1">
            <StatusIndicator status={statusKind(block.status)} size={9} />
          </span>
          <div className="min-w-0">
            <p className="ui-body font-medium text-primary">{block.title}</p>
            <p className="ui-meta mt-0.5">
              {block.metric ? `${block.metric} · ` : ""}{block.status.replaceAll("_", " ")}
            </p>
          </div>
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto px-4 py-2" aria-label="Progress steps">
        {block.entries.map((entry, index) => {
          const hasDetails = Boolean(entry.detail || entry.operationId);
          return (
            <li
              key={`${entry.operationId ?? entry.at}:${entry.phase}:${index}`}
              className="relative border-l border-subtle py-2 pl-4 before:absolute before:-left-[3px] before:top-[17px] before:h-[5px] before:w-[5px] before:rounded-full before:bg-[var(--text-tertiary)]"
            >
              <div className="flex items-baseline gap-2">
                <time className="ui-code w-12 shrink-0 text-tertiary" dateTime={entry.at}>
                  {clockTimestamp(entry.at)}
                </time>
                <div className="min-w-0 flex-1">
                  <p className="ui-body text-primary">{entry.summary}</p>
                  <p className="ui-meta mt-0.5">
                    <span className="font-mono">{entry.tool}</span>
                    <span aria-hidden> · </span>
                    {phaseLabel(entry)}
                  </p>
                </div>
              </div>
              {hasDetails ? (
                <details className="group mt-2 ml-14">
                  <summary className="ui-meta flex cursor-pointer list-none items-center gap-1 rounded-md py-1 text-secondary hover:text-primary">
                    <ChevronRight size={11} className="transition-transform group-open:rotate-90" aria-hidden />
                    Exact details
                  </summary>
                  <div className="mt-1 border-l border-subtle pl-3">
                    {entry.operationId ? (
                      <dl className="ui-meta mb-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
                        <dt>Operation</dt>
                        <dd className="truncate font-mono text-secondary" data-tooltip={entry.operationId}>{entry.operationId}</dd>
                      </dl>
                    ) : null}
                    {entry.detail ? (
                      <pre className={cn(
                        "selectable max-h-[320px] overflow-auto rounded-md border border-subtle bg-terminal px-2 py-1.5",
                        "whitespace-pre-wrap break-words text-xs leading-[1.5] text-secondary",
                      )}>
                        {boundedActivityDetail(entry.detail)}
                      </pre>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </DialogSurface>
  );
}
