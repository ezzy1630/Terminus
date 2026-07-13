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
 * The title-bar theme control changes immediately; density remains available
 * through the command palette and Settings without a restart.
 *
 * Per SPEC §25.1: "The initial shell must appear before heavy feature
 * bundles load." Settings, onboarding, review, conversation, and the
 * task inspector are split behind React.lazy boundaries.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, GitPullRequestArrow, MessageCircle, Monitor, Moon, PanelRight, Puzzle, Sun } from "lucide-react";
import { Layout } from "./components/Layout";
import { ResizableReviewLayout } from "./components/ResizableReviewLayout";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import { NewTaskScreen } from "./components/NewTaskScreen";
import { EmptyState } from "./components/EmptyState";
import { CommandPalette, buildDefaultCommands } from "./components/CommandPalette";
import { useTerminusStore, useSelectedSessionTasks, useSelectedTask, useSelectedTaskEvents } from "./hooks/use-terminus";
import { useThemeStore } from "./hooks/use-theme";
import { useViewport } from "./hooks/use-viewport";
import { deriveComputerUseActivity } from "./lib/task-surface";
import { api } from "./lib/api";
import type { Theme } from "./types";
import type { SidebarDestination } from "./components/Sidebar";
import type { SettingCategoryId } from "./components/Settings";

const Settings = lazy(async () => {
  const settingsModule = await import("./components/Settings");
  return { default: settingsModule.Settings };
});

const Onboarding = lazy(async () => {
  const onboardingModule = await import("./components/Onboarding");
  return { default: onboardingModule.Onboarding };
});

const ReviewPane = lazy(async () => {
  const reviewModule = await import("./components/ReviewPane");
  return { default: reviewModule.ReviewPane };
});

const Conversation = lazy(async () => {
  const conversationModule = await import("./components/Conversation");
  return { default: conversationModule.Conversation };
});

const Inspector = lazy(async () => {
  const inspectorModule = await import("./components/Inspector");
  return { default: inspectorModule.Inspector };
});

const ONBOARDING_KEY = "terminus-desktop.onboarding.completed.v1";

type SecondaryDestination = Exclude<SidebarDestination, "new_task" | "chat"> | "chat";

const DESTINATION_SURFACES: Record<SecondaryDestination, {
  icon: JSX.Element;
  title: string;
  description: string;
  actionLabel: string;
}> = {
  scheduled: {
    icon: <CalendarClock size={18} strokeWidth={1.6} />,
    title: "Nothing scheduled yet",
    description: "Scheduled tasks will appear here when the control plane exposes them. Start with a focused task whenever you are ready.",
    actionLabel: "Start a task",
  },
  plugins: {
    icon: <Puzzle size={18} strokeWidth={1.6} />,
    title: "Plugins are quiet for now",
    description: "Installed capabilities will be listed here with their trust boundary and current status.",
    actionLabel: "Open settings",
  },
  pull_requests: {
    icon: <GitPullRequestArrow size={18} strokeWidth={1.6} />,
    title: "No pull requests yet",
    description: "Pull requests created from verified task changes will be collected here.",
    actionLabel: "Start a review",
  },
  chat: {
    icon: <MessageCircle size={18} strokeWidth={1.6} />,
    title: "Start a conversation",
    description: "Choose a project and describe what you want to explore, build, review, or fix.",
    actionLabel: "New task",
  },
};

