/**
 * Terminus Desktop — Canonical ARP v2 task panel.
 *
 * Renders a canonical v2 task (contract, acceptance criteria, transactional
 * effects) driven entirely by the `/v2/*` protocol surface — the same
 * surface the CLI's `*-v2` commands use. Selecting a task id shows its
 * snapshot; effect rows expose the human confirmation gate (authorize →
 * deterministic settlement → commit).
 *
 * Per SPEC §11 ("sections appear only after relevant information exists"):
 * when no v2 task is selected the panel lists the canonical tasks that do
 * exist rather than rendering empty placeholders.
 */
import { memo, useCallback, useEffect, useState } from "react";
import { BadgeCheck, CheckCircle2, FileText, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "../lib/cn";
import { arpV2 } from "../lib/api-v2";
import { useTaskV2 } from "../hooks/use-task-v2";
import type { EffectSnapshot, TaskV2Snapshot } from "../types/v2";

interface TaskV2PanelProps {
  className?: string;
  /** Bind the panel to a specific canonical task id (inspector mode).
   * When omitted, the panel shows a picker over all canonical tasks. */
  taskId?: string | null;
}

const EFFECT_TERMINAL = new Set(["COMMITTED", "DENIED", "CANCELLED", "COMPENSATED"]);

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
  const { task, effects, loading, error, streamState, refresh, confirmEffect } = useTaskV2(selectedId);
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadCatalog = useCallback(async (): Promise<void> => {
    try {
      setCatalog(await arpV2.listTasks());
    } catch {
      // Control plane offline — panel stays quiet.
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const onConfirm = useCallback(async (effectId: string): Promise<void> => {
    setConfirming(effectId);
    try {
      await confirmEffect(effectId);
    } finally {
      setConfirming(null);
    }
  }, [confirmEffect]);

  return (
    <div className={cn("flex flex-col gap-3 text-xs", className)} data-testid="task-v2-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
          <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
          ARP v2 task
        </div>
        <button
          type="button"
          onClick={() => { void refresh(); void loadCatalog(); }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
          aria-label="Refresh canonical task"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Refresh
        </button>
      </div>

      {/* Task picker: canonical tasks known to the control plane. */}
      {!task && (
        <div className="flex flex-col gap-1">
          {catalog.length === 0 && (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              No canonical tasks yet{loading ? "…" : "."} Create one with{" "}
              <code className="rounded bg-[var(--color-surface-raised)] px-1">terminus new-task-v2 --objective …</code>
            </p>
          )}
          {catalog.slice(0, 8).map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setPickedId(candidate.id)}
              className="flex items-center justify-between rounded px-2 py-1.5 text-left hover:bg-[var(--color-surface-hover)]"
            >
              <span className="truncate">{candidate.contract.mission}</span>
              <span className="ml-2 shrink-0 text-[10px]" style={{ color: statusTone(candidate.status) }}>{candidate.status}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-[11px] text-[var(--color-error)]" role="alert">
          {error}
        </p>
      )}

      {/* Canonical contract view. */}
      {task && (
        <>
          <div className="flex flex-col gap-1 rounded border border-[var(--color-border)] px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{task.contract.mission}</span>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: statusTone(task.status), background: "var(--color-surface-raised)" }}>
                {task.status}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] text-[var(--color-text-muted)]">
              <dt>version</dt><dd className="tabular-nums">{task.version}</dd>
              <dt>mode</dt><dd>{task.contract.mode}</dd>
              <dt>budget</dt><dd className="tabular-nums">{task.contract.constraints.costMicros} µ$ · {task.contract.constraints.timeoutSeconds}s</dd>
              <dt>authority</dt><dd>{task.contract.authorityCeiling.join(", ") || "—"}</dd>
              <dt>stream</dt>
              <dd>
                <span className={cn(streamState === "connected" && "text-[var(--color-success)]", streamState === "reconnecting" && "text-[var(--color-warning)]")}>
                  {streamState}
                </span>
              </dd>
            </dl>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Acceptance criteria
            </div>
            {task.contract.acceptance.map((criterion) => (
              <div key={criterion.claimId} className="flex items-start gap-1.5 rounded px-1 py-0.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-[var(--color-info)]" aria-hidden />
                <span>
                  {criterion.statement}
                  <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">({criterion.evidenceRequirement})</span>
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              Transactional effects
            </div>
            {effects.length === 0 && (
              <p className="text-[11px] text-[var(--color-text-muted)]">No effects proposed for this task.</p>
            )}
            {effects.map((effect) => (
              <EffectRow
                key={`${effect.id}:${effect.version}`}
                effect={effect}
                confirming={confirming === effect.id}
                onConfirm={() => void onConfirm(effect.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
});

function EffectRow({ effect, confirming, onConfirm }: {
  effect: EffectSnapshot;
  confirming: boolean;
  onConfirm: () => void;
}): React.ReactNode {
  const settled = EFFECT_TERMINAL.has(effect.state);
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] px-2 py-1.5">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {effect.intentType}
          <span className="ml-1.5 text-[10px] font-normal text-[var(--color-text-muted)]">{effect.effectClass}</span>
        </div>
        <div className="text-[10px]" style={{ color: statusTone(effect.state) }}>
          {effect.state}
          {effect.settledAt ? ` · ${effect.settledAt}` : ""}
        </div>
      </div>
      {!settled && effect.state !== "UNCERTAIN" && (
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[10px] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          {confirming && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          Confirm &amp; commit
        </button>
      )}
    </div>
  );
}

export default TaskV2Panel;
