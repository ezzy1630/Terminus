import {
  CockpitPage,
  FeatureUnavailableState,
  TaskRequiredState,
} from "./CockpitPrimitives";

export function WorkflowGraphView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  return (
    <CockpitPage
      title="Workflow graph"
      description="Workflow nodes, guarded edges, ownership, and execution state for the selected task."
      selectedTaskId={selectedTaskId}
    >
      {selectedTaskId ? (
        <FeatureUnavailableState
          feature="Task workflow graph"
          detail="ARP v2 can read a workflow by workflow ID, but it does not expose a task-to-workflow lookup. The desktop will not render guessed nodes or execution states."
        />
      ) : (
        <TaskRequiredState feature="The workflow graph" />
      )}
    </CockpitPage>
  );
}
