import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, FileDiff, PanelRightClose, Send } from "lucide-react";
import { cn } from "../lib/cn";
import { DiffViewer, parseUnifiedDiff, type DiffCommentAnchor, type DiffFile } from "./DiffViewer";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "./ErrorState";
import { extractUnifiedDiffs } from "../lib/task-surface";
import { api, TerminusApiError } from "../lib/api";
import type { ArtifactSummary, TaskArtifactsPage, TerminusSseEvent } from "../types";
import type { DiffComment } from "./DiffViewer";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Status";
import { Button } from "../ui/Button";

/** Hard byte cap for inline artifact previews (bounded output). */
const ARTIFACT_PREVIEW_BYTES = 256 * 1024;

function isDiffArtifact(artifact: ArtifactSummary): boolean {
  return (
    artifact.media_type === "text/x-diff"
    || artifact.media_type === "text/vnd.diff"
    || /patch|diff/i.test(artifact.purpose)
  );
}

interface OpenArtifact {
  artifact: ArtifactSummary;
  loading: boolean;
  text: string | null;
  truncated: boolean;
  /** Populated when the artifact parses as a unified diff. */
  files: DiffFile[];
  parseError: string | null;
}

interface ArtifactInventoryState {
  taskId: string | null;
  page: TaskArtifactsPage | null;
  error: string | null;
  refreshing: boolean;
}

interface ReviewNote extends DiffComment {
  sourceId: string;
  sourceLabel: string;
}

/**
 * Patches carried by one event, parsed once and cached on the event itself.
 *
 * The transcript tail is append-only and the store never mutates a frame once
 * it has been appended, so an event's diffs can be derived exactly once. This
 * used to run `extractUnifiedDiffs([event])` — a fresh one-element array per
 * event — and `parseUnifiedDiff` over the entire tail on every render, which
 * meant re-parsing every patch in the conversation on every streamed flush.
 *
 * A WeakMap keeps the cache exactly as alive as the events: when the store's
 * LRU drops an old tail, the parsed diffs go with it.
 */
const EVENT_DIFF_CACHE = new WeakMap<TerminusSseEvent, readonly DiffFile[][]>();

function diffsForEvent(event: TerminusSseEvent): readonly DiffFile[][] {
  const cached = EVENT_DIFF_CACHE.get(event);
  if (cached !== undefined) return cached;
  const parsed = extractUnifiedDiffs([event]).map((diff) => parseUnifiedDiff(diff));
  EVENT_DIFF_CACHE.set(event, parsed);
  return parsed;
}

interface EventDiffSource {
  id: string;
  label: string;
  files: DiffFile[];
}

/** Server messages rarely end in punctuation; ours run into the next sentence. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The one source that is ground truth rather than a report of it. */
const WORKSPACE_SOURCE_ID = "workspace-diff";

interface WorkspaceDiffState {
  taskId: string | null;
  files: DiffFile[];
  gitAvailable: boolean;
  truncated: boolean;
  error: string | null;
  loading: boolean;
}

const NO_WORKSPACE_DIFF: WorkspaceDiffState = {
  taskId: null,
  files: [],
  gitAvailable: true,
  truncated: false,
  error: null,
  loading: false,
};

/**
 * Event-derived review notes are bound to the authoritative stream event id.
 * The patch body is deliberately not fingerprinted: short presentation hashes
 * can collide and reopen feedback against unrelated evidence.
 */
export function eventDiffSourceId(
  event: TerminusSseEvent,
  eventIndex: number,
  diffIndex: number,
): string {
  const sourceEventId = event.id
    ? `${event.event}:${event.id}`
    : `missing-event-id:${eventIndex}:${event.event}:${event.data.length}`;
  return `event-diff:${sourceEventId}:${diffIndex}`;
}

const REVIEW_NOTES_PREFIX = "terminus-desktop.review-notes.v2.";
const MAX_PERSISTED_REVIEW_NOTES = 200;
const MAX_PERSISTED_REVIEW_NOTE_BYTES = 128 * 1024;
const MAX_SESSION_REVIEW_NOTES = 250;
const MAX_SESSION_REVIEW_NOTE_BYTES = 256 * 1024;
const REVIEW_NOTES_WRITE_DELAY_MS = 150;
const reviewNoteEncoder = new TextEncoder();
let reviewNoteFallbackSequence = 0;

function reviewNotesStorageKey(taskId: string): string {
  return `${REVIEW_NOTES_PREFIX}${taskId}`;
}

function createReviewNoteId(sourceId: string, filePath: string, lineNo: number): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `review-note:${randomId}`;
  reviewNoteFallbackSequence += 1;
  return `${sourceId}:${filePath}:${lineNo}:${Date.now()}:${reviewNoteFallbackSequence}`;
}

