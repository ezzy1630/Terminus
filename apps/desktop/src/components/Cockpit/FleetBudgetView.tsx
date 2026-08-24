import { useCallback } from "react";
import { arpV2 } from "../../lib/api-v2";
import type { TaskBudgetSnapshot, TaskV2Snapshot } from "../../types/v2";
import {
  CockpitErrorState,
  CockpitLoadingState,
  CockpitPage,
  DataSection,
  StaleDataBanner,
  TaskRequiredState,
  useCockpitResource,
} from "./CockpitPrimitives";

interface BudgetData {
  budget: TaskBudgetSnapshot;
  task: TaskV2Snapshot | null;
}

function formatInteger(value: string): string {
  return BigInt(value).toLocaleString();
}

function BudgetMetric({ label, value, unit }: { label: string; value: string; unit?: string }): JSX.Element {
  return (
    <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-1">
      <dt className="ui-meta">{label}</dt>
      <dd className="font-mono text-sm font-medium tabular-nums text-primary">
        {value}{unit ? <span className="ml-1 text-xs font-normal text-secondary">{unit}</span> : null}
      </dd>
    </div>
  );
}

function FleetBudgetForTask({ taskId }: { taskId: string }): JSX.Element {
  const load = useCallback(async (signal: AbortSignal): Promise<BudgetData> => {
    const [budget, task] = await Promise.all([
      arpV2.getTaskBudget(taskId, signal),
      arpV2.getTask(taskId, signal),
    ]);
    return { budget, task };
  }, [taskId]);
  const resource = useCockpitResource(load, `task:${taskId}`);
  const data = resource.data;

  return (
    <CockpitPage
      title="Usage"
      description="Task cost, token, compute, and approval counters."
      selectedTaskId={taskId}
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="task budget" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : data ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          <div className="mx-auto max-w-[720px]">
            <DataSection title="Consumed resources" detail={`Updated ${new Date(data.budget.lastUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}>
              <dl className="grid grid-cols-1 divide-y divide-subtle border-y border-subtle sm:grid-cols-2 sm:divide-y-0 sm:[&>*]:border-b sm:[&>*]:border-subtle sm:[&>*:nth-child(odd)]:pr-4 sm:[&>*:nth-child(even)]:border-l sm:[&>*:nth-child(even)]:pl-4">
                <BudgetMetric label="Cost" value={formatInteger(data.budget.consumedCostMicros)} unit="microdollars" />
                <BudgetMetric label="Input tokens" value={formatInteger(data.budget.consumedInputTokens)} />
                <BudgetMetric label="Output tokens" value={formatInteger(data.budget.consumedOutputTokens)} />
                <BudgetMetric label="Compute" value={data.budget.consumedComputeSeconds.toLocaleString()} unit="seconds" />
                <BudgetMetric label="Approvals" value={data.budget.consumedApprovals.toLocaleString()} />
              </dl>
            </DataSection>

            <DataSection title="Contract limit">
              {data.task ? (
                <div className="flex min-h-10 items-center justify-between border-y border-subtle px-1">
                  <p className="ui-meta">Cost cap</p>
                  <p className="font-mono text-sm text-primary">{formatInteger(data.task.contract.constraints.costMicros)} microdollars</p>
                </div>
              ) : (
                <p className="ui-body text-tertiary">No contract limit is available for this task.</p>
              )}
            </DataSection>

          </div>
        </>
      ) : null}
    </CockpitPage>
  );
}

export function FleetBudgetView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  if (!selectedTaskId) {
    return (
      <CockpitPage title="Usage" description="Consumption counters for one durable task.">
        <TaskRequiredState feature="Task usage" />
      </CockpitPage>
    );
  }
  return <FleetBudgetForTask taskId={selectedTaskId} />;
}
