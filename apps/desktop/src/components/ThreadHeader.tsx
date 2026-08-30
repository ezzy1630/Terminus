import { memo, useEffect, useState } from "react";
import { ExternalLink, GitBranch, MoreHorizontal } from "lucide-react";
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
  className?: string;
}

export interface ThreadRunBarProps {
  presentation: TaskPresentation;
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
    labels.push(`${presentation.changes.files} ${presentation.changes.files === 1 ? "file" : "files"}`);
  }
  const verification = presentation.verification;
  if (verification) {
    if (verification.failed > 0) {
      labels.push(`${verification.failed} ${verification.failed === 1 ? "check" : "checks"} failed`);
    } else if (verification.total > 0) {
      labels.push(`${verification.passed}/${verification.total} checks`);
    }
  }
  if (presentation.activeSubagents > 1) labels.push(`${presentation.activeSubagents} agents`);
  return labels;
}

function LiveElapsed({ active, initialSeconds }: { active: boolean; initialSeconds: number }): JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(initialSeconds);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setElapsedSeconds((current) => current + 1), 1_000);
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
  className,
}: ThreadHeaderProps): JSX.Element {
  const showChanges = presentation.changes !== null && onOpenChanges !== undefined;
  return (
    <header className={cn("titlebar-drag relative z-10 flex h-12 shrink-0 items-center border-b border-subtle bg-canvas px-4", className)}>
      <div className="mx-auto flex w-full max-w-[1080px] min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="ui-page-title truncate text-primary">{presentation.objective}</h1>
            <span className="ui-meta hidden min-w-0 items-center gap-1.5 text-tertiary lg:flex" aria-label="Task workspace">
              <span aria-hidden>·</span>
              <span className="max-w-36 truncate">{repository}</span>
              {workspace ? (
                <>
                  <GitBranch size={11} strokeWidth={1.75} className="shrink-0" aria-hidden />
                  <span className="max-w-36 truncate">{workspace}</span>
                </>
              ) : null}
            </span>
          </div>
        </div>
        <div className="titlebar-no-drag flex shrink-0 items-center gap-1">
          {showChanges ? (
            <Button type="button" variant="secondary" size="sm" onClick={onOpenChanges}>Changes</Button>
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

function ThreadRunBarImpl({ presentation, className }: ThreadRunBarProps): JSX.Element {
  const metrics = metricLabels(presentation);
  return (
    <div className={cn("content-column", className)}>
      <div className="run-bar flex min-h-8 min-w-0 items-center gap-2 border-b border-subtle px-1 text-xs">
        <span className={cn("shrink-0 font-medium", lifecycleClass(presentation))}>{presentation.stateLabel}</span>
        {presentation.currentDetail ? (
          <span className="min-w-0 flex-1 truncate text-secondary">{presentation.currentDetail}</span>
        ) : <span className="min-w-0 flex-1" />}
        {metrics.map((metric) => (
          <span key={metric} className="hidden shrink-0 text-tertiary sm:inline">{metric}</span>
        ))}
        {presentation.elapsedSeconds !== null ? (
          <span className="shrink-0 border-l border-subtle pl-2 tabular-nums text-tertiary">
            <LiveElapsed
              key={`${presentation.runActive}:${presentation.elapsedSeconds}`}
              active={presentation.runActive}
              initialSeconds={presentation.elapsedSeconds}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export const ThreadHeader = memo(ThreadHeaderImpl);
export const ThreadRunBar = memo(ThreadRunBarImpl);
