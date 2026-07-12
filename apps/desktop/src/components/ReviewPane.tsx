import { memo, useMemo, useState } from "react";
import { FileDiff, PanelRightClose, Send } from "lucide-react";
import { DiffViewer, parseUnifiedDiff } from "./DiffViewer";
import { EmptyState } from "./EmptyState";
import { extractUnifiedDiffs } from "../lib/task-surface";
import type { DiffComment } from "./DiffViewer";
import type { TerminusSseEvent } from "../types";

interface ReviewPaneProps {
  events: TerminusSseEvent[];
  onClose: () => void;
  onDraftRevision: (instruction: string) => void;
}

function ReviewPaneImpl({ events, onClose, onDraftRevision }: ReviewPaneProps): JSX.Element {
  const [comments, setComments] = useState<DiffComment[]>([]);
  const files = useMemo(
    () => extractUnifiedDiffs(events).flatMap((diff) => parseUnifiedDiff(diff)),
    [events],
  );

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-diff" aria-label="Changes review">
      <header className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-default px-3">
        <FileDiff size={15} className="text-secondary" />
        <span className="text-primary" style={{ fontSize: "var(--font-size-sm)", fontWeight: 600 }}>
          Changes
        </span>
        <span className="font-mono text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
          {files.length === 0 ? "waiting for patch evidence" : `${files.length} ${files.length === 1 ? "file" : "files"}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
          aria-label="Close changes"
          title="Close changes"
        >
          <PanelRightClose size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        {files.length === 0 ? (
          <EmptyState
            icon={<FileDiff size={17} />}
            title="No reviewable changes yet"
            description="Patch evidence will appear here as the agent updates the workspace."
            compact
          />
        ) : (
          <DiffViewer
            files={files}
            comments={comments}
            onAddComment={(filePath, lineNo, body) => {
              setComments((current) => [
                ...current,
                { id: `${filePath}:${lineNo}:${Date.now()}`, filePath, lineNo, body, at: new Date().toISOString() },
              ]);
            }}
            onAskAgentRevise={(filePath, lineStart, lineEnd) => {
              onDraftRevision(`Please revise ${filePath} around lines ${lineStart}-${lineEnd}. Keep the current task scope and explain the change before applying it.`);
            }}
          />
        )}
      </div>
      {comments.length > 0 ? (
        <footer className="flex flex-shrink-0 items-center gap-2 border-t border-default px-3 py-2 text-secondary" style={{ fontSize: "var(--font-size-xs)" }}>
          <Send size={13} />
          <span>{comments.length} {comments.length === 1 ? "review note" : "review notes"} ready.</span>
          <button
            type="button"
            onClick={() => {
              const note = comments.map((comment) => `- ${comment.filePath}:${comment.lineNo} — ${comment.body}`).join("\n");
              onDraftRevision(`Please address this code review feedback:\n${note}`);
            }}
            className="ml-auto rounded-sm px-2 py-1 text-primary hover:bg-hover"
          >
            Add to composer
          </button>
        </footer>
      ) : null}
    </section>
  );
}

export const ReviewPane = memo(ReviewPaneImpl);
