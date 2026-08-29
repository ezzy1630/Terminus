/**
 * Terminus Desktop — CommandPalette.
 *
 * Per SPEC §18: ⌘K opens a Raycast-quality central command palette
 * that must open nearly instantly (<100ms). Full keyboard
 * navigation, fuzzy search, recent commands, context-aware ranking,
 * grouped results, clear shortcut hints, accessible SR labels, no
 * keyboard traps.
 *
 * Implementation notes:
 *   - The component owns its transient interaction state while the
 *     host controls `open`. The host lazy-loads this module only after
 *     the first ⌘K request, so the closed startup path pays no palette
 *     rendering cost.
 *   - Fuzzy search is a hand-written subsequence matcher with
 *     scoring (start-of-word bonus, consecutive-match bonus, length
 *     penalty). It runs in O(n × query_len) which is sub-millisecond
 *     for typical command catalogs (~50 items).
 *   - Recent commands are persisted to localStorage as an array of
 *     command ids (cap 16). Recency multiplies a small score bonus.
 *   - The first result is auto-selected and Enter invokes it. Arrow
 *     keys move the selection. Esc closes. Modal focus is trapped while the
 *     palette is open and restored to the launching control on close.
 *
 * Per design constraints: lucide-react icons, CSS variables, no
 * emojis, restrained motion (the palette fades in over 150ms).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "../lib/cn";
import { isComposingKeyboardEvent, useDialogFocus } from "../hooks/use-dialog-focus";
import type { Command, CommandGroup } from "../lib/command-catalog";
import { Button } from "../ui/Button";
import { DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";

export { buildDefaultCommands } from "../lib/command-catalog";
export type { Command, CommandGroup, DefaultCommandActions } from "../lib/command-catalog";

export interface CommandPaletteProps {
  /** Whether the palette is currently open. */
  open: boolean;
  /** Called when the user dismisses the palette (Esc, backdrop click, etc.). */
  onClose: () => void;
  /** Commands to surface. */
  commands: Command[];
  /** Optional placeholder for the search input. */
  placeholder?: string;
  /** Optional className. */
  className?: string;
}

// ────────────────────────── Recent commands persistence ──────────────────────

const RECENT_KEY = "terminus-desktop.command-palette.recent.v1";
const RECENT_CAP = 16;

function readRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_CAP);
    }
  } catch {
    // ignore
  }
  return [];
}

function writeRecent(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_CAP)));
  } catch {
    // ignore
  }
}

function pushRecent(id: string): string[] {
  const prev = readRecent().filter((x) => x !== id);
  const next = [id, ...prev].slice(0, RECENT_CAP);
  writeRecent(next);
  return next;
}

// ────────────────────────── Fuzzy matcher ───────────────────────────────────

export interface FuzzyMatch {
  /** Whether the query matched. */
  matched: boolean;
  /** Score — higher is better. 0 means no match. */
  score: number;
  /** Character indices in the haystack that matched (for highlight). */
  indices: number[];
}

/**
 * Subsequence fuzzy matcher with scoring. Roughly:
 *   - +50 base if the query is empty (everything matches equally)
 *   - +0 if no match
 *   - +5 per matched char
 *   - +8 if the match starts at a word boundary
 *   - +6 per consecutive matched char (camelCase or separator)
 *   - -1 per skipped char between matches (small length penalty)
 *
 * Returns the highest-scoring match across label + keywords.
 */
