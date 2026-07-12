import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const SPLIT_KEY = "terminus-desktop.review-split.v1";
const MIN_PERCENT = 32;
const MAX_PERCENT = 68;
const DEFAULT_PERCENT = 47;

function readSplit(): number {
  if (typeof window === "undefined") return DEFAULT_PERCENT;
  const stored = window.localStorage.getItem(SPLIT_KEY);
  if (stored === null) return DEFAULT_PERCENT;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, value)) : DEFAULT_PERCENT;
}

function persistSplit(value: number): void {
  try {
    window.localStorage.setItem(SPLIT_KEY, String(Math.round(value * 10) / 10));
  } catch {
    // The split remains functional when storage is unavailable.
  }
}

interface ResizableReviewLayoutProps {
  conversation: ReactNode;
  review: ReactNode;
}

function ResizableReviewLayoutImpl({ conversation, review }: ResizableReviewLayoutProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [conversationPercent, setConversationPercent] = useState(readSplit);

  const updateFromClientX = useCallback((clientX: number): void => {
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const next = ((clientX - bounds.left) / bounds.width) * 100;
    setConversationPercent(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, next)));
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (draggingRef.current) updateFromClientX(event.clientX);
    };
    const onUp = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setConversationPercent((current) => {
        persistSplit(current);
        return current;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [updateFromClientX]);

  return (
    <div
      ref={containerRef}
      className="grid h-full min-w-0"
      style={{ gridTemplateColumns: `${conversationPercent}% 6px minmax(0, 1fr)` }}
      data-testid="review-split"
    >
      <div className="min-w-0 overflow-hidden">{conversation}</div>
      <div
        role="separator"
        aria-label="Resize conversation and review panes"
        aria-orientation="vertical"
        aria-valuemin={MIN_PERCENT}
        aria-valuemax={MAX_PERCENT}
        aria-valuenow={Math.round(conversationPercent)}
        tabIndex={0}
        className="group relative cursor-col-resize bg-transparent focus:outline-none"
        onMouseDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          updateFromClientX(event.clientX);
        }}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 5 : 2;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setConversationPercent((current) => {
            const next = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, current + (event.key === "ArrowRight" ? delta : -delta)));
            persistSplit(next);
            return next;
          });
        }}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-default transition-colors group-hover:bg-strong" />
      </div>
      <div className="min-w-0 overflow-hidden">{review}</div>
    </div>
  );
}

export const ResizableReviewLayout = memo(ResizableReviewLayoutImpl);
