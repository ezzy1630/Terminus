/**
 * Terminus Desktop — Canonical ARP v2 task panel.
 *
 * Renders a canonical v2 task (contract, acceptance criteria, transactional
 * effects) driven entirely by the `/v2/*` protocol surface — the same
 * surface the CLI's `*-v2` commands use. Selecting a task id shows its
 * snapshot; effect rows expose authoritative ledger state without letting the
 * UI synthesize policy, authorization, dispatch, validation, or commit steps.
 *
 * Per SPEC §11 ("sections appear only after relevant information exists"):
 * when no v2 task is selected the panel lists the canonical tasks that do
 * exist rather than rendering empty placeholders.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, CheckCircle2, FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "../lib/cn";
import { arpV2 } from "../lib/api-v2";
import { useTaskV2 } from "../hooks/use-task-v2";
import type { EffectSnapshot, TaskV2Snapshot } from "../types/v2";
import { Skeleton } from "../ui/Status";
import { Button } from "../ui/Button";

interface TaskV2PanelProps {
  className?: string;
  /** Bind the panel to a specific canonical task id (inspector mode).
   * When omitted, the panel shows a picker over all canonical tasks. */
  taskId?: string | null;
}

const EFFECT_TERMINAL = new Set(["COMMITTED", "DENIED", "CANCELLED", "COMPENSATED"]);
const INITIAL_CATALOG_COUNT = 8;

function statusTone(status: string): string {
  if (status === "COMPLETED") return "var(--color-success)";
  if (status === "FAILED" || status === "CANCELLED" || status === "DENIED") return "var(--color-error)";
  if (status === "BLOCKED" || status.startsWith("WAITING")) return "var(--color-warning)";
  return "var(--color-info)";
}

