/**
 * Terminus Desktop — DiffViewer.
 *
 * Per SPEC §13: a resizable split beside the conversation, or an
 * overlay. Review-first, editor-capable. Surfaces:
 *
 *   - Unified diff and side-by-side diff modes (toggle, persisted)
 *   - Changed-file navigation with +/- counts
 *   - Additions in green background, deletions in red, context muted
 *   - Hunk headers
 *   - Inline comments (click on a line to add a comment)
 *   - Draft a revision request for selected code
 *   - Accept / Reject per logical change group (hunk)
 *   - Restore file / Restore hunk
 *   - Copy code, open in external editor, reveal in Finder
 *   - Jump between changes (prev/next)
 *   - Monospace, tight rows, stronger separators (Cursor precision)
 *
 * The component is data-driven: callers pass an array of DiffFile
 * objects. Each DiffFile may be constructed from a unified-diff string
 * via {@link parseUnifiedDiff} or assembled directly.
 *
 * Per SPEC §4.2: technical surfaces (diff, terminal) may be denser and
 * sharper than the general shell. We use the `.diff-*` helpers from
 * globals.css (`.diff-add`, `.diff-del`, `.diff-context`,
 * `.diff-hunk-header`, `.diff-line`) and add the structural chrome
 * here.
 *
 * Per design constraints: lucide-react icons, CSS variables only,
 * accessible keyboard navigation (j/k for next/prev change and [/] for
 * prev/next file), restrained motion (150-250ms),
 * both dark + light themes polished equally.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clipboard,
  Ellipsis,
  FileText,
  Folder,
  MessageSquarePlus,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ContextMenu, Menu, type MenuItem } from "../ui/Menu";
import { Select } from "../ui/Select";
import { FIXED_SHORTCUTS, matchesShortcut } from "../lib/shortcuts";
import { EmptyState } from "../ui/EmptyState";

// ────────────────────────── Types ───────────────────────────────────────────

export type DiffLineKind = "context" | "add" | "del" | "hunk-header";

export interface DiffLine {
  kind: DiffLineKind;
  /** Old-file line number (1-based), or null for additions / headers. */
  oldNo: number | null;
  /** New-file line number (1-based), or null for deletions / headers. */
  newNo: number | null;
  /** Raw line content (without the leading +/-/space sigil). */
  text: string;
  /** Hunk header text (e.g. "@@ -10,7 +10,9 @@") when kind === "hunk-header". */
  header?: string;
  /** Stable id used as React key. */
  key: string;
}

export interface DiffHunk {
  /** Old-file start line. */
  oldStart: number;
  /** New-file start line. */
  newStart: number;
  /** Old-file line count. */
  oldCount: number;
  /** New-file line count. */
  newCount: number;
  /** Header text "@@ -a,b +c,d @@". */
  header: string;
  lines: DiffLine[];
  /** Optional logical group label (e.g. "Imports", "Handler"). */
  group?: string;
  /** Stable id used as React key. */
  key: string;
}

export interface DiffFile {
  /** Old path (e.g. "a/src/index.ts"). */
  oldPath: string;
  /** New path (e.g. "b/src/index.ts"). */
  newPath: string;
  /** Display path, defaults to newPath without the b/ prefix. */
  displayPath?: string;
  /** Status: added, modified, deleted, renamed. */
  status: "added" | "modified" | "deleted" | "renamed";
  /** Parsed hunks. */
  hunks: DiffHunk[];
  /** Optional binary-content flag (no line-level diff). */
  binary?: boolean;
  /** Optional logical group label, e.g. "Tests" or "Source". */
  group?: string;
}

export type DiffViewMode = "unified" | "split";
export type DiffCommentAnchor = "old" | "new";

export interface DiffComment {
  /** Stable id. */
  id: string;
  /** File path the comment is attached to. */
  filePath: string;
  /** Line number on the selected old/new side. */
  lineNo: number;
  /** Disambiguates removed and added lines that share the same number. */
  anchor: DiffCommentAnchor;
  /** Comment body. */
  body: string;
  /** ISO timestamp. */
  at: string;
}

export interface DiffViewerProps {
  /** Files to render. */
  files: DiffFile[];
  /** Comments keyed by `${filePath}:${anchor}:${lineNo}`. Caller owns storage. */
  comments?: DiffComment[];
  /** Optional callback when a comment is added. */
  onAddComment?: (filePath: string, lineNo: number, anchor: DiffCommentAnchor, body: string) => void;
  /** Optional callback when a revision request is drafted. */
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  /** Optional callback when a hunk is accepted or rejected. */
  onHunkResolve?: (filePath: string, hunkKey: string, decision: "accept" | "reject") => void;
  /** Optional callback when "Restore file" / "Restore hunk" is clicked. */
  onRestore?: (target: { kind: "file" | "hunk"; filePath: string; hunkKey?: string }) => void;
  /** Optional callback for opening in external editor. */
  onOpenInEditor?: (filePath: string) => void;
  /** Optional callback for opening in terminal at the file's directory. */
  onOpenInTerminal?: (filePath: string) => void;
  /** Optional callback for revealing in Finder. */
  onRevealInFinder?: (filePath: string) => void;
  /** Optional className. */
  className?: string;
  /** Optional initial selected file path. Defaults to first file. */
  initialSelectedPath?: string;
  /** Optional initial view mode. Defaults to "unified". */
  initialViewMode?: DiffViewMode;
  /** Hide the file navigation rail (single-file mode). */
  hideFileNav?: boolean;
}

// ────────────────────────── Unified-diff parser ─────────────────────────────

/**
 * Parse a unified-diff blob into DiffFile objects.
 *
 * Recognizes:
 *   diff --git a/... b/...
 *   --- a/path
 *   +++ b/path
 *   @@ -a,b +c,d @@ optional section
 *    context
 *   +added
 *   -removed
 *
 * Binary files / "Binary files differ" are flagged.
 * Anything unrecognized is ignored defensively.
 */
