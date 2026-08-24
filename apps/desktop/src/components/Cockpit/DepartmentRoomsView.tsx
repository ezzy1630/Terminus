import { useCallback, type ReactNode } from "react";
import { arpV2 } from "../../lib/api-v2";
import {
  CockpitEmptyState,
  CockpitErrorState,
  CockpitLoadingState,
  CockpitPage,
  DataSection,
  SemanticBadge,
  StaleDataBanner,
  useCockpitResource,
} from "./CockpitPrimitives";

function AssignmentList({ label, values, empty }: { label: string; values: string[]; empty: string }): JSX.Element {
  return (
    <div>
      <h3 className="text-secondary text-xs" style={{ fontWeight: 600 }}>{label}</h3>
      {values.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {values.map((value) => <SemanticBadge key={value}>{value}</SemanticBadge>)}
        </div>
      ) : (
        <p className="mt-2 text-tertiary text-xs" >{empty}</p>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-tertiary text-xs" >{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-secondary text-xs" >{children}</dd>
    </div>
  );
}

export function DepartmentRoomsView(): JSX.Element {
  const load = useCallback((signal: AbortSignal) => arpV2.listAgentRooms(undefined, signal), []);
  const resource = useCockpitResource(load);

  return (
    <CockpitPage
      title="Agent rooms"
      description="Worker, specialist, reviewer, supervisor, and operator assignments reported by the organization directory."
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="agent rooms" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : resource.data ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          {resource.data.length === 0 ? (
            <CockpitEmptyState
              title="No agent rooms"
              description="The control plane returned an empty agent-room collection."
            />
          ) : (
            <DataSection title="Rooms" detail={`${resource.data.length} returned`}>
              <div className="mx-auto max-w-[720px] divide-y divide-subtle border-y border-subtle">
                {resource.data.map((room) => (
                  <details key={room.id} className="px-2 py-2.5 open:bg-subtle/35">
                    <summary className="cursor-pointer">
                    <span className="inline-flex w-[calc(100%-12px)] items-start justify-between gap-3 align-middle">
                      <div className="min-w-0">
                        <h2 className="ui-label truncate text-primary">{room.name}</h2>
                        <p className="ui-code mt-0.5 truncate text-tertiary">{room.id}</p>
                      </div>
                      <SemanticBadge tone={room.activeWorkerIds.length > 0 ? "info" : "neutral"}>
                        {room.activeWorkerIds.length} workers
                      </SemanticBadge>
                    </span>
                    </summary>

                    <dl className="mt-2 grid grid-cols-2 gap-3 border-t border-subtle pt-2">
                      <Fact label="Department">{room.departmentId}</Fact>
                      <Fact label="Operator">{room.operatorId}</Fact>
                      <Fact label="Supervisor">{room.supervisorId ?? "None assigned"}</Fact>
                      <Fact label="Created">{room.createdAt}</Fact>
                    </dl>

                    <div className="mt-2 grid grid-cols-1 gap-3 border-t border-subtle pt-2 sm:grid-cols-3">
                      <AssignmentList label="Workers" values={room.activeWorkerIds} empty="No workers assigned." />
                      <AssignmentList label="Specialists" values={room.specialistIds} empty="No specialists assigned." />
                      <AssignmentList label="Reviewers" values={room.reviewerIds} empty="No reviewers assigned." />
                    </div>
                  </details>
                ))}
              </div>
            </DataSection>
          )}
        </>
      ) : null}
    </CockpitPage>
  );
}
