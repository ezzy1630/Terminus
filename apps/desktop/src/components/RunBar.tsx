/**
 * The active task's compact truth surface.
 *
 * It sits directly above the composer: close enough to answer what is running
 * before a person steers it, small enough not to compete with the transcript.
 * Every value comes from the task snapshot or its authoritative event tail.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { FileDiff, PanelRight } from "lucide-react";
import { useSelectedTask, useSelectedTaskEvents } from "../hooks/use-terminus";
import { compactDuration } from "../lib/time";
import { deriveVerificationActivity } from "../lib/task-surface";
import { lifecycleIsActive, lifecycleLabel } from "../lib/task-lifecycle";
import { displayLifecycle } from "../lib/turn-activity";
import { Button } from "../ui/Button";
import { StatusIndicator } from "./StatusIndicator";

interface RunBarProps {
  onShowChanges: () => void;
  onShowDetails: () => void;
}

export interface VerificationSummary {
  passed: number;
  total: number;
  failed: number;
}

export function summarizeVerification(
  checks: ReadonlyArray<{ state: "passed" | "failed" | "running" }>,
): VerificationSummary {
  return {
    passed: checks.filter((check) => check.state === "passed").length,
    failed: checks.filter((check) => check.state === "failed").length,
    total: checks.length,
  };
}

function RunBarImpl({ onShowChanges, onShowDetails }: RunBarProps): JSX.Element | null {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();
  const lifecycle = task ? displayLifecycle(task, events) : null;
  const active = lifecycle !== null && lifecycleIsActive(lifecycle);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !task?.active_turn?.started_at) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(handle);
  }, [active, task?.active_turn?.started_at]);

  const verification = useMemo(
    () => summarizeVerification(deriveVerificationActivity([...events])),
    [events],
  );

  if (!task || lifecycle === null) return null;
  const elapsed = active && task.active_turn?.started_at
    ? compactDuration(task.active_turn.started_at, now)
    : null;

  return (
    <div className="content-column" role="region" aria-label="Current run">
      <div className="run-bar flex min-h-9 items-center gap-2 px-2.5 text-xs text-secondary">
        <StatusIndicator status={lifecycle} size={9} />
        <span className="font-medium text-primary">{lifecycleLabel(lifecycle)}</span>
        {elapsed ? <span className="tabular-nums text-tertiary">{elapsed}</span> : null}
        <span className="h-3 w-px bg-border-subtle" aria-hidden />
        <span className="tabular-nums text-tertiary">{events.length} {events.length === 1 ? "event" : "events"}</span>
        {verification.total > 0 ? (
          <span className={verification.failed > 0 ? "tabular-nums text-warning" : "tabular-nums text-tertiary"}>
            {verification.passed}/{verification.total} checks
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            variant="bare"
            onClick={onShowChanges}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
          >
            <FileDiff size={12} strokeWidth={1.7} aria-hidden />
            Changes
          </Button>
          <Button
            type="button"
            variant="bare"
            onClick={onShowDetails}
            className="details-trigger flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
          >
            <PanelRight size={12} strokeWidth={1.7} aria-hidden />
            Details
          </Button>
        </div>
      </div>
    </div>
  );
}

export const RunBar = memo(RunBarImpl);
