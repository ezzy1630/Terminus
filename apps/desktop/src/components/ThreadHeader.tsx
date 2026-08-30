import { memo, useEffect, useState } from "react";
import { ExternalLink, GitBranch, MoreHorizontal, Square } from "lucide-react";
import { cn } from "../lib/cn";
import { formatElapsedTime, type TaskPresentation } from "../lib/task-presentation";
import { Button } from "../ui/Button";

export interface ThreadHeaderProps {
  presentation: TaskPresentation;
  repository: string;
  workspace?: string | null;
  onOpenChanges?: () => void;
  onOpenEditor?: () => void;
  onOpenDetails?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  className?: string;
}

function lifecycleClass(presentation: TaskPresentation): string {
  switch (presentation.lifecycle) {
    case "needs_you": return "text-warning";
    case "review": return "text-success";
    case "failed": return "text-error";
    default: return "text-secondary";
  }
}

function metricLabels(presentation: TaskPresentation): string[] {
  const labels: string[] = [];
  if (presentation.changes && presentation.changes.files > 0) {
    labels.push(`${presentation.changes.files} ${presentation.changes.files === 1 ? "file" : "files"} changed`);
  }
  const verification = presentation.verification;
  if (verification) {
    if (verification.failed > 0) {
      labels.push(`${verification.failed} ${verification.failed === 1 ? "check" : "checks"} failed`);
    } else if (verification.total > 0) {
      labels.push(`${verification.passed}/${verification.total} checks passed`);
    }
  }
  if (presentation.activeSubagents > 1) {
    labels.push(`${presentation.activeSubagents} subagents active`);
  }
  return labels;
}

function LiveElapsed({
  active,
  initialSeconds,
}: {
  active: boolean;
  initialSeconds: number;
}): JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(initialSeconds);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  return <>{formatElapsedTime(elapsedSeconds)}</>;
}

function ThreadHeaderImpl({
  presentation,
  repository,
  workspace,
  onOpenChanges,
  onOpenEditor,
  onOpenDetails,
  onStop,
  stopping = false,
  className,
}: ThreadHeaderProps): JSX.Element {
  const metrics = metricLabels(presentation);
  const showChanges = presentation.changes !== null && onOpenChanges !== undefined;

  return (
    <header className={cn("shrink-0 border-b border-subtle bg-canvas px-5 py-3", className)}>
      <div className="mx-auto flex w-full max-w-[960px] items-start gap-5">
        <div className="min-w-0 flex-1">
          <div className="ui-meta flex min-w-0 items-center gap-1.5 text-tertiary" aria-label="Task workspace">
            <span className="truncate">{repository}</span>
            {workspace ? (
              <>
                <span aria-hidden>/</span>
                <GitBranch size={11} strokeWidth={1.75} className="shrink-0" aria-hidden />
                <span className="truncate">{workspace}</span>
              </>
            ) : null}
          </div>

          <h1 className="ui-page-title mt-1 truncate text-primary">
            {presentation.objective}
          </h1>

          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={cn("font-medium", lifecycleClass(presentation))}>{presentation.stateLabel}</span>
            {presentation.currentDetail ? (
              <>
                <span className="text-tertiary" aria-hidden>·</span>
                <span className="min-w-0 truncate text-secondary">{presentation.currentDetail}</span>
              </>
            ) : null}
            {presentation.elapsedSeconds !== null ? (
              <span className="border-l border-subtle pl-2 tabular-nums text-tertiary">
                <LiveElapsed
                  key={`${presentation.elapsedSeconds}:${presentation.runActive}`}
                  active={presentation.runActive}
                  initialSeconds={presentation.elapsedSeconds}
                />
              </span>
            ) : null}
          </div>

          {metrics.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tertiary">
              {metrics.map((metric) => <span key={metric}>{metric}</span>)}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {showChanges ? (
            <Button type="button" variant="secondary" size="sm" onClick={onOpenChanges}>
              Changes
            </Button>
          ) : null}
          {onOpenEditor ? (
            <Button
              type="button"
              variant="bare"
              size="sm"
              onClick={onOpenEditor}
              leading={<ExternalLink size={12} strokeWidth={1.8} aria-hidden />}
              className="text-secondary hover:bg-hover hover:text-primary"
            >
              Open in Editor
            </Button>
          ) : null}
          {presentation.runActive && onStop ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onStop}
              disabled={stopping}
              leading={<Square size={9} strokeWidth={2.4} fill="currentColor" aria-hidden />}
            >
              {stopping ? "Stopping" : "Stop"}
            </Button>
          ) : null}
          {onOpenDetails ? (
            <Button
              type="button"
              variant="bare"
              onClick={onOpenDetails}
              aria-label="Thread details"
              data-tooltip="Thread details"
              className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
            >
              <MoreHorizontal size={15} strokeWidth={1.8} aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export const ThreadHeader = memo(ThreadHeaderImpl);
