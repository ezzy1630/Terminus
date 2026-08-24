import { useCallback } from "react";
import { arpV2 } from "../../lib/api-v2";
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
} from "./CockpitPrimitives";

function ClaimEvidenceForTask({ taskId }: { taskId: string }): JSX.Element {
  const load = useCallback((signal: AbortSignal) => arpV2.getTask(taskId, signal), [taskId]);
  const resource = useCockpitResource(load, `task:${taskId}`);
  const task = resource.data;

  return (
    <CockpitPage
      title="Evidence"
      description="Acceptance claims declared by the selected task."
      selectedTaskId={taskId}
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="acceptance claims" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : (resource.status === "ready" || resource.status === "stale") && task === null ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          <CockpitEmptyState
            title="No ARP v2 task record"
            description="The selected task has no canonical ARP v2 contract snapshot."
          />
        </>
      ) : task ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          <div className="mx-auto max-w-4xl space-y-5">
            <DataSection title="Acceptance claims" detail={`${task.contract.acceptance.length} requirements`}>
              {task.contract.acceptance.length > 0 ? (
                <div className="space-y-2">
                  {task.contract.acceptance.map((claim) => (
                    <article key={claim.claimId} className="rounded-md bg-subtle px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="text-sm font-medium text-primary">{claim.statement}</h2>
                          <p className="mt-1 font-mono text-tertiary text-xs" >
                            Evidence requirement: {claim.evidenceRequirement}
                          </p>
                        </div>
                        <SemanticBadge>{claim.claimId}</SemanticBadge>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <CockpitEmptyState
                  title="No claims declared"
                  description="The selected task contract contains no acceptance requirements."
                />
              )}
            </DataSection>
            <p className="px-1 text-xs text-tertiary">Verification status appears here when the control plane reports evidence receipts.</p>
          </div>
        </>
      ) : null}
    </CockpitPage>
  );
}

export function ClaimEvidenceGraphView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  if (!selectedTaskId) {
    return (
      <CockpitPage title="Evidence" description="Acceptance claims for one durable task.">
        <TaskRequiredState feature="Task evidence" />
      </CockpitPage>
    );
  }
  return <ClaimEvidenceForTask taskId={selectedTaskId} />;
}
