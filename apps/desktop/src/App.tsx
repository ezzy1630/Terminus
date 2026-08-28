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
 * task inspector and operator cockpit are split behind React.lazy boundaries.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderClosed, MessageCircle, PanelLeft, PanelRight } from "lucide-react";
import { Layout } from "./components/Layout";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ProjectMenu } from "./components/ProjectMenu";
import { projectUriToPath } from "./lib/projects";
import { ResizableReviewLayout } from "./components/ResizableReviewLayout";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import { NewTaskScreen } from "./components/NewTaskScreen";
import { MissionBoardView } from "./components/MissionBoardView";
import { EmptyState } from "./ui/EmptyState";
import { TaskStatusPill } from "./components/StatusIndicator";
import {
  useTerminusStore,
  useSelectedSessionTasks,
  useSelectedTask,
  useSelectedTaskEventHistory,
  useSelectedTaskEvents,
  useHealthMonitor,
  useSelectedTaskRunActivity,
  useTurnWatchdog,
} from "./hooks/use-terminus";
import { useThemeStore } from "./hooks/use-theme";
import { useNativeAttention } from "./hooks/use-native-attention";
import { displayLifecycleWith, taskRunIsActiveWith } from "./lib/turn-activity";
import type { Theme } from "./types";
import type { SidebarDestination } from "./components/Sidebar";
import { SETTING_CATEGORIES, type SettingCategoryId } from "./components/Settings";

/**
 * Resolve a requested settings category.
 *
 * Providers and models live under "Agents and Models", but every caller that
 * wants them naturally asks for "providers" or "models" — and an unknown id
 * silently opened Appearance instead, which is how "configure a provider"
 * landed on the theme picker.
 */
const SETTINGS_CATEGORY_ALIASES: Readonly<Record<string, SettingCategoryId>> = {
  providers: "agents",
  provider: "agents",
  models: "agents",
  model: "agents",
};

export function settingsCategoryFor(requested: string | undefined): SettingCategoryId {
  if (!requested) return "appearance";
  const alias = SETTINGS_CATEGORY_ALIASES[requested];
  if (alias) return alias;
  const known = SETTING_CATEGORIES.find((category) => category.id === requested);
  return known ? known.id : "appearance";
}
import type { TaskV2Snapshot } from "./types/v2";
import { FIXED_SHORTCUTS, matchesShortcut, shortcutDisplay } from "./lib/shortcuts";
import { restoreAppDialogFocusOrigin, setAppDialogFocusOrigin } from "./hooks/use-dialog-focus";
import { buildDefaultCommands } from "./lib/command-catalog";
import { Button } from "./ui/Button";
import { DialogSurface } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { Skeleton, Spinner } from "./ui/Status";
import { Tabs } from "./ui/Tabs";
import { TaskRequiredState } from "./components/Cockpit/CockpitPrimitives";

const CommandPalette = lazy(async () => {
  const paletteModule = await import("./components/CommandPalette");
  return { default: paletteModule.CommandPalette };
});

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


const AgentsView = lazy(async () => {
  const agentsModule = await import("./components/AgentsView");
  return { default: agentsModule.AgentsView };
});

const AttentionCenterModal = lazy(async () => {
  const cockpitModule = await import("./components/Cockpit/AttentionCenterModal");
  return { default: cockpitModule.AttentionCenterModal };
});

function SelectedTaskReviewPane({
  taskId,
  onClose,
  onDraftRevision,
}: {
  taskId: string;
  onClose: () => void;
  onDraftRevision: (instruction: string) => void;
}): JSX.Element {
  const events = useSelectedTaskEvents();
  const history = useSelectedTaskEventHistory();
  return (
    <ReviewPane
      key={taskId}
      events={history ? [] : events}
      eventHistoryIncomplete={history !== null}
      taskId={taskId}
      onClose={onClose}
      onDraftRevision={onDraftRevision}
    />
  );
}

import {
  parseTaskWorkspaceTab as parseTaskWorkspaceTabValue,
  taskWorkspaceTabs,
  type TaskWorkspaceTab,
} from "./lib/session-view";