export function parseUnifiedDiff(input: string): DiffFile[] {
  const lines = input.split(/\r?\n/);
  const files: DiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      const oldPath = m?.[1] ?? "unknown";
      const newPath = m?.[2] ?? oldPath;
      i++;
      // Skip metadata lines until we find a hunk header.
      let status: DiffFile["status"] = "modified";
      let binary = false;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined) break;
        if (cur.startsWith("@@")) break;
        if (cur.startsWith("new file mode")) status = "added";
        else if (cur.startsWith("deleted file mode")) status = "deleted";
        else if (cur.startsWith("rename from") || cur.startsWith("rename to")) status = "renamed";
        else if (cur.startsWith("Binary files") || cur.startsWith("GIT binary patch")) binary = true;
        else if (cur.startsWith("--- ") || cur.startsWith("+++ ")) {
          // Allow the --- / +++ lines to override paths.
        }
        i++;
      }
      const hunks: DiffHunk[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined) break;
        if (cur.startsWith("diff --git ")) break;
        if (!cur.startsWith("@@")) {
          i++;
          continue;
        }
        const hm = cur.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
        if (!hm) {
          i++;
          continue;
        }
        const oldStart = parseInt(hm[1] ?? "0", 10);
        const oldCount = hm[2] !== undefined ? parseInt(hm[2], 10) : 1;
        const newStart = parseInt(hm[3] ?? "0", 10);
        const newCount = hm[4] !== undefined ? parseInt(hm[4], 10) : 1;
        const header = cur;
        const hunkLines: DiffLine[] = [];
        i++;
        let oldLn = oldStart;
        let newLn = newStart;
        let consumed = 0;
        const total = oldCount + newCount;
        while (i < lines.length && consumed < total + oldCount /* generous bound */) {
          const raw = lines[i];
          if (raw === undefined) break;
          if (raw.startsWith("diff --git ") || raw.startsWith("@@")) break;
          const sigil = raw.charAt(0);
          const rest = raw.slice(1);
          if (sigil === "+") {
            hunkLines.push({
              kind: "add",
              oldNo: null,
              newNo: newLn,
              text: rest,
              key: `L-${i}`,
            });
            newLn++;
            consumed++;
          } else if (sigil === "-") {
            hunkLines.push({
              kind: "del",
              oldNo: oldLn,
              newNo: null,
              text: rest,
              key: `L-${i}`,
            });
            oldLn++;
            consumed++;
          } else if (sigil === " ") {
            hunkLines.push({
              kind: "context",
              oldNo: oldLn,
              newNo: newLn,
              text: rest,
              key: `L-${i}`,
            });
            oldLn++;
            newLn++;
            consumed++;
          } else if (raw === "") {
            // Blank line in unified diff is a context line.
            hunkLines.push({
              kind: "context",
              oldNo: oldLn,
              newNo: newLn,
              text: "",
              key: `L-${i}`,
            });
            oldLn++;
            newLn++;
            consumed++;
          } else if (raw.startsWith("\\")) {
            // "\ No newline at end of file" marker — skip but keep.
            i++;
            continue;
          } else {
            // Unknown line — bail.
            break;
          }
          i++;
        }
        hunks.push({
          oldStart,
          newStart,
          oldCount,
          newCount,
          header,
          lines: hunkLines,
          key: `H-${hunks.length}-${oldStart}-${newStart}`,
        });
      }
      files.push({
        oldPath: `a/${oldPath}`,
        newPath: `b/${newPath}`,
        displayPath: newPath,
        status,
        hunks,
        binary,
      });
    } else {
      i++;
    }
  }
  return files;
}

// ────────────────────────── Helpers ─────────────────────────────────────────

function countChanges(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "del") deletions++;
    }
  }
  return { additions, deletions };
}

const VIEW_MODE_STORAGE = "terminus-desktop.diff.view-mode.v1";
const NO_RESOLVED_HUNKS: Record<string, "accept" | "reject"> = {};

function readStoredViewMode(): DiffViewMode | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(VIEW_MODE_STORAGE);
    return v === "split" || v === "unified" ? v : null;
  } catch {
    return null;
  }
}

function writeStoredViewMode(mode: DiffViewMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE, mode);
  } catch {
    // ignore
  }
}

// ────────────────────────── Component ───────────────────────────────────────

