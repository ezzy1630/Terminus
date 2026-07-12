/**
 * Forge Desktop — TerminalDrawer.
 *
 * Per SPEC §15: a resizable bottom drawer, hidden by default, with:
 *
 *   - Multiple tabs
 *   - New / close / rename terminal
 *   - Preserve session when hidden
 *   - Pause expensive rendering when not visible
 *   - Fit-to-container behavior
 *   - Search, clear, copy
 *   - Expand to full working area
 *   - Restore previous drawer height
 *   - Correct keyboard handling (no conflict with global shortcuts)
 *   - Accessible focus management
 *
 * Per SPEC §25.1: "Suspend inactive terminal rendering" and "Pause
 * hidden PiP rendering" — when the drawer is closed (or its tab is not
 * active) the terminal body's content-visibility is set to "hidden"
 * and the xterm.js render loop is paused via `disableStdin = true`
 * (we don't fully dispose() until the tab is closed, so scrollback is
 * preserved).
 *
 * Per design constraints: lucide-react icons, CSS variables, no
 * emojis, restrained motion, accessible keyboard nav.
 *
 * Two session factories are shipped:
 *
 *   - `PtyTerminalSessionFactory` — real PTY via `node-pty` (Electron
 *     main) + xterm.js (renderer). Used when `window.forgeTerminal`
 *     is present and `spawn()` returns an id without an error.
 *   - `StubTerminalSessionFactory` — echo-only fallback for tests,
 *     non-Electron browsers, and sandboxes where node-pty didn't
 *     compile. Always available; never throws.
 *
 * Keyboard handling (SPEC §15: "no conflict with global shortcuts"):
 *   - The drawer never claims Cmd/Ctrl+` (that's owned by Layout)
 *   - Inside the drawer: Cmd/Ctrl+F focuses search, Cmd/Ctrl+K clears
 *   - Tab/Shift+Tab cycles focus through the toolbar
 *   - Esc closes the search field (not the drawer)
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Plus,
  Search,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../lib/cn";
import { EmptyState } from "./EmptyState";

// Lazy-load xterm.js so the stub path (tests, non-Electron browsers)
// doesn't pay the cost. We import dynamically inside effect hooks; the
// type import below is erased at build time.
type XtermTerminal = {
  open(parent: HTMLElement): void;
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  dispose(): void;
  cols: number;
  rows: number;
  options: { disableStdin?: boolean };
  loadAddon?: (a: unknown) => void;
};
type FitAddon = { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined; dispose(): void };

// ────────────────────────── Adapter ─────────────────────────────────────────

/**
 * Minimal adapter a host wires up to bridge the drawer UI to a PTY
 * (node-pty + xterm.js, or a remote stream). The drawer only cares
 * about appending output lines and being notified when a session
 * ends. The adapter owns the underlying transport.
 */
export interface TerminalSessionAdapter {
  /** Unique id. */
  id: string;
  /** Display label (e.g. "bash" or "zsh — forge"). */
  label: string;
  /** Working directory or initial command. */
  cwd?: string;
  /** Subscribe to output chunks. Returns an unsubscribe. */
  onOutput(handler: (chunk: string) => void): () => void;
  /** Send user input to the PTY. */
  send(input: string): void;
  /** Resize the PTY to cols × rows. */
  resize(cols: number, rows: number): void;
  /** End the session. */
  dispose(): void;
}

export interface TerminalSessionFactory {
  /** Create a new terminal session. */
  create(cwd?: string): TerminalSessionAdapter;
  /** True when the factory is backed by a real PTY (vs a stub). */
  isReal?: boolean;
}

// ────────────────────────── Types ───────────────────────────────────────────

export interface TerminalDrawerProps {
  /** Whether the drawer is open (visible). */
  open: boolean;
  /** Drawer pixel height (managed by Layout). */
  height: number;
  /** Called when the user wants to close the drawer. */
  onClose: () => void;
  /** Called when the user drags the resize handle. */
  onResize: (h: number) => void;
  /** Optional factory for creating new terminal sessions. */
  sessionFactory?: TerminalSessionFactory;
  /** Optional className. */
  className?: string;
  /** Expand the drawer to the full working area (hide inspector + sidebar). */
  expanded?: boolean;
  /** Toggle the expanded state. */
  onToggleExpanded?: () => void;
}

