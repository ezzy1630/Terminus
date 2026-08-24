import { RefreshCw, Search, WifiOff } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { TerminusApiError } from "../lib/api";
import { arpV2 } from "../lib/api-v2";
import { cn } from "../lib/cn";
import type {
  AgentRoomSnapshot,
  DepartmentSnapshot,
  OperatorAgentSnapshot,
  OrganizationSnapshot,
} from "../types/v2";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Tabs, type TabItem } from "../ui/Tabs";
import {
  useCockpitResource,
  type CockpitSnapshotAdapter,
} from "./Cockpit/CockpitPrimitives";

interface AgentsDirectoryData {
  organizations: OrganizationSnapshot[];
  departments: DepartmentSnapshot[];
  operators: OperatorAgentSnapshot[];
  rooms: AgentRoomSnapshot[];
}

type AgentDetailTab = "overview" | "rooms" | "capabilities";

const CACHE_KEY = "terminus-desktop.agents-directory.v1";
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const CACHE_MAX_BYTES = 256 * 1_024;
const CACHE_MAX_ITEMS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOrganization(value: unknown): value is OrganizationSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.displayName === "string"
    && typeof value.rootPolicyProfile === "string"
    && typeof value.createdAt === "string";
}

function isDepartment(value: unknown): value is DepartmentSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.organizationId === "string"
    && typeof value.displayName === "string"
    && typeof value.policyProfile === "string"
    && (value.defaultOperatorId === null || typeof value.defaultOperatorId === "string")
    && typeof value.createdAt === "string";
}

function isOperator(value: unknown): value is OperatorAgentSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.departmentId === "string"
    && typeof value.displayName === "string"
    && isStringArray(value.capabilityScope)
    && typeof value.modelProfile === "string"
    && typeof value.active === "boolean";
}

function isRoom(value: unknown): value is AgentRoomSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.departmentId === "string"
    && typeof value.name === "string"
    && typeof value.operatorId === "string"
    && isStringArray(value.activeWorkerIds)
    && isStringArray(value.specialistIds)
    && isStringArray(value.reviewerIds)
    && (value.supervisorId === null || typeof value.supervisorId === "string")
    && typeof value.createdAt === "string";
}

function boundedArray<T>(value: unknown, guard: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.length <= CACHE_MAX_ITEMS && value.every(guard);
}

function readAgentsSnapshot(): { data: AgentsDirectoryData; loadedAt: string } | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(CACHE_KEY);
  if (!raw || raw.length > CACHE_MAX_BYTES) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || typeof parsed.loadedAt !== "string" || !isRecord(parsed.data)) return null;
  const loadedAtMs = Date.parse(parsed.loadedAt);
  if (!Number.isFinite(loadedAtMs) || loadedAtMs > Date.now() + 5 * 60 * 1_000 || Date.now() - loadedAtMs > CACHE_MAX_AGE_MS) return null;
  const data = parsed.data;
  if (!boundedArray(data.organizations, isOrganization)
    || !boundedArray(data.departments, isDepartment)
    || !boundedArray(data.operators, isOperator)
    || !boundedArray(data.rooms, isRoom)) return null;
  return {
    loadedAt: parsed.loadedAt,
    data: {
      organizations: data.organizations,
      departments: data.departments,
      operators: data.operators,
      rooms: data.rooms,
    },
  };
}

function writeAgentsSnapshot(snapshot: { data: AgentsDirectoryData; loadedAt: string }): void {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify({ version: CACHE_VERSION, ...snapshot });
  if (raw.length <= CACHE_MAX_BYTES) window.localStorage.setItem(CACHE_KEY, raw);
}

const agentsSnapshotAdapter: CockpitSnapshotAdapter<AgentsDirectoryData> = {
  read: readAgentsSnapshot,
  write: writeAgentsSnapshot,
};

const EMPTY_DIRECTORY: AgentsDirectoryData = {
  organizations: [],
  departments: [],
  operators: [],
  rooms: [],
};

function refreshFailureCopy(error: Error): string {
  if (error instanceof TerminusApiError && error.status === 0) {
    return "Offline. Agent data will refresh when the local service reconnects.";
  }
  return "Agent data could not be refreshed.";
}

