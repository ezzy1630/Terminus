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
import { ArrowLeft, ArrowRight, Ellipsis, FolderClosed, MessageCircle, PanelLeft, PanelRight } from "lucide-react";
import { Layout } from "./components/Layout";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ProviderAccountsNotice } from "./components/ProviderAccountsNotice";
import { projectUriToPath } from "./lib/projects";
import { readSidebarVisible, writeSidebarVisible } from "./lib/sidebar-prefs";
import { useMarkSelectedTaskRead } from "./hooks/use-task-read";
import { ResizableReviewLayout } from "./components/ResizableReviewLayout";
import { Sidebar } from "./components/Sidebar";
import { FOCUS_QUEUE_EVENT } from "./components/TaskQueue";
import { Composer } from "./components/Composer";
import { NewTaskScreen } from "./components/NewTaskScreen";
import { MissionBoardView } from "./components/MissionBoardView";
import { EmptyState } from "./ui/EmptyState";
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
import { useNavHistory, type NavLocation } from "./hooks/use-nav-history";
import { taskRunIsActiveWith } from "./lib/turn-activity";
import type { Theme } from "./types";
import type { SidebarDestination } from "./components/Sidebar";
import { isSettingCategoryId, type SettingCategoryId } from "./lib/settings-categories";

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
  return isSettingCategoryId(requested) ? requested : "appearance";
}
import type { TaskV2Snapshot } from "./types/v2";
import { FIXED_SHORTCUTS, matchesShortcut, shortcutDisplay } from "./lib/shortcuts";
import { restoreAppDialogFocusOrigin, setAppDialogFocusOrigin } from "./hooks/use-dialog-focus";
import { buildDefaultCommands } from "./lib/command-catalog";
import { Button } from "./ui/Button";
import { DialogSurface } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { Menu, type MenuItem } from "./ui/Menu";
import { Skeleton, Spinner } from "./ui/Status";
import { Tabs } from "./ui/Tabs";
import { TaskRequiredState } from "./components/Cockpit/CockpitPrimitives";

/**
 * Feature chunks, named rather than inlined into `lazy()` so they can also be
 * *warmed*.
 *
 * Splitting these out keeps SPEC §25.1 — the shell paints before the feature
 * bundles load — but the rule only ever meant "not before first paint". Left
 * to load on demand, every first click paid for a fetch in front of the
 * operator: a sheet mounted twice (the Suspense fallback, then the real panel
 * at a different size, each with its own entrance), a tab that showed the word
 * "Loading" before it showed anything, an inspector that arrived a beat after
 * the task did. None of that is network latency — these files are on the local
 * disk, a few milliseconds away — so it bought nothing and read as a slow app.
 *
 * They are all pulled in on the frame after the shell paints instead. First
 * paint is still unblocked; everything after it is already in memory.
 */
const importTaskSearch = () => import("./components/TaskSearch");
const importCommandPalette = () => import("./components/CommandPalette");
const importSettings = () => import("./components/Settings");
const importOnboarding = () => import("./components/Onboarding");
const importReviewPane = () => import("./components/ReviewPane");
const importConversation = () => import("./components/Conversation");
const importInspector = () => import("./components/Inspector");
const importAgentsView = () => import("./components/AgentsView");

const FEATURE_CHUNKS = [
  // The surfaces behind the sidebar and the task tabs come first: they are
  // what the operator reaches for before anything else.
  importConversation,
  importInspector,
  importTaskSearch,
  importCommandPalette,
  importSettings,
  importReviewPane,
  importAgentsView,
  importOnboarding,
];

/** Fetch every feature chunk. A failure here is not an error: the Suspense
 *  boundary still loads the chunk on demand, just more slowly. */
function warmFeatureChunks(): void {
  for (const load of FEATURE_CHUNKS) void load().catch(() => { /* the boundary retries */ });
}

const TaskSearch = lazy(async () => {
  const searchModule = await importTaskSearch();
  return { default: searchModule.TaskSearch };
});
const CommandPalette = lazy(async () => {
  const paletteModule = await importCommandPalette();
  return { default: paletteModule.CommandPalette };
});

const Settings = lazy(async () => {
  const settingsModule = await importSettings();
  return { default: settingsModule.Settings };
});

