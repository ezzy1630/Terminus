import { useCallback, useState } from "react";
import { arpV2 } from "../../lib/api-v2";
import type { EffectState } from "../../types/v2";
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

function effectTone(state: EffectState): SemanticTone {
  if (state === "COMMITTED" || state === "COMPENSATED") return "success";
  if (["DENIED", "CANCELLED", "RESIDUE", "MANUAL_RECONCILE"].includes(state)) return "error";
  if (["AUTHORIZATION_REQUIRED", "UNCERTAIN", "RECONCILING", "COMPENSATING"].includes(state)) return "warning";
  if (["AUTHORIZED", "PREPARED", "DISPATCHED", "OBSERVED", "VALIDATED"].includes(state)) return "info";
  return "neutral";
}

const MAX_PARAMETER_PRESENTATION_CHARS = 16_000;
const MAX_PARAMETER_PRESENTATION_NODES = 500;
const MAX_PARAMETER_PRESENTATION_DEPTH = 16;

function hasCanonicalParameters(parameters: Record<string, unknown>): boolean {
  for (const key in parameters) {
    if (Object.prototype.hasOwnProperty.call(parameters, key)) return true;
  }
  return false;
}

function boundedParameterPresentation(parameters: Record<string, unknown>): string {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: parameters, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let characterEstimate = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_PARAMETER_PRESENTATION_NODES || current.depth > MAX_PARAMETER_PRESENTATION_DEPTH) {
      return `[Canonical parameters rejected from the presentation: the structure exceeds ${MAX_PARAMETER_PRESENTATION_NODES} nodes or ${MAX_PARAMETER_PRESENTATION_DEPTH} levels. Inspect the immutable effect artifact.]`;
    }
    const { value } = current;
    if (typeof value === "string") characterEstimate += value.length;
    else if (typeof value === "number" || typeof value === "boolean" || value === null) characterEstimate += String(value).length;
    else if (value && typeof value === "object") {
      if (seen.has(value)) return "[Canonical parameters rejected from the presentation: cyclic structure.]";
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (nodes + stack.length >= MAX_PARAMETER_PRESENTATION_NODES) {
            return `[Canonical parameters rejected from the presentation: the structure exceeds ${MAX_PARAMETER_PRESENTATION_NODES} nodes. Inspect the immutable effect artifact.]`;
          }
          stack.push({ value: item, depth: current.depth + 1 });
        }
      } else {
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (nodes + stack.length >= MAX_PARAMETER_PRESENTATION_NODES) {
            return `[Canonical parameters rejected from the presentation: the structure exceeds ${MAX_PARAMETER_PRESENTATION_NODES} nodes. Inspect the immutable effect artifact.]`;
          }
          characterEstimate += key.length;
          stack.push({ value: (value as Record<string, unknown>)[key], depth: current.depth + 1 });
        }
      }
    }
    if (characterEstimate > MAX_PARAMETER_PRESENTATION_CHARS) {
      return `[Canonical parameters rejected from the presentation: content exceeds the ${MAX_PARAMETER_PRESENTATION_CHARS}-character limit. Inspect the immutable effect artifact.]`;
    }
  }
  const text = JSON.stringify(parameters, null, 2);
  return text.length <= MAX_PARAMETER_PRESENTATION_CHARS
    ? text
    : `[Canonical parameters rejected from the presentation: formatted content exceeds the ${MAX_PARAMETER_PRESENTATION_CHARS}-character limit. Inspect the immutable effect artifact.]`;
}

function CanonicalParameters({ parameters }: { parameters: Record<string, unknown> }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="mt-3" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium text-secondary">Canonical parameters</summary>
      {expanded ? (
        <pre className="selectable mt-2 max-h-72 overflow-auto border-l border-subtle bg-terminal px-2.5 py-2 font-mono text-xs leading-5 text-primary">
          {boundedParameterPresentation(parameters)}
        </pre>
      ) : null}
    </details>
  );
}

function EffectQueueForTask({ taskId }: { taskId: string }): JSX.Element {
  const load = useCallback((signal: AbortSignal) => arpV2.listEffects(taskId, signal), [taskId]);
  const resource = useCockpitResource(load, `task:${taskId}`);

  return (
    <CockpitPage
      title="Activity"
      description="Server-reported task effects and outcomes."
      selectedTaskId={taskId}
      snapshot={resource}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="transactional effects" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : resource.data ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
          {resource.data.length === 0 ? (
            <CockpitEmptyState
              title="No effects recorded"
              description="The control plane returned no transactional effects for this task."
            />
          ) : (
            <DataSection title="Effects" detail={`${resource.data.length} recorded`}>
              <div className="mx-auto max-w-[720px] divide-y divide-subtle border-y border-subtle">
                {resource.data.map((effect) => (
                  <details key={effect.id} className="group open:bg-subtle/35">
                    <summary className="cursor-pointer px-1 py-2">
                      <span className="inline-flex w-[calc(100%-12px)] items-center justify-between gap-3 align-middle">
                        <span className="ui-code min-w-0 truncate text-primary">{effect.intentType}</span>
                        <span className="flex flex-shrink-0 items-center gap-2">
                        <SemanticBadge>{effect.effectClass}</SemanticBadge>
                        <SemanticBadge tone={effectTone(effect.state)}>{effect.state}</SemanticBadge>
                        </span>
                      </span>
                    </summary>
                    <div className="border-t border-subtle px-2 pb-3 pt-2">
                      <p className="ui-code truncate text-tertiary">{effect.id}, version {effect.version}</p>
                      <dl className="mt-2 divide-y divide-subtle">
                        <div className="grid min-h-7 grid-cols-[132px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Connector or worker</dt><dd className="ui-code truncate text-secondary">{effect.connectorOrWorker}</dd></div>
                        <div className="grid min-h-7 grid-cols-[132px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Idempotency key</dt><dd className="ui-code truncate text-secondary">{effect.semanticIdempotencyKey}</dd></div>
                        <div className="grid min-h-7 grid-cols-[132px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Authorization</dt><dd className="ui-code truncate text-secondary">{effect.authorizationId ?? "Not issued"}</dd></div>
                        <div className="grid min-h-7 grid-cols-[132px_minmax(0,1fr)] items-center gap-3"><dt className="ui-meta">Policy decision</dt><dd className="ui-code truncate text-secondary">{effect.policyDecisionId ?? "Not recorded"}</dd></div>
                      </dl>
                      {effect.uncertaintyReason ? (
                        <p className="mt-2 border-l-2 border-warning px-2 py-1 text-xs text-warning">
                          Uncertainty: {effect.uncertaintyReason}
                        </p>
                      ) : null}
                      {hasCanonicalParameters(effect.canonicalParameters)
                        ? <CanonicalParameters parameters={effect.canonicalParameters} />
                        : null}
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

export function EffectQueueView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  if (!selectedTaskId) {
    return (
      <CockpitPage title="Activity" description="Recorded effects for one durable task.">
        <TaskRequiredState feature="Task activity" />
      </CockpitPage>
    );
  }
  return <EffectQueueForTask taskId={selectedTaskId} />;
}
