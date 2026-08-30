/**
 * Terminus Desktop — Layout shell.
 *
 * Per SPEC §6: adaptive three-region structure with a persistent left
 * sidebar, primary conversation/working surface, and dynamic right inspector.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ Left     │ Main conversation and working surface              │
 * │ sidebar  │                          ╭─ Dynamic inspector ─╮  │
 * └──────────┴───────────────────────────────┴───────────────────┘
 *
 * The shell stays desktop-native at every supported window size: columns are
 * docked and both separators can be resized without a phone/rail layout.
 *
 * Per SPEC §5: a small drag target remains over the sidebar material. It does
 * not consume a full application row; controls inside it opt out with
 * `no-drag`, and macOS traffic lights keep their native inset.
 */
import { memo, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useThemeStore } from "../hooks/use-theme";
import type { ReactNode } from "react";

interface LayoutProps {
  sidebar: ReactNode;
  sidebarVisible?: boolean;
  /** Overlay the sidebar at narrow widths while a technical surface is open. */
  sidebarOverlay?: boolean;
  main: ReactNode;
  inspector: ReactNode;
  /** Hides the contextual inspector when a technical split needs the width. */
  inspectorVisible?: boolean;
  /** Native-window control floated beside the traffic lights without a toolbar. */
  windowControl?: ReactNode;
  /**
   * Slim full-width strip used for offline / reconnecting state.
   */
  banner?: ReactNode;
  /** Makes the shell unavailable to pointer and assistive input behind a modal. */
  backgroundInert?: boolean;
}

const SIDEBAR_DEFAULT_WIDTH = 276;
const SIDEBAR_MIN_WIDTH = 264;
const SIDEBAR_MAX_WIDTH = 360;
const INSPECTOR_DEFAULT_WIDTH = 320;
const INSPECTOR_MIN_WIDTH = 260;
const INSPECTOR_MAX_WIDTH = 420;
const MIN_MAIN_WIDTH = 360;
const RESIZE_HANDLE_WIDTH = 4;
// The task-centered shell uses a narrower range than the retired cockpit.
// Version the preference so an old 380px admin-sidebar setting cannot make
// the new workspace open at the wrong density.
// v4: the default moved 224 → 256 so two-line task titles fit. A stored v3
// width would otherwise pin existing installs to the old, too-narrow rail.
const SIDEBAR_WIDTH_KEY = "terminus-desktop.sidebar-width.v5";
const INSPECTOR_WIDTH_KEY = "terminus-desktop.inspector-width.v3";
function readWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function fitDockWidths({
  viewportWidth,
  sidebarVisible,
  inspectorVisible,
  preferredSidebarWidth,
  preferredInspectorWidth,
}: {
  viewportWidth: number;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  preferredSidebarWidth: number;
  preferredInspectorWidth: number;
}): { sidebarWidth: number; inspectorWidth: number; dockBudget: number } {
  let sidebarWidth = sidebarVisible ? preferredSidebarWidth : 0;
  let inspectorWidth = inspectorVisible ? preferredInspectorWidth : 0;
  const handleWidth = Number(sidebarVisible) * RESIZE_HANDLE_WIDTH
    + Number(inspectorVisible) * RESIZE_HANDLE_WIDTH;
  const dockBudget = Math.max(0, viewportWidth - MIN_MAIN_WIDTH - handleWidth);
  let excess = Math.max(0, sidebarWidth + inspectorWidth - dockBudget);

  if (inspectorVisible && excess > 0) {
    const reduction = Math.min(excess, inspectorWidth - INSPECTOR_MIN_WIDTH);
    inspectorWidth -= reduction;
    excess -= reduction;
  }
  if (sidebarVisible && excess > 0) {
    const reduction = Math.min(excess, sidebarWidth - SIDEBAR_MIN_WIDTH);
    sidebarWidth -= reduction;
  }

  return { sidebarWidth, inspectorWidth, dockBudget };
}

interface ResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  direction: "left" | "right";
  testId: string;
  onChange: (value: number) => void;
}

function ResizeHandle({ label, value, min, max, direction, testId, onChange }: ResizeHandleProps): JSX.Element {
  const dragStart = useRef<{ clientX: number; value: number } | null>(null);
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (!dragStart.current) return;
      const delta = event.clientX - dragStart.current.clientX;
      const signedDelta = direction === "right" ? delta : -delta;
      onChange(Math.min(max, Math.max(min, dragStart.current.value + signedDelta)));
    };
    const onUp = (): void => {
      dragStart.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [direction, max, min, onChange]);

  return (
    <div
      data-testid={testId}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      className="titlebar-no-drag h-full w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-strong focus-visible:bg-strong"
      onPointerDown={(event) => {
        dragStart.current = { clientX: event.clientX, value };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.shiftKey ? 32 : 8;
        const delta = event.key === "ArrowRight" ? step : -step;
        onChange(Math.min(max, Math.max(min, value + (direction === "right" ? delta : -delta))));
      }}
    />
  );
}

