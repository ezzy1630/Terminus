import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { ArtifactSummary, TaskArtifactsPage } from "../../types";
import { DiffViewer, parseUnifiedDiff } from "../DiffViewer";
import { Button } from "../../ui/Button";
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

const ARTIFACT_PREVIEW_BYTES = 256 * 1024;

function isDiffArtifact(artifact: ArtifactSummary): boolean {
  return artifact.media_type === "text/x-diff"
    || artifact.media_type === "text/vnd.diff"
    || /patch|diff/i.test(artifact.purpose);
}

function ArtifactPreview({ artifact, taskId }: { artifact: ArtifactSummary; taskId: string }): JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) => api.getArtifactText(artifact.hash, taskId, ARTIFACT_PREVIEW_BYTES, signal),
    [artifact.hash, taskId],
  );
  const resource = useCockpitResource(load, `artifact:${artifact.hash}`);
  const parsedDiff = useMemo(() => {
    if (!resource.data || resource.data.truncated || !isDiffArtifact(artifact)) return { files: [], error: null as string | null };
    try {
      return { files: parseUnifiedDiff(resource.data.text), error: null as string | null };
    } catch (error: unknown) {
      return { files: [], error: error instanceof Error ? error.message : "The diff could not be parsed." };
    }
  }, [artifact, resource.data]);

  if (resource.status === "loading") return <CockpitLoadingState label="artifact content" />;
  if (resource.status === "error" && resource.error) return <CockpitErrorState error={resource.error} retry={resource.retry} />;
  if (!resource.data) return <CockpitEmptyState title="Empty artifact" description="The artifact response contained no preview data." />;

  return (
    <div className="space-y-3">
      {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={resource.retry} /> : null}
      {resource.data.truncated ? (
        <p role="note" className="border-l-2 border-warning px-2 py-1 text-xs text-warning">
          Preview stopped at {ARTIFACT_PREVIEW_BYTES.toLocaleString()} bytes. Full artifact: {artifact.hash}
        </p>
      ) : null}
      {resource.data.truncated ? (
        <pre className="selectable max-h-[520px] overflow-auto whitespace-pre-wrap break-all bg-terminal p-3 font-mono text-xs leading-5 text-primary">{resource.data.text}</pre>
      ) : parsedDiff.error ? (
        <p role="alert" className="border-l-2 border-error px-2 py-1 text-xs text-error">
          Diff parse failed: {parsedDiff.error}
        </p>
      ) : isDiffArtifact(artifact) && parsedDiff.files.length > 0 ? (
        <div className="h-[520px] overflow-hidden border border-subtle">
          <DiffViewer files={parsedDiff.files} />
        </div>
      ) : resource.data.text.length > 0 ? (
        <pre className="selectable max-h-[520px] overflow-auto bg-terminal p-3 font-mono text-xs leading-5 text-primary">{resource.data.text}</pre>
      ) : (
        <CockpitEmptyState title="Empty artifact" description="The artifact body was empty." />
      )}
    </div>
  );
}