function DestinationSurface({
  destination,
  onStartTask,
  onOpenSettings,
}: {
  destination: SecondaryDestination;
  onStartTask: () => void;
  onOpenSettings: () => void;
}): JSX.Element {
  const surface = DESTINATION_SURFACES[destination];
  const action = destination === "plugins" ? onOpenSettings : onStartTask;
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <EmptyState
        icon={surface.icon}
        title={surface.title}
        description={surface.description}
        action={{ label: surface.actionLabel, onClick: action, shortcutHint: destination === "plugins" ? "⌘," : "⌘N" }}
      />
    </div>
  );
}

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

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingCategoryId>("general");
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => shouldShowOnboarding());
  const [activeDestination, setActiveDestination] = useState<SidebarDestination>("new_task");

  const [computerUseExpandedTaskId, setComputerUseExpandedTaskId] = useState<string | null>(null);
  const [computerUseHiddenTaskId, setComputerUseHiddenTaskId] = useState<string | null>(null);
  const [computerUseStoppedTaskId, setComputerUseStoppedTaskId] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [inspectorPinned, setInspectorPinned] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const computerUseActivity = useMemo(
    () => deriveComputerUseActivity(selectedTaskEvents),
    [selectedTaskEvents],
  );

  const stopComputerUse = useCallback(async (): Promise<void> => {
    if (!selectedTaskId) return;
    try {
      await api.cancelTask(selectedTaskId, "computer_use_stopped_by_user");
      setComputerUseExpandedTaskId(null);
      setComputerUseHiddenTaskId(null);
      setComputerUseStoppedTaskId(selectedTaskId);
    } catch (error) {
      useTerminusStore.setState({
        lastError: error instanceof Error ? error.message : "Failed to stop computer use",
      });
    }
  }, [selectedTaskId]);

  const toggleInspector = useCallback((): void => {
    if (viewport.inspectorOverlay && !inspectorPinned) {
      setInspectorPinned(true);
      setInspectorVisible(true);
      return;
    }
    setInspectorVisible((visible) => !visible);
  }, [inspectorPinned, viewport.inspectorOverlay]);

  const goToNewTask = useCallback((): void => {
    setActiveDestination("new_task");
    selectTask(null);
    setChangesOpen(false);
  }, [selectTask]);

  const openSettings = useCallback((category: SettingCategoryId = "general"): void => {
    setSettingsCategory(category);
    setSettingsOpen(true);
  }, []);

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
        goToNewTask();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedTaskId) {
        e.preventDefault();
        setChangesOpen((open) => !open);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        toggleInspector();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (settingsOpen) setSettingsOpen(false);
        else openSettings("general");
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarVisible((visible) => !visible);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOnboardingOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        openSettings("shortcuts");
      } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const task = selectedSessionTasks[Number(e.key) - 1];
        if (task) {
          e.preventDefault();
          setActiveDestination("chat");
          selectTask(task.id);
          setChangesOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goToNewTask, openSettings, selectedSessionTasks, selectedTaskId, selectTask, settingsOpen, toggleInspector]);

  useEffect(() => {
    const onOpenSettings = (event: Event): void => {
      const detail = event instanceof CustomEvent
        ? event.detail as { category?: SettingCategoryId } | undefined
        : undefined;
      openSettings(detail?.category ?? "general");
    };
    const openOnboarding = (): void => setOnboardingOpen(true);
    window.addEventListener("terminus:open-settings", onOpenSettings);
    window.addEventListener("terminus:open-onboarding", openOnboarding);
    return () => {
      window.removeEventListener("terminus:open-settings", onOpenSettings);
      window.removeEventListener("terminus:open-onboarding", openOnboarding);
    };
  }, [openSettings]);

  // Build the command catalog. Memoized so the palette doesn't re-rank
  // on every App re-render.
  const commands = useMemo(
    () =>
      buildDefaultCommands({
        newTask: goToNewTask,
        showChanges: selectedTaskId ? () => setChangesOpen(true) : undefined,
        openTerminal: () => setTerminalOpen(true),
        toggleInspector,
        pinInspector: () => {
          setInspectorPinned((pinned) => !pinned);
          setInspectorVisible(true);
        },
        switchTheme: () => cycleTheme(),
        switchDensity: () => toggleDensity(),
        openSettings,
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
    [cycleTheme, goToNewTask, openSettings, selectedTaskId, toggleDensity, toggleInspector],
  );

  const showNewTask = selectedTaskId === null && activeDestination === "new_task";
  const showNavigationSurface = selectedTaskId === null && !showNewTask;

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

  const conversation = (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-tertiary" style={{ fontSize: "var(--font-size-sm)" }}>Loading task…</div>}>
      <Conversation />
    </Suspense>
  );

  return (
    <>
      <Layout
        sidebar={
          <Sidebar
            activeDestination={selectedTaskId ? "chat" : activeDestination}
            onNavigate={setActiveDestination}
          />
        }
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
          <Suspense fallback={null}>
            <Inspector
              computerUseSession={{
                active: computerUseActivity.active && computerUseStoppedTaskId !== selectedTaskId,
                expanded: computerUseExpandedTaskId === selectedTaskId,
                hidden: computerUseHiddenTaskId === selectedTaskId,
              }}
            onComputerUseHide={() => setComputerUseHiddenTaskId(selectedTaskId)}
            onComputerUseShow={() => setComputerUseHiddenTaskId(null)}
            onComputerUseStop={() => void stopComputerUse()}
            onComputerUseToggleExpanded={(expanded) => setComputerUseExpandedTaskId(expanded ? selectedTaskId : null)}
              onShowChanges={() => setChangesOpen(true)}
            />
          </Suspense>
        }
        main={
          showNewTask ? (
            <NewTaskScreen />
          ) : showNavigationSurface ? (
            <DestinationSurface
              destination={activeDestination === "new_task" ? "chat" : activeDestination}
              onStartTask={goToNewTask}
              onOpenSettings={openSettings}
            />
          ) : changesOpen ? (
            <ResizableReviewLayout
              conversation={<div className="flex h-full min-w-0 flex-col">
                <div className="min-h-0 flex-1">{conversation}</div>
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
                {conversation}
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
          <Settings
            key={settingsCategory}
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            initialCategoryId={settingsCategory}
          />
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