function LayoutImpl({
  sidebar,
  sidebarVisible = true,
  sidebarOverlay = false,
  main,
  inspector,
  inspectorVisible = true,
  windowControl,
  banner,
  backgroundInert = false,
}: LayoutProps): JSX.Element {
  const density = useThemeStore((s) => s.density);
  const [sidebarWidth, setSidebarWidth] = useState(() => readWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
  const [inspectorWidth, setInspectorWidth] = useState(() => readWidth(INSPECTOR_WIDTH_KEY, INSPECTOR_DEFAULT_WIDTH, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const useSidebarOverlay = sidebarVisible && sidebarOverlay && viewportWidth < 1080;
  const useInspectorOverlay = inspectorVisible && viewportWidth < 1200;
  const fittedDocks = fitDockWidths({
    viewportWidth,
    sidebarVisible: sidebarVisible && !useSidebarOverlay,
    inspectorVisible: inspectorVisible && !useInspectorOverlay,
    preferredSidebarWidth: sidebarWidth,
    preferredInspectorWidth: inspectorWidth,
  });
  const renderedSidebarWidth = useSidebarOverlay ? sidebarWidth : fittedDocks.sidebarWidth;
  const renderedInspectorWidth = useInspectorOverlay ? Math.min(inspectorWidth, 360) : fittedDocks.inspectorWidth;
  const sidebarResizeMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      fittedDocks.dockBudget - (inspectorVisible ? INSPECTOR_MIN_WIDTH : 0),
    ),
  );
  const inspectorResizeMax = Math.max(
    INSPECTOR_MIN_WIDTH,
    Math.min(
      INSPECTOR_MAX_WIDTH,
      fittedDocks.dockBudget - (sidebarVisible ? SIDEBAR_MIN_WIDTH : 0),
    ),
  );
  const resizeSidebar = (nextWidth: number): void => {
    setSidebarWidth(nextWidth);
    if (inspectorVisible && nextWidth + inspectorWidth > fittedDocks.dockBudget) {
      setInspectorWidth(Math.max(INSPECTOR_MIN_WIDTH, fittedDocks.dockBudget - nextWidth));
    }
  };
  const resizeInspector = (nextWidth: number): void => {
    setInspectorWidth(nextWidth);
    if (sidebarVisible && sidebarWidth + nextWidth > fittedDocks.dockBudget) {
      setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, fittedDocks.dockBudget - nextWidth));
    }
  };

  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);
  useEffect(() => {
    try { window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth)); } catch {}
  }, [inspectorWidth]);
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return (
    <div
      inert={backgroundInert ? true : undefined}
      data-sidebar-visible={sidebarVisible}
      className="app-shell relative flex h-full w-full flex-col bg-canvas text-primary"
      style={{
        fontFamily: "var(--font-family)",
        "--window-drag-width": sidebarVisible ? `${renderedSidebarWidth}px` : "124px",
      } as React.CSSProperties}
    >
      <div className="window-drag-zone" aria-hidden />
      {windowControl ? (
        <div className="window-control titlebar-no-drag">
          {windowControl}
        </div>
      ) : null}

      {banner ?? null}

      {/* Three-region body. */}
      <div className="relative flex min-h-0 flex-1">
        {/* Sidebar. */}
        {sidebarVisible ? <aside
          className={cn(
            "flex h-full flex-col border-r bg-sidebar",
            density === "compact" && "py-0",
            useSidebarOverlay && "absolute inset-y-0 left-0 z-30 shadow-2xl",
          )}
          style={{
            borderColor: 'var(--sidebar-separator)',
            width: renderedSidebarWidth,
            minWidth: renderedSidebarWidth,
            flexShrink: 0,
          }}
        >
          {sidebar}
        </aside> : null}

        {sidebarVisible && !useSidebarOverlay ? (
          <ResizeHandle
            testId="sidebar-resize-handle"
            label="Resize sidebar"
            value={fittedDocks.sidebarWidth}
            min={SIDEBAR_MIN_WIDTH}
            max={sidebarResizeMax}
            direction="right"
            onChange={resizeSidebar}
          />
        ) : null}

        {/* Main working surface and a docked, resizable inspector. */}
        <main className={cn("app-content relative flex min-w-0 flex-1", !sidebarVisible && "app-content-sidebar-hidden")}>
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">{main}</div>
          </section>

          {inspectorVisible ? (
            <>
              {!useInspectorOverlay ? (
                <ResizeHandle
                  testId="inspector-resize-handle"
                  label="Resize inspector"
                  value={fittedDocks.inspectorWidth}
                  min={INSPECTOR_MIN_WIDTH}
                  max={inspectorResizeMax}
                  direction="left"
                  onChange={resizeInspector}
                />
              ) : null}
              <div
                data-testid="inspector-dock"
                data-layout={useInspectorOverlay ? "overlay" : "docked"}
                className={cn(
                  "inspector-dock flex h-full shrink-0 flex-col",
                  useInspectorOverlay && "absolute inset-y-0 right-0 z-30 shadow-2xl",
                )}
                style={{ width: renderedInspectorWidth }}
              >
                {/* One contextual surface, inset from the transcript. It is
                    still a docked region: resizing and persistence belong to
                    the shell, while the rounded outer edge makes the optional
                    context legible as one thing rather than another app rail. */}
                <aside
                  className="inspector-card flex h-full min-h-0 flex-col overflow-hidden border"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  {inspector}
                </aside>
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

export const Layout = memo(LayoutImpl);
