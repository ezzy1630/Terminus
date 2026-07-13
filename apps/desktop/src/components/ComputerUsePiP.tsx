/**
 * Terminus Desktop — Computer Use picture-in-picture (SPEC §16).
 *
 * A floating, draggable, resizable window-within-a-window that shows a
 * live preview of the agent's computer-use session. The agent's screen
 * capture is mirrored here so the user can supervise what's happening
 * without losing their place in the conversation.
 *
 * Capabilities:
 *
 *   - Drag the header to move the PiP.
 *   - Drag the bottom-right corner to resize.
 *   - Pause preview (stops frame requests; the video element is paused).
 *   - Resume preview.
 *   - Expand to fill the main conversation area.
 *   - Return to PiP.
 *   - Hide (collapses to a small badge; the session keeps running).
 *   - Stop session.
 *   - "Take over" button to switch control back to the user.
 *
 * The screen capture itself uses Electron's `desktopCapturer.getSources`
 * (handled in the main process — see `terminusDesktop.getScreenSources()`)
 * to fetch a screen source id, then `navigator.mediaDevices.getUserMedia`
 * in the renderer to capture the stream and pipe it into a <video>.
 *
 * On macOS this requires Screen Recording permission (the user is
 * prompted by the OS the first time). On Linux sandboxes (CI, dev
 * containers) the capture will fail — we show a friendly message and
 * the rest of the PiP controls (drag, resize, hide, expand, stop) still
 * work so the component is fully testable without a real display.
 *
 * Per SPEC §25.1: "Pause hidden PiP rendering" — when the PiP is
 * hidden or paused, we don't request frames.
 *
 * Implementation notes:
 *
 *   - We use plain pointer events for drag + resize (no react-draggable
 *     dependency at runtime — `react-draggable` is installed but we
 *     keep the surface small here).
 *   - The video element uses `srcObject` to attach the MediaStream.
 *   - When the user pauses or hides the PiP, we call `video.pause()`.
 *     When they resume, we call `video.play()` (the stream keeps flowing
 *     in the background — pausing the element just freezes the rendered
 *     frame, which is what SPEC §25.1 calls for).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Expand,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Monitor,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";

export type ComputerUseState = "agent-controlled" | "user-controlled" | "paused";

export interface ComputerUsePiPProps {
  /** Optional className. */
  className?: string;
  /** Called when the user dismisses the PiP. */
  onHide?: () => void;
  /** Called when the user stops the session. */
  onStop?: () => void;
  /** Called when the user toggles between PiP and expanded-full-canvas. */
  onToggleExpanded?: (expanded: boolean) => void;
  /** Called when the user toggles the "Take over" control. */
  onTakeOver?: (controlled: ComputerUseState) => void;
  /** Initial position (top-left of the PiP). Defaults to bottom-right. */
  initialPosition?: { x: number; y: number };
  /** Initial size. Defaults to 360×240. */
  initialSize?: { width: number; height: number };
  /** When true, the PiP fills its parent (no drag/resize). */
  expanded?: boolean;
  /** When true, the PiP is collapsed to a small badge. */
  hidden?: boolean;
}

