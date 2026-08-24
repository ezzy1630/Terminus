import { useCallback } from "react";
import { arpV2 } from "../../lib/api-v2";
import type { ClaimSnapshot, EvidenceSnapshot, TaskV2Snapshot } from "../../types/v2";
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

interface ClaimEvidenceResource {
  task: TaskV2Snapshot | null;
  claims: ClaimSnapshot[];
  evidence: EvidenceSnapshot[];
}

function ClaimEvidenceForTask({ taskId }: { taskId: string }): JSX.Element {
  const load = useCallback(async (signal: AbortSignal): Promise<ClaimEvidenceResource> => {
    const [task, claims, evidence] = await Promise.all([
      arpV2.getTask(taskId, signal),
      arpV2.listClaims(taskId, signal),
      arpV2.listEvidence(taskId, signal),
    ]);
    const claimIds = new Set(claims.map((claim) => claim.id));
    if (evidence.some((item) => !claimIds.has(item.claimId))) {
      throw new Error("v2 evidence response crossed the selected task claim scope");
    }
    return { task, claims, evidence };
  }, [taskId]);
  const resource = useCockpitResource(load, `task:${taskId}`);
  const task = resource.data?.task ?? null;
  const claims = resource.data?.claims ?? [];
  const evidence = resource.data?.evidence ?? [];
  const declaredClaims = task?.contract.acceptance ?? [];
  const persistedClaimsById = new Map(claims.map((claim) => [claim.id, claim]));

  return (
    <CockpitPage
      title="Evidence"
      description="Acceptance claims and trusted verification receipts for the selected task."
      selectedTaskId={taskId}
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="claims and evidence" />
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
            <DataSection
              title="Acceptance claims"
              detail={`${declaredClaims.length} requirements · ${claims.length} persisted`}
            >
              {declaredClaims.length > 0 || claims.length > 0 ? (
                <div className="space-y-2">
                  {declaredClaims.map((declared) => {
                    const persisted = persistedClaimsById.get(declared.claimId);
                    return (
                      <article key={declared.claimId} className="rounded-md bg-subtle px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="text-sm font-medium text-primary">{declared.statement}</h2>
                            <p className="mt-1 font-mono text-tertiary text-xs">
                              Required evidence: {declared.evidenceRequirement}
                            </p>
                          </div>
                          <SemanticBadge>{persisted?.status ?? "DECLARED"}</SemanticBadge>
                        </div>
                      </article>
                    );
                  })}
                  {claims
                    .filter((claim) => !declaredClaims.some((declared) => declared.claimId === claim.id))
                    .map((claim) => (
                      <article key={claim.id} className="rounded-md bg-subtle px-4 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="text-sm font-medium text-primary">{claim.statement}</h2>
                            <p className="mt-1 font-mono text-tertiary text-xs">
                              Required evidence: {claim.requiredEvidenceKind}
                            </p>
                          </div>
                          <SemanticBadge>{claim.status}</SemanticBadge>
                        </div>
                      </article>
                    ))}
                </div>
              ) : (
                <CockpitEmptyState
                  title="No claims declared"
                  description="The control plane has no persisted acceptance claim records for this task."
                />
              )}
            </DataSection>
            <DataSection title="Verification receipts" detail={`${evidence.length} admitted`}>
              {evidence.length > 0 ? (
                <div className="space-y-2">
                  {evidence.map((item) => (
                    <article key={item.id} className="rounded-md bg-subtle px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="text-sm font-medium text-primary">{item.summary}</h2>
                          <p className="mt-1 text-xs text-tertiary">
                            {item.kind} · {item.verifierResult} · claim {item.claimId}
                          </p>
                          {item.artifactRef ? (
                            <p className="mt-1 break-all font-mono text-xs text-tertiary">{item.artifactRef.uri}</p>
                          ) : null}
                        </div>
                        <SemanticBadge>{item.id}</SemanticBadge>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <CockpitEmptyState
                  title="No trusted receipts admitted"
                  description="The control plane has not accepted a verifier receipt for this task. Local test results are not projected as proof."
                />
              )}
            </DataSection>
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