export function AgentsView(): JSX.Element {
  const load = useCallback(async (signal: AbortSignal): Promise<AgentsDirectoryData> => {
    const [organizations, departments, operators, rooms] = await Promise.all([
      arpV2.listOrganizations(signal),
      arpV2.listDepartments(undefined, signal),
      arpV2.listOperators(undefined, signal),
      arpV2.listAgentRooms(undefined, signal),
    ]);
    return { organizations, departments, operators, rooms };
  }, []);
  const resource = useCockpitResource(load, "agents-directory", agentsSnapshotAdapter);
  const data = resource.data ?? EMPTY_DIRECTORY;
  const [query, setQuery] = useState("");
  const [requestedOperatorId, setRequestedOperatorId] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentDetailTab>("overview");

  const normalizedQuery = query.trim().toLowerCase();
  const operators = useMemo(() => data.operators
    .filter((operator) => normalizedQuery.length === 0
      || operator.displayName.toLowerCase().includes(normalizedQuery)
      || operator.modelProfile.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => Number(right.active) - Number(left.active) || left.displayName.localeCompare(right.displayName)),
  [data.operators, normalizedQuery]);
  const selectedOperatorId = operators.some((operator) => operator.id === requestedOperatorId)
    ? requestedOperatorId
    : operators[0]?.id ?? null;
  const selectedOperator = operators.find((operator) => operator.id === selectedOperatorId) ?? null;
  const selectedDepartment = selectedOperator
    ? data.departments.find((department) => department.id === selectedOperator.departmentId) ?? null
    : null;
  const selectedOrganization = selectedDepartment
    ? data.organizations.find((organization) => organization.id === selectedDepartment.organizationId) ?? null
    : null;
  const selectedRooms = selectedOperator
    ? data.rooms.filter((room) => room.operatorId === selectedOperator.id || room.departmentId === selectedOperator.departmentId)
    : [];
  const showNotice = resource.status === "error" || resource.status === "stale";
  const detailTabs: readonly TabItem[] = selectedOperator ? [
    {
      value: "overview",
      label: "Overview",
      content: (
        <div className="mx-auto h-full max-w-[660px] overflow-y-auto px-4 py-3">
          <dl className="divide-y divide-subtle border-y border-subtle">
            <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Status</dt><dd className="ui-body text-primary">{selectedOperator.active ? "Available" : "Offline"}</dd></div>
            <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Model</dt><dd className="ui-body truncate text-primary">{selectedOperator.modelProfile}</dd></div>
            <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Department</dt><dd className="ui-body truncate text-primary">{selectedDepartment?.displayName ?? "Not reported"}</dd></div>
            <div className="grid min-h-8 grid-cols-[112px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Organization</dt><dd className="ui-body truncate text-primary">{selectedOrganization?.displayName ?? "Not reported"}</dd></div>
          </dl>
        </div>
      ),
    },
    {
      value: "rooms",
      label: "Rooms",
      content: (
        <div className="mx-auto grid h-full max-w-[660px] content-start divide-y divide-subtle overflow-y-auto px-4 py-3">
          {selectedRooms.length > 0 ? selectedRooms.map((room) => (
            <div key={room.id} className="ui-list-row flex items-center gap-3 px-1 hover:bg-hover">
              <span className="ui-body min-w-0 flex-1 truncate text-primary">{room.name}</span>
              <span className="ui-meta">{room.activeWorkerIds.length} active</span>
            </div>
          )) : <p className="py-3 text-xs text-tertiary">No rooms are assigned to this agent.</p>}
        </div>
      ),
    },
    {
      value: "capabilities",
      label: "Capabilities",
      content: (
        <div className="mx-auto grid h-full max-w-[660px] content-start divide-y divide-subtle overflow-y-auto px-4 py-3">
          {selectedOperator.capabilityScope.length > 0 ? selectedOperator.capabilityScope.map((capability) => (
            <div key={capability} className="ui-list-row ui-code flex items-center px-1 text-primary hover:bg-hover">{capability}</div>
          )) : <p className="py-3 text-xs text-tertiary">No capabilities are reported for this agent.</p>}
        </div>
      ),
    },
  ] : [];

  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden bg-canvas text-primary" aria-labelledby="agents-title">
      <header className="ui-view-header">
        <h1 id="agents-title" className="ui-page-title">Agents</h1>
        <label className="relative ml-auto w-44">
          <Search size={13} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary" />
          <span className="sr-only">Search agents</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents"
            className="ui-input h-7 w-full rounded-md border border-subtle bg-card pl-8 pr-2 ui-meta text-primary placeholder:text-tertiary"
          />
        </label>
        <IconButton
          label="Refresh agents"
          icon={<RefreshCw size={13} aria-hidden />}
          onClick={resource.retry}
          disabled={resource.refreshing}
          aria-busy={resource.refreshing || undefined}
          size="md"
          className="rounded-md border-subtle text-tertiary hover:bg-hover hover:text-primary disabled:opacity-50"
        />
      </header>

      {showNotice && resource.error ? (
        <div role="status" className="ui-meta flex h-8 flex-none items-center gap-2 border-b border-subtle px-3 text-secondary">
          <WifiOff size={13} className="text-warning" aria-hidden />
          <span className="truncate">{resource.data ? "Offline. Showing saved agent data." : refreshFailureCopy(resource.error)}</span>
          <Button type="button" onClick={resource.retry} className="ml-auto text-xs text-accent hover:underline">Retry</Button>
        </div>
      ) : null}

      {resource.status === "loading" && resource.data === null ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6" role="status" aria-label="Loading agents">
          <span className="text-xs text-tertiary">Loading agents…</span>
        </div>
      ) : data.operators.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          <div className="max-w-xs">
            <h2 className="text-sm font-medium text-primary">
              {resource.status === "error" ? "Agents unavailable" : "No agents yet"}
            </h2>
            <p className="mt-1 text-xs leading-5 text-tertiary">
              {resource.status === "error"
                ? "Reconnect to load the agent directory."
                : "Agents will appear here when they join this workspace."}
            </p>
          </div>
        </div>
      ) : (
      <div className="flex min-h-0 flex-1">
        <aside className="w-[216px] flex-none overflow-y-auto border-r border-subtle px-2 py-2" aria-label="Agent directory">
          {operators.length > 0 ? (
            <div className="grid gap-1">
              {operators.map((operator) => {
                const department = data.departments.find((entry) => entry.id === operator.departmentId);
                return (
                  <Button
                    key={operator.id}
                    type="button"
                    onClick={() => setRequestedOperatorId(operator.id)}
                    aria-pressed={selectedOperatorId === operator.id}
                    className={cn("flex h-9 w-full items-center justify-start gap-2 rounded-md px-2 text-left", selectedOperatorId === operator.id ? "bg-selected" : "hover:bg-hover")}
                  >
                    <span className={cn("h-1.5 w-1.5 flex-none rounded-full", operator.active && "bg-success")} style={operator.active ? undefined : { background: "var(--text-tertiary)" }} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="ui-label block truncate text-primary">{operator.displayName}</span>
                      <span className="ui-meta block truncate">{department?.displayName ?? operator.modelProfile}</span>
                    </span>
                  </Button>
                );
              })}
            </div>
          ) : (
            <div className="px-2 py-3 text-xs leading-5 text-tertiary">
              {query ? "No agents match this search." : "No agents are registered."}
            </div>
          )}
        </aside>

        <div className="min-w-0 flex-1 overflow-hidden">
          {selectedOperator ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="mx-auto w-full max-w-[660px] px-4 pt-4">
                <div className="flex items-start gap-3">
                  <span className={cn("mt-2 h-2 w-2 flex-none rounded-full", selectedOperator.active && "bg-success")} style={selectedOperator.active ? undefined : { background: "var(--text-tertiary)" }} aria-hidden />
                  <div className="min-w-0">
                    <h2 className="ui-section-title truncate text-primary">{selectedOperator.displayName}</h2>
                    <p className="ui-meta mt-0.5 truncate text-secondary">
                      {[selectedDepartment?.displayName, selectedOperator.modelProfile].filter(Boolean).join(", ")}
                    </p>
                  </div>
                </div>
              </div>
              <Tabs
                value={tab}
                onValueChange={(value) => {
                  if (value === "overview" || value === "rooms" || value === "capabilities") setTab(value);
                }}
                items={detailTabs}
                label="Agent details"
                className="mt-2"
              />
            </div>
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center overflow-y-auto px-6 py-5 text-center">
              <div className="max-w-xs">
                <h2 className="text-sm font-medium text-primary">No agent selected</h2>
                <p className="mt-1 text-xs leading-5 text-tertiary">
                  {query ? "Clear the search to choose an agent." : "Choose an agent from the directory."}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </section>
  );
}

export default AgentsView;
