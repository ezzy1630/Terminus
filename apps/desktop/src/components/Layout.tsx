/**
 * Forge Desktop — Layout shell.
 *
 * Per SPEC §6: adaptive three-region structure with native integrated
 * title bar, persistent left sidebar, primary conversation/working
 * surface, dynamic right inspector, and an optional resizable
 * terminal drawer at the bottom.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ Native integrated title bar (draggable, 44px)                │
 * ├──────────┬───────────────────────────────┬───────────────────┤
 * │ Left     │ Main conversation             │ Dynamic inspector │
 * │ sidebar  │ and working surface           │ (contextual)      │
 * ├──────────┴───────────────────────────────┴───────────────────┤
 * │ Optional resizable terminal drawer (hidden by default)       │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Progressive collapse (SPEC §6):
 *   < 1100px → narrow sidebar (compact-width token)
 *   < 900px  → inspector becomes floating overlay
 *   < 700px  → sidebar collapses to a 56px rail
 *
 * Per SPEC §5: title bar uses `-webkit-app-region: drag` so the whole
 * bar is draggable; controls inside it opt out with `no-drag`. macOS
 * traffic lights live in the top-left ~80px (we leave that space).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { cn } from "../lib/cn";
import { useViewport } from "../hooks/use-viewport";
import { useThemeStore } from "../hooks/use-theme";
import { TerminalDrawer, StubTerminalSessionFactory } from "./TerminalDrawer";
import type { ReactNode } from "react";

interface LayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  inspector: ReactNode;
  /** Optional content for the right side of the title bar (theme, density, etc.). */
  right?: ReactNode;
  /** Optional content for the center of the title bar. */
  center?: ReactNode;
  /** Initial terminal drawer open state. SPEC: "hidden by default." */
  terminalInitiallyOpen?: boolean;
}

const TITLEBAR_HEIGHT = 44;
const TRAFFIC_LIGHTS_PAD = 80;
const TERMINAL_MIN_HEIGHT = 120;
const TERMINAL_DEFAULT_HEIGHT = 240;
const TERMINAL_MAX_HEIGHT_RATIO = 0.6;

interface TitleBarProps {
  center?: ReactNode;
  right?: ReactNode;
  onToggleTerminal?: () => void;
  terminalOpen: boolean;
}

const TitleBar = memo(function TitleBar({
  center,
  right,
  onToggleTerminal,
  terminalOpen,
}: TitleBarProps): JSX.Element {
  return (
    <div
      className="titlebar-drag flex items-center justify-between border-b border-subtle bg-sidebar"
      style={{
        height: TITLEBAR_HEIGHT,
        // Leave space for macOS traffic lights on the left.
        paddingLeft: TRAFFIC_LIGHTS_PAD,
        paddingRight: 12,
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      {/* Center region — application/section title. */}
      <div className="titlebar-no-drag flex min-w-0 flex-1 items-center justify-center">
        {center}
      </div>
      {/* Right region — view toggles, theme controls. */}
      <div className="titlebar-no-drag flex items-center gap-1">
        {right}
        <button
          type="button"
          onClick={onToggleTerminal}
          aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
          title={terminalOpen ? "Hide terminal" : "Show terminal"}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover",
            terminalOpen && "text-primary bg-hover",
          )}
        >
          {terminalOpen ? <PanelBottomClose size={15} /> : <PanelBottomOpen size={15} />}
        </button>
      </div>
    </div>
  );
});

// Layout delegates the in-drawer chrome (tabs, search, clear, copy, body)
// to the standalone <TerminalDrawer /> component. Layout still owns the
// resize handle + open/close + ⌘` shortcut, per SPEC §6 + §15.
interface LayoutTerminalDrawerProps {
  open: boolean;
  height: number;
  onResize: (h: number) => void;
  onClose: () => void;
}