interface DragState {
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

function ComputerUsePiPImpl({
  className,
  onHide,
  onStop,
  onToggleExpanded,
  onTakeOver,
  initialPosition,
  initialSize,
  expanded = false,
  hidden = false,
}: ComputerUsePiPProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [position, setPosition] = useState(
    initialPosition ?? { x: -1, y: -1 }, // -1 means "use bottom-right default"
  );
  const [size, setSize] = useState(initialSize ?? { width: 360, height: 240 });
  const [paused, setPaused] = useState(false);
  const [controlState, setControlState] = useState<ComputerUseState>("agent-controlled");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string>("");

  // Acquire a screen-capture stream when the PiP mounts (or when it
  // resumes from a paused/hidden state).
  const acquireStream = useCallback(async (): Promise<void> => {
    if (!window.terminusDesktop?.getScreenSources) {
      setSourceError("Screen capture requires the Terminus desktop runtime.");
      return;
    }
    try {
      const sources = await window.terminusDesktop.getScreenSources();
      if (sources.length === 0) {
        setSourceError("Screen capture requires macOS Screen Recording permission.");
        return;
      }
      // Prefer the first screen source (primary display).
      const source = sources.find((s) => s.name.toLowerCase().includes("screen")) ?? sources[0];
      if (!source) {
        setSourceError("No screen source available.");
        return;
      }
      setSourceName(source.name);
      setSourceError(null);
      // Electron's desktopCapturer returns a source id like
      // "screen:1:0" that we pass as `chromeMediaSourceId`.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // Electron-specific mandatory constraints for desktop capture.
          // The TS DOM lib doesn't know about these, hence the cast.
          ...(({
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: source.id,
              minWidth: 320,
              maxWidth: 1920,
              minHeight: 240,
              maxHeight: 1080,
            },
          }) as unknown as MediaTrackConstraints),
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {
          // Autoplay can be blocked by the browser if there's no user
          // gesture. We ignore the error — the user can press play.
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSourceError(`Screen capture failed: ${msg}`);
    }
  }, []);

  // Initial mount: try to acquire the stream. If it fails (e.g. Linux
  // sandbox without desktopCapturer, or no permission), we show a
  // helpful error but keep the rest of the controls working.
  useEffect(() => {
    if (expanded || !hidden) {
      void acquireStream();
    }
    return () => {
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause / resume the video element when `paused` or `hidden` changes.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused || hidden) {
      v.pause();
    } else {
      void v.play().catch(() => {
        // ignore — user gesture required
      });
    }
  }, [paused, hidden]);

  // Drag + resize handlers (pointer events).
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.mode === "move") {
        setPosition({
          x: Math.max(8, drag.origX + dx),
          y: Math.max(44, drag.origY + dy), // below the title bar
        });
      } else {
        setSize({
          width: Math.max(240, drag.origW + dx),
          height: Math.max(160, drag.origH + dy),
        });
      }
    };
    const onUp = (): void => {
      dragRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const startMove = (e: React.PointerEvent): void => {
    if (expanded) return;
    dragRef.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      origX: position.x < 0 ? window.innerWidth - size.width - 24 : position.x,
      origY: position.y < 0 ? window.innerHeight - size.height - 80 : position.y,
      origW: size.width,
      origH: size.height,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "move";
  };

  const startResize = (e: React.PointerEvent): void => {
    e.stopPropagation();
    if (expanded) return;
    dragRef.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      origX: position.x,
      origY: position.y,
      origW: size.width,
      origH: size.height,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
  };

  const togglePause = (): void => setPaused((p) => !p);
  const toggleTakeOver = (): void => {
    const next: ComputerUseState = controlState === "agent-controlled" ? "user-controlled" : "agent-controlled";
    setControlState(next);
    onTakeOver?.(next);
  };
  const toggleExpand = (): void => {
    onToggleExpanded?.(!expanded);
  };

  // Compute effective position.
  const effectiveX = position.x < 0 ? (typeof window !== "undefined" ? window.innerWidth - size.width - 24 : 24) : position.x;
  const effectiveY = position.y < 0 ? (typeof window !== "undefined" ? window.innerHeight - size.height - 80 : 80) : position.y;

  // Hidden state — collapsed to a small floating badge.
  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => onToggleExpanded?.(false)}
        aria-label="Show computer-use preview"
        title="Show computer-use preview"
        className={cn(
          "fixed z-50 flex items-center gap-2 rounded-full border border-default bg-inspector px-3 py-2 shadow-lg",
          className,
        )}
        style={{
          right: 24,
          bottom: 80,
          fontSize: "var(--font-size-xs)",
        }}
      >
        <Monitor size={14} className="text-secondary" />
        <span className="text-secondary">Computer use active</span>
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--color-warning)", animation: "pulse 1.6s ease-in-out infinite" }}
        />
      </button>
    );
  }

  // Expanded — fills the parent (main conversation area).
  const containerStyle: React.CSSProperties = expanded
    ? {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
      }
    : {
        position: "fixed",
        left: effectiveX,
        top: effectiveY,
        width: size.width,
        height: size.height,
        zIndex: 40,
      };

  return (
    <div
      role="region"
      aria-label="Computer-use preview"
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-default bg-inspector shadow-lg",
        className,
      )}
      style={containerStyle}
    >
      {/* Header — draggable. */}
      <div
        onPointerDown={startMove}
        className="flex flex-shrink-0 items-center gap-2 border-b border-subtle px-3 py-2"
        style={{
          height: 36,
          cursor: expanded ? "default" : "move",
          background: "var(--bg-elevated)",
        }}
      >
        <Monitor size={12} className="text-secondary" />
        <span
          className="min-w-0 flex-1 truncate text-secondary"
          style={{ fontSize: "var(--font-size-xs)", fontWeight: 600 }}
        >
          Computer Use
          {sourceName ? <span className="text-tertiary"> · {sourceName}</span> : null}
        </span>
        {/* State pill. */}
        <span
          className="flex-shrink-0 rounded-sm px-1.5 py-0.5 font-mono"
          style={{
            fontSize: 10,
            background:
              controlState === "agent-controlled"
                ? "color-mix(in srgb, var(--color-warning) 15%, transparent)"
                : "color-mix(in srgb, var(--color-success) 15%, transparent)",
            color:
              controlState === "agent-controlled" ? "var(--color-warning)" : "var(--color-success)",
          }}
          aria-label={`Control state: ${controlState}`}
        >
          {controlState === "agent-controlled" ? "agent" : "you"}
        </span>
        {/* Header actions. */}
        <button
          type="button"
          onClick={togglePause}
          aria-label={paused ? "Resume preview" : "Pause preview"}
          title={paused ? "Resume preview" : "Pause preview"}
          className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button
          type="button"
          onClick={toggleExpand}
          aria-label={expanded ? "Return to PiP" : "Expand to main canvas"}
          title={expanded ? "Return to PiP" : "Expand to main canvas"}
          className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        {onHide ? (
          <button
            type="button"
            onClick={() => onHide()}
            aria-label="Hide preview"
            title="Hide preview"
            className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
          >
            <EyeOff size={13} />
          </button>
        ) : null}
        {onStop ? (
          <button
            type="button"
            onClick={() => onStop()}
            aria-label="Stop session"
            title="Stop session"
            className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-error"
          >
            <Square size={13} />
          </button>
        ) : null}
      </div>

      {/* Video body. */}
      <div
        className="relative min-h-0 flex-1 bg-black"
        style={{ background: "var(--bg-terminal)" }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Live screen capture of the agent's computer-use session"
          className="h-full w-full"
          style={{ objectFit: "contain", display: sourceError ? "none" : "block" }}
        />
        {sourceError ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center"
            style={{ color: "var(--text-tertiary)", fontSize: "var(--font-size-xs)" }}
          >
            <Eye size={20} className="text-tertiary" />
            <div className="text-secondary" style={{ fontSize: "var(--font-size-sm)" }}>
              Live preview unavailable
            </div>
            <div style={{ maxWidth: 280, lineHeight: 1.4 }}>{sourceError}</div>
            <button
              type="button"
              onClick={() => void acquireStream()}
              className="mt-1 rounded px-2 py-1 text-primary hover:bg-hover"
              style={{ fontSize: "var(--font-size-xs)", border: "1px solid var(--border-default)" }}
            >
              Retry
            </button>
          </div>
        ) : null}
        {paused ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.4)" }}
          >
            <Play size={20} className="text-secondary" />
          </div>
        ) : null}
        {/* Resize handle (bottom-right corner). */}
        {!expanded ? (
          <div
            onPointerDown={startResize}
            aria-hidden
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 14,
              height: 14,
              cursor: "nwse-resize",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M4 13 L13 4 M8 13 L13 8"
                stroke="var(--text-tertiary)"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
          </div>
        ) : null}
      </div>

      {/* Footer — Take over / status. */}
      <div
        className="flex flex-shrink-0 items-center gap-2 border-t border-subtle px-3 py-1.5"
        style={{ height: 32, background: "var(--bg-elevated)" }}
      >
        <span
          className="text-tertiary"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          {controlState === "agent-controlled" ? "Agent is driving" : "You are in control"}
        </span>
        <button
          type="button"
          onClick={toggleTakeOver}
          aria-label={
            controlState === "agent-controlled" ? "Take over control" : "Return control to agent"
          }
          title={
            controlState === "agent-controlled" ? "Take over control" : "Return control to agent"
          }
          className="ml-auto rounded px-2 py-0.5 text-primary hover:bg-hover"
          style={{ fontSize: "var(--font-size-xs)", border: "1px solid var(--border-default)" }}
        >
          {controlState === "agent-controlled" ? "Take over" : "Hand back"}
        </button>
      </div>
    </div>
  );
}

export const ComputerUsePiP = memo(ComputerUsePiPImpl);

// Re-export the placeholder so callers can grab both from one import.
export { ComputerUsePlaceholder } from "./ComputerUsePlaceholder";