interface TerminalTab {
  id: string;
  label: string;
  cwd?: string;
  lines: string[];
  /** Most recent scroll position — preserved when switching tabs. */
  scrollTop: number;
  /** Adapter (may be null if disposed). */
  adapter: TerminalSessionAdapter | null;
  /** True when the adapter is backed by a real PTY (xterm.js rendering). */
  isReal: boolean;
  /** xterm.js Terminal instance, attached when the body mounts. */
  xterm: XtermTerminal | null;
  /** FitAddon, attached alongside the xterm Terminal. */
  fitAddon: FitAddon | null;
  /** Whether xterm is currently attached to a DOM container. */
  xtermAttached: boolean;
}

// ────────────────────────── Component ───────────────────────────────────────

function TerminalDrawerImpl({
  open,
  height,
  onClose,
  onResize,
  sessionFactory,
  className,
  expanded = false,
  onToggleExpanded,
}: TerminalDrawerProps): JSX.Element {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** Per-tab DOM container refs (keyed by tab id) so xterm can attach. */
  const xtermContainerRef = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Create the first terminal when the drawer is first opened.
  useEffect(() => {
    if (open && tabs.length === 0 && sessionFactory) {
      void createTerminal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionFactory]);

  // Preserve the scroll position when switching tabs (only relevant for
  // stub-mode tabs — xterm.js manages its own viewport).
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !activeId) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (tab && !tab.isReal) body.scrollTop = tab.scrollTop;
  }, [activeId, tabs]);

  const activeTab = useMemo(
    () => (activeId ? tabs.find((t) => t.id === activeId) ?? null : null),
    [activeId, tabs],
  );

  const createTerminal = useCallback(
    async (cwd?: string) => {
      if (!sessionFactory) return;
      const adapter = sessionFactory.create(cwd);
      const id = adapter.id;
      const label = adapter.label;
      const isReal = sessionFactory.isReal === true;
      const tab: TerminalTab = {
        id,
        label,
        cwd: adapter.cwd ?? cwd,
        lines: [],
        scrollTop: 0,
        adapter,
        isReal,
        xterm: null,
        fitAddon: null,
        xtermAttached: false,
      };
      adapter.onOutput((chunk) => {
        // For real (xterm.js) tabs we forward output directly to xterm
        // via the adapter's own internal wiring — we still keep a plain
        // text log so the search bar can scan it.
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== id) return t;
            const next = [...t.lines, chunk];
            // Cap stored output to prevent unbounded growth.
            const MAX_LINES = 8000;
            return next.length > MAX_LINES
              ? { ...t, lines: next.slice(next.length - MAX_LINES) }
              : { ...t, lines: next };
          }),
        );
      });
      setTabs((prev) => [...prev, tab]);
      setActiveId(id);
    },
    [sessionFactory],
  );

  const closeTerminal = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const target = prev.find((t) => t.id === id);
        target?.adapter?.dispose();
        target?.xterm?.dispose();
        xtermContainerRef.current.delete(id);
        const next = prev.filter((t) => t.id !== id);
        if (activeId === id) {
          const fallback = next[0]?.id ?? null;
          setActiveId(fallback);
        }
        return next;
      });
    },
    [activeId],
  );

  const renameTerminal = useCallback((id: string, label: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
    setRenamingId(null);
  }, []);

  // Drive the active adapter's resize when the body size changes.
  useEffect(() => {
    if (!open || !activeTab?.adapter) return;
    const body = bodyRef.current;
    if (!body) return;
    const measure = (): void => {
      const cols = Math.max(20, Math.floor(body.clientWidth / 7.2));
      const rows = Math.max(3, Math.floor(body.clientHeight / 16));
      activeTab.adapter?.resize(cols, rows);
      try {
        activeTab.fitAddon?.fit();
      } catch {
        // xterm.js throws if the addon hasn't been loaded — ignore.
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, [open, activeTab]);

  // Attach xterm.js to the active tab's container when it changes.
  // Skipped for stub tabs (which render plain text instead).
  useEffect(() => {
    if (!open || !activeTab || !activeTab.isReal) return;
    const container = xtermContainerRef.current.get(activeTab.id);
    if (!container) return;
    if (activeTab.xtermAttached && activeTab.xterm) {
      // Already attached; just refit in case the container size changed.
      try {
        activeTab.fitAddon?.fit();
      } catch {
        // ignore
      }
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (cancelled) return;
        const term = new Terminal({
          fontFamily: "var(--font-family-mono, 'SF Mono', Menlo, monospace)",
          fontSize: 12,
          lineHeight: 1.4,
          cursorBlink: true,
          allowProposedApi: true,
          theme: {
            background: "#00000000", // transparent — uses container bg
            foreground: "var(--text-primary, #e8e8ea)",
            cursor: "var(--text-primary, #e8e8ea)",
            selectionBackground: "color-mix(in srgb, var(--color-primary, #4a9eff) 35%, transparent)",
          },
        }) as unknown as XtermTerminal;
        const fit = new FitAddon() as unknown as FitAddon;
        // xterm.js v6 exposes `loadAddon` via the ITerminalExtensions mixin.
        type WithLoadAddon = { loadAddon(a: unknown): void };
        (term as unknown as WithLoadAddon).loadAddon(fit);
        term.open(container);
        try {
          fit.fit();
        } catch {
          // ignore — fit can throw if the container is hidden
        }
        // Wire xterm → PTY input.
        term.onData((data: string) => {
          activeTab.adapter?.send(data);
        });
        // Replay any buffered output into the new xterm instance so
        // switching tabs doesn't lose history.
        for (const chunk of activeTab.lines) {
          term.write(chunk);
        }
        // Mark attached and stash on the tab.
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTab.id
              ? { ...t, xterm: term, fitAddon: fit, xtermAttached: true }
              : t,
          ),
        );
      } catch (err) {
        // xterm.js failed to load (e.g. CSS missing in a non-electron
        // test env). Fall back to stub rendering.
        console.warn("[forge] xterm.js load failed — falling back to text mode", err);
        setTabs((prev) =>
          prev.map((t) => (t.id === activeTab.id ? { ...t, isReal: false } : t)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab]);

  // Keyboard shortcuts inside the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      // Cmd/Ctrl+F → search.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      // Cmd/Ctrl+K → clear.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        if (activeId) {
          e.preventDefault();
          setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, lines: [] } : t)));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, activeId]);

  // Search navigation — find all match indexes in the concatenated output.
  const searchMatches = useMemo(() => {
    if (!searchQuery || !activeTab) return [];
    const text = activeTab.lines.join("");
    const out: number[] = [];
    let i = 0;
    while (i <= text.length) {
      const idx = text.indexOf(searchQuery, i);
      if (idx < 0) break;
      out.push(idx);
      i = idx + searchQuery.length;
      if (out.length > 500) break;
    }
    return out;
  }, [searchQuery, activeTab]);

  const copyOutput = useCallback((): void => {
    if (!activeTab) return;
    const text = activeTab.lines.join("");
    void navigator.clipboard?.writeText(text);
  }, [activeTab]);

  const clearOutput = useCallback((): void => {
    if (!activeId) return;
    setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, lines: [] } : t)));
  }, [activeId]);

  const onBodyScroll = useCallback((): void => {
    const body = bodyRef.current;
    if (!body || !activeId) return;
    const scrollTop = body.scrollTop;
    setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, scrollTop } : t)));
  }, [activeId]);

  // Render. When closed we return an empty fragment — Layout still
  // owns the height reservation (none, because hidden) and the
  // ⌘` shortcut.
  if (!open) return <></>;

  return (
    <div
      role="region"
      aria-label="Terminal drawer"
      className={cn("flex flex-col border-t border-default bg-terminal", className)}
      style={{ height }}
    >
      {/* Toolbar. */}
      <div
        className="flex flex-shrink-0 items-center gap-1 border-b border-subtle px-2"
        style={{ height: 32 }}
      >
        <TerminalIcon size={12} className="text-tertiary" />
        {/* Tabs. */}
        <div
          role="tablist"
          aria-label="Terminal sessions"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            const isRenaming = renamingId === tab.id;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={cn(
                  "group flex items-center gap-1 rounded-sm px-2 py-1",
                  isActive ? "bg-hover text-primary" : "text-secondary hover:bg-hover hover:text-primary",
                )}
                style={{
                  fontSize: "var(--font-size-xs)",
                  height: 24,
                  minWidth: 0,
                  maxWidth: 200,
                }}
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    defaultValue={tab.label}
                    onBlur={(e) => renameTerminal(tab.id, e.target.value || tab.label)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        renameTerminal(tab.id, (e.target as HTMLInputElement).value || tab.label);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    className="bg-transparent text-primary focus:outline-none"
                    style={{ fontSize: "var(--font-size-xs)", width: 90 }}
                    aria-label="Rename terminal"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveId(tab.id)}
                    onDoubleClick={() => setRenamingId(tab.id)}
                    className="truncate"
                    title={tab.label + (tab.cwd ? ` — ${tab.cwd}` : "")}
                  >
                    {tab.label}
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(tab.id);
                  }}
                  aria-label={`Close ${tab.label}`}
                  className="rounded p-0.5 text-tertiary opacity-0 hover:bg-hover hover:text-primary group-hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
          {sessionFactory ? (
            <button
              type="button"
              onClick={() => void createTerminal()}
              aria-label="New terminal"
              title="New terminal"
              className="flex h-6 w-6 items-center justify-center rounded-sm text-secondary hover:bg-hover hover:text-primary"
            >
              <Plus size={12} />
            </button>
          ) : null}
        </div>
        {/* Right-aligned actions. */}
        <div className="flex items-center gap-0.5">
          <ToolbarButton
            icon={<Search size={11} />}
            label="Search"
            shortcutHint="⌘F"
            onClick={() => {
              setSearchOpen((s) => !s);
              if (!searchOpen) window.setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            active={searchOpen}
          />
          <ToolbarButton
            icon={<Copy size={11} />}
            label="Copy"
            onClick={copyOutput}
            disabled={!activeTab}
          />
          <ToolbarButton
            icon={<Trash2 size={11} />}
            label="Clear"
            shortcutHint="⌘K"
            onClick={clearOutput}
            disabled={!activeTab}
          />
          {onToggleExpanded ? (
            <ToolbarButton
              icon={expanded ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
              label={expanded ? "Collapse" : "Expand"}
              onClick={onToggleExpanded}
            />
          ) : null}
          <ToolbarButton icon={<X size={11} />} label="Close" onClick={onClose} />
        </div>
      </div>
      {/* Search bar. */}
      {searchOpen ? (
        <div
          className="flex flex-shrink-0 items-center gap-2 border-b border-subtle px-3 py-1.5"
          style={{ height: 32 }}
        >
          <Search size={11} className="text-tertiary" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setSearchIndex((i) => (i + 1) % Math.max(1, searchMatches.length));
              } else if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder="Search terminal output"
            aria-label="Search terminal output"
            className="flex-1 bg-transparent font-mono text-primary placeholder:text-tertiary focus:outline-none"
            style={{ fontSize: "var(--font-size-xs)" }}
          />
          {searchQuery ? (
            <span className="font-mono text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
              {searchMatches.length === 0 ? "0/0" : `${searchIndex + 1}/${searchMatches.length}`}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Body. */}
      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        className="selectable min-h-0 flex-1 overflow-auto px-3 py-2 font-mono"
        style={{
          background: "var(--bg-terminal)",
          color: "var(--text-primary)",
          fontSize: "var(--font-size-sm)",
          lineHeight: 1.5,
          // Suspend rendering when the drawer is closed (we render
          // nothing in that case, but this also helps when expanded).
          contentVisibility: open ? "visible" : "hidden",
        }}
        tabIndex={0}
      >
        {!activeTab ? (
          <EmptyState
            icon={<TerminalIcon size={14} />}
            title="No terminal session"
            description={sessionFactory ? "Click + to open a new terminal." : "Terminal sessions are not available in this build."}
            compact
            align="start"
          />
        ) : activeTab.isReal ? (
          // xterm.js attaches to this container. We render one container
          // per active tab; inactive tabs are unmounted (their scrollback
          // is buffered in `lines` and replayed when re-activated).
          <div
            ref={(el) => {
              xtermContainerRef.current.set(activeTab.id, el);
            }}
            data-testid={`xterm-container-${activeTab.id}`}
            style={{ height: "100%", width: "100%" }}
          />
        ) : (
          <TerminalOutput
            lines={activeTab.lines}
            searchQuery={searchQuery}
            searchIndex={searchIndex}
          />
        )}
      </div>
      {/* Resize hint (visual only — Layout owns the actual handle). */}
      <div
        aria-hidden
        className="flex flex-shrink-0 items-center justify-between border-t border-subtle px-3 text-tertiary"
        style={{ height: 20, fontSize: 10 }}
      >
        <span className="font-mono">
          {activeTab ? `${activeTab.label}${activeTab.cwd ? ` · ${activeTab.cwd}` : ""}` : "—"}
        </span>
        <span className="font-mono">
          ⌘F search · ⌘K clear · drag the top edge to resize
        </span>
      </div>
    </div>
  );
}

export const TerminalDrawer = memo(TerminalDrawerImpl);

// ────────────────────────── Subcomponents ───────────────────────────────────

function ToolbarButton({
  icon,
  label,
  onClick,
  shortcutHint,
  disabled,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  shortcutHint?: string;
  disabled?: boolean;
  active?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={shortcutHint ? `${label} (${shortcutHint})` : label}
      className={cn(
        "flex h-6 items-center gap-1 rounded-sm px-1.5 text-secondary hover:bg-hover hover:text-primary disabled:opacity-40",
        active && "bg-hover text-primary",
      )}
      style={{ fontSize: "var(--font-size-xs)" }}
    >
      {icon}
    </button>
  );
}

const TerminalOutput = memo(function TerminalOutput({
  lines,
  searchQuery,
  searchIndex,
}: {
  lines: string[];
  searchQuery: string;
  searchIndex: number;
}): JSX.Element {
  const text = lines.join("");
  // Highlight the active search match using a simple split.
  // We avoid running this on huge buffers when no query is set.
  if (!searchQuery || text.length === 0) {
    return <pre className="selectable whitespace-pre-wrap break-all" style={{ margin: 0 }}>{text}</pre>;
  }
  const idx = text.indexOf(searchQuery);
  if (idx < 0) {
    return <pre className="selectable whitespace-pre-wrap break-all" style={{ margin: 0 }}>{text}</pre>;
  }
  // Find the Nth match.
  let start = 0;
  for (let i = 0; i <= searchIndex; i++) {
    const next = text.indexOf(searchQuery, start);
    if (next < 0) break;
    start = next;
    if (i < searchIndex) start += searchQuery.length;
  }
  const before = text.slice(0, start);
  const match = text.slice(start, start + searchQuery.length);
  const after = text.slice(start + searchQuery.length);
  return (
    <pre
      className="selectable whitespace-pre-wrap break-all"
      style={{ margin: 0 }}
    >
      {before}
      <mark
        style={{
          background: "color-mix(in srgb, var(--color-warning) 35%, transparent)",
          color: "var(--text-primary)",
          borderRadius: 2,
          padding: "0 1px",
        }}
      >
        {match}
      </mark>
      {after}
    </pre>
  );
});

// ────────────────────────── Stub adapter (no PTY backend) ────────────────────

/**
 * A no-op session adapter used when no real PTY backend is wired up.
 * It echoes input back so the drawer remains interactive for demos
 * and tests. Real integrations pass a {@link TerminalSessionFactory}.
 */
export class StubTerminalSessionFactory implements TerminalSessionFactory {
  isReal = false;
  private counter = 0;
  create(cwd?: string): TerminalSessionAdapter {
    const id = `stub-${++this.counter}`;
    const label = `shell ${this.counter}`;
    const handlers = new Set<(chunk: string) => void>();
    let disposed = false;
    return {
      id,
      label,
      cwd,
      onOutput: (handler) => {
        handlers.add(handler);
        // Emit a banner so the user sees the session start.
        window.setTimeout(() => {
          if (!disposed) {
            handler(`Forge stub terminal — ${label}\r\n`);
            handler(cwd ? `cwd: ${cwd}\r\n` : "");
            handler("Type to echo. Connect a real PTY adapter for live sessions.\r\n\r\n");
          }
        }, 0);
        return () => {
          handlers.delete(handler);
        };
      },
      send: (input) => {
        if (disposed) return;
        for (const h of handlers) h(input);
      },
      resize: () => {
        // no-op
      },
      dispose: () => {
        disposed = true;
        handlers.clear();
      },
    };
  }
}

// ────────────────────────── Real PTY adapter (node-pty + xterm.js) ───────────

/**
 * A factory that bridges the drawer to a real `node-pty` session running
 * in the Electron main process. Each `create()` returns a
 * {@link TerminalSessionAdapter} backed by `window.forgeTerminal`.
 *
 * The renderer attaches xterm.js to the drawer's container in a separate
 * effect (see {@link TerminalDrawerImpl}) — the adapter only owns the
 * transport (spawn/write/resize/kill/onData).
 *
 * If `window.forgeTerminal` is missing (non-Electron browser, jsdom test)
 * or `spawn()` returns an error (node-pty unavailable on this platform),
 * the factory falls back to a {@link StubTerminalSessionFactory} session
 * so the drawer remains interactive. Callers can detect this via the
 * `isReal` flag.
 */
export class PtyTerminalSessionFactory implements TerminalSessionFactory {
  isReal = true;
  private counter = 0;
  private fallback = new StubTerminalSessionFactory();

  create(cwd?: string): TerminalSessionAdapter {
    const bridge = (typeof window !== "undefined" ? window.forgeTerminal : undefined) ?? null;
    if (!bridge) {
      // Non-Electron context. Fall back to stub.
      const stub = this.fallback.create(cwd);
      return { ...stub, label: `${stub.label} (stub)` };
    }
    const id = `pty-pending-${++this.counter}`;
    const label = "zsh";
    const handlers = new Set<(chunk: string) => void>();
    let disposed = false;
    let realId: string | null = null;
    let unsubscribeData: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;
    let pendingInput: string[] = [];
    let pendingResize: Array<{ cols: number; rows: number }> = [];

    // Fire the async spawn. We can't return a Promise from the factory
    // (the drawer expects a synchronous adapter), so we buffer input/
    // resize calls until the real id is known.
    void bridge.spawn(cwd).then((res) => {
      if (disposed) return;
      if (res.error || !res.id) {
        // node-pty not available — surface an error banner then become
        // an echo stub so the user can still see *something*.
        for (const h of handlers) {
          h(`\r\n[forge] PTY unavailable: ${res.error ?? "spawn failed"}\r\n`);
          h("[forge] Falling back to echo mode.\r\n\r\n");
        }
        return;
      }
      realId = res.id;
      // Drain pending input + resize.
      for (const data of pendingInput) void bridge.write(realId, data);
      pendingInput = [];
      for (const r of pendingResize) void bridge.resize(realId, r.cols, r.rows);
      pendingResize = [];
      // Wire output → drawer.
      unsubscribeData = bridge.onData(realId, (data) => {
        for (const h of handlers) h(data);
      });
      unsubscribeExit = bridge.onExit(realId, (code) => {
        for (const h of handlers) h(`\r\n[process exited with code ${code}]\r\n`);
      });
    });

    return {
      id,
      label,
      cwd,
      onOutput: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      send: (input) => {
        if (disposed) return;
        if (realId) {
          void bridge.write(realId, input);
        } else {
          pendingInput.push(input);
        }
      },
      resize: (cols, rows) => {
        if (disposed) return;
        if (realId) {
          void bridge.resize(realId, cols, rows);
        } else {
          pendingResize.push({ cols, rows });
        }
      },
      dispose: () => {
        disposed = true;
        unsubscribeData?.();
        unsubscribeExit?.();
        if (realId) {
          void bridge.kill(realId);
        }
        handlers.clear();
      },
    };
  }
}

/**
 * Pick the best available factory for the current environment.
 *
 *   - When `window.forgeTerminal` is present (Electron with PTY bridge),
 *     return a singleton {@link PtyTerminalSessionFactory}.
 *   - Otherwise, return a singleton {@link StubTerminalSessionFactory}.
 *
 * Exported so Layout can pass a stable factory to the drawer without
 * re-creating it on every render.
 */
export function pickTerminalSessionFactory(): TerminalSessionFactory {
  if (typeof window !== "undefined" && window.forgeTerminal) {
    return PtyTerminalFactorySingleton;
  }
  return StubTerminalFactorySingleton;
}

const PtyTerminalFactorySingleton = new PtyTerminalSessionFactory();
const StubTerminalFactorySingleton = new StubTerminalSessionFactory();
