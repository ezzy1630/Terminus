import { useCallback, useState } from "react";
import { arpV2 } from "../../lib/api-v2";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../../hooks/use-logical-mutation";
import type { CounterfactualExperimentSnapshot, CounterfactualVariationType } from "../../types/v2";
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
import { Select } from "../../ui/Select";
import { Button } from "../../ui/Button";

const VARIATION_TYPES: Array<{ value: CounterfactualVariationType; label: string; field: string }> = [
  { value: "profile", label: "Model profile", field: "profileId" },
  { value: "prompt", label: "Prompt change", field: "prompt" },
  { value: "retrieval", label: "Retrieval change", field: "retrieval" },
  { value: "intervention", label: "Intervention", field: "intervention" },
];

function CausalReplayForTask({ taskId }: { taskId: string }): JSX.Element {
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [variationType, setVariationType] = useState<CounterfactualVariationType>("profile");
  const [variationValue, setVariationValue] = useState("");
  const [experiment, setExperiment] = useState<CounterfactualExperimentSnapshot | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [experimentRunning, setExperimentRunning] = useState(false);
  const counterfactualMutation = useLogicalMutation(`counterfactual.${taskId}`);
  const load = useCallback((signal: AbortSignal) => arpV2.getCausalTrace(taskId, signal), [taskId]);
  const resource = useCockpitResource(load, `task:${taskId}`);
  const trace = resource.data;
  const selectedStep = trace?.steps.find((step) => step.stepIndex === selectedStepIndex) ?? trace?.steps[0] ?? null;
  const variationField = VARIATION_TYPES.find((type) => type.value === variationType)?.field ?? "value";

  const runCounterfactualExperiment = async (): Promise<void> => {
    if (!variationValue.trim()) return;
    setExperimentRunning(true);
    setExperimentError(null);
    setExperiment(null);
    const variation = variationValue.trim();
    let operationKey: string | null = null;
    try {
      operationKey = counterfactualMutation.keyFor(JSON.stringify({ taskId, variationType, variationField, variation }));
      const result = await arpV2.runCounterfactual({
        sourceTaskId: taskId,
        variationType,
        variationDetails: { [variationField]: variation },
      }, { idempotencyKey: operationKey });
      counterfactualMutation.settle(operationKey);
      setExperiment(result);
    } catch (error: unknown) {
      if (operationKey && isDefinitiveMutationFailure(error)) counterfactualMutation.abandon(operationKey);
      setExperimentError(error instanceof Error ? error.message : String(error));
    } finally {
      setExperimentRunning(false);
    }
  };

  return (
    <CockpitPage
      title="Replay"
      description="Recorded steps, diagnostics, and counterfactual experiments."
      selectedTaskId={taskId}
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="causal trace" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : (resource.status === "ready" || resource.status === "stale") && trace === null ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          <CockpitEmptyState
            title="No causal trace"
            description="The control plane has not recorded a causal replay trace for this task."
          />
        </>
      ) : trace ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          <div className="mx-auto max-w-[760px]">
            <section className="border-b border-subtle px-1 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="ui-code text-primary">{trace.id}</p>
                  <p className="ui-code mt-0.5 truncate text-tertiary">
                    Pinned inputs {trace.pinnedInputsHash}
                  </p>
                </div>
                <SemanticBadge>{trace.attemptId}</SemanticBadge>
              </div>
            </section>

            {trace.steps.length === 0 ? (
              <CockpitEmptyState
                title="No causal steps recorded"
                description="The trace exists, but the control plane returned no recorded causal steps for this task."
              />
            ) : (
              <>
                <DataSection title="Step lineage" detail={`${trace.steps.length} steps`}>
                  <div className="flex divide-x divide-subtle overflow-x-auto border-y border-subtle" role="group" aria-label="Causal steps">
                    {trace.steps.map((step) => (
                      <Button
                        key={step.stepIndex}
                        type="button"
                        onClick={() => setSelectedStepIndex(step.stepIndex)}
                        aria-pressed={selectedStep?.stepIndex === step.stepIndex}
                        className={`h-10 min-w-36 justify-start rounded-none px-2.5 text-left ${selectedStep?.stepIndex === step.stepIndex ? "bg-selected" : "hover:bg-hover"}`}
                      >
                        <span className="min-w-0">
                          <span className="ui-code block text-tertiary">Step {step.stepIndex}, {step.durationMs}ms</span>
                          <span className="ui-label block truncate text-primary">{step.component}</span>
                        </span>
                      </Button>
                    ))}
                  </div>
                </DataSection>

                {selectedStep ? (
                  <DataSection title="Selected step">
                    <dl className="divide-y divide-subtle border-y border-subtle">
                      <div className="grid min-h-8 grid-cols-[120px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Input manifest</dt><dd className="ui-code selectable break-all text-primary">{selectedStep.inputManifestHash}</dd></div>
                      <div className="grid min-h-8 grid-cols-[120px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Model output</dt><dd className="ui-code selectable break-all text-primary">{selectedStep.modelOutputHash ?? "Not recorded"}</dd></div>
                      <div className="grid min-h-8 grid-cols-[120px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Effect</dt><dd className="ui-code text-primary">{selectedStep.effectId ?? "Not recorded"}</dd></div>
                      <div className="grid min-h-8 grid-cols-[120px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Verifier result</dt><dd className="ui-code text-primary">{selectedStep.verifierResult ?? "Not recorded"}</dd></div>
                    </dl>
                  </DataSection>
                ) : null}
              </>
            )}

            <DataSection title="Omission diagnostics" detail={`${trace.omissionDiagnostics.length} records`}>
              {trace.omissionDiagnostics.length > 0 ? (
                <div className="divide-y divide-subtle border-y border-subtle">
                  {trace.omissionDiagnostics.map((diagnostic) => (
                    <details key={diagnostic.blockId} className="px-2 py-2 open:bg-subtle/35">
                      <summary className="cursor-pointer">
                        <span className="ml-1 inline-flex w-[calc(100%-16px)] items-center justify-between gap-3 align-middle">
                          <span className="min-w-0 truncate font-mono text-sm text-primary">{diagnostic.sourcePath}</span>
                          <SemanticBadge tone={diagnostic.causalRelevanceScore >= 0.75 ? "warning" : "neutral"}>
                            {(diagnostic.causalRelevanceScore * 100).toFixed(0)}% relevance
                          </SemanticBadge>
                        </span>
                      </summary>
                      <div className="mt-2 border-t border-subtle px-1 pt-2">
                        <p className="text-xs text-secondary">{diagnostic.omittedReason}</p>
                        <p className="mt-2 text-xs text-tertiary">Evaluator <span className="font-mono text-secondary">{diagnostic.evaluatorId}</span></p>
                        <ul className="mt-1 space-y-0.5" aria-label="Diagnostic evidence references">
                          {diagnostic.evidenceRefs.map((reference) => (
                            <li key={reference} className="break-all font-mono text-xs text-tertiary">{reference}</li>
                          ))}
                        </ul>
                      </div>
                    </details>
                  ))}
                </div>
              ) : <p className="text-sm text-tertiary">No omission diagnostics were returned for this trace.</p>}
            </DataSection>

            <DataSection title="Counterfactual evaluation">
              <div className="border-y border-subtle px-1 py-3">
                <p className="mb-2 text-xs text-tertiary">
                  Experiments may use model compute. Results are hypotheses, not completion evidence.
                </p>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px_minmax(0,1fr)_auto]">
                  <div>
                    <label htmlFor="counterfactual-type" className="block text-xs font-medium text-secondary">Variation type</label>
                    <Select
                      id="counterfactual-type"
                      label="Variation type"
                      value={variationType}
                      onValueChange={(value) => setVariationType(value as CounterfactualVariationType)}
                      className="mt-1 w-full"
                      options={VARIATION_TYPES}
                    />
                  </div>
                  <div>
                    <label htmlFor="counterfactual-value" className="block text-xs font-medium text-secondary">Variation detail</label>
                    <input
                      id="counterfactual-value"
                      value={variationValue}
                      onChange={(event) => setVariationValue(event.target.value)}
                      className="ui-input mt-1 h-7 w-full rounded-md border border-default bg-canvas px-2.5 text-sm text-primary placeholder:text-tertiary"
                      placeholder={`Enter ${variationField}`}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={() => void runCounterfactualExperiment()}
                    disabled={!variationValue.trim() || experimentRunning}
                    aria-busy={experimentRunning || undefined}
                    className="mt-5 whitespace-nowrap"
                  >
                    {experimentRunning ? "Evaluating…" : "Evaluate experiment"}
                  </Button>
                </div>
                {experimentError ? <p role="alert" className="mt-3 text-xs" style={{ color: "var(--color-error)" }}>{experimentError}</p> : null}
                {experiment ? (
                  <div className="mt-4 border-t border-subtle pt-3" role="status">
                    <p className="font-mono text-xs text-tertiary">Experiment {experiment.id}</p>
                    <p className="mt-1 font-mono text-xs text-tertiary">Source task {experiment.sourceTaskId}</p>
                    <p className="mt-1 text-xs text-secondary">Evaluator status: {experiment.executionStatus}</p>
                    <p className="mt-2 text-sm text-primary">Counterfactual hypothesis: {experiment.predictedOutcome}</p>
                    <p className="mt-1 text-sm text-secondary">Evaluator-reported comparison: {experiment.actualOutcome ?? "Not recorded"}</p>
                    <p className="mt-2 text-xs text-warning">Hypothesis only. Do not treat this result as completion evidence.</p>
                  </div>
                ) : null}
              </div>
            </DataSection>
          </div>
        </>
      ) : null}
    </CockpitPage>
  );
}

export function CausalReplayView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  if (!selectedTaskId) {
    return (
      <CockpitPage title="Replay" description="Recorded steps and experiments for one durable task.">
        <TaskRequiredState feature="Task replay" />
      </CockpitPage>
    );
  }
  return <CausalReplayForTask key={selectedTaskId} taskId={selectedTaskId} />;
}
