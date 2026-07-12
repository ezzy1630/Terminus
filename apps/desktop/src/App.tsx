/**
 * Terminus Desktop — Root App component.
 *
 * Wires the layout shell to the sidebar / main / inspector regions,
 * boots the initial data fetch + SSE stream, and routes the main
 * surface between the New Task screen and an active conversation
 * based on whether a task is selected.
 *
 * Phase 5 wiring (this task):
 *   - ⌘K opens the CommandPalette (SPEC §18)
 *   - ⌘, opens Settings (SPEC §20)
 *   - First launch shows Onboarding (SPEC §19)
 *
 * Per SPEC §24: theme + density come from the Zustand store (which
 * installs CSS variables on document.documentElement at module load).
 * A small control in the title-bar area lets the user cycle theme +
 * toggle density without a restart.
 *
 * Per SPEC §25.1: "The initial shell must appear before heavy feature
 * bundles load." The main route switch is plain conditional rendering
 * — no React.lazy / Suspense boundaries yet.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Command, Monitor, Moon, Rows3, Sun } from "lucide-react";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { NewTaskScreen } from "./components/NewTaskScreen";
import { CommandPalette, buildDefaultCommands } from "./components/CommandPalette";
import { useTerminusStore, useSelectedTask, useSelectedTaskEvents } from "./hooks/use-terminus";
import { useThemeStore } from "./hooks/use-theme";
import { useViewport } from "./hooks/use-viewport";
import type { Theme } from "./types";

const Settings = lazy(async () => {
  const module = await import("./components/Settings");
  return { default: module.Settings };
});

const Onboarding = lazy(async () => {
  const module = await import("./components/Onboarding");
  return { default: module.Onboarding };
});

const ReviewPane = lazy(async () => {
  const module = await import("./components/ReviewPane");
  return { default: module.ReviewPane };
});

const ONBOARDING_KEY = "terminus-desktop.onboarding.completed.v1";

function shouldShowOnboarding(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) !== "true";
  } catch {
    return false;
  }
}

function markOnboardingComplete(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONBOARDING_KEY, "true");
  } catch {
    // ignore
  }
}

export function App(): JSX.Element {
  const refreshAll = useTerminusStore((s) => s.refreshAll);
  const selectedTaskId = useTerminusStore((s) => s.selectedTaskId);
  const selectTask = useTerminusStore((s) => s.selectTask);
  const healthReady = useTerminusStore((s) => s.healthReady);
  const lastError = useTerminusStore((s) => s.lastError);
  const setDraft = useTerminusStore((s) => s.setDraft);
  const selectedTask = useSelectedTask();
  const selectedTaskEvents = useSelectedTaskEvents();
  const viewport = useViewport();

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const toggleDensity = useThemeStore((s) => s.toggleDensity);
  const density = useThemeStore((s) => s.density);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => shouldShowOnboarding());

  // Computer-use session state (SPEC §16). In production this would be
  // driven by a `computer_use.started` event from the control plane;
  // for now it's locally toggled via the command palette / keyboard.
  const [computerUseActive, setComputerUseActive] = useState(false);
  const [computerUseExpanded, setComputerUseExpanded] = useState(false);
  const [computerUseHidden, setComputerUseHidden] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [inspectorPinned, setInspectorPinned] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  const toggleInspector = useCallback((): void => {
    if (viewport.inspectorOverlay && !inspectorPinned) {
      setInspectorPinned(true);
      setInspectorVisible(true);
      return;
    }
    setInspectorVisible((visible) => !visible);
  }, [inspectorPinned, viewport.inspectorOverlay]);

  // Initial data load.
  useEffect(() => {
    void refreshAll();
    // Refresh sessions every 30s as a slow fallback. SSE is the primary
    // update channel; this is just for reconciliation.
    const id = window.setInterval(() => {
      void useTerminusStore.getState().refreshSessions();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  // ⌘K opens the command palette (SPEC §18). ⌘, opens Settings (SPEC §20).
  // ⌘⇧C toggles a computer-use session (SPEC §16 — demo shortcut until
  // the control plane emits computer_use.started events).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        selectTask(null);
        setChangesOpen(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedTaskId) {
        e.preventDefault();
        setChangesOpen((open) => !open);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        toggleInspector();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        setComputerUseActive((a) => !a);
        setComputerUseExpanded(false);
        setComputerUseHidden(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTaskId, selectTask, toggleInspector]);

  // Build the command catalog. Memoized so the palette doesn't re-rank
  // on every App re-render.
  const commands = useMemo(
    () =>
      buildDefaultCommands({
        newTask: () => selectTask(null),
        showChanges: selectedTaskId ? () => setChangesOpen(true) : undefined,
        openTerminal: () => setTerminalOpen(true),
        toggleInspector,
        pinInspector: () => {
          setInspectorPinned((pinned) => !pinned);
          setInspectorVisible(true);
        },
        switchTheme: () => cycleTheme(),
        switchDensity: () => toggleDensity(),
        openSettings: () => setSettingsOpen(true),
        openProject: undefined,
        openTask: undefined,
        switchModel: undefined,
        startSubagent: undefined,
        commit: undefined,
        push: undefined,
        compareBranch: undefined,
        createPullRequest: undefined,
        openInCursor: undefined,
        openInTerminal: undefined,
        revealInFinder: undefined,
        viewShortcuts: undefined,
      }),
    [cycleTheme, selectTask, selectedTaskId, toggleDensity, toggleInspector],
  );

  const showNewTask = selectedTaskId === null;

  const onCompleteOnboarding = useCallback((): void => {
    markOnboardingComplete();
    setOnboardingOpen(false);
  }, []);

  const draftReviewRevision = useCallback((instruction: string): void => {
    if (!selectedTaskId) return;
    setDraft(selectedTaskId, instruction);
    setChangesOpen(false);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("terminus:focus-composer"));
    });
  }, [selectedTaskId, setDraft]);

  return (
    <>
      <Layout
        sidebar={<Sidebar />}
        inspectorVisible={inspectorVisible && (!changesOpen || inspectorPinned) && (!viewport.inspectorOverlay || inspectorPinned)}
        terminalOpen={terminalOpen}
        onTerminalOpenChange={setTerminalOpen}
        center={
          selectedTask ? (
            <div className="min-w-0 max-w-[460px] truncate text-secondary" style={{ fontSize: "var(--font-size-xs)" }}>
              {selectedTask.contract?.objective ?? "Task"}
            </div>
          ) : undefined
        }
        inspector={
          <Inspector
            computerUseSession={{
              active: computerUseActive,
              expanded: computerUseExpanded,
              hidden: computerUseHidden,
            }}
            onComputerUseHide={() => setComputerUseHidden(true)}
            onComputerUseStop={() => {
              setComputerUseActive(false);
              setComputerUseExpanded(false);
              setComputerUseHidden(false);
            }}
            onComputerUseToggleExpanded={(expanded) => setComputerUseExpanded(expanded)}
            onShowChanges={() => setChangesOpen(true)}
          />
        }
        main={
          showNewTask ? (
            <NewTaskScreen />
          ) : changesOpen ? (
            <div className="flex h-full min-w-0">
              <div className="flex min-w-[360px] flex-[0.9] flex-col border-r border-default">
                <div className="min-h-0 flex-1"><Conversation /></div>
                <div className="border-t border-subtle" style={{ background: "var(--bg-canvas)", padding: "10px 20px 14px" }}>
                  <Composer />
                </div>
              </div>
              <Suspense fallback={<div className="flex min-w-[360px] flex-1 items-center justify-center bg-diff text-tertiary" style={{ fontSize: "var(--font-size-sm)" }}>Loading review…</div>}>
                <ReviewPane events={selectedTaskEvents} onClose={() => setChangesOpen(false)} onDraftRevision={draftReviewRevision} />
              </Suspense>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                <Conversation />
              </div>
              <div
                className="border-t border-subtle"
                style={{ background: "var(--bg-canvas)", padding: "12px 32px 16px" }}
              >
                <Composer />
              </div>
            </div>
          )
        }
        right={
          <>
            {/* Theme cycle: system → light → dark → system. */}
            <button
              type="button"
              onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}
              aria-label={`Theme: ${theme}`}
              title={`Theme: ${theme}`}
              className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary"
            >
              {theme === "system" ? <Monitor size={14} /> : theme === "light" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            {/* Density toggle. */}
            <button
              type="button"
              onClick={toggleDensity}
              aria-label={`Density: ${density}`}
              title={`Density: ${density}`}
              className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary"
            >
              <Rows3 size={14} />
            </button>
            {/* Command palette trigger (small icon — main entry is ⌘K). */}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              title="Command palette (⌘K)"
              className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary"
            >
              <Command size={14} />
            </button>
            {/* Health indicator — a single restrained dot. */}
            <span
              aria-label={healthReady ? "Control plane ready" : "Control plane offline"}
              title={healthReady ? "Control plane ready" : lastError ?? "Control plane offline"}
              className="ml-2 inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: healthReady ? "var(--color-success)" : "var(--color-error)" }}
            />
          </>
        }
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      {settingsOpen ? (
        <Suspense fallback={null}>
          <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      ) : null}
      {onboardingOpen ? (
        <Suspense fallback={null}>
          <Onboarding onComplete={onCompleteOnboarding} />
        </Suspense>
      ) : null}
    </>
  );
}

/** Convenience export for tests that just want to flip the theme. */
export function useThemeControls(): {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleDensity: () => void;
  density: "spacious" | "compact";
} {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const toggleDensity = useThemeStore((s) => s.toggleDensity);
  const density = useThemeStore((s) => s.density);
  return { theme, setTheme, toggleDensity, density };
}
