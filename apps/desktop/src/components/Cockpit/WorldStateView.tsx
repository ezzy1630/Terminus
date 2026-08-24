import {
  CockpitPage,
  FeatureUnavailableState,
  TaskRequiredState,
} from "./CockpitPrimitives";

export function WorldStateView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  return (
    <CockpitPage
      title="World state"
      description="Resource handles, environment identity, locks, and contradiction observations for the selected task."
      selectedTaskId={selectedTaskId}
    >
      {selectedTaskId ? (
        <FeatureUnavailableState
          feature="World state"
          detail="The control plane does not expose a task-scoped world-state read endpoint. No environment hash, lock state, resource handle, or contradiction count can be confirmed here."
        />
      ) : (
        <TaskRequiredState feature="World state" />
      )}
    </CockpitPage>
  );
}
