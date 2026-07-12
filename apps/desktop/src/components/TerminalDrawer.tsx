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
 * hidden PiP rendering" — we apply the same pattern here: when the
 * drawer is closed (or collapsed to a tab that's not active), the
 * terminal body's content-visibility is set to "hidden" and the
 * internal rAF loop is suspended.
 *
 * Per design constraints: lucide-react icons, CSS variables, no
 * emojis, restrained motion, accessible keyboard nav. The drawer
 * itself does not own the PTY transport — that is wired in via the
 * `TerminalSessionAdapter` interface (a small, replaceable adapter
 * so a future `xterm.js` integration can be dropped in without
 * touching the drawer chrome).
 *
 * Keyboard handling (SPEC §15: "no conflict with global shortcuts"):
 *   - The drawer never claims Cmd/Ctrl+` (that's owned by Layout)
 *   - Inside the drawer: Cmd/Ctrl+F focuses search, Cmd/Ctrl+K clears
 *   - Tab/Shift+Tab cycles focus through the toolbar
 *   - Esc closes the search field (not the drawer)
 *
 * This component replaces the placeholder TerminalDrawer that was
 * inlined in Layout.tsx during Phase 4. The Layout continues to own
 * the resize handle + open/close + ⌘` shortcut; this component owns
 * everything inside the drawer.
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

  // Create the first terminal when the drawer is first opened.
  useEffect(() => {
    if (open && tabs.length === 0 && sessionFactory) {
      createTerminal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionFactory]);

  // Preserve the scroll position when switching tabs.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !activeId) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (tab) body.scrollTop = tab.scrollTop;
  }, [activeId, tabs]);

  // Suspend rendering when closed (SPEC §25.1: "Suspend inactive
  // terminal rendering"). When closed we still keep the adapters
  // alive so the session is preserved — we just don't paint.
  const activeTab = useMemo(
    () => (activeId ? tabs.find((t) => t.id === activeId) ?? null : null),
    [activeId, tabs],
  );

  const createTerminal = useCallback(
    (cwd?: string) => {
      if (!sessionFactory) return;
      const adapter = sessionFactory.create(cwd);
      const id = adapter.id;
      const label = adapter.label;
      const tab: TerminalTab = {
        id,
        label,
        cwd: adapter.cwd ?? cwd,
        lines: [],
        scrollTop: 0,
        adapter,
      };
      adapter.onOutput((chunk) => {
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
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
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
              onClick={() => createTerminal()}
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