const ONBOARDING_KEY = "terminus-desktop.onboarding.completed.v1";
const INSPECTOR_VISIBILITY_KEY = "terminus-desktop.inspector-visible.";
type AppOverlay = "palette" | "settings" | "onboarding" | "attention" | null;
// Session-first tabs live in lib/session-view.
const parseTaskWorkspaceTab = parseTaskWorkspaceTabValue;

function readInspectorVisibility(taskId: string): boolean {
  try { return window.localStorage.getItem(`${INSPECTOR_VISIBILITY_KEY}${taskId}`) === "true"; }
  catch { return false; }
}

function ModalLoadingFallback({ label, onClose }: { label: string; onClose: () => void }): JSX.Element {
  return (
    <DialogSurface
        open
        onOpenChange={(open) => { if (!open) onClose(); }}
        accessibleTitle={`Loading ${label}`}
        aria-describedby="modal-loading-description"
        className="dialog-panel fixed left-1/2 top-1/2 z-[calc(var(--z-dialog)+1)] flex w-[min(384px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] border border-default bg-elevated p-5 text-primary shadow-lg"
      >
        <h2 className="text-md font-semibold">Loading {label}</h2>
        <p id="modal-loading-description" className="mt-1 text-sm text-secondary">
          The task workspace remains unchanged while this interface loads.
        </p>
        <div className="mt-5 flex items-center gap-2 text-sm text-secondary" role="status">
          <Spinner /> Loading…
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
    </DialogSurface>
  );
}

/**
 * The only non-task navigation surface left. Scheduled / Plugins /
 * Pull-requests placeholders were removed: the control plane exposes no
 * backing data for them, and unbacked UI is dead UI (SPEC §11 — no empty
 * sections).
 */
