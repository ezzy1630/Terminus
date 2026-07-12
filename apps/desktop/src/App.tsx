/**
 * Forge Desktop — Root App component.
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { Conversation } from "./components/Conversation";
import { Composer } from "./components/Composer";
import { NewTaskScreen } from "./components/NewTaskScreen";
import { CommandPalette, buildDefaultCommands } from "./components/CommandPalette";
import { Settings } from "./components/Settings";
import { Onboarding } from "./components/Onboarding";
import { useForgeStore } from "./hooks/use-forge";
import { useThemeStore } from "./hooks/use-theme";
import type { Theme } from "./types";

const ONBOARDING_KEY = "forge-desktop.onboarding.completed.v1";

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
  const refreshAll = useForgeStore((s) => s.refreshAll);
  const selectedTaskId = useForgeStore((s) => s.selectedTaskId);
  const selectTask = useForgeStore((s) => s.selectTask);
  const healthReady = useForgeStore((s) => s.healthReady);
  const lastError = useForgeStore((s) => s.lastError);

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const cycleTheme = useThemeStore((s) => s.cycleTheme);
  const toggleDensity = useThemeStore((s) => s.toggleDensity);
  const density = useThemeStore((s) => s.density);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => shouldShowOnboarding());

  // Initial data load.
  useEffect(() => {
    void refreshAll();
    // Refresh sessions every 30s as a slow fallback. SSE is the primary
    // update channel; this is just for reconciliation.
    const id = window.setInterval(() => {
      void useForgeStore.getState().refreshSessions();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  // ⌘K opens the command palette (SPEC §18). ⌘, opens Settings (SPEC §20).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Build the command catalog. Memoized so the palette doesn't re-rank
  // on every App re-render.
  const commands = useMemo(
    () =>
      buildDefaultCommands({
        newTask: () => selectTask(null),
        switchTheme: () => cycleTheme(),
        switchDensity: () => toggleDensity(),
        openSettings: () => setSettingsOpen(true),
        // The remaining actions are no-ops until the host wires them to
        // the diff/terminal/git surfaces (Phase 5 follow-up).
        openProject: undefined,
        openTask: undefined,
        showChanges: undefined,
        openTerminal: undefined,
        toggleInspector: undefined,
        pinInspector: undefined,
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
    [cycleTheme, selectTask, toggleDensity],
  );

  const showNewTask = selectedTaskId === null;

  const onCompleteOnboarding = useCallback((): void => {
    markOnboardingComplete();
    setOnboardingOpen(false);
  }, []);

  return (
    <>
      <Layout
        sidebar={<Sidebar />}
        inspector={<Inspector />}
        main={
          showNewTask ? (
            <NewTaskScreen />
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
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-secondary hover:bg-hover hover:text-primary"
              style={{ fontSize: "var(--font-size-xs)" }}
            >
              <span>{density === "spacious" ? "Spacious" : "Compact"}</span>
            </button>
            {/* Command palette trigger (small icon — main entry is ⌘K). */}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              title="Command palette (⌘K)"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-secondary hover:bg-hover hover:text-primary"
              style={{ fontSize: "var(--font-size-xs)" }}
            >
              <span>Commands</span>
              <kbd className="font-mono text-tertiary">⌘K</kbd>
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
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {onboardingOpen ? (
        <Onboarding onComplete={onCompleteOnboarding} />
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