interface ReviewNotesLoad {
  notes: ReviewNote[];
  status: "ready" | "session_only" | "recovery_needed";
  error: string | null;
}

interface ReviewNotesState extends ReviewNotesLoad {
  taskId: string | null;
}

function reviewNotesCollectionError(
  notes: ReviewNote[],
  maxCount: number,
  maxBytes: number,
): string | null {
  if (notes.length > maxCount) return `Review notes are limited to ${maxCount} per task.`;
  if (reviewNoteEncoder.encode(JSON.stringify(notes)).byteLength > maxBytes) {
    return `Review notes exceed the ${Math.floor(maxBytes / 1024)} KiB per-task storage limit.`;
  }
  return null;
}

function readReviewNotes(taskId: string | null | undefined): ReviewNotesLoad {
  if (!taskId) return { notes: [], status: "ready", error: null };
  try {
    const storage = window.localStorage;
    if (!storage) throw new Error("Local storage is unavailable.");
    const raw = storage.getItem(reviewNotesStorageKey(taskId));
    if (raw === null) return { notes: [], status: "ready", error: null };
    if (reviewNoteEncoder.encode(raw).byteLength > MAX_PERSISTED_REVIEW_NOTE_BYTES) {
      return {
        notes: [],
        status: "recovery_needed",
        error: "Stored review notes exceed the supported limit. The original storage entry was preserved.",
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Stored review notes are not a collection.");
    const notes = parsed.flatMap((value): ReviewNote[] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.sourceId !== "string" ||
        typeof record.sourceLabel !== "string" ||
        typeof record.filePath !== "string" ||
        typeof record.lineNo !== "number" ||
        !Number.isInteger(record.lineNo) ||
        (record.anchor !== "old" && record.anchor !== "new") ||
        typeof record.body !== "string" ||
        typeof record.at !== "string"
      ) return [];
      return [{
        id: record.id,
        sourceId: record.sourceId,
        sourceLabel: record.sourceLabel,
        filePath: record.filePath,
        lineNo: record.lineNo,
        anchor: record.anchor,
        body: record.body,
        at: record.at,
      }];
    });
    if (notes.length !== parsed.length || reviewNotesCollectionError(
      notes,
      MAX_PERSISTED_REVIEW_NOTES,
      MAX_PERSISTED_REVIEW_NOTE_BYTES,
    )) {
      return {
        notes: [],
        status: "recovery_needed",
        error: "Stored review notes are invalid. The original storage entry was preserved.",
      };
    }
    return { notes, status: "ready", error: null };
  } catch (error) {
    return {
      notes: [],
      status: "recovery_needed",
      error: error instanceof Error
        ? `Stored review notes could not be read: ${error.message}`
        : "Stored review notes could not be read.",
    };
  }
}

function writeReviewNotes(taskId: string, notes: ReviewNote[]): string | null {
  const validationError = reviewNotesCollectionError(
    notes,
    MAX_PERSISTED_REVIEW_NOTES,
    MAX_PERSISTED_REVIEW_NOTE_BYTES,
  );
  if (validationError) return `${validationError} Newer notes remain available only in this window.`;
  try {
    const storage = window.localStorage;
    if (!storage) throw new Error("Local storage is unavailable.");
    storage.setItem(reviewNotesStorageKey(taskId), JSON.stringify(notes));
    return null;
  } catch (error) {
    return error instanceof Error
      ? `Review notes remain available only in this window: ${error.message}`
      : "Review notes remain available only in this window because local storage failed.";
  }
}

interface ReviewPaneProps {
  events: TerminusSseEvent[];
  /** True when the retained event tail is incomplete and cannot prove a patch. */
  eventHistoryIncomplete?: boolean;
  /** Selected task id — enables the real artifact inventory from the CAS. */
  taskId?: string | null;
  onClose: () => void;
  onDraftRevision: (instruction: string) => void;
}

/**
 * Changes review surface grounded in three real evidence sources:
 *
 *   0. The workspace itself (GET /v1/tasks/:id/diff), which the kernel
 *      produces by running git in the task's workspace. This is what the
 *      agent actually changed, so it leads and is selected by default.
 *   1. Unified diffs attached to patch tool events by the runtime — what the
 *      agent reported changing, and only while those events are retained.
 *   2. The task's artifact inventory (GET /v1/tasks/:id/artifacts), served
 *      from the kernel's content-addressed store. Diff-typed artifacts are
 *      fetched and parsed through the same viewer; other artifacts open as
 *      byte-capped previews.
 *
 * Previews never truncate silently: when the byte cap hits, the pane states
 * it and references the full artifact hash.
 */
