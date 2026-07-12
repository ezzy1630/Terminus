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
 *   - "Ask agent to revise selected code" button
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
 * accessible keyboard navigation (j/k for next/prev change, [/] for
 * prev/next file, ? for shortcuts), restrained motion (150-250ms),
 * both dark + light themes polished equally.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  MessageSquarePlus,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "../lib/cn";
import { EmptyState } from "./EmptyState";

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

export interface DiffComment {
  /** Stable id. */
  id: string;
  /** File path the comment is attached to. */
  filePath: string;
  /** New-file line number the comment is anchored to. */
  lineNo: number;
  /** Comment body. */
  body: string;
  /** ISO timestamp. */
  at: string;
}

export interface DiffViewerProps {
  /** Files to render. */
  files: DiffFile[];
  /** Comments keyed by `${filePath}:${lineNo}`. Caller owns storage. */
  comments?: DiffComment[];
  /** Optional callback when a comment is added. */
  onAddComment?: (filePath: string, lineNo: number, body: string) => void;
  /** Optional callback when "Ask agent to revise" is clicked. */
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
  const [commentDraft, setCommentDraft] = useState<{ path: string; lineNo: number; text: string } | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [resolvedHunks, setResolvedHunks] = useState<Record<string, "accept" | "reject">>({});
  const [focusIndex, setFocusIndex] = useState(0);

  const selectedFile = useMemo(
    () => files.find((f) => (f.displayPath ?? f.newPath) === selectedPath) ?? null,
    [files, selectedPath],
  );