function ArtifactInventoryForTask({ taskId }: { taskId: string }): JSX.Element {
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [additionalPages, setAdditionalPages] = useState<Array<{
    taskId: string;
    cursor: string;
    page: TaskArtifactsPage;
  }>>([]);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const paginationGeneration = useRef(0);
  const paginationAbort = useRef<AbortController | null>(null);
  const load = useCallback((signal: AbortSignal) => api.listTaskArtifacts(taskId, null, signal), [taskId]);
  const resource = useCockpitResource(load, `task:${taskId}`);
  const firstPage = resource.data?.task_id === taskId ? resource.data : null;

  const invalidatePagination = useCallback((): void => {
    paginationGeneration.current += 1;
    paginationAbort.current?.abort();
    paginationAbort.current = null;
    setAdditionalPages([]);
    setSelectedHash(null);
    setPaginationError(null);
    setLoadingMore(false);
  }, []);

  const refreshInventory = useCallback((): void => {
    invalidatePagination();
    resource.retry();
  }, [invalidatePagination, resource.retry]);

  // A task switch or refreshed first page invalidates every continuation page.
  // Abort the old request so a late response cannot repopulate another scope.
  useEffect(() => {
    invalidatePagination();
  }, [firstPage, invalidatePagination, taskId]);

  const pagesForTask = additionalPages.filter((entry) => entry.taskId === taskId);
  const pages = firstPage
    ? [firstPage, ...pagesForTask.map((entry) => entry.page)]
    : [];
  const artifacts = [...new Map(pages.flatMap((page) => page.artifacts).map((artifact) => [artifact.hash, artifact])).values()];
  const nextCursor = pagesForTask.at(-1)?.page.next_cursor ?? firstPage?.next_cursor ?? null;
  const selectedArtifact = artifacts.find((artifact) => artifact.hash === selectedHash) ?? null;

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMore || resource.refreshing) return;
    const requestedCursor = nextCursor;
    const generation = paginationGeneration.current;
    const controller = new AbortController();
    paginationAbort.current = controller;
    setLoadingMore(true);
    setPaginationError(null);
    try {
      const page = await api.listTaskArtifacts(taskId, requestedCursor, controller.signal);
      if (controller.signal.aborted || generation !== paginationGeneration.current || page.task_id !== taskId) return;
      setAdditionalPages((current) => {
        if (current.some((entry) => entry.taskId === taskId && entry.cursor === requestedCursor)) return current;
        return [...current, { taskId, cursor: requestedCursor, page }];
      });
    } catch (error: unknown) {
      if (!controller.signal.aborted && generation === paginationGeneration.current) {
        setPaginationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === paginationGeneration.current && paginationAbort.current === controller) {
        paginationAbort.current = null;
        setLoadingMore(false);
      }
    }
  };

  return (
    <CockpitPage
      title="Changes"
      description="Task files, artifacts, and bounded diff previews."
      selectedTaskId={taskId}
      snapshot={{ ...resource, retry: refreshInventory }}
    >
      {resource.status === "loading" ? (
        <CockpitLoadingState label="artifact inventory" />
      ) : resource.status === "error" && resource.error ? (
        <CockpitErrorState error={resource.error} retry={resource.retry} />
      ) : firstPage ? (
        <>
          {resource.status === "stale" && resource.error ? <StaleDataBanner error={resource.error} retry={refreshInventory} /> : null}
          {firstPage.total === 0 ? (
            <CockpitEmptyState title="No artifacts" description="The control plane returned no artifacts for this task." />
          ) : (
            <div className="grid grid-cols-1 gap-2 xl:grid-cols-[200px_minmax(0,1fr)]">
              <DataSection title="Files" detail={`${artifacts.length} of ${firstPage.total}`}>
                <div className="divide-y divide-subtle border-y border-subtle">
                  {artifacts.map((artifact) => (
                    <Button
                      key={artifact.hash}
                      type="button"
                      onClick={() => setSelectedHash(artifact.hash)}
                      aria-pressed={selectedHash === artifact.hash}
                      className={`h-9 w-full justify-start rounded-none px-2 text-left ${selectedHash === artifact.hash ? "bg-selected" : "hover:bg-hover"}`}
                    >
                      <span className="min-w-0">
                        <span className="ui-label block truncate text-primary">{artifact.purpose}</span>
                        <span className="ui-code block truncate text-tertiary">
                          {artifact.media_type}, {artifact.size_bytes === null ? "size unknown" : `${artifact.size_bytes.toLocaleString()} bytes`}
                        </span>
                      </span>
                    </Button>
                  ))}
                  {nextCursor ? (
                    <Button
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={loadingMore || resource.refreshing}
                      variant="secondary"
                      size="md"
                      className="mt-2 w-full text-xs"
                    >
                      {loadingMore ? "Loading more" : resource.refreshing ? "Refreshing inventory" : "Load more artifacts"}
                    </Button>
                  ) : null}
                  {paginationError ? <p role="alert" className="text-xs" style={{ color: "var(--color-error)" }}>{paginationError}</p> : null}
                  {nextCursor ? (
                    <details className="px-1 text-xs text-tertiary">
                      <summary className="cursor-pointer">Continuation details</summary>
                      <p className="selectable mt-1 break-all font-mono">{nextCursor}</p>
                    </details>
                  ) : null}
                </div>
              </DataSection>

              <DataSection title="Preview" detail={selectedArtifact ? selectedArtifact.hash : "Select a file"}>
                {selectedArtifact ? (
                  <>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <SemanticBadge>{selectedArtifact.media_type}</SemanticBadge>
                      <SemanticBadge>{selectedArtifact.purpose}</SemanticBadge>
                    </div>
                    <ArtifactPreview key={selectedArtifact.hash} artifact={selectedArtifact} taskId={taskId} />
                  </>
                ) : (
                  <CockpitEmptyState title="Choose an artifact" description="Choose an artifact from the inventory to fetch a bounded preview." />
                )}
              </DataSection>
            </div>
          )}
        </>
      ) : null}
    </CockpitPage>
  );
}

export function ArtifactDiffInspectorView({ selectedTaskId }: { selectedTaskId?: string | null }): JSX.Element {
  if (!selectedTaskId) {
    return (
      <CockpitPage title="Changes" description="Task files and bounded previews.">
        <TaskRequiredState feature="Task changes" />
      </CockpitPage>
    );
  }
  return <ArtifactInventoryForTask key={selectedTaskId} taskId={selectedTaskId} />;
}