const TaskV2Panel = memo(function TaskV2Panel({ className, taskId: boundTaskId }: TaskV2PanelProps) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectedId = boundTaskId ?? pickedId;
  const [catalog, setCatalog] = useState<TaskV2Snapshot[]>([]);
  const [catalogState, setCatalogState] = useState<"idle" | "loading" | "ready" | "stale" | "error">("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [visibleCatalogCount, setVisibleCatalogCount] = useState(INITIAL_CATALOG_COUNT);
  const catalogGeneration = useRef(0);
  const catalogRef = useRef<TaskV2Snapshot[]>([]);
  const { task, effects, loading, error, resourceState, streamState, refresh } = useTaskV2(selectedId);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const generation = ++catalogGeneration.current;
    setCatalogState((current) => catalogRef.current.length > 0 && current !== "idle" ? "stale" : "loading");
    setCatalogError(null);
    try {
      const tasks = await arpV2.listTasks();
      if (generation !== catalogGeneration.current) return;
      catalogRef.current = tasks;
      setCatalog(tasks);
      setCatalogState("ready");
      setCatalogError(null);
    } catch (cause: unknown) {
      if (generation !== catalogGeneration.current) return;
      setCatalogState(catalogRef.current.length > 0 ? "stale" : "error");
      setCatalogError(cause instanceof Error ? cause.message : "Could not load canonical tasks");
    }
  }, []);

  useEffect(() => {
    if (!boundTaskId) void loadCatalog();
    return () => {
      catalogGeneration.current += 1;
    };
  }, [boundTaskId, loadCatalog]);

  return (
    <div className={cn("flex flex-col gap-2.5 text-xs", className)} data-testid="task-v2-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-secondary">
          <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
          Task snapshot
        </div>
        <Button
          type="button"
          onClick={() => {
            if (selectedId) void refresh();
            if (!boundTaskId) void loadCatalog();
          }}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-tertiary hover:bg-hover"
          aria-label="Refresh canonical task"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Refresh
        </Button>
      </div>

      {selectedId && resourceState === "loading" && !task && (
        <div className="grid gap-2 py-1" role="status" aria-label="Loading task details">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-full" />
        </div>
      )}

      {selectedId && resourceState === "stale" && task && (
        <p className={cn(
          "border-l-2 border-warning/55 px-2 py-1 text-xs",
          error ? "text-warning" : "text-tertiary",
        )} data-cockpit-state="stale" role="status">
          {error ? `Refresh failed. Showing the last confirmed snapshot: ${error}` : "Showing the last confirmed snapshot while this task refreshes."}
          {loading ? " Refreshing…" : ""}
        </p>
      )}

      {/* Task picker: canonical tasks known to the control plane. */}
      {!selectedId && (
        <div className="flex flex-col gap-1">
          {catalogState === "loading" && catalog.length === 0 ? (
            <div className="grid gap-2" role="status" aria-label="Loading tasks">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-7 w-full" />
            </div>
          ) : null}
          {(catalogState === "error" || catalogState === "stale") && catalogError ? (
            <div className="border-l-2 border-warning/55 px-2 py-1 text-xs" role="alert">
              <p className={catalogState === "error" ? "text-error" : "text-warning"}>
                {catalogState === "stale" ? `Could not refresh canonical tasks. Showing the last confirmed catalog: ${catalogError}` : catalogError}
              </p>
              <Button type="button" onClick={() => void loadCatalog()} className="mt-1 rounded px-1.5 py-0.5 font-medium text-secondary hover:bg-hover">
                Retry
              </Button>
            </div>
          ) : null}
          {catalogState === "ready" && catalog.length === 0 && (
            <p className="text-xs text-tertiary">
              No tasks yet.
            </p>
          )}
          {catalog.slice(0, visibleCatalogCount).map((candidate) => (
            <Button
              key={candidate.id}
              type="button"
              onClick={() => setPickedId(candidate.id)}
              className="flex items-center justify-between rounded px-2 py-1.5 text-left hover:bg-hover"
            >
              <span className="truncate">{candidate.contract.mission}</span>
              <span className="ml-2 shrink-0 text-xs" style={{ color: statusTone(candidate.status) }}>{candidate.status}</span>
            </Button>
          ))}
          {visibleCatalogCount < catalog.length ? (
            <Button
              type="button"
              onClick={() => setVisibleCatalogCount((count) => Math.min(catalog.length, count + INITIAL_CATALOG_COUNT))}
              className="mt-1 h-7 justify-start rounded border border-default px-2 text-left text-xs font-medium text-secondary hover:bg-hover"
            >
              Show more tasks ({visibleCatalogCount} of {catalog.length})
            </Button>
          ) : null}
        </div>
      )}

      {selectedId && resourceState === "error" && error && (
        <p className="border-l-2 border-error/55 px-2 py-1 text-xs text-error" role="alert">
          {error}
        </p>
      )}

      {/* Canonical contract view. */}
      {task && (
        <>
          <div className="flex flex-col gap-1 border-y border-subtle py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{task.contract.mission}</span>
              <span className="shrink-0 text-xs font-medium" style={{ color: statusTone(task.status) }}>
                {task.status}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-tertiary">
              <dt>Version</dt><dd className="tabular-nums">{task.version}</dd>
              <dt>Mode</dt><dd>{task.contract.mode}</dd>
              <dt>Budget</dt><dd className="tabular-nums">{task.contract.constraints.costMicros} µ$, {task.contract.constraints.timeoutSeconds}s</dd>
              <dt>Authority</dt><dd>{task.contract.authorityCeiling.join(", ") || "None"}</dd>
              <dt>Updates</dt>
              <dd>
                <span className={cn(streamState === "connected" && "text-success", streamState === "reconnecting" && "text-warning")}>
                  {streamState}
                </span>
              </dd>
            </dl>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 font-medium text-secondary">
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Acceptance criteria
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
            {task.contract.acceptance.map((criterion) => (
              <div key={criterion.claimId} className="flex items-start gap-1.5 py-1.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-info" aria-hidden />
                <span>
                  {criterion.statement}
                  <span className="ml-1 text-xs text-tertiary">({criterion.evidenceRequirement})</span>
                </span>
              </div>
            ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 font-medium text-secondary">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              Transactional effects
            </div>
            {effects.length === 0 && (
              <p className="text-xs text-tertiary">No effects proposed for this task.</p>
            )}
            {effects.map((effect) => (
              <EffectRow
                key={`${effect.id}:${effect.version}`}
                effect={effect}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
});

function EffectRow({ effect }: {
  effect: EffectSnapshot;
}): React.ReactNode {
  const settled = EFFECT_TERMINAL.has(effect.state);
  return (
    <div className="flex items-center justify-between gap-2 border-b border-subtle py-1.5 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {effect.intentType}
          <span className="ml-1.5 text-xs font-normal text-tertiary">{effect.effectClass}</span>
        </div>
        <div className="text-xs" style={{ color: statusTone(effect.state) }}>
          {effect.state}
          {effect.settledAt ? `, ${effect.settledAt}` : ""}
        </div>
      </div>
      {!settled && effect.state !== "UNCERTAIN" && (
        <span className="max-w-32 shrink-0 text-right text-xs leading-tight text-tertiary">
          Waiting for settlement
        </span>
      )}
    </div>
  );
}

export default TaskV2Panel;