const LayoutTerminalDrawer = memo(function LayoutTerminalDrawer({
  open,
  height,
  onResize,
  onClose,
}: LayoutTerminalDrawerProps): JSX.Element {
  const dragRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent): void => {
      if (!startRef.current) return;
      const dy = startRef.current.y - e.clientY;
      const max = Math.floor(window.innerHeight * TERMINAL_MAX_HEIGHT_RATIO);
      const next = Math.min(max, Math.max(TERMINAL_MIN_HEIGHT, startRef.current.h + dy));
      onResize(next);
    };
    const onUp = (): void => {
      startRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [open, onResize]);

  if (!open) return <></>;

  return (
    <>
      {/* Resize handle — sits above the drawer, draggable. */}
      <div
        ref={dragRef}
        onMouseDown={(e) => {
          startRef.current = { y: e.clientY, h: height };
          document.body.style.userSelect = "none";
          document.body.style.cursor = "row-resize";
        }}
        style={{ height: 4, cursor: "row-resize", flexShrink: 0 }}
        className="bg-transparent hover:bg-strong"
        aria-hidden
      />
      <TerminalDrawer
        open={open}
        height={height - 4}
        onClose={onClose}
        onResize={onResize}
        sessionFactory={stubFactory}
      />
    </>
  );
});

// A single stub factory instance — real integrations pass their own.
// Memoized at module scope so it survives Layout re-renders.
const stubFactory = new StubTerminalSessionFactory();

function LayoutImpl({
  sidebar,
  main,
  inspector,
  right,
  center,
  terminalInitiallyOpen = false,
}: LayoutProps): JSX.Element {
  const vp = useViewport();
  const density = useThemeStore((s) => s.density);

  const [terminalOpen, setTerminalOpen] = useState(terminalInitiallyOpen);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);

  // Sidebar width: rail (56px) at < 700, compact token at < 1100, full token otherwise.
  const sidebarWidth = vp.sidebarRail
    ? 56
    : vp.narrowSidebar
      ? "var(--sidebar-width-compact)"
      : "var(--sidebar-width)";

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((o) => !o);
  }, []);

  // Keyboard: Cmd/Ctrl + ` toggles terminal (common macOS convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setTerminalOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="flex h-full w-full flex-col bg-canvas text-primary"
      style={{ fontFamily: "var(--font-family)" }}
    >
      <TitleBar
        terminalOpen={terminalOpen}
        onToggleTerminal={toggleTerminal}
        center={
          center ?? (
            <div className="flex items-center gap-2 text-xs text-tertiary">
              <span className="font-medium tracking-tight text-secondary">Forge</span>
            </div>
          )
        }
        right={right}
      />

      {/* Three-region body. */}
      <div className="flex min-h-0 flex-1">
        {/* Sidebar. */}
        <aside
          className={cn(
            "flex h-full flex-col border-r border-subtle bg-sidebar",
            density === "compact" && "py-0",
          )}
          style={{
            width: sidebarWidth,
            minWidth: typeof sidebarWidth === "number" ? sidebarWidth : 180,
            flexShrink: 0,
            transition: "width var(--duration-fast) var(--easing-default)",
          }}
        >
          {sidebar}
        </aside>

        {/* Main conversation + inspector region. */}
        <main className="flex min-w-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">{main}</div>
          </section>

          {/* Inspector.
              At < 900px, becomes an absolutely-positioned floating overlay. */}
          {vp.inspectorOverlay ? (
            <div
              className="pointer-events-none absolute"
              style={{
                top: TITLEBAR_HEIGHT + 12,
                right: 12,
                bottom: terminalOpen ? terminalHeight + 12 : 12,
                width: "min(var(--inspector-width), calc(100vw - 24px))",
                zIndex: 30,
              }}
            >
              <div className="pointer-events-auto h-full overflow-hidden rounded-lg border border-default bg-inspector shadow-lg">
                {inspector}
              </div>
            </div>
          ) : (
            <aside
              className="h-full flex-shrink-0 p-3"
              style={{ width: "var(--inspector-width)" }}
            >
              <div className="h-full overflow-hidden rounded-lg border border-default bg-inspector shadow-md">
                {inspector}
              </div>
            </aside>
          )}
        </main>
      </div>

      {/* Terminal drawer. */}
      <LayoutTerminalDrawer
        open={terminalOpen}
        height={terminalHeight}
        onResize={setTerminalHeight}
        onClose={() => setTerminalOpen(false)}
      />
    </div>
  );
}

export const Layout = memo(LayoutImpl);
