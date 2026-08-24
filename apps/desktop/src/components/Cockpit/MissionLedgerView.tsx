import { useCallback } from "react";
import { arpV2 } from "../../lib/api-v2";
import type { TaskV2Status } from "../../types/v2";
import {
  CockpitEmptyState,
  CockpitErrorState,
  CockpitLoadingState,
  CockpitPage,
  DataSection,
  SemanticBadge,
  StaleDataBanner,
  TaskRequiredState,
  useCockpitResource,
  type SemanticTone,
} from "./CockpitPrimitives";

function taskTone(status: TaskV2Status): SemanticTone {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "CANCELLED" || status === "BLOCKED") return "error";
  if (status === "WAITING_AUTH" || status === "WAITING_USER" || status === "WAITING_RESOURCE" || status === "PAUSED") return "warning";
  if (status === "RUNNING" || status === "VERIFYING") return "info";
  return "neutral";
}

function MissionLedgerForTask({ taskId }: { taskId: string }): JSX.Element {
  const load = useCallback((signal: AbortSignal) => arpV2.getTask(taskId, signal), [taskId]);
  const resource = useCockpitResource(load, `task:${taskId}`);
  const task = resource.data;

  return (
    <CockpitPage
      title="Overview"
      description="Task objective, acceptance requirements, and contract details."
      selectedTaskId={taskId}
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="task contract" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : (resource.status === "ready" || resource.status === "stale") && task === null ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          <CockpitEmptyState
            title="No ARP v2 task record"
            description="The selected desktop task has no canonical ARP v2 task snapshot. No substitute task was selected."
          />
        </>
      ) : task ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          <div className="mx-auto max-w-[720px]">
            <section className="border-b border-subtle px-1 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-3xl">
                  <h2 className="ui-section-title text-primary">{task.contract.mission}</h2>
                  <p className="ui-meta mt-1">
                    Updated {new Date(task.updatedAt).toLocaleString()}
                  </p>
                </div>
                <SemanticBadge tone={taskTone(task.status)}>{task.status}</SemanticBadge>
              </div>
            </section>

            <DataSection title="Acceptance requirements" detail={`${task.contract.acceptance.length} declared`}>
              {task.contract.acceptance.length > 0 ? (
                <ol className="divide-y divide-subtle border-y border-subtle">
                  {task.contract.acceptance.map((criterion) => (
                    <li key={criterion.claimId} className="group px-1 py-2.5">
                      <div className="min-w-0">
                        <p className="ui-body text-primary">{criterion.statement}</p>
                        <p className="ui-meta mt-0.5">
                          Requires {criterion.evidenceRequirement}
                        </p>
                        <code className="ui-code mt-1 hidden text-tertiary group-hover:block group-focus-within:block">{criterion.claimId}</code>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-tertiary">No acceptance requirements were declared in this contract.</p>
              )}
            </DataSection>

            <details className="mt-3 border-y border-subtle px-1 py-2">
              <summary className="ui-label cursor-pointer text-secondary">Contract details</summary>
              <dl className="mt-2 divide-y divide-subtle text-xs">
                <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="text-tertiary">Organization</dt><dd className="truncate font-mono text-primary">{task.organizationId}</dd></div>
                <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="text-tertiary">Department</dt><dd className="truncate font-mono text-primary">{task.departmentId}</dd></div>
                <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="text-tertiary">Mode</dt><dd className="truncate font-mono text-primary">{task.contract.mode}</dd></div>
                <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="text-tertiary">Contract</dt><dd className="font-mono text-primary">v{task.contract.version}, record v{task.version}</dd></div>
                <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="text-tertiary">Cost cap</dt><dd className="font-mono text-primary">{task.contract.constraints.costMicros} microdollars</dd></div>
                <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="text-tertiary">Timeout</dt><dd className="font-mono text-primary">{task.contract.constraints.timeoutSeconds}s</dd></div>
                <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="text-tertiary">Security</dt><dd className="font-mono text-primary">{task.contract.constraints.security.join(", ") || "None declared"}</dd></div>
              </dl>
              {task.contract.authorityCeiling.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Authority ceiling">
                  {task.contract.authorityCeiling.map((authority) => <SemanticBadge key={authority}>{authority}</SemanticBadge>)}
                </div>
              ) : null}
            </details>
          </div>
        </>
      ) : null}
    </CockpitPage>
  );
}

export function MissionLedgerView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  if (!selectedTaskId) {
    return (
      <CockpitPage title="Overview" description="Task objective and acceptance requirements.">
        <TaskRequiredState feature="Task overview" />
      </CockpitPage>
    );
  }
  return <MissionLedgerForTask taskId={selectedTaskId} />;
}