function ReviewPaneImpl({
  events,
  eventHistoryIncomplete = false,
  taskId,
  onClose,
  onDraftRevision,
}: ReviewPaneProps): JSX.Element {
  const initialNotesTaskId = taskId ?? null;
  const [reviewNotesState, setReviewNotesState] = useState<ReviewNotesState>(() => ({
    taskId: initialNotesTaskId,
    ...readReviewNotes(initialNotesTaskId),
  }));
  const reviewNotesWriteTimerRef = useRef<number | null>(null);
  const latestReviewNotesStateRef = useRef(reviewNotesState);
  latestReviewNotesStateRef.current = reviewNotesState;
  const comments = reviewNotesState.taskId === (taskId ?? null) ? reviewNotesState.notes : [];
  const [artifactInventory, setArtifactInventory] = useState<ArtifactInventoryState>({
    taskId: null,
    page: null,
    error: null,
    refreshing: false,
  });
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [openArtifact, setOpenArtifact] = useState<OpenArtifact | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedEventSourceId, setSelectedEventSourceId] = useState<string | null>(null);
  const [workspaceDiff, setWorkspaceDiff] = useState<WorkspaceDiffState>(NO_WORKSPACE_DIFF);
  const [browsingArtifacts, setBrowsingArtifacts] = useState(false);
  const [inventoryRequestVersion, setInventoryRequestVersion] = useState(0);
  const [previewRequestVersion, setPreviewRequestVersion] = useState(0);
  const [revisionQueued, setRevisionQueued] = useState(false);
  const [reviewedSourceIds, setReviewedSourceIds] = useState<Set<string>>(() => new Set());
  const loadMoreInFlightRef = useRef(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  // Real patch evidence embedded in patch tool events.
  const eventSources = useMemo<EventDiffSource[]>(() => {
    const sources: EventDiffSource[] = [];
    events.forEach((event, index) => {
      // `diffIndex` still counts over every extracted patch, including the
      // ones that parse to nothing, so source ids stay stable across renders.
      diffsForEvent(event).forEach((files, diffIndex) => {
        if (files.length === 0) return;
        sources.push({
          id: eventDiffSourceId(event, index, diffIndex),
          label: event.id
            ? `event ${event.id} · patch ${diffIndex + 1}`
            : `unidentified event ${index + 1} · patch ${diffIndex + 1}`,
          files,
        });
      });
    });
    return sources;
  }, [events]);
  const visibleEventSources = eventHistoryIncomplete ? [] : eventSources;

  // The workspace as it stands. Unlike event patches this does not expire with
  // the event window, and it reflects edits the agent made without announcing
  // them in a patch tool call.
  useEffect(() => {
    if (!taskId) {
      setWorkspaceDiff(NO_WORKSPACE_DIFF);
      return;
    }
    const controller = new AbortController();
    setWorkspaceDiff({ ...NO_WORKSPACE_DIFF, taskId, loading: true });
    void api.getTaskDiff(taskId, controller.signal).then((diff) => {
      if (controller.signal.aborted) return;
      setWorkspaceDiff({
        taskId,
        files: diff.diff.trim().length > 0 ? parseUnifiedDiff(diff.diff) : [],
        gitAvailable: diff.git_available,
        truncated: diff.diff_truncated,
        error: null,
        loading: false,
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      // Event patches and artifacts remain; this source simply drops out.
      setWorkspaceDiff({
        ...NO_WORKSPACE_DIFF,
        taskId,
        error: error instanceof TerminusApiError || error instanceof Error
          ? error.message
          : "The workspace diff could not be read.",
      });
    });
    return () => controller.abort();
  }, [taskId]);

  const workspaceSource = useMemo<EventDiffSource | null>(() => {
    if (workspaceDiff.taskId !== (taskId ?? null) || workspaceDiff.files.length === 0) return null;
    const count = workspaceDiff.files.length;
    return {
      id: WORKSPACE_SOURCE_ID,
      label: `Working tree · ${count} ${count === 1 ? "file" : "files"}`,
      files: workspaceDiff.files,
    };
  }, [taskId, workspaceDiff]);

  const visibleSources = useMemo<EventDiffSource[]>(
    () => workspaceSource === null ? visibleEventSources : [workspaceSource, ...visibleEventSources],
    [visibleEventSources, workspaceSource],
  );
  // The workspace leads when nothing is explicitly selected; otherwise the
  // most recent event patch, as before.
  const activeEventSource = visibleSources.find((source) => source.id === selectedEventSourceId)
    ?? workspaceSource
    ?? visibleEventSources[visibleEventSources.length - 1]
    ?? null;
  const eventFileCount = visibleSources.reduce((total, source) => total + source.files.length, 0);

  useEffect(() => {
    setSelectedHash(null);
    setOpenArtifact(null);
    setPreviewError(null);
    setSelectedEventSourceId(null);
    setBrowsingArtifacts(false);
    setLoadingMore(false);
    setReviewedSourceIds(new Set());
    loadMoreInFlightRef.current = false;
  }, [taskId]);

  useEffect(() => {
    const nextTaskId = taskId ?? null;
    if (reviewNotesState.taskId === nextTaskId) return;
    if (reviewNotesWriteTimerRef.current !== null) {
      window.clearTimeout(reviewNotesWriteTimerRef.current);
      reviewNotesWriteTimerRef.current = null;
    }
    const previous = latestReviewNotesStateRef.current;
    if (previous.taskId && previous.status !== "recovery_needed") writeReviewNotes(previous.taskId, previous.notes);
    setReviewNotesState({ taskId: nextTaskId, ...readReviewNotes(nextTaskId) });
  }, [reviewNotesState.taskId, taskId]);

  useEffect(() => {
    if (!reviewNotesState.taskId || reviewNotesState.status === "recovery_needed") return;
    if (reviewNotesWriteTimerRef.current !== null) window.clearTimeout(reviewNotesWriteTimerRef.current);
    reviewNotesWriteTimerRef.current = window.setTimeout(() => {
      reviewNotesWriteTimerRef.current = null;
      const writeError = writeReviewNotes(reviewNotesState.taskId!, reviewNotesState.notes);
      setReviewNotesState((current) => current.taskId === reviewNotesState.taskId
        && current.notes === reviewNotesState.notes
        ? { ...current, status: writeError ? "session_only" : "ready", error: writeError }
        : current);
    }, REVIEW_NOTES_WRITE_DELAY_MS);
    return () => {
      if (reviewNotesWriteTimerRef.current !== null) {
        window.clearTimeout(reviewNotesWriteTimerRef.current);
        reviewNotesWriteTimerRef.current = null;
      }
    };
  }, [reviewNotesState.notes, reviewNotesState.status, reviewNotesState.taskId]);

  useEffect(() => () => {
    if (reviewNotesWriteTimerRef.current !== null) window.clearTimeout(reviewNotesWriteTimerRef.current);
    const latest = latestReviewNotesStateRef.current;
    if (latest.taskId && latest.status !== "recovery_needed") writeReviewNotes(latest.taskId, latest.notes);
  }, []);

  // Artifact inventory from the control plane (kernel CAS).
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setArtifactInventory((current) => current.taskId === taskId
      ? { ...current, error: null, refreshing: true }
      : { taskId, page: null, error: null, refreshing: true });
    api.listTaskArtifacts(taskId)
      .then((page) => {
        if (!cancelled) {
          setArtifactInventory({ taskId, page, error: null, refreshing: false });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setArtifactInventory({
            taskId,
            page: null,
            error: err instanceof Error ? err.message : "Failed to load artifacts",
            refreshing: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inventoryRequestVersion, taskId]);

  const inventoryIsCurrent = artifactInventory.taskId === taskId;
  const artifactPage = inventoryIsCurrent ? artifactInventory.page : null;
  const artifactsError = inventoryIsCurrent ? artifactInventory.error : null;
  const artifactsLoading = Boolean(taskId) && (!inventoryIsCurrent || artifactInventory.refreshing);
  const retryInventory = useCallback((): void => {
    setInventoryRequestVersion((version) => version + 1);
  }, []);

  // Fetch + decode the selected artifact whenever a new one is opened.
  useEffect(() => {
    if (!taskId || !selectedHash) return;
    const artifact = artifactPage?.artifacts.find((a) => a.hash === selectedHash);
    if (!artifact) return;
    let cancelled = false;
    api.getArtifactText(artifact.hash, taskId, ARTIFACT_PREVIEW_BYTES)
      .then((result) => {
        if (cancelled) return;
        let files: DiffFile[] = [];
        let parseError: string | null = null;
        if (isDiffArtifact(artifact)) {
          if (!result.truncated) {
            files = parseUnifiedDiff(result.text);
            if (files.length === 0) {
              parseError = result.text.trim().length === 0
                ? "The diff artifact is empty."
                : "The artifact does not contain a recognizable unified diff.";
            }
          }
        }
        setPreviewError(null);
        setOpenArtifact({
          artifact,
          loading: false,
          text: result.text,
          truncated: result.truncated,
          files,
          parseError,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreviewError(err instanceof Error ? err.message : "Artifact preview is temporarily unavailable.");
        setOpenArtifact((current) => current?.artifact.hash === selectedHash
          ? { ...current, loading: false }
          : current);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactPage, previewRequestVersion, selectedHash, taskId]);

  const retryPreview = useCallback((): void => {
    if (!selectedHash) return;
    setPreviewError(null);
    setOpenArtifact((current) => current ? { ...current, loading: true } : current);
    setPreviewRequestVersion((version) => version + 1);
  }, [selectedHash]);

  const closeOpenArtifact = useCallback((): void => {
    setSelectedHash(null);
    setOpenArtifact(null);
    setPreviewError(null);
  }, []);

  const openArtifactPreview = useCallback((artifact: ArtifactSummary): void => {
    setBrowsingArtifacts(true);
    setOpenArtifact({ artifact, loading: true, text: null, truncated: false, files: [], parseError: null });
    setPreviewError(null);
    setSelectedHash(artifact.hash);
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!taskId || !artifactPage?.next_cursor || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    try {
      const next = await api.listTaskArtifacts(taskId, artifactPage.next_cursor);
      setArtifactInventory((current) => current.taskId === taskId && current.page
        ? (() => {
            const artifactsByHash = new Map(current.page.artifacts.map((artifact) => [artifact.hash, artifact]));
            for (const artifact of next.artifacts) artifactsByHash.set(artifact.hash, artifact);
            return {
              taskId,
              error: null,
              page: {
                task_id: next.task_id,
                total: next.total,
                artifacts: [...artifactsByHash.values()],
                next_cursor: next.next_cursor,
              },
              refreshing: false,
            };
          })()
        : { taskId, page: next, error: null, refreshing: false });
    } catch (err: unknown) {
      setArtifactInventory((current) => current.taskId === taskId
        ? { ...current, error: err instanceof Error ? err.message : "Failed to load more artifacts" }
        : current);
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [artifactPage, taskId]);

  const workspaceIssue = workspaceDiff.taskId !== (taskId ?? null) || workspaceDiff.loading
    ? null
    : workspaceDiff.error !== null
      ? `The working tree could not be read: ${sentence(workspaceDiff.error)} Patch evidence below comes from tool events.`
      : !workspaceDiff.gitAvailable
        ? "This workspace is not a git repository, so there is no working-tree diff to show. Patch evidence below comes from tool events."
        : workspaceDiff.truncated
          ? "The working-tree diff is too large to show in full and was cut short. Open the workspace to see everything that changed."
          : null;

  const selectedIsDiff = openArtifact ? isDiffArtifact(openArtifact.artifact) : false;
  // Evidence means a diff. A list of content-addressed blobs is an index of
  // what the kernel stored, not a review surface — this pane opened straight
  // onto that list whenever the working tree read came back empty, so a task
  // that had really edited files showed a column of sha256 hashes.
  const hasEvidence = activeEventSource !== null;

  // A selected immutable artifact is one evidence source. Never append
  // event-derived files under its hash: that would misattribute unrelated
  // presentation history to the artifact.
  const viewerFiles: DiffFile[] = openArtifact && selectedIsDiff
    ? openArtifact.files
    : browsingArtifacts
      ? []
      : activeEventSource?.files ?? [];
  /*
   * Changed-line totals for the header.
   *
   * The control plane sends no diff stats — `GET /v1/tasks/:id/diff` returns
   * raw text — so they are counted off the parsed hunks the viewer is already
   * holding. "12 changed files" answered a question nobody asks first.
   */
  const viewerStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of viewerFiles) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === "add") additions += 1;
          else if (line.kind === "del") deletions += 1;
        }
      }
    }
    return { additions, deletions, files: viewerFiles.length };
  }, [viewerFiles]);

  const activeSource = openArtifact && selectedIsDiff
    ? {
        id: `artifact:${openArtifact.artifact.hash}`,
        label: `immutable artifact ${openArtifact.artifact.hash}`,
      }
    : !browsingArtifacts && activeEventSource
      ? {
        id: activeEventSource?.id ?? "event-diff:no-event-evidence",
        label: activeEventSource?.label ?? "event diff snapshot unavailable",
      }
      : {
          id: "review:no-active-evidence",
          label: "no active review evidence",
        };
  const visibleComments = comments.filter((comment) => comment.sourceId === activeSource.id);
  const reviewedLocally = reviewedSourceIds.has(activeSource.id);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-diff" aria-label="Changes review">
      {/* Title, bounded change totals, and close. Unsupported editor, restore,
          apply, and authoritative review controls stay absent. */}
      <header className="ui-view-header">
        {openArtifact ? (
          <Button
            variant="bare"
            onClick={closeOpenArtifact}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary"
            aria-label="Back to changes overview"
            data-tooltip="Back to changes overview"
          >
            <ArrowLeft size={14} />
          </Button>
        ) : null}
        <span className="ui-body min-w-0 truncate font-semibold text-primary">
          {openArtifact ? `${openArtifact.artifact.hash.replace(/^sha256:/, "").slice(0, 16)}…` : "Changes"}
        </span>
        {openArtifact ? (
          <span className="ml-auto flex-shrink-0 font-mono text-tertiary text-xs">
            {openArtifact.artifact.purpose}
          </span>
        ) : viewerStats.files > 0 ? (
          <span className="flex-shrink-0 text-xs tabular-nums text-tertiary">
            <span>{viewerStats.files} {viewerStats.files === 1 ? "file" : "files"}</span>
            <span aria-hidden> · </span>
            <span className="text-addition">+{viewerStats.additions.toLocaleString()}</span>
            {" "}
            <span className="text-deletion">&minus;{viewerStats.deletions.toLocaleString()}</span>
          </span>
        ) : (
          <span className="flex-shrink-0 text-tertiary text-xs">
            {hasEvidence
              ? `${eventFileCount} changed ${eventFileCount === 1 ? "file" : "files"}`
              : workspaceDiff.loading
                ? "reading the working tree"
                : "no changes yet"}
          </span>
        )}
        <Button
          variant="bare"
          onClick={onClose}
          className={cn(
            "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary",
            openArtifact ? "ml-2" : "ml-auto",
          )}
          aria-label="Close changes"
          data-tooltip="Close changes"
        >
          <PanelRightClose size={15} />
        </Button>
      </header>
      {eventHistoryIncomplete ? (
        <p className="border-b border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning" role="status">
          Event-derived patch evidence is hidden because the live history has a retention gap. Immutable task artifacts remain available below.
        </p>
      ) : null}
      {/* Why the working tree is absent or partial. Silence here would read as
          "the agent changed nothing", which is a different claim entirely. */}
      {workspaceIssue ? (
        <p className="border-b border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning" role="status">
          {workspaceIssue}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {openArtifact?.truncated ? (
          <p
            role="note"
            className="border-b border-warning/40 bg-warning/5 px-3 py-2 font-mono text-warning text-xs"

            data-tooltip={`Full artifact: ${openArtifact.artifact.hash}`}
          >
            Partial preview: stopped at {ARTIFACT_PREVIEW_BYTES.toLocaleString()} bytes. Structured diff review is disabled; the full immutable artifact is {openArtifact.artifact.hash}.
          </p>
        ) : null}
        {previewError ? (
          <ErrorState
            severity="warning"
            title="Artifact preview unavailable"
            description={previewError}
            action={{ label: "Retry preview", onClick: retryPreview }}
            compact
            className="m-3 rounded-md border border-subtle bg-elevated"
          />
        ) : !openArtifact && browsingArtifacts && artifactsError && !artifactPage ? (
          <ErrorState
            severity="warning"
            title="Artifact inventory unavailable"
            description={artifactsError}
            action={{ label: "Retry inventory", onClick: retryInventory }}
            compact
            className="m-3 rounded-md border border-subtle bg-elevated"
          />
        ) : !openArtifact && browsingArtifacts && artifactsLoading ? (
          <div className="grid gap-2 px-4 py-6" role="status" aria-label="Loading task artifacts">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !openArtifact && !browsingArtifacts && workspaceDiff.loading ? (
          <div className="grid gap-2 px-4 py-6" role="status" aria-label="Reading the working tree">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !openArtifact && !browsingArtifacts && !hasEvidence ? (
          <EmptyState
            icon={<FileDiff size={17} />}
            title={!taskId
              ? "No reviewable changes yet"
              : workspaceDiff.error !== null
                ? "The working tree could not be read"
                : !workspaceDiff.gitAvailable
                  ? "No working-tree diff available"
                  : "No changes in the working tree"}
            description={!taskId
              ? "Patch evidence will appear here as the agent updates the workspace."
              : workspaceDiff.error !== null
                ? sentence(workspaceDiff.error)
                : !workspaceDiff.gitAvailable
                  ? "Terminus can only diff a git workspace. Patch evidence from tool events appears here when the agent reports it."
                  : "Nothing has been modified yet. Edits appear here as the agent makes them."}
            {...(taskId ? { action: { label: "Browse artifacts", onClick: () => setBrowsingArtifacts(true) } } : {})}
            compact
          />
        ) : openArtifact && !selectedIsDiff && !openArtifact.loading ? (
          <div className="flex h-full flex-col text-xs" >
            <pre className="selectable overflow-x-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-primary" style={{ margin: 0 }}>
              <code>{openArtifact.text ?? ""}</code>
            </pre>
          </div>
        ) : openArtifact && selectedIsDiff && openArtifact.truncated ? (
          <pre className="selectable overflow-x-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-primary text-xs" style={{ margin: 0 }}>
            <code>{openArtifact.text ?? ""}</code>
          </pre>
        ) : openArtifact && selectedIsDiff && openArtifact.parseError ? (
          <div className="px-4 py-6 text-tertiary text-sm" role="alert" >
            {openArtifact.parseError}
          </div>
        ) : openArtifact && openArtifact.loading ? (
          <div className="grid gap-2 px-4 py-6" role="status" aria-label="Loading artifact preview">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : viewerFiles.length > 0 ? (
          <div className="flex h-full min-h-0 flex-col">
            {!openArtifact && activeEventSource ? (
              <div className="flex flex-shrink-0 items-center gap-2 bg-elevated px-3 py-2 text-xs" >
                <label htmlFor="review-event-source" className="sr-only">Change source</label>
                <Select
                  id="review-event-source"
                  label="Change source"
                  value={activeEventSource.id}
                  onValueChange={setSelectedEventSourceId}
                  className="min-w-0 flex-1 font-mono text-xs"
                  options={visibleSources.map((source) => ({ value: source.id, label: source.label }))}
                />
                {taskId ? (
                  <Button
                    type="button"
                    onClick={() => setBrowsingArtifacts(true)}
                    aria-label="Browse artifacts"
                    className="flex-shrink-0 rounded-sm px-2 py-1 text-primary hover:bg-hover"
                  >
                    Artifacts
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <DiffViewer
                key={openArtifact?.artifact.hash ?? activeEventSource?.id ?? "event-diffs"}
                autoFocus
                files={viewerFiles}
                initialSelectedPath={viewerFiles[0]?.displayPath ?? viewerFiles[0]?.newPath}
                comments={visibleComments}
                onAddComment={(filePath, lineNo, anchor: DiffCommentAnchor, body) => {
                  setReviewNotesState((current) => {
                    if (current.taskId !== (taskId ?? null)) return current;
                    const nextNotes = [
                      ...current.notes,
                      {
                        id: createReviewNoteId(activeSource.id, filePath, lineNo),
                        sourceId: activeSource.id,
                        sourceLabel: activeSource.label,
                        filePath,
                        lineNo,
                        anchor,
                        body,
                        at: new Date().toISOString(),
                      },
                    ];
                    const sessionError = reviewNotesCollectionError(
                      nextNotes,
                      MAX_SESSION_REVIEW_NOTES,
                      MAX_SESSION_REVIEW_NOTE_BYTES,
                    );
                    if (sessionError) {
                      return { ...current, status: "recovery_needed", error: `${sessionError} The note was not added.` };
                    }
                    const persistenceError = reviewNotesCollectionError(
                      nextNotes,
                      MAX_PERSISTED_REVIEW_NOTES,
                      MAX_PERSISTED_REVIEW_NOTE_BYTES,
                    );
                    const recoveryBlocked = current.status === "recovery_needed";
                    return {
                      ...current,
                      notes: nextNotes,
                      status: recoveryBlocked ? "recovery_needed" : persistenceError ? "session_only" : "ready",
                      error: recoveryBlocked
                        ? `${current.error ?? "Stored notes require recovery."} New notes remain available only in this window.`
                        : persistenceError
                        ? `${persistenceError} Newer notes remain available only in this window.`
                        : null,
                    };
                  });
                }}
                onAskAgentRevise={(filePath, lineStart, lineEnd) => {
                  onDraftRevision(`Please revise ${filePath} around lines ${lineStart}-${lineEnd}, based on ${activeSource.label}. Keep the current task scope and explain the change before applying it.`);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {/* The way out used to require `activeEventSource`, so a task
                with no working tree and no patch events opened the artifact
                list with no control that could leave it. The bar is now
                unconditional; only its label depends on what it returns to. */}
            {!openArtifact ? (
              <div className="flex flex-shrink-0 items-center justify-between border-b border-subtle bg-elevated px-3 py-2 text-xs">
                <span className="text-tertiary">Immutable task artifacts</span>
                <Button
                  variant="bare"
                  onClick={() => setBrowsingArtifacts(false)}
                  className="rounded-md px-2 py-1 text-secondary transition-colors hover:bg-hover hover:text-primary"
                >
                  {activeEventSource ? "Review event diff" : "Back to changes"}
                </Button>
              </div>
            ) : null}
            <ArtifactListSection
              artifacts={artifactPage?.artifacts ?? []}
              onOpen={openArtifactPreview}
            />
          </div>
        )}
      </div>
      {artifactsError && (artifactPage !== null || activeEventSource !== null) ? (
        <ErrorState
          severity="warning"
          title="Artifact inventory unavailable"
          description={artifactsError}
          action={{ label: "Retry inventory", onClick: retryInventory }}
          compact
          className="mx-3 mb-2 rounded-md border border-subtle bg-elevated"
        />
      ) : null}
      {artifactPage && artifactPage.artifacts.length < artifactPage.total ? (
        <div className="flex flex-shrink-0 items-center justify-between border-t border-subtle px-3 py-2 text-xs" >
          <span className="font-mono text-tertiary">
            {artifactPage.artifacts.length} of {artifactPage.total} artifacts
          </span>
          <Button
            type="button"
            onClick={() => void loadMore()}
            disabled={!artifactPage.next_cursor || loadingMore}
            className="rounded-sm px-2 py-1 text-primary hover:bg-hover disabled:opacity-50"
          >
            {loadingMore ? "Loading" : "Load more"}
          </Button>
        </div>
      ) : null}
      {reviewNotesState.taskId === (taskId ?? null) && reviewNotesState.error ? (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-subtle px-3 py-2 text-danger text-xs" role="status" >
          <span>{reviewNotesState.error}</span>
          <Button
            type="button"
            className="ml-auto rounded-sm px-2 py-1 text-primary hover:bg-hover"
            onClick={() => {
              if (!taskId) return;
              const loaded = readReviewNotes(taskId);
              if (loaded.status === "ready") {
                const mergedById = new Map(loaded.notes.map((note) => [note.id, note]));
                for (const note of reviewNotesState.notes) mergedById.set(note.id, note);
                const merged = [...mergedById.values()];
                const error = writeReviewNotes(taskId, merged);
                setReviewNotesState({
                  taskId,
                  notes: error ? reviewNotesState.notes : merged,
                  status: error ? "session_only" : "ready",
                  error,
                });
              } else {
                setReviewNotesState((current) => ({ ...current, error: loaded.error }));
              }
            }}
          >
            Retry storage
          </Button>
        </div>
      ) : null}
      {viewerFiles.length > 0 ? (
        <footer className="flex flex-shrink-0 items-center gap-2 border-t border-subtle px-3 py-2 text-secondary text-xs">
          {reviewedLocally ? <Check size={13} aria-hidden /> : <Send size={13} aria-hidden />}
          <span>{visibleComments.length} {visibleComments.length === 1 ? "comment" : "comments"}</span>
          <span className="hidden min-w-0 truncate text-tertiary xl:inline">
            {reviewedLocally ? "Reviewed in this window" : "Review state is local to this window"}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-pressed={reviewedLocally}
            data-tooltip="This does not change task, Git, or review state outside this window."
            onClick={() => {
              setReviewedSourceIds((current) => {
                const next = new Set(current);
                if (next.has(activeSource.id)) next.delete(activeSource.id);
                else next.add(activeSource.id);
                return next;
              });
            }}
            className="ml-auto"
          >
            {reviewedLocally ? "Reviewed locally" : "Mark reviewed locally"}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={visibleComments.length === 0}
            data-tooltip={visibleComments.length === 0
              ? "Add at least one comment before drafting a change request."
              : "Adds these comments to the composer. You choose when to send them."}
            onClick={() => {
              const note = visibleComments.map((comment) => `- [${comment.sourceLabel}] ${comment.filePath}:${comment.anchor}:${comment.lineNo} — ${comment.body}`).join("\n");
              onDraftRevision(`Please address this code review feedback:\n${note}`);
              setRevisionQueued(true);
              window.setTimeout(() => setRevisionQueued(false), 1600);
            }}
          >
            {revisionQueued ? "Drafted" : "Draft change request"}
          </Button>
          <span className="sr-only" aria-live="polite">{revisionQueued ? "Review request added to the composer" : ""}</span>
        </footer>
      ) : null}
    </section>
  );
}

function ArtifactListSection({
  artifacts,
  onOpen,
}: {
  artifacts: ArtifactSummary[];
  onOpen: (artifact: ArtifactSummary) => void;
}): JSX.Element {
  if (artifacts.length === 0) {
    return (
      <EmptyState
        icon={<FileDiff size={17} />}
        title="No immutable artifacts"
        description="This task has not published any immutable review artifacts."
        compact
      />
    );
  }
  return (
    <ul className="flex flex-col" aria-label="Task artifacts">
      {artifacts.map((artifact) => (
        <li key={artifact.hash} className="border-b border-subtle last:border-b-0">
          <Button
            type="button"
            onClick={() => onOpen(artifact)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-hover text-xs"

          >
            <span className="truncate font-mono text-secondary" data-tooltip={artifact.hash}>
              {artifact.hash}
            </span>
            <span className="ml-auto flex-shrink-0 font-mono text-tertiary">{artifact.purpose}</span>
            {isDiffArtifact(artifact) ? (
              <span className="flex-shrink-0 font-mono" style={{ color: "var(--color-info)" }}>diff</span>
            ) : null}
            {artifact.size_bytes !== null ? (
              <span className="w-20 flex-shrink-0 text-right font-mono text-tertiary">
                {artifact.size_bytes.toLocaleString()} B
              </span>
            ) : null}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export const ReviewPane = memo(ReviewPaneImpl);