function ChatDestinationSurface({ onStartTask }: { onStartTask: () => void }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <EmptyState
        icon={<MessageCircle size={18} strokeWidth={1.6} />}
        title="Start a conversation"
        description="Choose a project and describe what you want to explore, build, review, or fix."
        action={{ label: "New task", onClick: onStartTask, shortcutHint: shortcutDisplay(FIXED_SHORTCUTS.newTask) }}
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
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const sessions = useTerminusStore((s) => s.sessions);
  const selectedTaskId = useTerminusStore((s) => s.selectedTaskId);
  const selectedTaskPage = useTerminusStore((s) => s.selectedSessionId ? s.taskPagesBySession[s.selectedSessionId] : undefined);
  const loadMoreTasks = useTerminusStore((s) => s.loadMoreTasks);
  const selectTask = useTerminusStore((s) => s.selectTask);
  const selectSession = useTerminusStore((s) => s.selectSession);
  const stopTask = useTerminusStore((s) => s.stopTask);
  const setDraft = useTerminusStore((s) => s.setDraft);
  const selectedTask = useSelectedTask();
  const selectedSessionTasks = useSelectedSessionTasks();
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  // The stored status says ACTIVE for as long as a task exists. What the title
  // bar reports is what the run is actually doing.
  const selectedRunActivity = useSelectedTaskRunActivity();
  const selectedRunIsActive = taskRunIsActiveWith(selectedTask, selectedRunActivity);

  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const toggleDensity = useThemeStore((s) => s.toggleDensity);

  const [overlay, setOverlay] = useState<AppOverlay>(() => shouldShowOnboarding() ? "onboarding" : null);
  const previousOverlayRef = useRef<AppOverlay>(null);
  const [onboardingInitialStep, setOnboardingInitialStep] = useState<1 | 2>(() => shouldShowOnboarding() ? 1 : 2);
  const [onboardingProjectPath, setOnboardingProjectPath] = useState<string | undefined>();
  const [settingsCategory, setSettingsCategory] = useState<SettingCategoryId>("appearance");
  const [activeDestination, setActiveDestination] = useState<SidebarDestination>("new_task");
  const [selectedCanonicalTaskId, setSelectedCanonicalTaskId] = useState<string | null>(null);
  const [taskWorkspaceTab, setTaskWorkspaceTab] = useState<TaskWorkspaceTab>("session");

  const [changesOpen, setChangesOpen] = useState(false);
  const [inspectorVisibilityByTask, setInspectorVisibilityByTask] = useState<Record<string, boolean>>({});
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const inspectorVisible = selectedTaskId === null
    ? false
    : inspectorVisibilityByTask[selectedTaskId] ?? readInspectorVisibility(selectedTaskId);

  useLayoutEffect(() => {
    const previous = previousOverlayRef.current;
    if (previous === null && overlay !== null) {
      setAppDialogFocusOrigin(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    } else if (previous !== null && overlay === null) {
      restoreAppDialogFocusOrigin();
    }
    previousOverlayRef.current = overlay;
  }, [overlay]);

  useEffect(() => () => {
    if (previousOverlayRef.current !== null) restoreAppDialogFocusOrigin();
  }, []);

  const toggleInspector = useCallback((): void => {
    if (!selectedTaskId) return;
    const next = !(inspectorVisibilityByTask[selectedTaskId] ?? readInspectorVisibility(selectedTaskId));
    setInspectorVisibilityByTask((current) => ({ ...current, [selectedTaskId]: next }));
    try { window.localStorage.setItem(`${INSPECTOR_VISIBILITY_KEY}${selectedTaskId}`, String(next)); } catch { /* optional preference */ }
  }, [inspectorVisibilityByTask, selectedTaskId]);

  const goToNewTask = useCallback((): void => {
    setActiveDestination("new_task");
    setSelectedCanonicalTaskId(null);
    selectTask(null);
    setChangesOpen(false);
  }, [selectTask]);

  const openDestination = useCallback((destination: SidebarDestination): void => {
    setActiveDestination(destination);
    setSelectedCanonicalTaskId(null);
    if (destination !== "chat") setChangesOpen(false);
  }, []);

  const openTaskWorkspace = useCallback((tab: TaskWorkspaceTab): void => {
    const allowed = taskWorkspaceTabs().some((entry) => entry.value === tab);
    setTaskWorkspaceTab(allowed ? tab : "session");
    setActiveDestination("task_details");
    setChangesOpen(false);
  }, []);

  const inspectCanonicalTask = useCallback((taskId: string): void => {
    setSelectedCanonicalTaskId(taskId);
    setTaskWorkspaceTab("session");
    setActiveDestination("task_details");
    setChangesOpen(false);
  }, []);

  const openBoardTask = useCallback((task: TaskV2Snapshot): void => {
    if (task.conversationContext === null) {
      inspectCanonicalTask(task.id);
      return;
    }
    setSelectedCanonicalTaskId(null);
    setActiveDestination("chat");
    setChangesOpen(false);
    selectTask(task.id);
  }, [inspectCanonicalTask, selectTask]);

  /** Open a task by id — from a clicked notification, or from the board. */
  const openTaskById = useCallback((taskId: string): void => {
    setSelectedCanonicalTaskId(null);
    setActiveDestination("chat");
    setChangesOpen(false);
    setOverlay(null);
    selectTask(taskId);
  }, [selectTask]);

  // Dock badge and native notifications for tasks that want a human.
  useNativeAttention(openTaskById);
  // Catch a run whose ending never reached this client.
  useTurnWatchdog();
  // The connection state is a fact about the whole window, so it is checked and
  // shown here rather than inferred separately by each surface.
  useHealthMonitor();

  const openSettings = useCallback((category: SettingCategoryId = "appearance"): void => {
    // Preferences belong in their own window on macOS. Fall back to the
    // in-app overlay wherever there is no native shell to open one — the
    // browser build and tests — and if the window refuses to open.
    const openNativeSettings = window.terminusDesktop?.openSettings;
    if (openNativeSettings) {
      void openNativeSettings(category).catch(() => {
        setSettingsCategory(category);
        setOverlay("settings");
      });
      return;
    }
    setSettingsCategory(category);
    setOverlay("settings");
  }, []);

  const openProject = useCallback((projectPath?: string): void => {
    // React passes a MouseEvent to unwrapped click handlers. Keep the native
    // drop path, but never let an event object become persisted path state.
    setOnboardingProjectPath(typeof projectPath === "string" ? projectPath : undefined);
    setOnboardingInitialStep(2);
    setOverlay("onboarding");
  }, []);

  useEffect(() => {
    const desktop = window.terminusDesktop;
    if (!desktop) return;
    return desktop.onCommand((commandId) => {
      switch (commandId) {
        case "command-palette":
          setOverlay((current) => current === "palette" ? null : "palette");
          break;
        case "open-project":
          openProject();
          break;
        case "settings":
          openSettings("appearance");
          break;
        case "shortcut-reference":
          openSettings("shortcuts");
          break;
        case "new-task":
          setOverlay(null);
          goToNewTask();
          break;
        case "show-changes":
          if (selectedTaskId) setChangesOpen((open) => !open);
          break;
        case "toggle-inspector":
          toggleInspector();
          break;
        case "toggle-sidebar":
          setSidebarVisible((visible) => !visible);
          break;
        case "stop-run": {
          // ⌘. from the native menu. The control plane answers whether there
          // is anything to stop; this does not second-guess it.
          const target = useTerminusStore.getState().selectedTaskId;
          if (target) void useTerminusStore.getState().stopTask(target);
          break;
        }
      }
    });
  }, [goToNewTask, openProject, openSettings, selectedTaskId, toggleInspector]);

  /**
   * Where the native shell is asking the window to go.
   *
   * The menu bar, the Dock and deep links all route through one channel now:
   * a task id, a session id, or a directory that may not be open yet.
   */
  useEffect(() => {
    const subscribe = window.terminusDesktop?.onNavigate;
    if (!subscribe) return;
    return subscribe((target) => {
      setOverlay(null);
      if (target.kind === "task") {
        selectTask(target.taskId);
        openDestination("chat");
        return;
      }
      if (target.kind === "project") {
        selectSession(target.sessionId);
        openDestination("new_task");
        selectTask(null);
        return;
      }
      void useTerminusStore.getState().openProjectPath(target.path)
        .then(() => {
          openDestination("new_task");
          selectTask(null);
        })
        .catch(() => {
          // The path could not be opened as it stands; let the operator see
          // and correct it rather than failing silently.
          openProject(target.path);
        });
    });
  }, [openDestination, openProject, selectSession, selectTask]);

  useEffect(() => {
    const desktop = window.terminusDesktop;
    if (!desktop) return;
    return desktop.onDirectoryDrop((projectPath) => openProject(projectPath));
  }, [openProject]);

  useEffect(() => {
    const objective = activeDestination === "chat"
      ? selectedTask?.contract?.objective?.trim()
      : undefined;
    const title = objective ? `${objective} — Terminus` : "Terminus";
    void window.terminusDesktop?.setWindowTitle(title);
  }, [activeDestination, selectedTask?.contract?.objective]);

  // Initial data load.
  useEffect(() => {
    void refreshAll();
    // Reconcile when the user returns to the app instead of polling while
    // idle. Active task updates remain event-driven through SSE.
    const refreshOnFocus = (): void => {
      const state = useTerminusStore.getState();
      // The task on screen is the one whose staleness is visible, and it was
      // the one thing this did not refresh: coming back to a window that had
      // been behind something else for ten minutes left the open task showing
      // whatever it was doing when you left.
      void Promise.all([
        state.refreshSessions(),
        state.refreshPinnedTasks(),
        state.selectedSessionId ? state.refreshTasks(state.selectedSessionId) : Promise.resolve(),
        state.selectedTaskId ? state.refreshTask(state.selectedTaskId) : Promise.resolve(),
      ]);
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refreshAll]);

  // ⌘K opens the command palette (SPEC §18). ⌘, opens Settings (SPEC §20).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (matchesShortcut(e, FIXED_SHORTCUTS.commandPalette)) {
        e.preventDefault();
        setOverlay((current) => current === "palette" ? null : current === null ? "palette" : current);
        return;
      }
      if (matchesShortcut(e, FIXED_SHORTCUTS.settings)) {
        e.preventDefault();
        if (overlay === "settings") setOverlay(null);
        else if (overlay === null) openSettings("appearance");
        return;
      }
      if (matchesShortcut(e, FIXED_SHORTCUTS.openProject)) {
        e.preventDefault();
        if (overlay === null || overlay === "onboarding") openProject();
        return;
      }
      if (matchesShortcut(e, FIXED_SHORTCUTS.shortcutReference)) {
        e.preventDefault();
        if (overlay === null || overlay === "settings") openSettings("shortcuts");
        return;
      }
      if (overlay !== null) return;
      if (matchesShortcut(e, FIXED_SHORTCUTS.stopRun)) {
        const target = selectedTaskId ?? selectedCanonicalTaskId;
        if (target) {
          e.preventDefault();
          void stopTask(target);
        }
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.newTask)) {
        e.preventDefault();
        goToNewTask();
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.showChanges) && selectedTaskId) {
        e.preventDefault();
        setChangesOpen((open) => !open);
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.toggleInspector)) {
        e.preventDefault();
        toggleInspector();
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.toggleSidebar)) {
        e.preventDefault();
        setSidebarVisible((visible) => !visible);
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.taskSlot)) {
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
  }, [goToNewTask, openProject, openSettings, overlay, selectedSessionTasks, selectedTaskId, selectTask, toggleInspector]);

  useEffect(() => {
    const onOpenSettings = (event: Event): void => {
      const detail = event instanceof CustomEvent
        ? event.detail as { category?: string } | undefined
        : undefined;
      openSettings(settingsCategoryFor(detail?.category));
    };
    const openOnboarding = (): void => openProject();
    const openCommandPalette = (): void => setOverlay("palette");
    window.addEventListener("terminus:open-settings", onOpenSettings);
    window.addEventListener("terminus:open-onboarding", openOnboarding);
    window.addEventListener("terminus:open-command-palette", openCommandPalette);
    return () => {
      window.removeEventListener("terminus:open-settings", onOpenSettings);
      window.removeEventListener("terminus:open-onboarding", openOnboarding);
      window.removeEventListener("terminus:open-command-palette", openCommandPalette);
    };
  }, [openProject, openSettings]);

  // Build the command catalog. Memoized so the palette doesn't re-rank
  // on every App re-render.
  const taskCommandsEnabled = selectedTaskId !== null || selectedCanonicalTaskId !== null;
  // Stop applies to whichever task is on screen, including one selected only
  // on the board and therefore absent from the v1 selection.
  const stopTarget = selectedTaskId ?? selectedCanonicalTaskId;
  // "Stop this run" offered against an idle task is a button that can only
  // fail. The board-only selection has no event tail here, so it keeps the
  // entry and lets the control plane answer.
  const canStopRun = stopTarget !== null && (selectedTaskId === null || selectedRunIsActive);

  const commands = useMemo(
    () => [
      ...buildDefaultCommands({
        openProject,
        newTask: goToNewTask,
        stopRun: canStopRun && stopTarget ? () => { void stopTask(stopTarget); } : undefined,
        showChanges: selectedTaskId ? () => setChangesOpen(true) : undefined,
        toggleInspector: selectedTaskId ? toggleInspector : undefined,
        toggleSidebar: () => setSidebarVisible((visible) => !visible),
        sidebarVisible,
        switchTheme: () => cycleTheme(),
        switchDensity: () => toggleDensity(),
        openSettings,
        openMissionBoard: () => openDestination("board"),
        openAttentionCenter: () => setOverlay("attention"),
        viewShortcuts: () => openSettings("shortcuts"),
        projects: sessions.map((session) => ({
          id: session.id,
          title: session.title,
          path: projectUriToPath(session.workspace_root_uri ?? null),
          current: session.id === selectedSessionId,
        })),
        selectProject: (sessionId: string) => {
          selectSession(sessionId);
          openDestination("new_task");
          selectTask(null);
        },
      }),
      ...selectedSessionTasks.map((task) => ({
        id: `task.open.${task.id}`,
        label: task.contract?.objective ?? task.id,
        group: "Task" as const,
        description: `Open loaded task ${task.id}`,
        keywords: [task.id, "open", "switch", "loaded task"],
        action: () => {
          selectTask(task.id);
          openDestination("chat");
        },
      })),
      ...(selectedSessionId && selectedTaskPage?.nextCursor ? [{
        id: `task.load-more.${selectedSessionId}`,
        label: "Load more tasks",
        group: "Task" as const,
        description: "Fetch the next task page before searching again",
        keywords: ["search more tasks", "next page", "loaded tasks"],
        action: () => loadMoreTasks(selectedSessionId),
      }] : []),
    ],
    [canStopRun, cycleTheme, goToNewTask, loadMoreTasks, openDestination, openProject, openSettings, openTaskWorkspace, selectSession, selectTask, selectedSessionId, selectedSessionTasks, selectedTask, selectedTaskId, selectedTaskPage?.nextCursor, sessions, sidebarVisible, stopTarget, stopTask, taskCommandsEnabled, toggleDensity, toggleInspector],
  );

  const showNewTask = selectedTaskId === null && activeDestination === "new_task";
  const showNavigationSurface = selectedTaskId === null && activeDestination === "chat";
  const durableTaskId = selectedTask?.id ?? null;

  const onCompleteOnboarding = useCallback((): void => {
    markOnboardingComplete();
    setOverlay(null);
  }, []);

  const draftReviewRevision = useCallback((instruction: string): void => {
    if (!selectedTaskId) return;
    const existing = useTerminusStore.getState().draftsByTask[selectedTaskId]?.trim() ?? "";
    setDraft(selectedTaskId, existing ? `${existing}\n\n${instruction}` : instruction);
  }, [selectedTaskId, setDraft]);

  const conversation = (
    <Suspense
      fallback={
        <div className="content-column grid h-full content-center gap-2 px-6" role="status" aria-label="Loading conversation">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      }
    >
      <Conversation onNewTask={goToNewTask} />
    </Suspense>
  );

  return (
    <>
      <Layout
        banner={<ConnectionBanner />}
        sidebarVisible={sidebarVisible}
        inspectorVisible={activeDestination === "chat" && inspectorVisible && durableTaskId !== null && !changesOpen}
        backgroundInert={overlay !== null}
        center={activeDestination === "task_details" ? (
          <span className="ui-label text-secondary">Task</span>
        ) : activeDestination === "chat" && selectedTask ? (
          <span className="flex min-w-0 max-w-2xl items-center gap-2.5 text-primary">
            <FolderClosed size={14} className="shrink-0 text-tertiary" aria-hidden />
            <span className="ui-page-title truncate">{selectedTask.contract?.objective ?? selectedTask.id}</span>
            <TaskStatusPill status={displayLifecycleWith(selectedTask, selectedRunActivity)} />
          </span>
        ) : undefined}
        sidebar={
          <Sidebar
            activeDestination={activeDestination}
            onNavigate={(destination) => {
              openDestination(destination);
              if (destination === "new_task") selectTask(null);
            }}
            onOpenAttentionCenter={() => setOverlay("attention")}
            onOpenProject={openProject}
            taskActionsEnabled={selectedTask !== null}
          />
        }
        inspector={
          activeDestination === "chat" && durableTaskId ? (
            <Suspense fallback={null}>
              <Inspector
                onShowChanges={() => setChangesOpen(true)}
              />
            </Suspense>
          ) : null
        }
        main={
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-tertiary">Loading</div>}>
            {showNewTask ? (
              <NewTaskScreen onOpenProject={openProject} />
            ) : activeDestination === "board" ? (
              <MissionBoardView
                onOpenTask={openBoardTask}
                onInspectTask={inspectCanonicalTask}
              />
            ) : activeDestination === "agents" ? (
              <AgentsView />
            ) : activeDestination === "task_details" ? (
              <Tabs
                value={taskWorkspaceTab}
                onValueChange={(value) => {
                  const tab = parseTaskWorkspaceTab(value);
                  if (tab) setTaskWorkspaceTab(tab);
                }}
                label="Task workspace views"
                items={[
                  ...taskWorkspaceTabs().map((tab) => ({
                    value: tab.value,
                    label: tab.label,
                    content: tab.value === "session"
                      ? (
                          <div className="flex h-full flex-col">
                            <div className="min-h-0 flex-1">{conversation}</div>
                            <div className="composer-dock shrink-0 pb-3 pt-2">
                              <Composer />
                            </div>
                          </div>
                        )
                      : durableTaskId
                        ? (
                            <SelectedTaskReviewPane
                              taskId={durableTaskId}
                              onClose={() => setTaskWorkspaceTab("session")}
                              onDraftRevision={draftReviewRevision}
                            />
                          )
                        // The review pane reads the durable task's event
                        // stream, which a task selected only on the board does
                        // not have yet. Say so rather than render a blank tab.
                        : <TaskRequiredState feature="Changes" />,
                  })),
                ]}
              />
            ) : showNavigationSurface ? (
              <ChatDestinationSurface onStartTask={goToNewTask} />
            ) : changesOpen && durableTaskId ? (
              <ResizableReviewLayout
                conversation={<div className="flex h-full min-w-0 flex-col">
                  <div className="min-h-0 flex-1">{conversation}</div>
                  <div className="composer-dock shrink-0 pb-3 pt-2">
                    <Composer />
                  </div>
                </div>}
                review={<Suspense fallback={<div className="flex h-full items-center justify-center bg-diff text-tertiary text-sm" >Loading review</div>}>
                  <SelectedTaskReviewPane
                    taskId={durableTaskId}
                    onClose={() => setChangesOpen(false)}
                    onDraftRevision={draftReviewRevision}
                  />
                </Suspense>}
              />
            ) : (
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1">
                  {conversation}
                </div>
                <div className="composer-dock shrink-0 pb-3 pt-2">
                  <Composer />
                </div>
              </div>
            )}
          </Suspense>
        }
        left={
          <>
            <IconButton
              onClick={() => setSidebarVisible((visible) => !visible)}
              label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
              icon={<PanelLeft size={14} />}
              aria-pressed={sidebarVisible}
              data-tooltip={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
              className="icon-button rounded-md text-secondary hover:bg-hover hover:text-primary"
            />
            {/* The space name is the sidebar's header. Without it the left
                column's first content sat 32px below the right column's,
                which is what made the two columns read as misaligned. */}
            {selectedSession ? (
              <ProjectMenu
                onProjectSelected={() => {
                  openDestination("new_task");
                  selectTask(null);
                }}
                onOpenProject={openProject}
                trigger={(
                  <Button
                    type="button"
                    aria-label="Switch project"
                    className="ui-label titlebar-no-drag flex min-w-0 max-w-48 items-center gap-1 truncate rounded px-1 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                  >
                    <span className="min-w-0 truncate">{selectedSession.title}</span>
                    <ChevronDown size={11} strokeWidth={2} className="shrink-0 text-tertiary" aria-hidden />
                  </Button>
                )}
              />
            ) : null}
          </>
        }
        right={
          <>
            {activeDestination === "chat" ? (
              <IconButton
                onClick={toggleInspector}
                disabled={!selectedTask}
                label={inspectorVisible ? "Hide task context" : "Show task context"}
                icon={<PanelRight size={14} />}
                aria-pressed={inspectorVisible}
                data-tooltip={selectedTask ? (inspectorVisible ? "Hide task context" : "Show task context") : "Task context appears when a task is selected"}
                className="icon-button rounded-md text-secondary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-35"
              />
            ) : null}
          </>
        }
      />
      {overlay === "palette" ? (
        <Suspense fallback={<ModalLoadingFallback label="command palette" onClose={() => setOverlay(null)} />}>
          <CommandPalette open onClose={() => setOverlay(null)} commands={commands} />
        </Suspense>
      ) : null}
      {overlay === "settings" ? (
        <Suspense fallback={<ModalLoadingFallback label="settings" onClose={() => setOverlay(null)} />}>
          <Settings
            key={settingsCategory}
            open
            onClose={() => setOverlay(null)}
            initialCategoryId={settingsCategory}
          />
        </Suspense>
      ) : null}
      {overlay === "onboarding" ? (
        <Suspense fallback={<ModalLoadingFallback label="project setup" onClose={() => setOverlay(null)} />}>
          <Onboarding
            key={`${onboardingInitialStep}:${onboardingProjectPath ?? "picker"}`}
            onComplete={onCompleteOnboarding}
            pickDirectory={window.terminusDesktop?.pickDirectory}
            initialStep={onboardingInitialStep}
            initialProjectPath={onboardingProjectPath}
            mode={onboardingInitialStep === 1 ? "first-run" : "open-project"}
          />
        </Suspense>
      ) : null}
      {overlay === "attention" ? (
        <Suspense fallback={<ModalLoadingFallback label="attention center" onClose={() => setOverlay(null)} />}>
          <AttentionCenterModal
            isOpen
            onClose={() => setOverlay(null)}
            selectedTaskId={durableTaskId}
            onOpenTask={(taskId) => {
              setOverlay(null);
              selectTask(taskId);
              openDestination("chat");
            }}
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
