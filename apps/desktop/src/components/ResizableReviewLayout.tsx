import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";

const SPLIT_KEY = "terminus-desktop.review-split.v1";
const MIN_PERCENT = 32;
const MAX_PERCENT = 68;
const DEFAULT_PERCENT = 47;
const MIN_SPLIT_CONTAINER_WIDTH = 1_100;

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
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const windowResizeCleanupRef = useRef<(() => void) | null>(null);
  const [conversationPercent, setConversationPercent] = useState(readSplit);
  const [compactPane, setCompactPane] = useState<"conversation" | "review">("review");
  const [containerWidth, setContainerWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const compactTabRefs = useRef<Record<"conversation" | "review", HTMLButtonElement | null>>({ conversation: null, review: null });

  const attachContainer = useCallback((container: HTMLDivElement | null): void => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    windowResizeCleanupRef.current?.();
    windowResizeCleanupRef.current = null;
    containerRef.current = container;
    if (!container) return;
    const update = (width: number): void => {
      setContainerWidth((current) => Math.abs(current - width) < 1 ? current : width);
    };
    const measure = (): void => {
      const measuredWidth = container.getBoundingClientRect().width;
      update(measuredWidth > 0 ? measuredWidth : window.innerWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    windowResizeCleanupRef.current = () => window.removeEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(container);
    resizeObserverRef.current = observer;
  }, []);

  useEffect(() => () => {
    resizeObserverRef.current?.disconnect();
    windowResizeCleanupRef.current?.();
  }, []);

  const updateFromClientX = useCallback((clientX: number): void => {
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const next = ((clientX - bounds.left) / bounds.width) * 100;
    setConversationPercent(Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, next)));
  }, []);

  const compact = containerWidth < MIN_SPLIT_CONTAINER_WIDTH;

  return (
    <div
      ref={attachContainer}
      className={compact ? "flex h-full min-w-0 flex-col" : "grid h-full min-w-0"}
      style={compact ? undefined : { gridTemplateColumns: `${conversationPercent}% 8px minmax(0, 1fr)` }}
      data-testid={compact ? "review-tabs" : "review-split"}
    >
      {compact ? (
        <div className="flex flex-shrink-0 border-b border-default bg-elevated p-1" role="tablist" aria-label="Task and changes">
          {(["conversation", "review"] as const).map((pane) => (
            <Button
              key={pane}
              ref={(element) => { compactTabRefs.current[pane] = element; }}
              id={`review-tab-${pane}`}
              type="button"
              role="tab"
              aria-selected={compactPane === pane}
              aria-controls={`review-panel-${pane}`}
              tabIndex={compactPane === pane ? 0 : -1}
              onClick={() => setCompactPane(pane)}
              onKeyDown={(event) => {
                const target = event.key === "Home" || event.key === "ArrowLeft"
                  ? "conversation"
                  : event.key === "End" || event.key === "ArrowRight"
                    ? "review"
                    : null;
                if (!target) return;
                event.preventDefault();
                setCompactPane(target);
                compactTabRefs.current[target]?.focus();
              }}
              className={[compactPane === pane ? "rounded-md bg-selected px-3 py-1 text-primary" : "rounded-md px-3 py-1 text-secondary hover:bg-hover", "text-sm"].filter(Boolean).join(" ")}

            >
              {pane === "conversation" ? "Task" : "Changes"}
            </Button>
          ))}
        </div>
      ) : null}
      <div
        key="conversation-pane"
        id="review-panel-conversation"
        role={compact ? "tabpanel" : undefined}
        aria-labelledby={compact ? "review-tab-conversation" : undefined}
        hidden={compact && compactPane !== "conversation"}
        className={compact ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-w-0 overflow-hidden"}
      >
        {conversation}
      </div>
      {!compact ? (
        <div
          role="separator"
          aria-label="Resize conversation and review panes"
          aria-orientation="vertical"
          aria-valuemin={MIN_PERCENT}
          aria-valuemax={MAX_PERCENT}
          aria-valuenow={Math.round(conversationPercent)}
          tabIndex={0}
          className="group relative cursor-col-resize bg-transparent"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            updateFromClientX(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromClientX(event.clientX);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            setConversationPercent((current) => {
              persistSplit(current);
              return current;
            });
          }}
          onDoubleClick={() => {
            setConversationPercent(DEFAULT_PERCENT);
            persistSplit(DEFAULT_PERCENT);
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
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-default transition-colors group-hover:bg-strong group-focus-visible:bg-strong" />
        </div>
      ) : null}
      <div
        key="review-pane"
        id="review-panel-review"
        role={compact ? "tabpanel" : undefined}
        aria-labelledby={compact ? "review-tab-review" : undefined}
        hidden={compact && compactPane !== "review"}
        className={compact ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-w-0 overflow-hidden"}
      >
        {review}
      </div>
    </div>
  );
}

export const ResizableReviewLayout = memo(ResizableReviewLayoutImpl);
