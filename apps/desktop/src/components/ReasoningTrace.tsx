/**
 * Terminus Desktop — reasoning trace.
 *
 * The control plane already reports what a turn is doing between
 * `turn.started` and `turn.completed` (`turn.context_compiling`,
 * `turn.provider_running`, `turn.response_validating`, `turn.finalizing`).
 * The feed used to drop every one of them, so the wait before the first token
 * was indistinguishable from a hang.
 *
 * While the turn runs this is one quiet live line: a spinner, the current
 * phase, and elapsed time. Once it settles it collapses to "Run details ·
 * 4.2s", which expands into the observed phases and how long each took.
 * Provider reasoning prose is deliberately absent. The useful portable record
 * is what the runtime did and observed, not private model narration.
 */
import { memo, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "../ui/Button";
import type { ReasoningBlock, ReasoningPhaseKind } from "../types";

const PHASE_LABEL: Record<ReasoningPhaseKind, string> = {
  context_compiling: "Read context",
  provider_running: "Model response",
  tool_settlement: "Ran tools",
  response_validating: "Validated response",
  verifying: "Verified result",
  repairing: "Repaired result",
  finalizing: "Finalized run",
};

const LIVE_PHASE_LABEL: Record<ReasoningPhaseKind, string> = {
  context_compiling: "Reading context",
  provider_running: "Generating response",
  tool_settlement: "Running tools",
  response_validating: "Validating response",
  verifying: "Verifying result",
  repairing: "Repairing result",
  finalizing: "Finalizing run",
};

/** Ticks once a second, but only while a turn is actually running. */
function useElapsed(startedAt: string, endedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt !== null) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [endedAt]);
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return 0;
  const end = endedAt === null ? now : Date.parse(endedAt);
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function ReasoningTraceImpl({ block }: { block: ReasoningBlock }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const running = block.endedAt === null;
  const elapsed = useElapsed(block.startedAt, block.endedAt);

  // A settled turn without observed phases has no run detail to present. The
  // provider's reasoning prose is not a substitute for runtime observation.
  if (!running && block.phases.length === 0) return null;

  const current = block.phases[block.phases.length - 1];
  const label = running
    ? LIVE_PHASE_LABEL[current?.kind ?? "provider_running"]
    : `Run details · ${formatDuration(elapsed)}`;

  if (running) {
    return (
      <div className="my-1.5 flex items-center gap-2 px-1.5" role="status" aria-live="polite">
        <span className="spinner-sm" aria-hidden />
        <span className="ui-body text-secondary">{label}</span>
        <span className="ui-meta tabular-nums">{formatDuration(elapsed)}</span>
      </div>
    );
  }

  return (
    <div className="my-1.5">
      {/* Collapsed by default. Runtime timing is useful context for the answer,
          not a headline above it. */}
      <Button
        variant="bare"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        data-tooltip={expanded ? "Hide the phases of this turn" : "Show the phases of this turn"}
        className="flex min-h-6 items-center gap-1.5 rounded-md px-1.5 text-tertiary hover:bg-hover hover:text-secondary"
      >
        <ChevronRight
          size={11}
          className={cn("transition-transform", expanded && "rotate-90")}
          aria-hidden
        />
        <span className="ui-body">{label}</span>
      </Button>
      {expanded ? (
        <div className="mt-1 ml-2 border-l border-subtle pl-3">
        <ul className="flex flex-col gap-0.5">
          {block.phases.map((phase, index) => {
            const next = block.phases[index + 1];
            const from = Date.parse(phase.at);
            const to = next ? Date.parse(next.at) : Date.parse(block.endedAt ?? phase.at);
            const span = Number.isNaN(from) || Number.isNaN(to) ? null : Math.max(0, to - from);
            return (
              <li key={`${phase.kind}-${index}`} className="flex items-center gap-2">
                <span className="ui-meta text-secondary">{PHASE_LABEL[phase.kind]}</span>
                {span === null ? null : (
                  <span className="ui-code text-tertiary tabular-nums">{formatDuration(span)}</span>
                )}
              </li>
            );
          })}
        </ul>
        </div>
      ) : null}
    </div>
  );
}

export const ReasoningTrace = memo(ReasoningTraceImpl);