  // A flat list of change lines for next/prev navigation.
  const changeLineRefs = useRef<Array<HTMLDivElement | null>>([]);
  changeLineRefs.current = [];

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
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "j") {
        e.preventDefault();
        setFocusIndex((i) => Math.min(changeLineRefs.current.length - 1, i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setFocusIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "[") {
        e.preventDefault();
        const idx = files.findIndex((f) => (f.displayPath ?? f.newPath) === selectedPath);
        if (idx > 0) {
          const prev = files[idx - 1];
          if (prev) setSelectedPath(prev.displayPath ?? prev.newPath);
        }
      } else if (e.key === "]") {
        e.preventDefault();
        const idx = files.findIndex((f) => (f.displayPath ?? f.newPath) === selectedPath);
        if (idx >= 0 && idx < files.length - 1) {
          const next = files[idx + 1];
          if (next) setSelectedPath(next.displayPath ?? next.newPath);
        }
      } else if (e.key === "u" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setViewMode((m) => (m === "unified" ? "split" : "unified"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files, selectedPath]);

  // Focus the change line on focusIndex change.
  useEffect(() => {
    const el = changeLineRefs.current[focusIndex];
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusIndex]);

  const onLineClick = useCallback((path: string, lineNo: number): void => {
    setCommentDraft({ path, lineNo, text: "" });
  }, []);

  const submitComment = useCallback((): void => {
    if (!commentDraft) return;
    const body = commentDraft.text.trim();
    if (body.length === 0) {
      setCommentDraft(null);
      return;
    }
    onAddComment?.(commentDraft.path, commentDraft.lineNo, body);
    setCommentDraft(null);
  }, [commentDraft, onAddComment]);

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
      className={cn("flex h-full min-h-0 bg-diff", className)}
      role="region"
      aria-label="Diff viewer"
    >
      {!hideFileNav ? (
        <FileNav
          files={filteredFiles}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          query={query}
          onQueryChange={setQuery}
          collapsed={collapsedFiles}
          onToggleCollapse={(p) =>
            setCollapsedFiles((prev) => {
              const next = new Set(prev);
              if (next.has(p)) next.delete(p);
              else next.add(p);
              return next;
            })
          }
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <DiffHeader
          file={selectedFile}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onOpenInEditor={onOpenInEditor}
          onOpenInTerminal={onOpenInTerminal}
          onRevealInFinder={onRevealInFinder}
          onRestore={onRestore}
          focusIndex={focusIndex}
          changeCount={changeLineRefs.current.length}
          onFocusIndexChange={setFocusIndex}
        />
        {selectedFile ? (
          <DiffBody
            file={selectedFile}
            viewMode={viewMode}
            comments={comments}
            commentDraft={commentDraft}
            onLineClick={onLineClick}
            onCommentDraftChange={(text) =>
              setCommentDraft((d) => (d ? { ...d, text } : null))
            }
            onSubmitComment={submitComment}
            onCancelComment={() => setCommentDraft(null)}
            onAskAgentRevise={onAskAgentRevise}
            onHunkResolve={(hunkKey, decision) => {
              if (!selectedFile) return;
              const key = `${selectedFile.displayPath ?? selectedFile.newPath}:${hunkKey}`;
              setResolvedHunks((prev) => ({ ...prev, [key]: decision }));
              onHunkResolve?.(selectedFile.displayPath ?? selectedFile.newPath, hunkKey, decision);
            }}
            onRestore={(hunkKey) =>
              onRestore?.({
                kind: "hunk",
                filePath: selectedFile.displayPath ?? selectedFile.newPath,
                hunkKey,
              })
            }
            resolvedHunks={resolvedHunks}
            changeLineRefs={changeLineRefs}
            focusIndex={focusIndex}
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
  collapsed,
  onToggleCollapse,
}: {
  files: DiffFile[];
  selectedPath: string | null;
  onSelect: (p: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  collapsed: Set<string>;
  onToggleCollapse: (p: string) => void;
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
      className="flex h-full flex-shrink-0 flex-col border-r border-default bg-elevated"
      style={{ width: 260, minWidth: 200 }}
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
            className="flex-1 bg-transparent text-primary placeholder:text-tertiary focus:outline-none"
            style={{ fontSize: "var(--font-size-xs)" }}
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Clear filter"
              className="text-tertiary hover:text-primary"
            >
              <X size={11} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-y-auto py-1">
        {groups.map(([groupName, groupFiles]) => (
          <div key={groupName} className="px-1">
            <div
              className="px-2 py-1 text-tertiary"
              style={{ fontSize: "var(--font-size-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}
            >
              {groupName}
            </div>
            {groupFiles.map((f) => {
              const path = f.displayPath ?? f.newPath;
              const isSel = path === selectedPath;
              const { additions, deletions } = countChanges(f);
              const isCollapsed = collapsed.has(path);
              const fileName = path.split("/").pop() ?? path;
              const dirPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              return (
                <div key={path}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(path)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(path);
                      }
                    }}
                    aria-current={isSel}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left hover:bg-hover",
                      isSel && "bg-selected",
                    )}
                    style={{ fontSize: "var(--font-size-xs)" }}
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
                      title={path}
                    >
                      <span className={cn("truncate text-primary", isSel && "font-medium")}>
                        {fileName}
                      </span>
                      {dirPath ? (
                        <span className="truncate text-tertiary" style={{ fontSize: 10 }}>
                          {dirPath}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-1 font-mono">
                      {additions > 0 ? (
                        <span className="text-success" style={{ fontSize: 10 }}>
                          +{additions}
                        </span>
                      ) : null}
                      {deletions > 0 ? (
                        <span className="text-error" style={{ fontSize: 10 }}>
                          -{deletions}
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleCollapse(path);
                      }}
                      aria-label={isCollapsed ? "Expand file" : "Collapse file"}
                      className="text-tertiary hover:text-primary"
                      style={{ marginLeft: 2 }}
                    >
                      {isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {files.length === 0 ? (
          <div className="px-3 py-4 text-center text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
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
  viewMode,
  onViewModeChange,
  onOpenInEditor,
  onOpenInTerminal,
  onRevealInFinder,
  onRestore,
  focusIndex,
  changeCount,
  onFocusIndexChange,
}: {
  file: DiffFile | null;
  viewMode: DiffViewMode;
  onViewModeChange: (m: DiffViewMode) => void;
  onOpenInEditor?: (p: string) => void;
  onOpenInTerminal?: (p: string) => void;
  onRevealInFinder?: (p: string) => void;
  onRestore?: (target: { kind: "file" | "hunk"; filePath: string; hunkKey?: string }) => void;
  focusIndex: number;
  changeCount: number;
  onFocusIndexChange: (i: number) => void;
}): JSX.Element {
  const path = file ? (file.displayPath ?? file.newPath) : "";
  return (
    <div
      className="flex flex-shrink-0 items-center gap-2 border-b border-default bg-elevated px-3 py-2"
      style={{ height: 40 }}
    >
      <Folder size={12} className="text-tertiary" />
      <span
        className="selectable truncate font-mono text-primary"
        style={{ fontSize: "var(--font-size-xs)" }}
        title={path}
      >
        {path || "No file selected"}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {/* Prev / next change. */}
        <button
          type="button"
          onClick={() => onFocusIndexChange(Math.max(0, focusIndex - 1))}
          disabled={changeCount === 0}
          aria-label="Previous change"
          title="Previous change (k)"
          className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
        >
          <ChevronDown size={12} style={{ transform: "rotate(180deg)" }} />
        </button>
        <button
          type="button"
          onClick={() => onFocusIndexChange(Math.min(changeCount - 1, focusIndex + 1))}
          disabled={changeCount === 0}
          aria-label="Next change"
          title="Next change (j)"
          className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
        >
          <ChevronDown size={12} />
        </button>
        <div className="mx-1 h-4 w-px" style={{ background: "var(--border-subtle)" }} />
        {/* View mode toggle. */}
        <div
          role="group"
          aria-label="Diff view mode"
          className="flex items-center rounded-md"
          style={{ background: "var(--bg-canvas)", border: "1px solid var(--border-subtle)" }}
        >
          <ViewModeButton
            label="Unified"
            active={viewMode === "unified"}
            onClick={() => onViewModeChange("unified")}
          />
          <ViewModeButton
            label="Split"
            active={viewMode === "split"}
            onClick={() => onViewModeChange("split")}
          />
        </div>
        <div className="mx-1 h-4 w-px" style={{ background: "var(--border-subtle)" }} />
        {/* Actions. */}
        <HeaderIconButton
          icon={<Copy size={12} />}
          label="Copy file path"
          disabled={!file}
          onClick={() => file && navigator.clipboard?.writeText(path)}
        />
        <HeaderIconButton
          icon={<Pencil size={12} />}
          label="Open in editor"
          disabled={!file || !onOpenInEditor}
          onClick={() => file && onOpenInEditor?.(path)}
        />
        <HeaderIconButton
          icon={<TerminalIcon size={12} />}
          label="Open in terminal"
          disabled={!file || !onOpenInTerminal}
          onClick={() => file && onOpenInTerminal?.(path)}
        />
        <HeaderIconButton
          icon={<ExternalLink size={12} />}
          label="Reveal in Finder"
          disabled={!file || !onRevealInFinder}
          onClick={() => file && onRevealInFinder?.(path)}
        />
        <HeaderIconButton
          icon={<RotateCcw size={12} />}
          label="Restore file"
          disabled={!file || !onRestore}
          onClick={() =>
            file &&
            onRestore?.({ kind: "file", filePath: path })
          }
        />
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
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-sm px-2 py-0.5 text-secondary hover:text-primary",
        active && "bg-hover text-primary",
      )}
      style={{ fontSize: "var(--font-size-xs)" }}
    >
      {label}
    </button>
  );
}

function HeaderIconButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
    >
      {icon}
    </button>
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
  resolvedHunks,
  changeLineRefs,
  focusIndex,
}: {
  file: DiffFile;
  viewMode: DiffViewMode;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; text: string } | null;
  onLineClick: (path: string, lineNo: number) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  onHunkResolve: (hunkKey: string, decision: "accept" | "reject") => void;
  onRestore?: (hunkKey: string) => void;
  resolvedHunks: Record<string, "accept" | "reject">;
  changeLineRefs: React.MutableRefObject<Array<HTMLDivElement | null>>;
  focusIndex: number;
}): JSX.Element {
  const path = file.displayPath ?? file.newPath;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { rows, changeRowIndices } = useMemo(
    () => buildDiffRows(file, viewMode, path, resolvedHunks),
    [file, viewMode, path, resolvedHunks],
  );

  // Virtualizer — only visible rows are mounted. Per SPEC §25.1: large
  // diffs (10k+ lines) must remain interactive. Each line is ~20px.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const row = rows[i];
      if (!row) return 24;
      if (row.kind === "hunk-header") return 28;
      if (row.kind === "hunk-resolution") return 28;
      return 20;
    },
    overscan: 16,
  });

  // Keep changeLineRefs in sync with the virtualized rows that are
  // currently mounted. The parent (DiffViewerImpl) reads this array to
  // navigate j/k. With virtualization only visible rows have refs, so
  // the j/k handler falls back to `virtualizer.scrollToIndex` (below).
  useEffect(() => {
    changeLineRefs.current = changeLineRefs.current.slice(0, changeRowIndices.length);
  }, [changeLineRefs, changeRowIndices.length]);

  // When focusIndex changes, scroll the matching change row into view.
  // With virtualization we can't rely on `scrollIntoView` for off-screen
  // rows, so we ask the virtualizer to bring the row into view first.
  useEffect(() => {
    if (focusIndex < 0 || focusIndex >= changeRowIndices.length) return;
    const rowIndex = changeRowIndices[focusIndex];
    if (rowIndex === undefined) return;
    virtualizer.scrollToIndex(rowIndex, { align: "center" });
    // After the virtual row mounts, scroll the inner element into view
    // for the focus ring + browser semantics.
    window.setTimeout(() => {
      const el = changeLineRefs.current[focusIndex];
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
  }, [focusIndex, changeRowIndices, virtualizer]);

  if (file.binary) {
    return (
      <div className="flex flex-1 items-center justify-center text-tertiary" style={{ fontSize: "var(--font-size-sm)" }}>
        Binary file — no line-level diff.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="selectable min-h-0 flex-1 overflow-auto bg-diff font-mono"
      role="region"
      aria-label={`Diff body for ${path}`}
    >
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
              key={vi.key}
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
                focusIndex={focusIndex}
                changeLineRefs={changeLineRefs}
              />
            </div>
          );
        })}
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
  focusIndex,
  changeLineRefs,
}: {
  row: DiffRow;
  path: string;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; text: string } | null;
  onLineClick: (path: string, lineNo: number) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  onHunkResolve: (hunkKey: string, decision: "accept" | "reject") => void;
  onRestore?: (hunkKey: string) => void;
  focusIndex: number;
  changeLineRefs: React.MutableRefObject<Array<HTMLDivElement | null>>;
}): JSX.Element {
  if (row.kind === "hunk-header") {
    const hunk = row.hunk;
    return (
      <div className="border-b border-subtle">
        <div
          className="diff-line diff-hunk-header flex items-center gap-2"
          style={{
            padding: "4px 12px",
            fontSize: "var(--font-size-xs)",
            background: "var(--bg-diff)",
          }}
        >
          <span className="text-secondary">{hunk.header}</span>
          {hunk.group ? (
            <span
              className="rounded-sm bg-hover px-1.5 py-0.5 text-tertiary"
              style={{ fontSize: 10 }}
            >
              {hunk.group}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {/* Restore hunk. */}
            <button
              type="button"
              onClick={() => onRestore?.(hunk.key)}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-tertiary hover:bg-hover hover:text-primary"
              style={{ fontSize: 10 }}
              title="Restore hunk"
              aria-label={`Restore hunk ${hunk.header}`}
            >
              <RotateCcw size={10} />
              <span>Restore</span>
            </button>
            {/* Reject. */}
            <button
              type="button"
              onClick={() => onHunkResolve(hunk.key, "reject")}
              disabled={row.resolution === "reject"}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-tertiary hover:text-error disabled:opacity-50"
              style={{ fontSize: 10 }}
              title="Reject this change"
              aria-label={`Reject hunk ${hunk.header}`}
            >
              <X size={10} />
              <span>Reject</span>
            </button>
            {/* Accept. */}
            <button
              type="button"
              onClick={() => onHunkResolve(hunk.key, "accept")}
              disabled={row.resolution === "accept"}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-tertiary hover:text-success disabled:opacity-50"
              style={{ fontSize: 10 }}
              title="Accept this change"
              aria-label={`Accept hunk ${hunk.header}`}
            >
              <Check size={10} />
              <span>Accept</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (row.kind === "hunk-resolution") {
    const resolution = row.resolution;
    return (
      <div
        className="flex items-center gap-2 px-3 py-1"
        style={{
          fontSize: "var(--font-size-xs)",
          color: resolution === "accept" ? "var(--color-success)" : "var(--color-error)",
          background:
            resolution === "accept"
              ? "color-mix(in srgb, var(--color-success) 6%, transparent)"
              : "color-mix(in srgb, var(--color-error) 6%, transparent)",
        }}
      >
        <Check size={10} />
        <span>{resolution === "accept" ? "Accepted" : "Rejected"}</span>
        <button
          type="button"
          onClick={() => onHunkResolve(row.hunk.key, resolution === "accept" ? "reject" : "accept")}
          className="ml-auto text-tertiary hover:text-primary"
          style={{ fontSize: 10 }}
        >
          Undo
        </button>
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
        changeLineRefs={changeLineRefs}
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
      changeLineRefs={changeLineRefs}
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
  changeLineRefs,
}: {
  line: DiffLine;
  path: string;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; text: string } | null;
  onLineClick: (path: string, lineNo: number) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  changeIdx: number;
  focused: boolean;
  changeLineRefs: React.MutableRefObject<Array<HTMLDivElement | null>>;
}): JSX.Element {
  const isChange = line.kind === "add" || line.kind === "del";
  const lineNo = line.newNo ?? line.oldNo ?? 0;
  const draftHere =
    commentDraft && commentDraft.path === path && commentDraft.lineNo === lineNo;
  const commentsHere = comments.filter(
    (c) => c.filePath === path && c.lineNo === lineNo,
  );
  return (
    <div>
      <div
        ref={(el) => {
          if (isChange && changeIdx >= 0) {
            changeLineRefs.current[changeIdx] = el;
          }
        }}
        className={cn(
          "diff-line group flex items-stretch hover:bg-hover",
          line.kind === "add" && "diff-add",
          line.kind === "del" && "diff-del",
          line.kind === "context" && "diff-context",
          focused && "ring-1 ring-inset",
        )}
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
          className="flex-shrink-0 select-none text-tertiary"
          style={{
            width: 48,
            padding: "0 8px",
            textAlign: "right",
            borderRight: "1px solid var(--border-subtle)",
            fontSize: "var(--font-size-xs)",
          }}
        >
          {line.oldNo ?? ""}
        </span>
        <span
          aria-hidden
          className="flex-shrink-0 select-none text-tertiary"
          style={{
            width: 48,
            padding: "0 8px",
            textAlign: "right",
            borderRight: "1px solid var(--border-subtle)",
            fontSize: "var(--font-size-xs)",
          }}
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
          className="flex-1 whitespace-pre select-text"
          style={{ padding: "0 8px", fontSize: "var(--font-size-sm)" }}
          aria-label={
            isChange
              ? `${line.kind === "add" ? "Added" : "Removed"} line ${line.newNo ?? line.oldNo ?? ""}`
              : undefined
          }
        >
          {line.text || " "}
        </code>
        {/* Hover actions. */}
        {line.kind !== "hunk-header" && (line.newNo ?? line.oldNo) !== null ? (
          <div
            className="flex flex-shrink-0 items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100"
            style={{ transition: "opacity var(--duration-fast) var(--easing-default)" }}
          >
            <button
              type="button"
              onClick={() => onLineClick(path, lineNo)}
              aria-label="Add comment"
              title="Add comment"
              className="flex h-5 w-5 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              <MessageSquarePlus size={11} />
            </button>
            {isChange && onAskAgentRevise ? (
              <button
                type="button"
                onClick={() =>
                  onAskAgentRevise(
                    path,
                    line.oldNo ?? line.newNo ?? 0,
                    line.newNo ?? line.oldNo ?? 0,
                  )
                }
                aria-label="Ask agent to revise selected code"
                title="Ask agent to revise"
                className="flex h-5 w-5 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
              >
                <RefreshCw size={11} />
              </button>
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
            <div key={c.id} className="flex flex-col gap-0.5 py-1 px-2" style={{ fontSize: "var(--font-size-xs)" }}>
              <span className="text-secondary">{c.body}</span>
              <span className="font-mono text-tertiary" style={{ fontSize: 10 }}>
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
  changeLineRefs,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  path: string;
  comments: DiffComment[];
  commentDraft: { path: string; lineNo: number; text: string } | null;
  onLineClick: (path: string, lineNo: number) => void;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  changeIdx: number;
  focused: boolean;
  changeLineRefs: React.MutableRefObject<Array<HTMLDivElement | null>>;
}): JSX.Element {
  const isChange = (left?.kind === "del") || (right?.kind === "add");
  return (
    <div
      ref={(el) => {
        if (isChange && changeIdx >= 0) {
          changeLineRefs.current[changeIdx] = el;
        }
      }}
      className={cn("flex items-stretch hover:bg-hover", focused && "ring-1 ring-inset")}
      style={{
        background: focused
          ? "color-mix(in srgb, var(--color-primary) 8%, transparent)"
          : undefined,
      }}
    >
      <SplitSideView
        line={left}
        side="left"
        path={path}
        onLineClick={onLineClick}
        onAskAgentRevise={onAskAgentRevise}
        commentDraft={commentDraft}
        onCommentDraftChange={onCommentDraftChange}
        onSubmitComment={onSubmitComment}
        onCancelComment={onCancelComment}
        comments={comments}
      />
      <div style={{ width: 1, background: "var(--border-default)" }} />
      <SplitSideView
        line={right}
        side="right"
        path={path}
        onLineClick={onLineClick}
        onAskAgentRevise={onAskAgentRevise}
        commentDraft={commentDraft}
        onCommentDraftChange={onCommentDraftChange}
        onSubmitComment={onSubmitComment}
        onCancelComment={onCancelComment}
        comments={comments}
      />
    </div>
  );
}

function SplitSideView({
  line,
  side,
  path,
  onLineClick,
  onAskAgentRevise,
  commentDraft,
  onCommentDraftChange,
  onSubmitComment,
  onCancelComment,
  comments,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  path: string;
  onLineClick: (path: string, lineNo: number) => void;
  onAskAgentRevise?: (filePath: string, lineStart: number, lineEnd: number) => void;
  commentDraft: { path: string; lineNo: number; text: string } | null;
  onCommentDraftChange: (text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  comments: DiffComment[];
}): JSX.Element {
  const no = side === "left" ? line?.oldNo : line?.newNo;
  const lineNo = no ?? 0;
  const draftHere = commentDraft && commentDraft.path === path && commentDraft.lineNo === lineNo;
  const commentsHere = comments.filter((c) => c.filePath === path && c.lineNo === lineNo);

  return (
    <div className="flex flex-1 items-stretch">
      <span
        aria-hidden
        className="flex-shrink-0 select-none text-tertiary"
        style={{
          width: 48,
          padding: "0 8px",
          textAlign: "right",
          fontSize: "var(--font-size-xs)",
        }}
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
        className={cn(
          "flex-1 whitespace-pre select-text group hover:bg-hover",
          line?.kind === "add" && "diff-add",
          line?.kind === "del" && "diff-del",
          line?.kind === "context" && "diff-context",
        )}
        style={{ padding: "0 8px", fontSize: "var(--font-size-sm)" }}
      >
        {line ? line.text || " " : ""}
      </code>
      {line && line.kind !== "hunk-header" ? (
        <div
          className="flex flex-shrink-0 items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100"
          style={{ transition: "opacity var(--duration-fast) var(--easing-default)" }}
        >
          <button
            type="button"
            onClick={() => onLineClick(path, lineNo)}
            aria-label="Add comment"
            title="Add comment"
            className="flex h-5 w-5 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
          >
            <MessageSquarePlus size={11} />
          </button>
          {(line.kind === "add" || line.kind === "del") && onAskAgentRevise ? (
            <button
              type="button"
              onClick={() =>
                onAskAgentRevise(path, line.oldNo ?? line.newNo ?? 0, line.newNo ?? line.oldNo ?? 0)
              }
              aria-label="Ask agent to revise selected code"
              title="Ask agent to revise"
              className="flex h-5 w-5 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
            >
              <RefreshCw size={11} />
            </button>
          ) : null}
        </div>
      ) : null}
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
            <div key={c.id} className="flex flex-col gap-0.5 py-1 px-2" style={{ fontSize: "var(--font-size-xs)" }}>
              <span className="text-secondary">{c.body}</span>
              <span className="font-mono text-tertiary" style={{ fontSize: 10 }}>
                {c.at}
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
      style={{ borderColor: "var(--color-primary)", background: "var(--bg-elevated)" }}
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
        className="selectable w-full resize-none rounded-sm bg-canvas px-2 py-1 text-primary placeholder:text-tertiary focus:outline-none"
        style={{
          fontSize: "var(--font-size-xs)",
          minHeight: 44,
          border: "1px solid var(--border-subtle)",
        }}
        rows={2}
      />
      <div className="mt-1 flex items-center justify-end gap-1" style={{ fontSize: "var(--font-size-xs)" }}>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-secondary hover:bg-hover hover:text-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-primary"
          style={{ background: "var(--color-primary)", color: "var(--text-inverse)" }}
        >
          <Clipboard size={10} />
          <span>Comment</span>
        </button>
      </div>
    </div>
  );
}
