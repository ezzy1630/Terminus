/**
 * Terminus Desktop — Layout shell.
 *
 * Per SPEC §6: adaptive three-region structure with native integrated
 * title bar, persistent left sidebar, primary conversation/working
 * surface, and dynamic right inspector.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ Native integrated title bar (draggable, 40px)                │
 * ├──────────┬───────────────────────────────┬───────────────────┤
 * │ Left     │ Main conversation and working surface              │
 * │ sidebar  │                          ╭─ Dynamic inspector ─╮  │
 * └──────────┴───────────────────────────────┴───────────────────┘
 *
 * The shell stays desktop-native at every supported window size: columns are
 * docked and both separators can be resized without a phone/rail layout.
 *
 * Per SPEC §5: title bar uses `-webkit-app-region: drag` so the whole
 * bar is draggable; controls inside it opt out with `no-drag`. macOS
 * traffic lights live in the top-left ~80px (we leave that space).
 */
import { memo, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useThemeStore } from "../hooks/use-theme";
import type { ReactNode } from "react";

interface LayoutProps {
  sidebar: ReactNode;
  sidebarVisible?: boolean;
  main: ReactNode;
  inspector: ReactNode;
  /** Hides the contextual inspector when a technical split needs the width. */
  inspectorVisible?: boolean;
  /** Optional content for the right side of the title bar (view controls). */
  right?: ReactNode;
  /**
   * Controls that belong to the sidebar, rendered in the title bar's sidebar
   * band beside the traffic lights. A left-panel toggle sitting at the far
   * right edge pointed away from the thing it controlled.
   */
  left?: ReactNode;
  /** Optional content for the center of the title bar. */
  center?: ReactNode;
  /**
   * Slim full-width strip rendered directly under the title bar (used for
   * offline / reconnecting state). Stays out of the drag region.
   */
  banner?: ReactNode;
  /** Makes the shell unavailable to pointer and assistive input behind a modal. */
  backgroundInert?: boolean;
}

const TITLEBAR_HEIGHT = 40;
const TRAFFIC_LIGHTS_PAD = 80;
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 184;
const SIDEBAR_MAX_WIDTH = 320;
const INSPECTOR_DEFAULT_WIDTH = 280;
const INSPECTOR_MIN_WIDTH = 232;
const INSPECTOR_MAX_WIDTH = 380;
const MIN_MAIN_WIDTH = 360;
const RESIZE_HANDLE_WIDTH = 4;
// The task-centered shell uses a narrower range than the retired cockpit.
// Version the preference so an old 380px admin-sidebar setting cannot make
// the new workspace open at the wrong density.
// v4: the default moved 224 → 256 so two-line task titles fit. A stored v3
// width would otherwise pin existing installs to the old, too-narrow rail.
const SIDEBAR_WIDTH_KEY = "terminus-desktop.sidebar-width.v4";
const INSPECTOR_WIDTH_KEY = "terminus-desktop.inspector-width.v2";
interface TitleBarProps {
  center?: ReactNode;
  right?: ReactNode;
  left?: ReactNode;
}

const TitleBar = memo(function TitleBar({
  center,
  right,
  left,
}: TitleBarProps): JSX.Element {
  return (
    <div
      className="titlebar-shell titlebar-drag flex items-center justify-between"
      style={{
        height: TITLEBAR_HEIGHT,
        // Leave space for macOS traffic lights on the left.
        paddingLeft: TRAFFIC_LIGHTS_PAD + 4,
        paddingRight: 12,
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      {/* Sidebar-owned controls, inside the sidebar band. */}
      <div
        className="titlebar-actions titlebar-no-drag flex items-center gap-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {left}
      </div>
      <div className="flex-1" aria-hidden />
      {/* Context belongs beside the sidebar, matching native document title bars. */}
      <div data-testid="titlebar-center" className="titlebar-center flex min-w-0 items-center">
        {center}
      </div>
      {/* Right region — contextual view toggles. The inline app-region repeats
          the class so the exemption survives even if utility-class ordering
          changes; Electron only honours the computed value. */}
      <div
        className="titlebar-actions titlebar-no-drag flex items-center gap-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {right}
      </div>
    </div>
  );
});

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
  main,
  inspector,
  inspectorVisible = true,
  right,
  center,
  left,
  banner,
  backgroundInert = false,
}: LayoutProps): JSX.Element {
  const density = useThemeStore((s) => s.density);
  const [sidebarWidth, setSidebarWidth] = useState(() => readWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
  const [inspectorWidth, setInspectorWidth] = useState(() => readWidth(INSPECTOR_WIDTH_KEY, INSPECTOR_DEFAULT_WIDTH, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH));
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const fittedDocks = fitDockWidths({
    viewportWidth,
    sidebarVisible,
    inspectorVisible,
    preferredSidebarWidth: sidebarWidth,
    preferredInspectorWidth: inspectorWidth,
  });
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
      className="app-shell flex h-full w-full flex-col bg-canvas text-primary"
      style={{
        fontFamily: "var(--font-family)",
        "--titlebar-sidebar-width": sidebarVisible ? `${fittedDocks.sidebarWidth}px` : "0px",
      } as React.CSSProperties}
    >
      <TitleBar
        left={left ?? null}
        center={center ?? null}
        right={right}
      />

      {banner ?? null}

      {/* Three-region body. */}
      <div className="flex min-h-0 flex-1">
        {/* Sidebar. */}
        {sidebarVisible ? <aside
          className={cn(
            "flex h-full flex-col border-r bg-sidebar",
            density === "compact" && "py-0",
          )}
          style={{
            borderColor: 'var(--sidebar-separator)',
            width: fittedDocks.sidebarWidth,
            minWidth: fittedDocks.sidebarWidth,
            flexShrink: 0,
          }}
        >
          {sidebar}
        </aside> : null}

        {sidebarVisible ? (
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
        <main className="app-content flex min-w-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">{main}</div>
          </section>

          {inspectorVisible ? (
            <>
              <ResizeHandle
                testId="inspector-resize-handle"
                label="Resize inspector"
                value={fittedDocks.inspectorWidth}
                min={INSPECTOR_MIN_WIDTH}
                max={inspectorResizeMax}
                direction="left"
                onChange={resizeInspector}
              />
              <div
                data-testid="inspector-dock"
                data-layout="docked"
                className="flex h-full shrink-0 flex-col"
                style={{ width: fittedDocks.inspectorWidth }}
              >
                {/* A docked native inspector: flat surface, hairline seam.
                    The floating rounded glass card read as web chrome. */}
                <aside
                  className="inspector-card flex h-full min-h-0 flex-col overflow-hidden border-l"
                  style={{ borderColor: "var(--sidebar-separator)" }}
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