const Onboarding = lazy(async () => {
  const onboardingModule = await importOnboarding();
  return { default: onboardingModule.Onboarding };
});

const ReviewPane = lazy(async () => {
  const reviewModule = await importReviewPane();
  return { default: reviewModule.ReviewPane };
});

const Conversation = lazy(async () => {
  const conversationModule = await importConversation();
  return { default: conversationModule.Conversation };
});

const Inspector = lazy(async () => {
  const inspectorModule = await importInspector();
  return { default: inspectorModule.Inspector };
});


const AgentsView = lazy(async () => {
  const agentsModule = await importAgentsView();
  return { default: agentsModule.AgentsView };
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
      events={events}
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

/**
 * Which surfaces show the task-context dock.
 *
 * The board used to carry its own 300px `TaskQuickView` — a second detail
 * panel, four pixels narrower than this one, with its own layout and its own
 * subset of the facts. Selecting a task now shows the same inspector in the
 * same place whichever surface you selected it from, which is most of what
 * makes two panes feel like one window.
 */
const SURFACES_WITH_INSPECTOR = new Set<SidebarDestination>(["chat", "board"]);

const ONBOARDING_KEY = "terminus-desktop.onboarding.completed.v1";
const INSPECTOR_VISIBILITY_KEY = "terminus-desktop.inspector-visible.";
type AppOverlay = "palette" | "search" | "settings" | "onboarding" | null;
// Session-first tabs live in lib/session-view.
const parseTaskWorkspaceTab = parseTaskWorkspaceTabValue;

/** Matches `--duration-fast`, which drives the `dialog-out` keyframes. */
const OVERLAY_EXIT_MS = 140;

/**
 * Keep a dismissed overlay in the tree long enough to animate out.
 *
 * Overlays are rendered conditionally, so clearing `overlay` used to remove
 * the Radix dialog in the same commit: every sheet rose and faded in, then
 * disappeared on a single frame. This returns the overlay that should still be
 * *mounted*, which for the length of the close animation is the one that was
 * just dismissed — rendered with `open={false}`, which is the signal Radix
 * needs to play its exit before unmounting itself.
 */
function useOverlayPresence(overlay: AppOverlay): AppOverlay {
  const [previous, setPrevious] = useState<AppOverlay>(overlay);
  const [exiting, setExiting] = useState<AppOverlay>(null);

  // Adjusted during render, the way React documents for state derived from a
  // changing input: the dismissed overlay has to appear in *this* render's
  // output. Deferring it to an effect would drop the sheet for one commit and
  // bring it back, which is a flicker rather than an exit.
  if (previous !== overlay) {
    setPrevious(overlay);
    setExiting(overlay === null ? previous : null);
  }

  useEffect(() => {
    if (exiting === null) return;
    const timer = window.setTimeout(() => setExiting(null), OVERLAY_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  return overlay ?? exiting;
}

function readInspectorVisibility(taskId: string): boolean {
  try { return window.localStorage.getItem(`${INSPECTOR_VISIBILITY_KEY}${taskId}`) === "true"; }
  catch { return false; }
}

/** Long enough that a warm chunk never shows this, short enough that a cold
 *  one does not look like a dropped click. */
const FALLBACK_DELAY_MS = 160;

/**
 * True once a wait has lasted long enough to be worth admitting to.
 *
 * A Suspense fallback drawn the instant a boundary suspends is what put a
 * small panel on screen for two frames before the real dialog replaced it, and
 * what flashed the word "Loading" across a pane that was about to render. A
 * warmed chunk resolves in single-digit milliseconds; below this threshold the
 * honest report is silence, because nobody waited.
 */
function useSlowEnoughToSay(): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), FALLBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return slow;
}

/** A pane-filling wait, shown only if the wait is real. */
function SurfaceLoadingFallback({ label, className }: { label: string; className?: string }): JSX.Element {
  if (!useSlowEnoughToSay()) return <></>;
  return (
    <div className={`flex h-full items-center justify-center text-sm text-tertiary ${className ?? ""}`} role="status">
      {label}
    </div>
  );
}

function ModalLoadingFallback({ label, onClose }: { label: string; onClose: () => void }): JSX.Element {
  if (!useSlowEnoughToSay()) return <></>;
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
  // The stored status says ACTIVE for as long as a task exists. What the shell
  // reports is what the run is actually doing.
  const selectedRunActivity = useSelectedTaskRunActivity();
  const selectedRunIsActive = taskRunIsActiveWith(selectedTask, selectedRunActivity);

  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const toggleDensity = useThemeStore((s) => s.toggleDensity);

  const [overlay, setOverlay] = useState<AppOverlay>(() => shouldShowOnboarding() ? "onboarding" : null);
  const previousOverlayRef = useRef<AppOverlay>(null);
  const [onboardingInitialStep, setOnboardingInitialStep] = useState<1 | 2>(() => shouldShowOnboarding() ? 1 : 2);
  const [onboardingProjectPath, setOnboardingProjectPath] = useState<string | undefined>();
  // The counter, not the category, is what tells Settings a *fresh* request
  // arrived: ⌘, twice in a row asks for Appearance both times, and the second
  // ask still has to move the pane there if the operator has since clicked
  // into Shortcuts.
  const [settingsRequest, setSettingsRequest] = useState<{ category: SettingCategoryId; nonce: number }>(
    { category: "appearance", nonce: 0 },
  );
  const settingsCategory = settingsRequest.category;
  const mountedOverlay = useOverlayPresence(overlay);
  const [activeDestination, setActiveDestination] = useState<SidebarDestination>(() =>
    useTerminusStore.getState().selectedTaskId ? "chat" : "new_task",
  );
  const [selectedCanonicalTaskId, setSelectedCanonicalTaskId] = useState<string | null>(null);
  const [taskWorkspaceTab, setTaskWorkspaceTab] = useState<TaskWorkspaceTab>("session");

  const [changesOpen, setChangesOpen] = useState(false);
  const [inspectorVisibilityByTask, setInspectorVisibilityByTask] = useState<Record<string, boolean>>({});
  // Hiding the rail is a deliberate act — usually to give a diff the width —
  // and it did not survive a relaunch, so the next launch undid it.
  const [sidebarVisible, setSidebarVisible] = useState(readSidebarVisible);
  const inspectorVisible = selectedTaskId === null
    ? false
    : inspectorVisibilityByTask[selectedTaskId] ?? readInspectorVisibility(selectedTaskId);

  useEffect(() => {
    if (selectedTaskId && activeDestination === "new_task") {
      setActiveDestination("chat");
    }
  }, [selectedTaskId, activeDestination]);

  // Three separate places toggle the rail — the title-bar button, the
  // shortcut, and the command palette — so this is written on the value
  // rather than at each of them.
  useEffect(() => { writeSidebarVisible(sidebarVisible); }, [sidebarVisible]);

  // The frame after the shell paints, not on idle: idle can be seconds away on
  // a busy stream, and the whole point is that the operator never waits for a
  // chunk. By the time the window has finished appearing, every surface behind
  // a lazy boundary is already resident.
  useEffect(() => {
    const frame = window.requestAnimationFrame(warmFeatureChunks);
    return () => window.cancelAnimationFrame(frame);
  }, []);

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

  /**
   * Replay a recorded position. This is the ordinary "go here" routine, which
   * is why back and forward need no special cases: everything that navigates
   * moves the same two pieces of state, and this puts them back.
   */
  const applyNavLocation = useCallback((target: NavLocation): void => {
    setSelectedCanonicalTaskId(null);
    setActiveDestination(target.destination);
    setChangesOpen(false);
    selectTask(target.taskId);
  }, [selectTask]);

  const navHistory = useNavHistory({
    destination: activeDestination,
    taskId: selectedTaskId,
    apply: applyNavLocation,
  });

  // Opening a task is what marks it read, which is what lets a finished task
  // settle out of the queue instead of sitting in it forever.
  useMarkSelectedTaskRead(selectedTaskId, selectedTask?.updated_at ?? null);
  // Dock badge and native notifications for tasks that want a human.
  useNativeAttention(openTaskById);
  // Catch a run whose ending never reached this client.
  useTurnWatchdog();
  // The connection state is a fact about the whole window, so it is checked and
  // shown here rather than inferred separately by each surface.
  useHealthMonitor();

  const openSettings = useCallback((category: SettingCategoryId = "appearance"): void => {
    // Always in-app. Settings used to prefer a second native window, which
    // meant ⌘, threw the operator out of the task they were reading into a
    // window with its own Dock entry and its own idea of which project was
    // current. Every entry point — the menu bar's ⌘,, the sidebar gear, the
    // palette — routes through here, so they all stay in one window.
    setSettingsRequest((current) => ({ category, nonce: current.nonce + 1 }));
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
      } else if (matchesShortcut(e, FIXED_SHORTCUTS.focusQueue)) {
        e.preventDefault();
        // Showing the rail first: the shortcut means "take me to the queue",
        // and a focus call into a hidden column is a keypress that does
        // nothing and says nothing.
        setSidebarVisible(true);
        window.dispatchEvent(new Event(FOCUS_QUEUE_EVENT));
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
    const openTaskSearch = (): void => setOverlay((current) => current === "search" ? null : current === null ? "search" : current);
    window.addEventListener("terminus:open-task-search", openTaskSearch);
    window.addEventListener("terminus:open-settings", onOpenSettings);
    window.addEventListener("terminus:open-onboarding", openOnboarding);
    window.addEventListener("terminus:open-command-palette", openCommandPalette);
    return () => {
      window.removeEventListener("terminus:open-settings", onOpenSettings);
      window.removeEventListener("terminus:open-onboarding", openOnboarding);
      window.removeEventListener("terminus:open-command-palette", openCommandPalette);
      window.removeEventListener("terminus:open-task-search", openTaskSearch);
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
        focusQueue: () => window.dispatchEvent(new Event(FOCUS_QUEUE_EVENT)),
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

  /**
   * The title bar's `···`. Codex puts the per-document actions here rather
   * than spreading them across the bar, and every entry below is an action the
   * app already performs — there is nothing here that only opens a dialog to
   * say it is unavailable.
   */
  const taskOverflowItems = useMemo<MenuItem[]>(() => {
    if (!selectedTask) return [];
    const items: MenuItem[] = [
      {
        id: "task.copy-id",
        label: "Copy task ID",
        onSelect: () => { void navigator.clipboard?.writeText(selectedTask.id); },
      },
      {
        id: "task.show-changes",
        label: "Show changes",
        shortcut: shortcutDisplay(FIXED_SHORTCUTS.showChanges),
        onSelect: () => setChangesOpen(true),
      },
      {
        id: "task.toggle-inspector",
        label: inspectorVisible ? "Hide context panel" : "Show context panel",
        shortcut: shortcutDisplay(FIXED_SHORTCUTS.toggleInspector),
        onSelect: toggleInspector,
      },
    ];
    // Offered only against a run that can actually be stopped. "Stop" on an
    // idle task is a button whose only possible outcome is an error.
    if (selectedRunIsActive) {
      items.push({
        id: "task.stop-run",
        label: "Stop run",
        shortcut: shortcutDisplay(FIXED_SHORTCUTS.stopRun),
        separatorBefore: true,
        danger: true,
        onSelect: () => { void stopTask(selectedTask.id); },
      });
    }
    return items;
  }, [inspectorVisible, selectedRunIsActive, selectedTask, stopTask, toggleInspector]);

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
        banner={(
          <>
            {/* A connection problem outranks an announcement, so it is drawn
                first; both are hairline strips that render nothing when they
                have nothing to say. */}
            <ConnectionBanner />
            <ProviderAccountsNotice />
          </>
        )}
        sidebarVisible={sidebarVisible}
        inspectorVisible={SURFACES_WITH_INSPECTOR.has(activeDestination) && inspectorVisible && durableTaskId !== null && !changesOpen}
        backgroundInert={overlay !== null}
        center={activeDestination === "task_details" ? (
          <span className="ui-label text-secondary">Task</span>
        ) : activeDestination === "chat" && selectedTask ? (
          <span className="flex min-w-0 items-center gap-2 text-primary">
            <FolderClosed size={14} className="shrink-0 text-tertiary" aria-hidden />
            {/* Native document titles are 13px semibold; the 15px page title
                made the bar read as a web page header. The run's state is not
                repeated here — the sidebar row and the composer both show it,
                and a third copy in the title bar was the one that never moved. */}
            <span className="truncate text-base font-semibold">{selectedTask.contract?.objective ?? selectedTask.id}</span>
            <Menu
              label="Task actions"
              align="start"
              items={taskOverflowItems}
              trigger={(
                <IconButton
                  label="Task actions"
                  icon={<Ellipsis size={15} />}
                  size="sm"
                  // `.titlebar-center` is a pointer-transparent overlay so the
                  // bar stays draggable across the title; the one control in it
                  // opts back into hit testing, and out of the drag region.
                  className="icon-button titlebar-no-drag pointer-events-auto h-6 w-6 shrink-0 rounded-md text-tertiary hover:bg-hover hover:text-primary"
                />
              )}
            />
          </span>
        ) : undefined}
        sidebar={
          <Sidebar
            activeDestination={activeDestination}
            onNavigate={(destination) => {
              openDestination(destination);
              if (destination === "new_task") selectTask(null);
            }}
            onOpenProject={openProject}
          />
        }
        inspector={
          SURFACES_WITH_INSPECTOR.has(activeDestination) && durableTaskId ? (
            <Suspense fallback={null}>
              <Inspector
                onShowChanges={() => setChangesOpen(true)}
              />
            </Suspense>
          ) : null
        }
        main={
          <Suspense fallback={<SurfaceLoadingFallback label="Loading" />}>
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
                review={<Suspense fallback={<SurfaceLoadingFallback label="Loading review" className="bg-diff" />}>
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
          /* Codex's cluster, in Codex's order: the panel toggle that owns the
             column beneath it, then the shell's own back/forward. The project
             name is no longer duplicated here — it is the sidebar's header,
             directly below, and two switchers for one project was one too
             many. */
          <>
            <IconButton
              onClick={() => setSidebarVisible((visible) => !visible)}
              label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
              icon={<PanelLeft size={14} />}
              aria-pressed={sidebarVisible}
              data-tooltip={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
              className="icon-button rounded-md text-secondary hover:bg-hover hover:text-primary"
            />
            <IconButton
              onClick={navHistory.goBack}
              disabled={!navHistory.canGoBack}
              label="Back"
              icon={<ArrowLeft size={14} />}
              data-tooltip="Back"
              className="icon-button rounded-md text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-30"
            />
            <IconButton
              onClick={navHistory.goForward}
              disabled={!navHistory.canGoForward}
              label="Forward"
              icon={<ArrowRight size={14} />}
              data-tooltip="Forward"
              className="icon-button rounded-md text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-30"
            />
          </>
        }
        right={
          <>
            {SURFACES_WITH_INSPECTOR.has(activeDestination) ? (
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
      {mountedOverlay === "search" ? (
        <Suspense fallback={<ModalLoadingFallback label="task search" onClose={() => setOverlay(null)} />}>
          <TaskSearch
            open={overlay === "search"}
            onClose={() => setOverlay(null)}
            onSelectTask={(taskId) => {
              selectTask(taskId);
              openDestination("chat");
              setChangesOpen(false);
            }}
            onNewTask={goToNewTask}
            onOpenProject={() => openProject()}
            onOpenBoard={() => openDestination("board")}
            onOpenCommands={() => setOverlay("palette")}
          />
        </Suspense>
      ) : null}
      {mountedOverlay === "palette" ? (
        <Suspense fallback={<ModalLoadingFallback label="command palette" onClose={() => setOverlay(null)} />}>
          <CommandPalette open={overlay === "palette"} onClose={() => setOverlay(null)} commands={commands} />
        </Suspense>
      ) : null}
      {mountedOverlay === "settings" ? (
        <Suspense fallback={<ModalLoadingFallback label="settings" onClose={() => setOverlay(null)} />}>
          {/* No `key`. Keying on the category tore the whole sheet down and
              rebuilt it whenever a second entry point asked for a different
              page — ⌘/ while Settings was already open replayed the entrance
              animation from scratch. The pane moves; the sheet stays put. */}
          <Settings
            open={overlay === "settings"}
            onClose={() => setOverlay(null)}
            initialCategoryId={settingsCategory}
            categoryRequest={settingsRequest.nonce}
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