export function fuzzyMatch(query: string, haystacks: string[]): FuzzyMatch {
  if (query.length === 0) {
    return { matched: true, score: 50, indices: [] };
  }
  const q = query.toLowerCase();
  let best: FuzzyMatch = { matched: false, score: 0, indices: [] };
  for (const rawHay of haystacks) {
    if (!rawHay) continue;
    const hay = rawHay.toLowerCase();
    let qi = 0;
    let score = 0;
    let consec = 0;
    let lastIdx = -2;
    const indices: number[] = [];
    for (let i = 0; i < hay.length && qi < q.length; i++) {
      const ch = hay.charAt(i);
      const want = q.charAt(qi);
      if (ch === want) {
        indices.push(i);
        score += 5;
        if (i === lastIdx + 1) {
          consec++;
          score += 6 * consec;
        } else {
          consec = 0;
        }
        // Word-boundary bonus.
        const prev = i > 0 ? hay.charAt(i - 1) : " ";
        if (i === 0 || prev === " " || prev === "/" || prev === "-" || prev === "_") {
          score += 8;
        }
        lastIdx = i;
        qi++;
      } else {
        if (lastIdx >= 0) score -= 0; // no per-skip penalty to keep matching cheap
      }
    }
    if (qi === q.length) {
      // Penalize long labels slightly so concise commands win ties.
      score -= Math.min(20, Math.floor(hay.length / 4));
      if (score > best.score) {
        best = { matched: true, score, indices };
      }
    }
  }
  return best;
}

// ────────────────────────── Component ───────────────────────────────────────

const GROUP_ORDER: CommandGroup[] = [
  "Navigation",
  "Task",
  "Changes",
  "Terminal",
  "Tools",
  "Appearance",
  "Help",
];

interface RankedCommand {
  command: Command;
  score: number;
  indices: number[];
}

