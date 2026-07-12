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
import { Command, Monitor, Moon, PanelRight, Rows3, Sun } from "lucide-react";
import { Layout } from "./components/Layout";
import { ResizableReviewLayout } from "./components/ResizableReviewLayout";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { NewTaskScreen } from "./components/NewTaskScreen";
import { CommandPalette, buildDefaultCommands } from "./components/CommandPalette";
import { useTerminusStore, useSelectedSessionTasks, useSelectedTask, useSelectedTaskEvents } from "./hooks/use-terminus";
import { useThemeStore } from "./hooks/use-theme";
import { useViewport } from "./hooks/use-viewport";
import { deriveComputerUseActivity } from "./lib/task-surface";
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
  const selectedSessionTasks = useSelectedSessionTasks();
  const viewport = useViewport();

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const toggleDensity = useThemeStore((s) => s.toggleDensity);
  const density = useThemeStore((s) => s.density);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => shouldShowOnboarding());

  const [computerUseExpanded, setComputerUseExpanded] = useState(false);
  const [computerUseHidden, setComputerUseHidden] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [inspectorPinned, setInspectorPinned] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const computerUseActivity = useMemo(
    () => deriveComputerUseActivity(selectedTaskEvents),
    [selectedTaskEvents],
  );

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
    // Reconcile when the user returns to the app instead of polling while
    // idle. Active task updates remain event-driven through SSE.
    const refreshOnFocus = (): void => {
      void useTerminusStore.getState().refreshSessions();
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refreshAll]);

  // ⌘K opens the command palette (SPEC §18). ⌘, opens Settings (SPEC §20).
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
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarVisible((visible) => !visible);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOnboardingOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const task = selectedSessionTasks[Number(e.key) - 1];
        if (task) {
          e.preventDefault();
          selectTask(task.id);
          setChangesOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSessionTasks, selectedTaskId, selectTask, toggleInspector]);

  useEffect(() => {
    const openSettings = (): void => setSettingsOpen(true);
    const openOnboarding = (): void => setOnboardingOpen(true);
    window.addEventListener("terminus:open-settings", openSettings);
    window.addEventListener("terminus:open-onboarding", openOnboarding);
    return () => {
      window.removeEventListener("terminus:open-settings", openSettings);
      window.removeEventListener("terminus:open-onboarding", openOnboarding);
    };
  }, []);

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
        sidebarVisible={sidebarVisible}
        // The inspector is contextual. A new-task screen has no task-bound
        // context yet, so keeping it out of the canvas restores the calm,
        // focused Codex-style start composition.
        inspectorVisible={Boolean(selectedTask) && inspectorVisible && (!changesOpen || inspectorPinned) && (!viewport.inspectorOverlay || inspectorPinned)}
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
              active: computerUseActivity.active,
              expanded: computerUseExpanded,
              hidden: computerUseHidden,
            }}
            onComputerUseHide={() => setComputerUseHidden(true)}
            onComputerUseToggleExpanded={(expanded) => setComputerUseExpanded(expanded)}
            onShowChanges={() => setChangesOpen(true)}
          />
        }
        main={
          showNewTask ? (
            <NewTaskScreen />
          ) : changesOpen ? (
            <ResizableReviewLayout
              conversation={<div className="flex h-full min-w-0 flex-col">
                <div className="min-h-0 flex-1"><Conversation /></div>
                <div className="border-t border-subtle" style={{ background: "var(--bg-canvas)", padding: "10px 20px 14px" }}>
                  <Composer />
                </div>
              </div>}
              review={<Suspense fallback={<div className="flex h-full items-center justify-center bg-diff text-tertiary" style={{ fontSize: "var(--font-size-sm)" }}>Loading review…</div>}>
                <ReviewPane events={selectedTaskEvents} onClose={() => setChangesOpen(false)} onDraftRevision={draftReviewRevision} />
              </Suspense>}
            />
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
            <button
              type="button"
              onClick={toggleInspector}
              disabled={!selectedTask}
              aria-label={inspectorVisible ? "Hide task context" : "Show task context"}
              title={selectedTask ? (inspectorVisible ? "Hide task context" : "Show task context") : "Task context appears when a task is selected"}
              className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-35"
            >
              <PanelRight size={14} />
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
          <Onboarding
            onComplete={onCompleteOnboarding}
            pickDirectory={window.terminusDesktop?.pickDirectory}
          />
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
