/**
 * Terminus Desktop — in-app navigation history.
 *
 * The title bar carries back / forward chevrons, exactly like Codex and every
 * other native document shell. There is no router here: "where you are" is the
 * pair (`activeDestination`, `selectedTaskId`), and the only thing missing was
 * a record of the pairs you passed through to get here.
 *
 * This hook watches that pair and keeps a linear stack of it. Anything that
 * navigates — a sidebar row, the command palette, a clicked notification, the
 * native menu — moves the pair, so all of them are recorded without needing to
 * be taught about history. Back and forward replay a recorded entry through
 * `apply`, which is the caller's ordinary "go here" routine.
 *
 * The stack is deliberately *not* persisted. A history that survives a relaunch
 * would offer to go "back" to a task the window never showed in this run.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SidebarDestination } from "../components/Sidebar";

/** One visited place. Two fields, because two fields are all the shell has. */
export interface NavLocation {
  readonly destination: SidebarDestination;
  readonly taskId: string | null;
}

export interface NavHistory {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly goBack: () => void;
  readonly goForward: () => void;
}

/**
 * Bounded so a window left open all day cannot grow an unbounded stack of
 * every task the operator glanced at. Fifty steps is far past the point where
 * anyone is still clicking back to find something.
 */
const MAX_HISTORY_ENTRIES = 50;

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return a.destination === b.destination && a.taskId === b.taskId;
}

export function useNavHistory({
  destination,
  taskId,
  apply,
}: {
  destination: SidebarDestination;
  taskId: string | null;
  /** The caller's own navigation routine. Called with a recorded location. */
  apply: (target: NavLocation) => void;
}): NavHistory {
  // The stack lives in a ref, not state: only the two enabled flags affect
  // what is painted, and mutating the stack inside a state updater would run
  // the caller's `apply` twice under StrictMode.
  const stackRef = useRef<{ entries: NavLocation[]; index: number }>({
    entries: [{ destination, taskId }],
    index: 0,
  });
  // Set while a replayed location is in flight, so the position change it
  // causes is recognised as replaying history rather than as a new navigation
  // (which would truncate the forward entries we just stepped off).
  const replayingRef = useRef<NavLocation | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const [{ canGoBack, canGoForward }, setEnds] = useState({ canGoBack: false, canGoForward: false });

  useEffect(() => {
    const location: NavLocation = { destination, taskId };
    // Consume the replay marker whatever happens. If `apply` could not reach
    // the recorded location — a task deleted while it sat in the stack — the
    // place we actually landed is recorded as a fresh step instead of leaving
    // the stack permanently waiting for a destination that will never arrive.
    const replaying = replayingRef.current;
    replayingRef.current = null;
    if (replaying !== null && sameLocation(replaying, location)) return;

    const stack = stackRef.current;
    const current = stack.entries[stack.index];
    if (current && sameLocation(current, location)) return;

    const entries = stack.entries.slice(0, stack.index + 1);
    entries.push(location);
    if (entries.length > MAX_HISTORY_ENTRIES) entries.splice(0, entries.length - MAX_HISTORY_ENTRIES);
    stack.entries = entries;
    stack.index = entries.length - 1;
    setEnds({ canGoBack: stack.index > 0, canGoForward: false });
  }, [destination, taskId]);

  const step = useCallback((delta: -1 | 1): void => {
    const stack = stackRef.current;
    const nextIndex = stack.index + delta;
    const target = stack.entries[nextIndex];
    if (target === undefined) return;
    stack.index = nextIndex;
    replayingRef.current = target;
    setEnds({
      canGoBack: nextIndex > 0,
      canGoForward: nextIndex < stack.entries.length - 1,
    });
    applyRef.current(target);
  }, []);

  const goBack = useCallback((): void => step(-1), [step]);
  const goForward = useCallback((): void => step(1), [step]);

  return { canGoBack, canGoForward, goBack, goForward };
}