function CommandPaletteImpl({
  open,
  onClose,
  commands,
  placeholder = "Search commands…",
  className,
}: CommandPaletteProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(open, onClose);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>(() => readRecent());

  // Reset query + selection on open. The dialog focus hook focuses the input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    setRecent(readRecent());
  }, [open]);

  // Compute ranked results.
  const ranked = useMemo<RankedCommand[]>(() => {
    const available = commands.filter((c) => c.available !== false);
    if (query.trim().length === 0) {
      // Show recent first, then by group order.
      const recentSet = new Set(recent);
      const recents = available
        .filter((c) => recentSet.has(c.id))
        .sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));
      const rest = available
        .filter((c) => !recentSet.has(c.id))
        .sort((a, b) => {
          const ga = GROUP_ORDER.indexOf(a.group);
          const gb = GROUP_ORDER.indexOf(b.group);
          if (ga !== gb) return ga - gb;
          return a.label.localeCompare(b.label);
        });
      return [
        ...recents.map((c) => ({ command: c, score: 100, indices: [] as number[] })),
        ...rest.map((c) => ({ command: c, score: 50, indices: [] as number[] })),
      ];
    }
    const out: RankedCommand[] = [];
    for (const c of available) {
      const haystacks = [c.label, ...(c.keywords ?? [])];
      const m = fuzzyMatch(query, haystacks);
      if (!m.matched) continue;
      const recencyBoost = recent.indexOf(c.id) >= 0 ? 10 : 0;
      out.push({ command: c, score: m.score + recencyBoost, indices: m.indices });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }, [commands, query, recent]);

  // Group the ranked results for display.
  const grouped = useMemo(() => {
    const out = new Map<CommandGroup, RankedCommand[]>();
    for (const r of ranked) {
      const arr = out.get(r.command.group);
      if (arr) arr.push(r);
      else out.set(r.command.group, [r]);
    }
    return GROUP_ORDER.filter((g) => out.has(g)).map((g) => ({ group: g, items: out.get(g)! }));
  }, [ranked]);
  const flatRanked = useMemo(() => grouped.flatMap(({ items }) => items), [grouped]);

  // Reset selection when results change.
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll the selected row into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-cp-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const invoke = useCallback(
    (cmd: Command | undefined): void => {
      if (!cmd) return;
      setRecent(pushRecent(cmd.id));
      onClose();
      // Defer the action so the palette closes first.
      window.setTimeout(() => {
        void cmd.action();
      }, 0);
    },
    [onClose],
  );

  // Keyboard handler (only when open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!dialogRef.current?.contains(document.activeElement)) return;
      if (isComposingKeyboardEvent(e)) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(flatRanked.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const r = flatRanked[selectedIndex];
        invoke(r?.command);
      } else if (e.key === "Home") {
        e.preventDefault();
        setSelectedIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setSelectedIndex(Math.max(0, flatRanked.length - 1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialogRef, flatRanked, open, selectedIndex, invoke]);

  // No early return on `!open`: that removed the sheet in one frame, so the
  // palette appeared with an animation and vanished without one. Radix reads
  // `open={false}` as "play the exit, then unmount the portal", and while it is
  // closed it renders nothing into the tree either way.
  let flatIdx = -1;

  return (
    <DialogSurface
      ref={dialogRef}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (isComposingKeyboardEvent(event)) event.preventDefault();
      }}
      accessibleTitle="Command palette"
      tabIndex={-1}
      overlayClassName="bg-black/35"
      className={cn(
        // `dialog-panel` for the same rise-and-settle every other sheet gets.
        // The palette used to snap into existence at full size while its
        // backdrop faded, which read as a rendering glitch rather than a
        // window opening.
        "dialog-panel fixed left-1/2 top-[14vh] flex max-h-[64vh] w-full -translate-x-1/2 flex-col overflow-hidden rounded-md border border-subtle bg-[var(--bg-popover)] shadow-lg",
        className,
      )}
      style={{ width: "min(512px, calc(100vw - 32px))" }}
    >
        {/* Search input. */}
        <div className="flex h-9 flex-none items-center gap-2 border-b border-subtle px-3">
          <Search size={13} className="flex-none text-tertiary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            role="combobox"
            aria-label="Search commands"
            aria-controls="command-palette-results"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-activedescendant={flatRanked[selectedIndex] ? `command-palette-option-${selectedIndex}` : undefined}
            className="ui-input ui-body min-w-0 flex-1 border-0 bg-transparent px-0 text-primary placeholder:text-tertiary"

            autoComplete="off"
            spellCheck={false}
          />
          <IconButton
            label="Close command palette"
            icon={<X size={12} />}
            size="sm"
            onClick={onClose}
            className="icon-button rounded text-tertiary hover:bg-hover hover:text-primary"
          />
        </div>
        {/* Results. */}
        <div
          id="command-palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="scrollable min-h-0 flex-1 overflow-y-auto p-1"
        >
          {grouped.length === 0 ? (
            <div className="ui-body px-4 py-6 text-center text-tertiary">
              No commands match “{query}”.
            </div>
          ) : (
            grouped.map(({ group, items }) => (
              <div key={group}>
                <div className="ui-meta px-2.5 pb-1 pt-2">{group}</div>
                {items.map((r) => {
                  flatIdx++;
                  const idx = flatIdx;
                  const isSel = idx === selectedIndex;
                  return (
                    <Button
                      key={r.command.id}
                      id={`command-palette-option-${idx}`}
                      type="button"
                      tabIndex={-1}
                      data-cp-index={idx}
                      role="option"
                      aria-selected={isSel}
                      data-tooltip={r.command.description}
                      onMouseMove={() => {
                        if (selectedIndex !== idx) setSelectedIndex(idx);
                      }}
                      onClick={() => invoke(r.command)}
                      className={cn(
                        "flex h-8 w-full items-center justify-start gap-2 rounded-[6px] px-2.5 text-left text-base font-normal",
                        isSel ? "bg-selected text-primary" : "text-secondary hover:bg-hover",
                      )}
                    >
                      {r.command.icon ? (
                        <span className="flex-shrink-0 text-tertiary" aria-hidden>
                          {r.command.icon}
                        </span>
                      ) : null}
                      <span className={cn("min-w-0 flex-1 truncate", isSel ? "text-primary" : "text-secondary")}>
                        {r.command.label}
                      </span>
                      {r.command.hint ? <Kbd className="flex-shrink-0">{r.command.hint}</Kbd> : null}
                    </Button>
                  );
                })}
              </div>
            ))
          )}
        </div>
    </DialogSurface>
  );
}

export const CommandPalette = memo(CommandPaletteImpl);
