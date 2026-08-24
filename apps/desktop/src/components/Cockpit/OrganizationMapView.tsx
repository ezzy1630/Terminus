import { useCallback, useState } from "react";
import { Button } from "../../ui/Button";
import { arpV2 } from "../../lib/api-v2";
import type {
  CapabilityDirectoryEntrySnapshot,
  DepartmentSnapshot,
  OperatorAgentSnapshot,
  OrganizationSnapshot,
} from "../../types/v2";
import {
  CockpitEmptyState,
  CockpitErrorState,
  CockpitLoadingState,
  CockpitPage,
  DataSection,
  SemanticBadge,
  StaleDataBanner,
  useCockpitResource,
  type SemanticTone,
} from "./CockpitPrimitives";

interface OrganizationTopology {
  organizations: OrganizationSnapshot[];
  departments: DepartmentSnapshot[];
  operators: OperatorAgentSnapshot[];
  capabilities: CapabilityDirectoryEntrySnapshot[];
}

function capabilityTone(status: CapabilityDirectoryEntrySnapshot["status"]): SemanticTone {
  if (status === "AVAILABLE") return "success";
  if (status === "RESTRICTED") return "warning";
  return "error";
}

export function OrganizationMapView(): JSX.Element {
  const [requestedDepartmentId, setRequestedDepartmentId] = useState<string | null>(null);
  const load = useCallback(async (signal: AbortSignal): Promise<OrganizationTopology> => {
    const [organizations, departments, operators, capabilities] = await Promise.all([
      arpV2.listOrganizations(signal),
      arpV2.listDepartments(undefined, signal),
      arpV2.listOperators(undefined, signal),
      arpV2.listCapabilityDirectory(signal),
    ]);
    return { organizations, departments, operators, capabilities };
  }, []);
  const resource = useCockpitResource(load);
  const data = resource.data;
  const selectedDepartmentId = data?.departments.some((department) => department.id === requestedDepartmentId)
    ? requestedDepartmentId
    : data?.departments[0]?.id ?? null;
  const selectedDepartment = data?.departments.find((department) => department.id === selectedDepartmentId) ?? null;
  const operators = data?.operators.filter((operator) => operator.departmentId === selectedDepartmentId) ?? [];

  return (
    <CockpitPage
      title="Organization map"
      description="Organizations, departments, operator assignments, and capability routing returned by ARP v2."
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="organization topology" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : data ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          {data.organizations.length === 0 && data.departments.length === 0 && data.capabilities.length === 0 ? (
            <CockpitEmptyState
              title="No organization topology"
              description="The control plane returned empty organization, department, and capability collections."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[200px_minmax(0,1fr)]">
              <DataSection title="Departments" detail={`${data.departments.length} returned`}>
                <div className="divide-y divide-subtle border-y border-subtle">
                  {data.departments.map((department) => (
                    <Button
                      key={department.id}
                      type="button"
                      onClick={() => setRequestedDepartmentId(department.id)}
                      aria-pressed={department.id === selectedDepartmentId}
                      className={`h-9 w-full justify-start rounded-none px-2 text-left hover:bg-hover ${department.id === selectedDepartmentId ? "bg-selected" : ""}`}
                    >
                      <span className="ui-label block truncate text-primary">{department.displayName}</span>
                      <span className="ui-code block truncate text-tertiary">
                        {department.id}
                      </span>
                    </Button>
                  ))}
                  {data.departments.length === 0 ? <p className="py-3 text-sm text-tertiary">No departments returned.</p> : null}
                </div>
              </DataSection>

              <div>
              <DataSection title="Operators" detail={selectedDepartment?.displayName ?? "No department"}>
                <div className="divide-y divide-subtle border-y border-subtle">
                  {operators.map((operator) => (
                    <article key={operator.id} className="px-2 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="ui-label truncate text-primary">{operator.displayName}</h3>
                          <p className="ui-code mt-0.5 truncate text-tertiary">
                            {operator.modelProfile}
                          </p>
                        </div>
                        <SemanticBadge tone={operator.active ? "success" : "neutral"}>
                          {operator.active ? "Active" : "Inactive"}
                        </SemanticBadge>
                      </div>
                      {operator.capabilityScope.length > 0 ? (
                        <p className="ui-meta mt-1.5 text-secondary">
                          {operator.capabilityScope.join(", ")}
                        </p>
                      ) : null}
                    </article>
                  ))}
                  {operators.length === 0 ? <p className="py-3 text-sm text-tertiary">No operators returned for this department.</p> : null}
                </div>
              </DataSection>

              <DataSection title="Capability directory" detail={`${data.capabilities.length} entries`}>
                <div className="divide-y divide-subtle border-y border-subtle">
                  {data.capabilities.map((capability) => (
                    <article key={capability.id} className="px-2 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="ui-code truncate text-primary">{capability.capabilityId}</h3>
                          <p className="ui-meta mt-0.5 text-secondary">
                            {capability.category} in {capability.resourceDomain}
                          </p>
                        </div>
                        <SemanticBadge tone={capabilityTone(capability.status)}>{capability.status}</SemanticBadge>
                      </div>
                    </article>
                  ))}
                  {data.capabilities.length === 0 ? <p className="py-3 text-sm text-tertiary">No capability entries returned.</p> : null}
                </div>
              </DataSection>
              </div>
            </div>
          )}
        </>
      ) : null}
    </CockpitPage>
  );
}