function DiffViewerImpl({
  files,
  comments = [],
  onAddComment,
  onAskAgentRevise,
  onHunkResolve,
  onRestore,
  onOpenInEditor,
  onOpenInTerminal,
  onRevealInFinder,
  className,
  initialSelectedPath,
  initialViewMode,
  hideFileNav = false,
}: DiffViewerProps): JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialSelectedPath ?? (files.length > 0 ? (files[0]?.displayPath ?? files[0]?.newPath ?? null) : null),
  );
  const [viewMode, setViewMode] = useState<DiffViewMode>(
    initialViewMode ?? readStoredViewMode() ?? "unified",
  );
  const [query, setQuery] = useState("");
  const [fullDiff, setFullDiff] = useState(false);
  const [commentDraft, setCommentDraft] = useState<{ path: string; lineNo: number; anchor: DiffCommentAnchor; text: string } | null>(null);
  const [resolvedHunks, setResolvedHunks] = useState<Record<string, "accept" | "reject">>({});
  const [focusIndex, setFocusIndex] = useState(0);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerResizeObserverRef = useRef<ResizeObserver | null>(null);
  const [viewerWidth, setViewerWidth] = useState(0);
  const keyboardFocusPendingRef = useRef(false);
  const focusMountFrameRef = useRef<number | null>(null);
  const commentFocusFrameRef = useRef<number | null>(null);
  const commentReturnFocusRef = useRef<HTMLElement | null>(null);
  const changeLineRefs = useRef<Array<HTMLDivElement | null>>([]);
  const resolutionEnabled = typeof onHunkResolve === "function";
  const activeResolvedHunks = resolutionEnabled ? resolvedHunks : NO_RESOLVED_HUNKS;
  const compactViewer = viewerWidth < 760;
  const effectiveViewMode: DiffViewMode = compactViewer ? "unified" : viewMode;

  const attachViewer = useCallback((element: HTMLDivElement | null): void => {
    viewerResizeObserverRef.current?.disconnect();
    viewerResizeObserverRef.current = null;
    viewerRef.current = element;
    if (!element) return;
    const update = (width: number): void => {
      setViewerWidth((current) => Math.abs(current - width) < 1 ? current : width);
    };
    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    viewerResizeObserverRef.current = observer;
  }, []);

  const activeSelectedPath = files.some((file) => (file.displayPath ?? file.newPath) === selectedPath)
    ? selectedPath
    : initialSelectedPath && files.some((file) => (file.displayPath ?? file.newPath) === initialSelectedPath)
      ? initialSelectedPath
      : files[0] ? (files[0].displayPath ?? files[0].newPath) : null;
  const selectedFile = useMemo(
    () => files.find((f) => (f.displayPath ?? f.newPath) === activeSelectedPath) ?? null,
    [activeSelectedPath, files],
  );

  const changeCount = useMemo(() => {
    if (!selectedFile) return 0;
    const path = selectedFile.displayPath ?? selectedFile.newPath;
    return buildDiffRows(selectedFile, effectiveViewMode, path, activeResolvedHunks).changeRowIndices.length;
  }, [activeResolvedHunks, effectiveViewMode, selectedFile]);
  const effectiveFocusIndex = changeCount === 0 ? 0 : Math.min(focusIndex, changeCount - 1);

  const activateFile = useCallback((path: string): void => {
    setSelectedPath(path);
    setFocusIndex(0);
    setCommentDraft(null);
    commentReturnFocusRef.current = null;
    keyboardFocusPendingRef.current = false;
    changeLineRefs.current = [];
    if (focusMountFrameRef.current !== null) {
      window.cancelAnimationFrame(focusMountFrameRef.current);
      focusMountFrameRef.current = null;
    }
  }, []);

  const updateFocusIndex = useCallback((index: number): void => {
    setFocusIndex(changeCount === 0 ? 0 : Math.max(0, Math.min(index, changeCount - 1)));
  }, [changeCount]);

  // A flat list of change lines for next/prev navigation.
  const registerChangeLine = useCallback((index: number, element: HTMLDivElement | null): void => {
    if (element) {
      changeLineRefs.current[index] = element;
      if (keyboardFocusPendingRef.current && index === effectiveFocusIndex) {
        if (focusMountFrameRef.current !== null) window.cancelAnimationFrame(focusMountFrameRef.current);
        focusMountFrameRef.current = window.requestAnimationFrame(() => {
          focusMountFrameRef.current = null;
          if (changeLineRefs.current[index] !== element || !keyboardFocusPendingRef.current) return;
          element.focus({ preventScroll: true });
          keyboardFocusPendingRef.current = false;
        });
      }
    } else {
      delete changeLineRefs.current[index];
    }
  }, [effectiveFocusIndex]);

  useEffect(() => () => {
    if (focusMountFrameRef.current !== null) window.cancelAnimationFrame(focusMountFrameRef.current);
    if (commentFocusFrameRef.current !== null) window.cancelAnimationFrame(commentFocusFrameRef.current);
    viewerResizeObserverRef.current?.disconnect();
  }, []);

  const filteredFiles = useMemo(() => {
    if (!query.trim()) return files;
    const q = query.toLowerCase();
    return files.filter((f) => (f.displayPath ?? f.newPath).toLowerCase().includes(q));
  }, [files, query]);

  // Persist the user's preferred view mode.
  useEffect(() => {
    writeStoredViewMode(viewMode);
  }, [viewMode]);

  // Keyboard: j/k next/prev change, [/] prev/next file, u toggle view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const viewer = viewerRef.current;
      if (!viewer || !viewer.contains(document.activeElement)) return;
      if (target?.closest("input, textarea, select, button, a[href], [contenteditable='true'], [role='textbox']")) return;
      if (matchesShortcut(e, FIXED_SHORTCUTS.diffNextChange)) {
        e.preventDefault();
        keyboardFocusPendingRef.current = true;
        updateFocusIndex(effectiveFocusIndex + 1);
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.diffPreviousChange)) {
        e.preventDefault();
        keyboardFocusPendingRef.current = true;
        updateFocusIndex(effectiveFocusIndex - 1);
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.diffPreviousFile)) {
        e.preventDefault();
        const idx = files.findIndex((f) => (f.displayPath ?? f.newPath) === activeSelectedPath);
        if (idx > 0) {
          const prev = files[idx - 1];
          if (prev) activateFile(prev.displayPath ?? prev.newPath);
        }
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.diffNextFile)) {
        e.preventDefault();
        const idx = files.findIndex((f) => (f.displayPath ?? f.newPath) === activeSelectedPath);
        if (idx >= 0 && idx < files.length - 1) {
          const next = files[idx + 1];
          if (next) activateFile(next.displayPath ?? next.newPath);
        }
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.diffToggleView) && !compactViewer) {
        e.preventDefault();
        setViewMode((m) => (m === "unified" ? "split" : "unified"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activateFile, activeSelectedPath, compactViewer, effectiveFocusIndex, files, updateFocusIndex]);

  // Focus the change line on focusIndex change.
  useEffect(() => {
    const el = changeLineRefs.current[effectiveFocusIndex];
    const viewer = viewerRef.current;
    if (!el || !viewer?.contains(document.activeElement)) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      || document.documentElement.dataset.reduceMotion === "true";
    el.focus({ preventScroll: true });
    keyboardFocusPendingRef.current = false;
    el.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }, [effectiveFocusIndex]);

  const onLineClick = useCallback((path: string, lineNo: number, anchor: DiffCommentAnchor): void => {
    commentReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setCommentDraft({ path, lineNo, anchor, text: "" });
  }, []);

  const closeCommentDraft = useCallback((): void => {
    const returnTarget = commentReturnFocusRef.current;
    commentReturnFocusRef.current = null;
    setCommentDraft(null);
    if (commentFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(commentFocusFrameRef.current);
    }
    commentFocusFrameRef.current = window.requestAnimationFrame(() => {
      commentFocusFrameRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    });
  }, []);

  const submitComment = useCallback((): void => {
    if (!commentDraft) return;
    const body = commentDraft.text.trim();
    if (body.length === 0) {
      closeCommentDraft();
      return;
    }
    onAddComment?.(commentDraft.path, commentDraft.lineNo, commentDraft.anchor, body);
    closeCommentDraft();
  }, [closeCommentDraft, commentDraft, onAddComment]);

  if (files.length === 0) {
    return (
      <div className={cn("h-full overflow-auto", className)}>
        <EmptyState
          icon={<FileText size={16} />}
          title="No changes yet"
          description="When the agent modifies files, they will appear here for review."
          compact
        />
      </div>
    );
  }

  return (
    <div
      ref={attachViewer}
      className={cn("flex h-full min-h-0 bg-diff", className)}
      role="region"
      aria-label="Diff viewer"
      tabIndex={0}
    >
      {!hideFileNav && !compactViewer ? (
        <FileNav
          files={filteredFiles}
          selectedPath={activeSelectedPath}
          onSelect={activateFile}
          query={query}
          onQueryChange={setQuery}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <DiffHeader
          file={selectedFile}
          files={files}
          compact={compactViewer}
          viewMode={effectiveViewMode}
          onViewModeChange={setViewMode}
          onFileSelect={activateFile}
          onOpenInEditor={onOpenInEditor}
          onOpenInTerminal={onOpenInTerminal}
          onRevealInFinder={onRevealInFinder}
          onRestore={onRestore}
          focusIndex={effectiveFocusIndex}
          changeCount={changeCount}
          onFocusIndexChange={updateFocusIndex}
          fullDiff={fullDiff}
          onFullDiffChange={setFullDiff}
        />
        {selectedFile ? (
          <DiffBody
            file={selectedFile}
            viewMode={effectiveViewMode}
            comments={comments}
            commentDraft={commentDraft}
            onLineClick={onLineClick}
            onCommentDraftChange={(text) =>
              setCommentDraft((d) => (d ? { ...d, text } : null))
            }
            onSubmitComment={submitComment}
            onCancelComment={closeCommentDraft}
            onAskAgentRevise={onAskAgentRevise}
            onHunkResolve={(hunkKey, decision) => {
              if (!selectedFile || !onHunkResolve) return;
              const key = `${selectedFile.displayPath ?? selectedFile.newPath}:${hunkKey}`;
              setResolvedHunks((prev) => ({ ...prev, [key]: decision }));
              onHunkResolve(selectedFile.displayPath ?? selectedFile.newPath, hunkKey, decision);
            }}
            onRestore={(hunkKey) =>
              onRestore?.({
                kind: "hunk",
                filePath: selectedFile.displayPath ?? selectedFile.newPath,
                hunkKey,
              })
            }
            resolutionEnabled={resolutionEnabled}
            resolvedHunks={activeResolvedHunks}
            registerChangeLine={registerChangeLine}
            focusIndex={effectiveFocusIndex}
            fullDiff={fullDiff}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-tertiary">
            Select a file to review.
          </div>
        )}
      </div>
    </div>
  );
}

export const DiffViewer = memo(DiffViewerImpl);

// ────────────────────────── File navigation ─────────────────────────────────

function FileNav({
  files,
  selectedPath,
  onSelect,
  query,
  onQueryChange,
}: {
  files: DiffFile[];
  selectedPath: string | null;
  onSelect: (p: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
}): JSX.Element {
  // Group by optional DiffFile.group, then by top-level directory.
  const groups = useMemo(() => {
    const out = new Map<string, DiffFile[]>();
    for (const f of files) {
      const key = f.group ?? "Files";
      const arr = out.get(key);
      if (arr) arr.push(f);
      else out.set(key, [f]);
    }
    return [...out.entries()];
  }, [files]);

  return (
    <aside
      className="diff-file-nav flex h-full flex-shrink-0 flex-col border-r border-default bg-elevated"
      aria-label="Changed files"
    >
      <div className="border-b border-subtle px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-md bg-canvas px-2" style={{ height: 26 }}>
          <Search size={12} className="text-tertiary" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter files"
            aria-label="Filter changed files"
            className="ui-input min-w-0 flex-1 border-0 bg-transparent px-0 text-xs text-primary placeholder:text-tertiary"

          />
          {query ? (
            <IconButton
              label="Clear filter"
              icon={<X size={11} />}
              size="sm"
              onClick={() => onQueryChange("")}
              className="text-tertiary hover:text-primary"
            />
          ) : null}
        </div>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-y-auto py-1">
        {groups.map(([groupName, groupFiles]) => (
          <div key={groupName} className="px-1">
            <div
              className="px-2 py-1 text-tertiary text-xs"
              style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}
            >
              {groupName}
            </div>
            {groupFiles.map((f) => {
              const path = f.displayPath ?? f.newPath;
              const isSel = path === selectedPath;
              const { additions, deletions } = countChanges(f);
              const fileName = path.split("/").pop() ?? path;
              const dirPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              return (
                <Button
                    key={path}
                    type="button"
                    onClick={() => onSelect(path)}
                    aria-current={isSel}
                    className={[cn(
                      "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left hover:bg-hover",
                      isSel && "bg-selected",
                    ), "text-xs"].filter(Boolean).join(" ")}

                  >
                    {f.status === "added" ? (
                      <Plus size={11} className="flex-shrink-0 text-success" />
                    ) : f.status === "deleted" ? (
                      <Minus size={11} className="flex-shrink-0 text-error" />
                    ) : f.status === "renamed" ? (
                      <ArrowUp size={11} className="flex-shrink-0 text-secondary" />
                    ) : (
                      <FileText size={11} className="flex-shrink-0 text-tertiary" />
                    )}
                    <span
                      className="flex min-w-0 flex-1 flex-col"
                      data-tooltip={path}
                    >
                      <span className={cn("truncate text-primary", isSel && "font-medium")}>
                        {fileName}
                      </span>
                      {dirPath ? (
                        <span className="truncate text-tertiary text-xs" >
                          {dirPath}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-1 font-mono">
                      {additions > 0 ? (
                        <span className="text-success text-xs" >
                          +{additions}
                        </span>
                      ) : null}
                      {deletions > 0 ? (
                        <span className="text-error text-xs" >
                          -{deletions}
                        </span>
                      ) : null}
                    </span>
                </Button>
              );
            })}
          </div>
        ))}
        {files.length === 0 ? (
          <div className="px-3 py-4 text-center text-tertiary text-xs" >
            No files match "{query}".
          </div>
        ) : null}
      </div>
    </aside>
  );
}

// ────────────────────────── Header ──────────────────────────────────────────

function DiffHeader({
  file,
  files,
  compact,
  viewMode,
  onViewModeChange,
  onFileSelect,
  onOpenInEditor,
  onOpenInTerminal,
  onRevealInFinder,
  onRestore,
  focusIndex,
  changeCount,
  onFocusIndexChange,
  fullDiff,
  onFullDiffChange,
}: {
  file: DiffFile | null;
  files: DiffFile[];
  compact: boolean;
  viewMode: DiffViewMode;
  onViewModeChange: (m: DiffViewMode) => void;
  onFileSelect: (path: string) => void;
  onOpenInEditor?: (p: string) => void;
  onOpenInTerminal?: (p: string) => void;
  onRevealInFinder?: (p: string) => void;
  onRestore?: (target: { kind: "file" | "hunk"; filePath: string; hunkKey?: string }) => void;
  focusIndex: number;
  changeCount: number;
  onFocusIndexChange: (i: number) => void;
  fullDiff: boolean;
  onFullDiffChange: (full: boolean) => void;
}): JSX.Element {
  const path = file ? (file.displayPath ?? file.newPath) : "";
  const [pathCopyState, setPathCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyPath = (): void => {
    const clipboard = navigator.clipboard;
    if (!file || !clipboard) {
      setPathCopyState("failed");
      return;
    }
    void clipboard.writeText(path).then(
      () => setPathCopyState("copied"),
      () => setPathCopyState("failed"),
    ).finally(() => window.setTimeout(() => setPathCopyState("idle"), 1600));
  };
  const fileActions: MenuItem[] = [];
  if (file) fileActions.push({ id: "copy-path", label: pathCopyState === "copied" ? "Path copied" : pathCopyState === "failed" ? "Copy failed — try again" : "Copy file path", onSelect: copyPath });
  if (file && onOpenInEditor) fileActions.push({ id: "open-editor", label: "Open in editor", onSelect: () => onOpenInEditor(path) });
  if (file && onOpenInTerminal) fileActions.push({ id: "open-terminal", label: "Open in terminal", onSelect: () => onOpenInTerminal(path) });
  if (file && onRevealInFinder) fileActions.push({ id: "reveal", label: "Reveal in Finder", onSelect: () => onRevealInFinder(path) });
  if (file && onRestore) fileActions.push({ id: "restore", label: "Restore file", danger: true, onSelect: () => onRestore({ kind: "file", filePath: path }) });
  return (
    <div
      className="flex flex-shrink-0 items-center gap-2 overflow-hidden border-b border-default bg-elevated px-3 py-2"
      style={{ height: 40 }}
    >
      <Folder size={12} className="text-tertiary" />
      {compact ? (
        <Select
          label="Changed file"
          value={path}
          onValueChange={onFileSelect}
          className="h-7 min-w-0 flex-1 truncate font-mono text-xs"
          options={files.map((candidate) => {
            const candidatePath = candidate.displayPath ?? candidate.newPath;
            return { value: candidatePath, label: candidatePath };
          })}
        />
      ) : (
        <span
          className="selectable truncate font-mono text-primary text-xs"

          data-tooltip={path}
        >
          {path || "No file selected"}
        </span>
      )}
      <div className="ml-auto flex flex-shrink-0 items-center gap-1">
        {/* Prev / next change. */}
        <Button
          type="button"
          onClick={() => onFocusIndexChange(Math.max(0, focusIndex - 1))}
          disabled={changeCount === 0}
          aria-label="Previous change"
          data-tooltip="Previous change (k)"
          className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
        >
          <ChevronDown size={13} style={{ transform: "rotate(180deg)" }} />
        </Button>
        <Button
          type="button"
          onClick={() => onFocusIndexChange(Math.min(changeCount - 1, focusIndex + 1))}
          disabled={changeCount === 0}
          aria-label="Next change"
          data-tooltip="Next change (j)"
          className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
        >
          <ChevronDown size={13} />
        </Button>
        <Button
          type="button"
          onClick={() => onFullDiffChange(!fullDiff)}
          aria-pressed={fullDiff}
          data-tooltip={fullDiff
            ? "Return to the high-performance windowed diff"
            : "Browse every loaded diff row in bounded sequential pages"}
          className="h-7 rounded-md px-2 text-secondary hover:bg-hover hover:text-primary text-xs"

        >
          {fullDiff ? "Windowed" : "Browse lines"}
        </Button>
        {!compact ? (
          <>
            <div role="group" aria-label="Diff view mode" className="flex items-center rounded-md bg-subtle p-0.5">
              <ViewModeButton label="Unified" active={viewMode === "unified"} onClick={() => onViewModeChange("unified")} />
              <ViewModeButton label="Split" active={viewMode === "split"} onClick={() => onViewModeChange("split")} />
            </div>
            {fileActions.length > 0 ? (
              <Menu
                label="File actions"
                align="end"
                items={fileActions}
                trigger={<IconButton label="File actions" icon={<Ellipsis size={14} aria-hidden />} size="sm" />}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ViewModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[cn(
        "rounded-sm px-2 py-0.5 text-secondary hover:text-primary",
        active && "bg-hover text-primary",
      ), "text-xs"].filter(Boolean).join(" ")}

    >
      {label}
    </Button>
  );
}

// ────────────────────────── Body ────────────────────────────────────────────

/**
 * Flattened row representation for the virtualized diff body. Each row is
 * either a hunk header (with resolution banner + controls) or a single
 * diff line (unified view) or a paired left/right row (split view).
 */
type DiffRow =
  | { kind: "hunk-header"; hunk: DiffHunk; resolution: "accept" | "reject" | undefined }
  | { kind: "hunk-resolution"; hunk: DiffHunk; resolution: "accept" | "reject" }
  | {
      kind: "unified-line";
      hunk: DiffHunk;
      line: DiffLine;
      changeIdx: number; // -1 if not a change line
    }
  | {
      kind: "split-row";
      hunk: DiffHunk;
      left: DiffLine | null;
      right: DiffLine | null;
      changeIdx: number; // -1 if neither side is a change
    };

const ACCESSIBLE_DIFF_PAGE_SIZE = 200;

function diffLineAccessibleLabel(line: DiffLine): string {
  const kind = line.kind === "add" ? "Added" : line.kind === "del" ? "Removed" : "Context";
  const oldCoordinate = line.oldNo === null ? "no old line" : `old line ${line.oldNo}`;
  const newCoordinate = line.newNo === null ? "no new line" : `new line ${line.newNo}`;
  return `${kind}; ${oldCoordinate}; ${newCoordinate}; ${line.text || "blank line"}`;
}

function splitRowAccessibleLabel(left: DiffLine | null, right: DiffLine | null): string {
  if (left && right && left.kind === "context" && right.kind === "context") {
    return diffLineAccessibleLabel(left);
  }
  const oldSide = left
    ? `removed old line ${left.oldNo ?? "unknown"}: ${left.text || "blank line"}`
    : "no removed line";
  const newSide = right
    ? `added new line ${right.newNo ?? "unknown"}: ${right.text || "blank line"}`
    : "no added line";
  return `Changed row; ${oldSide}; ${newSide}`;
}

/**
 * Build the flat row list for the virtualizer. We also collect the
 * virtual-row indices that correspond to each change line so the j/k
 * navigation can scroll to them via `virtualizer.scrollToIndex`.
 */
function buildDiffRows(
  file: DiffFile,
  viewMode: DiffViewMode,
  path: string,
  resolvedHunks: Record<string, "accept" | "reject">,
): { rows: DiffRow[]; changeRowIndices: number[] } {
  const rows: DiffRow[] = [];
  const changeRowIndices: number[] = [];
  let changeIdx = 0;
  for (const hunk of file.hunks) {
    const resolution = resolvedHunks[`${path}:${hunk.key}`];
    rows.push({ kind: "hunk-header", hunk, resolution });
    if (resolution) {
      rows.push({ kind: "hunk-resolution", hunk, resolution });
    }
    if (viewMode === "unified") {
      for (const line of hunk.lines) {
        const isChange = line.kind === "add" || line.kind === "del";
        const idx = isChange ? changeIdx++ : -1;
        const rowIndex = rows.length;
        rows.push({ kind: "unified-line", hunk, line, changeIdx: idx });
        if (isChange) changeRowIndices.push(rowIndex);
      }
    } else {
      // Build aligned split rows.
      let i = 0;
      while (i < hunk.lines.length) {
        const line = hunk.lines[i];
        if (!line) {
          i++;
          continue;
        }
        if (line.kind === "del") {
          const next = hunk.lines[i + 1];
          if (next && next.kind === "add") {
            const isChange = true;
            const idx = isChange ? changeIdx++ : -1;
            const rowIndex = rows.length;
            rows.push({ kind: "split-row", hunk, left: line, right: next, changeIdx: idx });
            if (isChange) changeRowIndices.push(rowIndex);
            i += 2;
          } else {
            const idx = changeIdx++;
            const rowIndex = rows.length;
            rows.push({ kind: "split-row", hunk, left: line, right: null, changeIdx: idx });
            changeRowIndices.push(rowIndex);
            i++;
          }
        } else if (line.kind === "add") {
          const idx = changeIdx++;
          const rowIndex = rows.length;
          rows.push({ kind: "split-row", hunk, left: null, right: line, changeIdx: idx });
          changeRowIndices.push(rowIndex);
          i++;
        } else {
          rows.push({ kind: "split-row", hunk, left: line, right: line, changeIdx: -1 });
          i++;
        }
      }
    }
  }
  return { rows, changeRowIndices };
}

function DiffBody({
  file,
  viewMode,
  comments,
  commentDraft,
  onLineClick,
  onCommentDraftChange,
  onSubmitComment,
  onCancelComment,
  onAskAgentRevise,
  onHunkResolve,
  onRestore,
  resolutionEnabled,
  resolvedHunks,
  registerChangeLine,
  focusIndex,
  fullDiff,
}: {
  file: DiffFile;
  viewMode: DiffViewMode;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; anchor: DiffCommentAnchor; text: string } | null;
  onLineClick: (path: string, lineNo: number, anchor: DiffCommentAnchor) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  onHunkResolve: (hunkKey: string, decision: "accept" | "reject") => void;
  onRestore?: (hunkKey: string) => void;
  resolutionEnabled: boolean;
  resolvedHunks: Record<string, "accept" | "reject">;
  registerChangeLine: (index: number, element: HTMLDivElement | null) => void;
  focusIndex: number;
  fullDiff: boolean;
}): JSX.Element {
  const path = file.displayPath ?? file.newPath;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [accessiblePage, setAccessiblePage] = useState(0);

  const { rows, changeRowIndices } = useMemo(
    () => buildDiffRows(file, viewMode, path, resolvedHunks),
    [file, viewMode, path, resolvedHunks],
  );
  const accessiblePageCount = Math.max(1, Math.ceil(rows.length / ACCESSIBLE_DIFF_PAGE_SIZE));
  const accessibleStart = Math.min(
    accessiblePage * ACCESSIBLE_DIFF_PAGE_SIZE,
    Math.max(0, rows.length - 1),
  );
  const accessibleEnd = Math.min(rows.length, accessibleStart + ACCESSIBLE_DIFF_PAGE_SIZE);
  const accessibleRows = fullDiff ? rows.slice(accessibleStart, accessibleEnd) : [];

  useEffect(() => {
    setAccessiblePage(0);
  }, [file, fullDiff, viewMode]);

  useEffect(() => {
    setAccessiblePage((current) => Math.min(current, accessiblePageCount - 1));
  }, [accessiblePageCount]);

  const estimateRowSize = useCallback((index: number): number => {
    const row = rows[index];
    if (!row) return 24;
    if (row.kind === "hunk-header" || row.kind === "hunk-resolution") return 28;
    return 20;
  }, [rows]);

  // Virtualizer — only visible rows are mounted. Per SPEC §25.1: large
  // diffs (10k+ lines) must remain interactive. Each line is ~20px.
  // TanStack Virtual exposes imperative functions by design; compiler
  // memoization would risk stale diff rows.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: fullDiff ? 0 : rows.length,
    getScrollElement: () => scrollRef.current,
    // Seed the first render before ResizeObserver reports the real viewport.
    // The observer replaces this estimate immediately in a live window.
    initialRect: { width: 800, height: 600 },
    estimateSize: estimateRowSize,
    measureElement: (element) => {
      const measuredHeight = element.getBoundingClientRect().height;
      if (measuredHeight > 0) return measuredHeight;
      const index = Number(element.getAttribute("data-index"));
      return Number.isInteger(index) ? estimateRowSize(index) : 24;
    },
    overscan: 16,
    enabled: !fullDiff,
  });

  // When focusIndex changes, scroll the matching change row into view.
  // With virtualization we can't rely on `scrollIntoView` for off-screen
  // rows, so we ask the virtualizer to bring the row into view first.
  useEffect(() => {
    if (focusIndex < 0 || focusIndex >= changeRowIndices.length) return;
    const rowIndex = changeRowIndices[focusIndex];
    if (rowIndex === undefined) return;
    if (fullDiff) return;
    virtualizer.scrollToIndex(rowIndex, { align: "center" });
  }, [focusIndex, changeRowIndices, fullDiff, virtualizer]);

  if (file.binary) {
    return (
      <div className="flex flex-1 items-center justify-center text-tertiary text-sm" >
        Binary file — no line-level diff.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-diff font-mono">
      {fullDiff ? (
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-default px-3 py-2 text-xs text-secondary" aria-label="Loaded diff page controls">
          <Button
            type="button"
            onClick={() => setAccessiblePage((page) => Math.max(0, page - 1))}
            disabled={accessiblePage === 0}
            className="rounded-md border border-subtle px-2 py-1 hover:bg-hover disabled:opacity-40"
          >
            Previous diff rows
          </Button>
          <span className="font-mono text-tertiary">
            {rows.length === 0 ? "0 rows" : `${accessibleStart + 1}-${accessibleEnd} of ${rows.length} loaded rows`}
          </span>
          <Button
            type="button"
            onClick={() => setAccessiblePage((page) => Math.min(accessiblePageCount - 1, page + 1))}
            disabled={accessiblePage >= accessiblePageCount - 1}
            className="rounded-md border border-subtle px-2 py-1 hover:bg-hover disabled:opacity-40"
          >
            Next diff rows
          </Button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="selectable min-h-0 flex-1 overflow-auto"
        role="list"
        aria-label={fullDiff
          ? `All loaded diff rows for ${path} (${accessibleStart + 1}-${accessibleEnd} of ${rows.length})`
          : `Windowed diff for ${path} (${rows.length} rows)`}
      >
      {fullDiff ? (
        accessibleRows.map((row, index) => (
          <div
            key={`${row.kind}:${row.hunk.key}:${accessibleStart + index}`}
            role="listitem"
            aria-posinset={accessibleStart + index + 1}
            aria-setsize={rows.length}
            data-row-index={accessibleStart + index}
          >
            <DiffRowView
              row={row}
              path={path}
              comments={comments}
              commentDraft={commentDraft}
              onLineClick={onLineClick}
              onCommentDraftChange={onCommentDraftChange}
              onSubmitComment={onSubmitComment}
              onCancelComment={onCancelComment}
              onAskAgentRevise={onAskAgentRevise}
              onHunkResolve={onHunkResolve}
              onRestore={onRestore}
              resolutionEnabled={resolutionEnabled}
              focusIndex={focusIndex}
              registerChangeLine={registerChangeLine}
            />
          </div>
        ))
      ) : (
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <div
                key={`${row.kind}:${row.hunk.key}:${vi.index}`}
                ref={virtualizer.measureElement}
                role="listitem"
                aria-posinset={vi.index + 1}
                aria-setsize={rows.length}
                data-index={vi.index}
                data-row-index={vi.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <DiffRowView
                  row={row}
                  path={path}
                  comments={comments}
                  commentDraft={commentDraft}
                  onLineClick={onLineClick}
                  onCommentDraftChange={onCommentDraftChange}
                  onSubmitComment={onSubmitComment}
                  onCancelComment={onCancelComment}
                  onAskAgentRevise={onAskAgentRevise}
                  onHunkResolve={onHunkResolve}
                  onRestore={onRestore}
                  resolutionEnabled={resolutionEnabled}
                  focusIndex={focusIndex}
                  registerChangeLine={registerChangeLine}
                />
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}

// ────────────────────────── Row renderer ────────────────────────────────────

function DiffRowView({
  row,
  path,
  comments,
  commentDraft,
  onLineClick,
  onCommentDraftChange,
  onSubmitComment,
  onCancelComment,
  onAskAgentRevise,
  onHunkResolve,
  onRestore,
  resolutionEnabled,
  focusIndex,
  registerChangeLine,
}: {
  row: DiffRow;
  path: string;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; anchor: DiffCommentAnchor; text: string } | null;
  onLineClick: (path: string, lineNo: number, anchor: DiffCommentAnchor) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  onHunkResolve: (hunkKey: string, decision: "accept" | "reject") => void;
  onRestore?: (hunkKey: string) => void;
  resolutionEnabled: boolean;
  focusIndex: number;
  registerChangeLine: (index: number, element: HTMLDivElement | null) => void;
}): JSX.Element {
  if (row.kind === "hunk-header") {
    const hunk = row.hunk;
    return (
      <ContextMenu items={[
        { id: "restore", label: "Restore hunk", disabled: !onRestore, onSelect: () => onRestore?.(hunk.key) },
        { id: "reject", label: "Reject change", disabled: !resolutionEnabled || row.resolution === "reject", danger: true, onSelect: () => onHunkResolve(hunk.key, "reject") },
        { id: "accept", label: "Accept change", disabled: !resolutionEnabled || row.resolution === "accept", onSelect: () => onHunkResolve(hunk.key, "accept") },
      ]}>
      <div className="border-b border-subtle" role="group" aria-label={`Hunk ${hunk.header}${hunk.group ? `, ${hunk.group}` : ""}`}>
        <div
          className="diff-line diff-hunk-header flex items-center gap-2 text-xs"
          style={{ padding: "4px 12px", background: "var(--bg-diff)" }}
        >
          <span className="text-secondary">{hunk.header}</span>
          {hunk.group ? (
            <span
              className="rounded-sm bg-hover px-1.5 py-0.5 text-tertiary text-xs"

            >
              {hunk.group}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {/* Restore hunk. */}
            {onRestore ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRestore(hunk.key)}
                className="h-6 px-1.5 text-xs text-tertiary"
                aria-label={`Restore hunk ${hunk.header}`}
              >
                <RotateCcw size={10} />
                <span>Restore</span>
              </Button>
            ) : null}
            {/* Reject. */}
            {resolutionEnabled ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onHunkResolve(hunk.key, "reject")}
                disabled={row.resolution === "reject"}
                className="h-6 px-1.5 text-xs text-tertiary hover:text-error"
                aria-label={`Reject hunk ${hunk.header}`}
              >
                <X size={10} />
                <span>Reject</span>
              </Button>
            ) : null}
            {/* Accept. */}
            {resolutionEnabled ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onHunkResolve(hunk.key, "accept")}
                disabled={row.resolution === "accept"}
                className="h-6 px-1.5 text-xs text-tertiary hover:text-success"
                aria-label={`Accept hunk ${hunk.header}`}
              >
                <Check size={10} />
                <span>Accept</span>
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      </ContextMenu>
    );
  }
  if (row.kind === "hunk-resolution") {
    const resolution = row.resolution;
    return (
      <div
        role="status"
        aria-label={`${resolution === "accept" ? "Accepted" : "Rejected"} hunk ${row.hunk.header}`}
        className="flex items-center gap-2 px-3 py-1 text-xs"
        style={{ color: resolution === "accept" ? "var(--color-success)" : "var(--color-error)", background:
            resolution === "accept"
              ? "color-mix(in srgb, var(--color-success) 6%, transparent)"
              : "color-mix(in srgb, var(--color-error) 6%, transparent)" }}
      >
        <Check size={10} />
        <span>{resolution === "accept" ? "Accepted" : "Rejected"}</span>
        {resolutionEnabled ? (
          <Button
            type="button"
            onClick={() => onHunkResolve(row.hunk.key, resolution === "accept" ? "reject" : "accept")}
            className="ml-auto text-tertiary hover:text-primary text-xs"

          >
            Undo
          </Button>
        ) : null}
      </div>
    );
  }
  if (row.kind === "unified-line") {
    return (
      <UnifiedLineView
        line={row.line}
        path={path}
        comments={comments}
        commentDraft={commentDraft}
        onLineClick={onLineClick}
        onCommentDraftChange={onCommentDraftChange}
        onSubmitComment={onSubmitComment}
        onCancelComment={onCancelComment}
        onAskAgentRevise={onAskAgentRevise}
        changeIdx={row.changeIdx}
        focused={row.changeIdx === focusIndex && row.changeIdx >= 0}
        registerChangeLine={registerChangeLine}
      />
    );
  }
  // split-row
  return (
    <SplitRowView
      left={row.left}
      right={row.right}
      path={path}
      comments={comments}
      commentDraft={commentDraft}
      onLineClick={onLineClick}
      onCommentDraftChange={onCommentDraftChange}
      onSubmitComment={onSubmitComment}
      onCancelComment={onCancelComment}
      onAskAgentRevise={onAskAgentRevise}
      changeIdx={row.changeIdx}
      focused={row.changeIdx === focusIndex && row.changeIdx >= 0}
      registerChangeLine={registerChangeLine}
    />
  );
}

// ────────────────────────── Unified line view ───────────────────────────────────

/**
 * Renders a single unified-mode diff line (and its inline comment draft +
 * attached comments). Used inside the virtualized {@link DiffBody}.
 */
function UnifiedLineView({
  line,
  path,
  comments,
  commentDraft,
  onLineClick,
  onCommentDraftChange,
  onSubmitComment,
  onCancelComment,
  onAskAgentRevise,
  changeIdx,
  focused,
  registerChangeLine,
}: {
  line: DiffLine;
  path: string;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; anchor: DiffCommentAnchor; text: string } | null;
  onLineClick: (path: string, lineNo: number, anchor: DiffCommentAnchor) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  changeIdx: number;
  focused: boolean;
  registerChangeLine: (index: number, element: HTMLDivElement | null) => void;
}): JSX.Element {
  const isChange = line.kind === "add" || line.kind === "del";
  const lineNo = line.newNo ?? line.oldNo ?? 0;
  const anchor: DiffCommentAnchor = line.kind === "del" ? "old" : "new";
  const draftHere =
    commentDraft && commentDraft.path === path && commentDraft.lineNo === lineNo && commentDraft.anchor === anchor;
  const commentsHere = comments.filter(
    (c) => c.filePath === path && c.lineNo === lineNo && c.anchor === anchor,
  );
  return (
    <div>
      <div
        ref={(el) => {
          if (isChange && changeIdx >= 0) {
            registerChangeLine(changeIdx, el);
          }
        }}
        className={cn(
          "diff-line group flex items-stretch hover:bg-hover",
          line.kind === "add" && "diff-add",
          line.kind === "del" && "diff-del",
          line.kind === "context" && "diff-context",
          focused && "ring-1 ring-inset",
        )}
        tabIndex={isChange ? (focused ? 0 : -1) : undefined}
        role="group"
        aria-label={diffLineAccessibleLabel(line)}
        style={{
          background: focused
            ? line.kind === "add"
              ? "color-mix(in srgb, var(--color-addition) 22%, transparent)"
              : line.kind === "del"
                ? "color-mix(in srgb, var(--color-deletion) 22%, transparent)"
                : "var(--bg-hover)"
            : undefined,
        }}
      >
        {/* Line numbers. */}
        <span
          aria-hidden
          className="flex-shrink-0 select-none text-tertiary text-xs"
          style={{ width: 48, padding: "0 8px", textAlign: "right", borderRight: "1px solid var(--border-subtle)" }}
        >
          {line.oldNo ?? ""}
        </span>
        <span
          aria-hidden
          className="flex-shrink-0 select-none text-tertiary text-xs"
          style={{ width: 48, padding: "0 8px", textAlign: "right", borderRight: "1px solid var(--border-subtle)" }}
        >
          {line.newNo ?? ""}
        </span>
        <span
          aria-hidden
          className="flex-shrink-0 select-none px-1"
          style={{
            width: 18,
            textAlign: "center",
            color:
              line.kind === "add"
                ? "var(--color-addition)"
                : line.kind === "del"
                  ? "var(--color-deletion)"
                  : "var(--text-tertiary)",
          }}
        >
          {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
        </span>
        <code
          aria-hidden="true"
          className="flex-1 whitespace-pre select-text text-sm"
          style={{ padding: "0 8px" }}
        >
          {line.text || " "}
        </code>
        {/* Hover actions. */}
        {line.kind !== "hunk-header" && (line.newNo ?? line.oldNo) !== null ? (
          <div
            className="flex flex-shrink-0 items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            style={{ transition: "opacity var(--duration-fast) var(--easing-default)" }}
          >
            <Button
              type="button"
              onClick={() => onLineClick(path, lineNo, anchor)}
              aria-label="Add comment"
              data-tooltip="Add comment"
              className="flex h-6 w-6 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              <MessageSquarePlus size={12} />
            </Button>
            {isChange && onAskAgentRevise ? (
              <Button
                type="button"
                onClick={() =>
                  onAskAgentRevise(
                    path,
                    line.oldNo ?? line.newNo ?? 0,
                    line.newNo ?? line.oldNo ?? 0,
                  )
                }
                aria-label="Draft revision request for selected code"
                data-tooltip="Draft revision request"
                className="flex h-6 w-6 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
              >
                <RefreshCw size={12} />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {draftHere ? (
        <CommentDraftRow
          value={commentDraft?.text ?? ""}
          onChange={onCommentDraftChange}
          onSubmit={onSubmitComment}
          onCancel={onCancelComment}
        />
      ) : null}
      {commentsHere.length > 0 ? (
        <div className="border-l-2 pl-2" style={{ borderColor: "var(--border-default)" }}>
          {commentsHere.map((c) => (
            <div key={c.id} className="flex flex-col gap-0.5 py-1 px-2 text-xs" >
              <span className="text-secondary">{c.body}</span>
              <span className="font-mono text-tertiary text-xs" >
                {c.at}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────── Split row view ─────────────────────────────────

/**
 * Renders a single split-mode row (paired left/right DiffLine). Used
 * inside the virtualized {@link DiffBody}.
 */
function SplitRowView({
  left,
  right,
  path,
  comments,
  commentDraft,
  onLineClick,
  onCommentDraftChange,
  onSubmitComment,
  onCancelComment,
  onAskAgentRevise,
  changeIdx,
  focused,
  registerChangeLine,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  path: string;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; anchor: DiffCommentAnchor; text: string } | null;
  onLineClick: (path: string, lineNo: number, anchor: DiffCommentAnchor) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  changeIdx: number;
  focused: boolean;
  registerChangeLine: (index: number, element: HTMLDivElement | null) => void;
}): JSX.Element {
  const isChange = (left?.kind === "del") || (right?.kind === "add");
  const leftLineNo = left?.oldNo ?? 0;
  const rightLineNo = right?.newNo ?? 0;
  const leftDraftHere = commentDraft !== null
    && commentDraft.path === path
    && commentDraft.lineNo === leftLineNo
    && commentDraft.anchor === "old";
  const rightDraftHere = commentDraft !== null
    && commentDraft.path === path
    && commentDraft.lineNo === rightLineNo
    && commentDraft.anchor === "new";
  const leftComments = comments.filter(
    (comment) => comment.filePath === path && comment.lineNo === leftLineNo && comment.anchor === "old",
  );
  const rightComments = comments.filter(
    (comment) => comment.filePath === path && comment.lineNo === rightLineNo && comment.anchor === "new",
  );
  const hasAnnotations = leftDraftHere || rightDraftHere || leftComments.length > 0 || rightComments.length > 0;

  return (
    <div>
      <div
        ref={(el) => {
          if (isChange && changeIdx >= 0) {
            registerChangeLine(changeIdx, el);
          }
        }}
        data-testid="split-code-row"
        className={cn("group flex items-stretch hover:bg-hover", focused && "ring-1 ring-inset")}
        tabIndex={isChange ? (focused ? 0 : -1) : undefined}
        role="group"
        aria-label={splitRowAccessibleLabel(left, right)}
        style={{
          background: focused
            ? "color-mix(in srgb, var(--action-primary) 8%, transparent)"
            : undefined,
        }}
      >
        <SplitSideView
          line={left}
          side="left"
          path={path}
          onLineClick={onLineClick}
          onAskAgentRevise={onAskAgentRevise}
        />
        <div style={{ width: 1, background: "var(--border-default)" }} />
        <SplitSideView
          line={right}
          side="right"
          path={path}
          onLineClick={onLineClick}
          onAskAgentRevise={onAskAgentRevise}
        />
      </div>
      {hasAnnotations ? (
        <div
          data-testid="split-comment-thread"
          className="flex border-t border-subtle bg-elevated"
        >
          <SplitAnnotationColumn
            side="Old"
            draftActive={leftDraftHere}
            draftValue={leftDraftHere ? commentDraft.text : ""}
            comments={leftComments}
            onCommentDraftChange={onCommentDraftChange}
            onSubmitComment={onSubmitComment}
            onCancelComment={onCancelComment}
          />
          <div style={{ width: 1, background: "var(--border-default)" }} />
          <SplitAnnotationColumn
            side="New"
            draftActive={rightDraftHere}
            draftValue={rightDraftHere ? commentDraft.text : ""}
            comments={rightComments}
            onCommentDraftChange={onCommentDraftChange}
            onSubmitComment={onSubmitComment}
            onCancelComment={onCancelComment}
          />
        </div>
      ) : null}
    </div>
  );
}

function SplitSideView({
  line,
  side,
  path,
  onLineClick,
  onAskAgentRevise,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  path: string;
  onLineClick: (path: string, lineNo: number, anchor: DiffCommentAnchor) => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
}): JSX.Element {
  const no = side === "left" ? line?.oldNo : line?.newNo;
  const lineNo = no ?? 0;
  const anchor: DiffCommentAnchor = side === "left" ? "old" : "new";

  return (
    <div className="group flex flex-1 items-stretch">
      <span
        aria-hidden
        className="flex-shrink-0 select-none text-tertiary text-xs"
        style={{ width: 48, padding: "0 8px", textAlign: "right" }}
      >
        {no ?? ""}
      </span>
      <span
        aria-hidden
        className="flex-shrink-0 select-none px-1"
        style={{
          width: 18,
          textAlign: "center",
          color:
            line?.kind === "add"
              ? "var(--color-addition)"
              : line?.kind === "del"
                ? "var(--color-deletion)"
                : "var(--text-tertiary)",
        }}
      >
        {line?.kind === "add" ? "+" : line?.kind === "del" ? "-" : " "}
      </span>
      <code
        aria-hidden="true"
        className={[cn(
          "flex-1 whitespace-pre select-text group hover:bg-hover",
          line?.kind === "add" && "diff-add",
          line?.kind === "del" && "diff-del",
          line?.kind === "context" && "diff-context",
        ), "text-sm"].filter(Boolean).join(" ")}
        style={{ padding: "0 8px" }}
      >
        {line ? line.text || " " : ""}
      </code>
      {line && line.kind !== "hunk-header" ? (
        <div
          className="flex flex-shrink-0 items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          style={{ transition: "opacity var(--duration-fast) var(--easing-default)" }}
        >
          <Button
            type="button"
            onClick={() => onLineClick(path, lineNo, anchor)}
            aria-label="Add comment"
            data-tooltip="Add comment"
            className="flex h-6 w-6 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
          >
            <MessageSquarePlus size={12} />
          </Button>
          {(line.kind === "add" || line.kind === "del") && onAskAgentRevise ? (
            <Button
              type="button"
              onClick={() =>
                onAskAgentRevise(path, line.oldNo ?? line.newNo ?? 0, line.newNo ?? line.oldNo ?? 0)
              }
              aria-label="Draft revision request for selected code"
              data-tooltip="Draft revision request"
              className="flex h-6 w-6 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              <RefreshCw size={12} />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SplitAnnotationColumn({
  side,
  draftActive,
  draftValue,
  comments,
  onCommentDraftChange,
  onSubmitComment,
  onCancelComment,
}: {
  side: "Old" | "New";
  draftActive: boolean;
  draftValue: string;
  comments: DiffComment[];
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
}): JSX.Element {
  return (
    <div className="min-w-0 flex-1 pl-[66px]" aria-label={`${side} side review notes`}>
      {draftActive ? (
        <CommentDraftRow
          value={draftValue}
          onChange={onCommentDraftChange}
          onSubmit={onSubmitComment}
          onCancel={onCancelComment}
        />
      ) : null}
      {comments.length > 0 ? (
        <div className="border-l-2 pl-2" style={{ borderColor: "var(--border-default)" }}>
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="flex flex-col gap-0.5 px-2 py-1 text-xs"

            >
              <span className="text-secondary">{comment.body}</span>
              <span className="font-mono text-tertiary text-xs" >
                {comment.at}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────── Comment draft ───────────────────────────────────

function CommentDraftRow({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      className="border-l-2 px-2 py-2"
      style={{ borderColor: "var(--action-primary)", background: "var(--bg-elevated)" }}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Add a comment…"
        aria-label="Comment draft"
        maxLength={4096}
        className="ui-input selectable w-full resize-none rounded-sm bg-canvas px-2 py-1 text-xs text-primary placeholder:text-tertiary"
        style={{ minHeight: 44, border: "1px solid var(--border-subtle)" }}
        rows={2}
      />
      <div className="mt-1 flex items-center justify-end gap-1 text-xs" >
        <Button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-secondary hover:bg-hover hover:text-primary"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onSubmit}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-primary"
          style={{ background: "var(--action-primary)", color: "var(--text-inverse)" }}
        >
          <Clipboard size={10} />
          <span>Comment</span>
        </Button>
      </div>
    </div>
  );
}
