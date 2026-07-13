/**
 * Terminus Desktop — Settings.
 *
 * Per SPEC §20: a full-screen overlay (or separate route) organized
 * into clear categories. Search, clear descriptions, sensible
 * defaults, per-setting and per-category reset, validation, and
 * immediate preview for appearance settings (theme, density).
 *
 * Categories (SPEC §20 list, preserved verbatim):
 *   - General
 *   - Appearance
 *   - Editor
 *   - Terminal
 *   - Agents and Models
 *   - Permissions
 *   - Git
 *   - Computer Use
 *   - Notifications
 *   - Keyboard Shortcuts
 *   - Performance
 *   - Integrations
 *   - Advanced
 *   - Diagnostics
 *
 * Per design constraints: CSS variables, lucide-react icons,
 * accessible (keyboard nav, focus states, SR labels), restrained
 * motion, both themes polished equally.
 *
 * The settings store is a small Zustand store persisted to
 * localStorage. Appearance settings (theme, density) also call into
 * the existing useThemeStore so the preview is immediate.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Bug,
  Cpu,
  Folder,
  GitBranch,
  Keyboard,
  Monitor,
  Palette,
  Plug,
  Search,
  Settings as SettingsIcon,
  Shield,
  Sliders,
  Terminal as TerminalIcon,
  Wand2,
  X,
  RotateCcw,
} from "lucide-react";
import { create } from "zustand";
import { cn } from "../lib/cn";
import { useThemeStore } from "../hooks/use-theme";
import type { Density, Theme } from "../types";

// ────────────────────────── Setting model ───────────────────────────────────

export type SettingCategoryId =
  | "general"
  | "appearance"
  | "editor"
  | "terminal"
  | "agents"
  | "permissions"
  | "git"
  | "computer-use"
  | "notifications"
  | "shortcuts"
  | "performance"
  | "integrations"
  | "advanced"
  | "diagnostics";

export type SettingControl =
  | { kind: "toggle" }
  | { kind: "select"; options: Array<{ value: string; label: string }> }
  | { kind: "text"; placeholder?: string }
  | { kind: "number"; min?: number; max?: number; step?: number; unit?: string }
  | { kind: "shortcut"; placeholder?: string };

export interface SettingDescriptor {
  id: string;
  /** Display label. */
  label: string;
  /** Longer description shown under the label. */
  description?: string;
  /** Control kind. */
  control: SettingControl;
  /** Default value (used by reset). */
  defaultValue: string | number | boolean;
  /**
   * Whether a restart is required for changes to take effect.
   * Per SPEC §20: "Restart labels only where actually necessary."
   */
  restartRequired?: boolean;
  /** Optional validation function returning an error message. */
  validate?: (value: string | number | boolean) => string | null;
  /**
   * Side-effect hook called whenever the value changes. Use for
   * appearance preview, density, etc.
   */
  apply?: (value: string | number | boolean) => void;
}

export interface SettingCategory {
  id: SettingCategoryId;
  label: string;
  description: string;
  icon: React.ReactNode;
  settings: SettingDescriptor[];
}

// ────────────────────────── Defaults catalog ────────────────────────────────

/**
 * Per SPEC §19 (Onboarding): "Default all settings for a base-model
 * 13-inch M4 MacBook Air: efficient spacious density, system
 * appearance, dynamic inspector, terminal hidden, computer-use
 * preview paused while hidden, conservative notifications, reduced
 * background work, lightweight editor behavior, performance-conscious
 * animation, sensible default shortcuts, no unnecessary startup
 * destinations, no decorative animation."
 */
function buildCatalog(): SettingCategory[] {
  return [
    {
      id: "general",
      label: "General",
      description: "Startup, workspace, and recovery behavior.",
      icon: <SettingsIcon size={14} />,
      settings: [
        {
          id: "general.open-last-project",
          label: "Reopen last project on launch",
          description: "Skip the project picker and resume where you left off.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "general.show-onboarding",
          label: "Show onboarding",
          description: "Run the first-launch flow again on next start.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
        {
          id: "general.auto-update",
          label: "Check for updates automatically",
          description: "Notify when a new build is available.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "general.crash-reports",
          label: "Send crash reports",
          description: "Anonymous diagnostics help us fix rare crashes.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
      ],
    },
    {
      id: "appearance",
      label: "Appearance",
      description: "Theme, density, and motion. Changes apply immediately.",
      icon: <Palette size={14} />,
      settings: [
        {
          id: "appearance.theme",
          label: "Theme",
          description: "System follows your macOS appearance.",
          control: {
            kind: "select",
            options: [
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ],
          },
          defaultValue: "system",
          apply: (v) => useThemeStore.getState().setTheme(v as Theme),
        },
        {
          id: "appearance.density",
          label: "Density",
          description: "Compact tightens rows and panel padding.",
          control: {
            kind: "select",
            options: [
              { value: "spacious", label: "Spacious" },
              { value: "compact", label: "Compact" },
            ],
          },
          defaultValue: "spacious",
          apply: (v) => useThemeStore.getState().setDensity(v as Density),
        },
        {
          id: "appearance.reduce-motion",
          label: "Reduce motion",
          description: "Disable non-essential animations.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
        {
          id: "appearance.reduce-transparency",
          label: "Reduce transparency",
          description: "Use solid surfaces instead of native vibrancy.",
          control: { kind: "toggle" },
          defaultValue: false,
          restartRequired: true,
        },
      ],
    },
    {
      id: "editor",
      label: "Editor",
      description: "Lightweight inline editor behavior.",
      icon: <Folder size={14} />,
      settings: [
        {
          id: "editor.tab-size",
          label: "Tab size",
          description: "Spaces per indentation level in previews.",
          control: { kind: "number", min: 1, max: 8, step: 1, unit: "spaces" },
          defaultValue: 2,
          validate: (v) => (typeof v === "number" && v >= 1 && v <= 8 ? null : "Tab size must be between 1 and 8."),
        },
        {
          id: "editor.word-wrap",
          label: "Word wrap",
          description: "Wrap long lines in the file preview.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "editor.font-size",
          label: "Font size",
          description: "Code preview font size in pixels.",
          control: { kind: "number", min: 10, max: 18, step: 1, unit: "px" },
          defaultValue: 12,
        },
        {
          id: "editor.external",
          label: "External editor",
          description: "Application used by Open in editor actions.",
          control: {
            kind: "select",
            options: [
              { value: "cursor", label: "Cursor" },
              { value: "vscode", label: "VS Code" },
              { value: "sublime", label: "Sublime Text" },
              { value: "system", label: "System default" },
            ],
          },
          defaultValue: "cursor",
        },
      ],
    },
    {
      id: "terminal",
      label: "Terminal",
      description: "Shell, scrollback, and tab behavior.",
      icon: <TerminalIcon size={14} />,
      settings: [
        {
          id: "terminal.shell",
          label: "Default shell",
          description: "Detected from your environment if left empty.",
          control: { kind: "text", placeholder: "/bin/zsh" },
          defaultValue: "",
        },
        {
          id: "terminal.scrollback",
          label: "Scrollback lines",
          description: "Maximum lines kept per terminal tab.",
          control: { kind: "number", min: 500, max: 50000, step: 500, unit: "lines" },
          defaultValue: 8000,
        },
        {
          id: "terminal.font-family",
          label: "Font family",
          description: "Monospace font for terminal output.",
          control: { kind: "text", placeholder: "SF Mono" },
          defaultValue: "SF Mono",
        },
        {
          id: "terminal.persist-when-hidden",
          label: "Persist sessions when hidden",
          description: "Keep the PTY alive when the drawer is collapsed.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
      ],
    },
    {
      id: "agents",
      label: "Agents and Models",
      description: "Default agent, model profile, and provider routing.",
      icon: <Wand2 size={14} />,
      settings: [
        {
          id: "agents.default",
          label: "Default model profile",
          description: "Profile id supplied by a connected provider. Leave empty to use the session default.",
          control: { kind: "text", placeholder: "Connected provider profile" },
          defaultValue: "",
        },
        {
          id: "agents.model",
          label: "Provider connection",
          description: "Connection id reported by the provider registry.",
          control: { kind: "text", placeholder: "No provider connected" },
          defaultValue: "",
        },
        {
          id: "agents.auto-verify",
          label: "Run verification automatically",
          description: "Trigger verification after the agent completes a step.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "agents.max-concurrent",
          label: "Max concurrent subagents",
          description: "Hard cap on parallel subagent executions.",
          control: { kind: "number", min: 1, max: 8, step: 1, unit: "agents" },
          defaultValue: 2,
        },
      ],
    },
    {
      id: "permissions",
      label: "Permissions",
      description: "Default access level and approval rules.",
      icon: <Shield size={14} />,
      settings: [
        {
          id: "permissions.default-access",
          label: "Default permission profile",
          description: "Policy profile id supplied by the selected workspace or session.",
          control: { kind: "text", placeholder: "Workspace policy" },
          defaultValue: "",
        },
        {
          id: "permissions.approve-network",
          label: "Approve network calls",
          description: "Require approval before outbound network operations.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "permissions.approve-writes",
          label: "Approve writes outside workspace",
          description: "Require approval before any write outside the workspace root.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "permissions.approve-exec",
          label: "Approve shell execution",
          description: "Require approval before running shell commands.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
      ],
    },
    {
      id: "git",
      label: "Git",
      description: "Branch, commit, and pull request defaults.",
      icon: <GitBranch size={14} />,
      settings: [
        {
          id: "git.auto-stage",
          label: "Auto-stage reviewed changes",
          description: "Stage accepted hunks automatically when committing.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
        {
          id: "git.default-branch",
          label: "Default branch name",
          description: "Used when creating new branches.",
          control: { kind: "text", placeholder: "main" },
          defaultValue: "main",
        },
        {
          id: "git.sign-commits",
          label: "Sign commits",
          description: "GPG-sign commits when a signing key is configured.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
        {
          id: "git.pr-base",
          label: "Default PR base branch",
          description: "Default target branch for new pull requests.",
          control: { kind: "text", placeholder: "main" },
          defaultValue: "main",
        },
      ],
    },
    {
      id: "computer-use",
      label: "Computer Use",
      description: "Picture-in-picture behavior and pause rules.",
      icon: <Monitor size={14} />,
      settings: [
        {
          id: "computer-use.pip-when-hidden",
          label: "Pause preview when hidden",
          description: "Stop frame rendering while the PiP is collapsed.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "computer-use.frame-rate",
          label: "Preview frame rate",
          description: "Captured frames per second.",
          control: { kind: "number", min: 1, max: 30, step: 1, unit: "fps" },
          defaultValue: 8,
        },
        {
          id: "computer-use.notify-on-control",
          label: "Notify when agent takes control",
          description: "Surface a native notification before input simulation.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
      ],
    },
    {
      id: "notifications",
      label: "Notifications",
      description: "Conservative defaults to keep you focused.",
      icon: <Bell size={14} />,
      settings: [
        {
          id: "notifications.task-completed",
          label: "Task completed",
          description: "Notify when a task finishes while the app is unfocused.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "notifications.task-failed",
          label: "Task failed",
          description: "Notify when a task fails.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "notifications.approval-required",
          label: "Approval required",
          description: "Notify when the agent requests permission.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "notifications.subagent-done",
          label: "Subagent finished",
          description: "Notify when a delegated subagent completes.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
        {
          id: "notifications.dock-badge",
          label: "Dock badge for pending approvals",
          description: "Show the count of pending approvals on the dock icon.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
      ],
    },
    {
      id: "shortcuts",
      label: "Keyboard Shortcuts",
      description: "Customize global and contextual shortcuts.",
      icon: <Keyboard size={14} />,
      settings: [
        {
          id: "shortcuts.command-palette",
          label: "Open command palette",
          control: { kind: "shortcut" },
          defaultValue: "Cmd+K",
        },
        {
          id: "shortcuts.new-task",
          label: "New task",
          control: { kind: "shortcut" },
          defaultValue: "Cmd+N",
        },
        {
          id: "shortcuts.toggle-terminal",
          label: "Toggle terminal",
          control: { kind: "shortcut" },
          defaultValue: "Cmd+`",
        },
        {
          id: "shortcuts.toggle-inspector",
          label: "Toggle inspector",
          control: { kind: "shortcut" },
          defaultValue: "Cmd+I",
        },
        {
          id: "shortcuts.send",
          label: "Send message",
          control: { kind: "shortcut" },
          defaultValue: "Cmd+Enter",
        },
      ],
    },
    {
      id: "performance",
      label: "Performance",
      description: "Tune for the base-model 13-inch MacBook Air.",
      icon: <Cpu size={14} />,
      settings: [
        {
          id: "performance.virtualize-conversations",
          label: "Virtualize long conversations",
          description: "Window messages outside the viewport for smoother scrolling.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "performance.virtualize-diffs",
          label: "Virtualize large diffs",
          description: "Render only visible hunks in the diff viewer.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "performance.background-polling",
          label: "Reduced background polling",
          description: "Slow the reconciliation poll when SSE is healthy.",
          control: { kind: "toggle" },
          defaultValue: true,
        },
        {
          id: "performance.max-events-per-task",
          label: "Max events per task",
          description: "Cap on events retained in memory per task.",
          control: { kind: "number", min: 200, max: 10000, step: 100, unit: "events" },
          defaultValue: 2000,
        },
      ],
    },
    {
      id: "integrations",
      label: "Integrations",
      description: "External editors, terminals, and version control hosts.",
      icon: <Plug size={14} />,
      settings: [
        {
          id: "integrations.cursor-path",
          label: "Cursor path",
          description: "Override the auto-detected Cursor binary location.",
          control: { kind: "text", placeholder: "/Applications/Cursor.app" },
          defaultValue: "",
        },
        {
          id: "integrations.vscode-path",
          label: "VS Code path",
          description: "Override the VS Code CLI path.",
          control: { kind: "text", placeholder: "code" },
          defaultValue: "",
        },
        {
          id: "integrations.git-path",
          label: "Git path",
          description: "Override the auto-detected git binary.",
          control: { kind: "text", placeholder: "/usr/bin/git" },
          defaultValue: "",
        },
        {
          id: "integrations.github-host",
          label: "GitHub host",
          description: "Use github.com or a GitHub Enterprise hostname.",
          control: { kind: "text", placeholder: "github.com" },
          defaultValue: "github.com",
        },
      ],
    },
    {
      id: "advanced",
      label: "Advanced",
      description: "Low-level behavior. Change with care.",
      icon: <Sliders size={14} />,
      settings: [
        {
          id: "advanced.api-base",
          label: "Control plane URL",
          description: "Base URL of the Terminus control plane service.",
          control: { kind: "text", placeholder: "http://127.0.0.1:3050" },
          defaultValue: "http://127.0.0.1:3050",
          restartRequired: true,
          validate: (v) => {
            if (typeof v !== "string") return null;
            try {
              // eslint-disable-next-line no-new
              new URL(v);
              return null;
            } catch {
              return "Enter a valid URL.";
            }
          },
        },
        {
          id: "advanced.debug-logging",
          label: "Debug logging",
          description: "Write verbose logs to the diagnostics console.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
        {
          id: "advanced.experimental-features",
          label: "Experimental features",
          description: "Enable unreleased capabilities for testing.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
      ],
    },
    {
      id: "diagnostics",
      label: "Diagnostics",
      description: "Inspect logs, runtime status, and cache.",
      icon: <Bug size={14} />,
      settings: [
        {
          id: "diagnostics.open-logs",
          label: "Log directory",
          description: "Where Terminus writes session and error logs.",
          control: { kind: "text", placeholder: "~/Library/Logs/Terminus" },
          defaultValue: "~/Library/Logs/Terminus",
        },
        {
          id: "diagnostics.cache-size",
          label: "Artifact cache size",
          description: "Maximum disk space used for cached artifacts.",
          control: { kind: "number", min: 100, max: 10000, step: 100, unit: "MB" },
          defaultValue: 1024,
        },
        {
          id: "diagnostics.clear-cache-on-quit",
          label: "Clear cache on quit",
          description: "Delete cached artifacts when Terminus exits.",
          control: { kind: "toggle" },
          defaultValue: false,
        },
      ],
    },
  ];
}

const CATALOG = buildCatalog();
const CATEGORIES = CATALOG;

// ────────────────────────── Settings store ──────────────────────────────────

const SETTINGS_KEY = "terminus-desktop.settings.v1";

type SettingValue = string | number | boolean;
type SettingValueMap = Record<string, SettingValue>;

function readPersisted(): SettingValueMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as SettingValueMap;
    }
  } catch {
    // ignore
  }
  return {};
}

function writePersisted(values: SettingValueMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(values));
  } catch {
    // ignore
  }
}

function defaultValues(): SettingValueMap {
  const out: SettingValueMap = {};
  for (const cat of CATALOG) {
    for (const s of cat.settings) {
      out[s.id] = s.defaultValue;
    }
  }
  return out;
}

interface SettingsState {
  values: SettingValueMap;
  get: (id: string) => SettingValue | undefined;
  set: (id: string, value: SettingValue) => void;
  reset: (id: string) => void;
  resetCategory: (categoryId: SettingCategoryId) => void;
  resetAll: () => void;
}

const persisted = readPersisted();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  values: { ...defaultValues(), ...persisted },
  get: (id) => get().values[id],
  set: (id, value) => {
    set((state) => {
      const next = { ...state.values, [id]: value };
      writePersisted(next);
      return { values: next };
    });
    // Apply side-effects (theme/density live preview).
    const descriptor = findDescriptor(id);
    descriptor?.apply?.(value);
  },
  reset: (id) => {
    const descriptor = findDescriptor(id);
    if (!descriptor) return;
    get().set(id, descriptor.defaultValue);
  },
  resetCategory: (categoryId) => {
    const cat = CATALOG.find((c) => c.id === categoryId);
    if (!cat) return;
    for (const s of cat.settings) {
      get().set(s.id, s.defaultValue);
    }
  },
  resetAll: () => {
    const next = defaultValues();
    writePersisted(next);
    set({ values: next });
    // Apply side-effects for every setting that has one.
    for (const cat of CATALOG) {
      for (const s of cat.settings) {
        s.apply?.(s.defaultValue);
      }
    }
  },
}));

function findDescriptor(id: string): SettingDescriptor | undefined {
  for (const cat of CATALOG) {
    const s = cat.settings.find((x) => x.id === id);
    if (s) return s;
  }
  return undefined;
}

// ────────────────────────── Component ───────────────────────────────────────

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  /** Optional initial category to focus. */
  initialCategoryId?: SettingCategoryId;
  className?: string;
}

function SettingsImpl({ open, onClose, initialCategoryId, className }: SettingsProps): JSX.Element {
  const [activeCat, setActiveCat] = useState<SettingCategoryId>(initialCategoryId ?? "general");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync theme store on first open so the appearance select reflects reality.
  useEffect(() => {
    if (!open) return;
    const theme = useThemeStore.getState().theme;
    const density = useThemeStore.getState().density;
    const store = useSettingsStore.getState();
    if (store.get("appearance.theme") !== theme) store.set("appearance.theme", theme);
    if (store.get("appearance.density") !== density) store.set("appearance.density", density);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const filteredCategories = useMemo(() => {
    if (!query.trim()) return CATEGORIES;
    const q = query.toLowerCase();
    return CATEGORIES.map((cat) => ({
      ...cat,
      settings: cat.settings.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          (s.description?.toLowerCase().includes(q) ?? false) ||
          s.id.includes(q),
      ),
    })).filter((cat) => cat.settings.length > 0);
  }, [query]);

  if (!open) return <></>;

  const activeCategory = filteredCategories.find((c) => c.id === activeCat) ?? filteredCategories[0] ?? CATEGORIES[0]!;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex flex-col bg-canvas"
      style={{ animation: "fade-in var(--duration-fast) var(--easing-default)" }}
    >
      {/* Header. */}
      <div
        className="titlebar-drag flex flex-shrink-0 items-center gap-2 border-b border-subtle px-4"
        style={{ height: 44, paddingLeft: 80 }}
      >
        <SettingsIcon size={14} className="text-secondary" />
        <span className="text-primary" style={{ fontSize: "var(--font-size-md)", fontWeight: 600 }}>
          Settings
        </span>
        <div className="titlebar-no-drag ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-7 w-7 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Sidebar — category list + search. */}
        <aside
          className="flex h-full w-64 flex-shrink-0 flex-col border-r border-subtle bg-sidebar"
          style={{ width: 240 }}
        >
          <div className="border-b border-subtle p-2">
            <div className="flex items-center gap-1.5 rounded-md bg-canvas px-2" style={{ height: 28 }}>
              <Search size={12} className="text-tertiary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                className="flex-1 bg-transparent text-primary placeholder:text-tertiary focus:outline-none"
                style={{ fontSize: "var(--font-size-xs)" }}
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="text-tertiary hover:text-primary"
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
          </div>
          <nav
            className="min-h-0 flex-1 overflow-y-auto py-1"
            aria-label="Settings categories"
          >
            {filteredCategories.map((cat) => {
              const isSel = cat.id === activeCategory?.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCat(cat.id)}
                  aria-current={isSel}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover",
                    isSel ? "bg-selected text-primary" : "text-secondary",
                  )}
                  style={{ fontSize: "var(--font-size-sm)" }}
                >
                  <span className="flex-shrink-0 text-tertiary" aria-hidden>
                    {cat.icon}
                  </span>
                  <span className="flex-1 truncate">{cat.label}</span>
                </button>
              );
            })}
            {filteredCategories.length === 0 ? (
              <div className="px-3 py-4 text-center text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
                No settings match "{query}".
              </div>
            ) : null}
          </nav>
        </aside>
        {/* Main pane. */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full" style={{ maxWidth: 720, padding: "24px 32px" }}>
              {activeCategory ? (
                <>
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <div>
                      <h1 className="text-primary" style={{ fontSize: "var(--font-size-xl)", fontWeight: 600 }}>
                        {activeCategory.label}
                      </h1>
                      <p className="mt-1 text-secondary" style={{ fontSize: "var(--font-size-sm)" }}>
                        {activeCategory.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => useSettingsStore.getState().resetCategory(activeCategory.id)}
                      className="inline-flex items-center gap-1 rounded-md text-secondary hover:bg-hover hover:text-primary"
                      style={{ height: 28, padding: "0 8px", fontSize: "var(--font-size-xs)" }}
                    >
                      <RotateCcw size={11} />
                      <span>Reset category</span>
                    </button>
                  </div>
                  <div className="flex flex-col gap-1">
                    {activeCategory.settings.map((s) => (
                      <SettingRow key={s.id} descriptor={s} />
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export const Settings = memo(SettingsImpl);

// ────────────────────────── Setting row ─────────────────────────────────────

function SettingRow({ descriptor }: { descriptor: SettingDescriptor }): JSX.Element {
  const value = useSettingsStore((s) => s.values[descriptor.id]);
  const set = useSettingsStore((s) => s.set);
  const reset = useSettingsStore((s) => s.reset);
  const [error, setError] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);

  const current: SettingValue = value ?? descriptor.defaultValue;

  const commit = useCallback(
    (next: SettingValue): void => {
      if (descriptor.validate) {
        const msg = descriptor.validate(next);
        if (msg) {
          setError(msg);
          return;
        }
      }
      setError(null);
      set(descriptor.id, next);
    },
    [descriptor, set],
  );

  return (
    <div
      className="flex items-start gap-4 rounded-md px-3 py-3 hover:bg-hover"
      style={{ transition: "background var(--duration-fast) var(--easing-default)" }}
    >
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="flex items-center gap-2">
          <label
            htmlFor={`setting-${descriptor.id}`}
            className="text-primary"
            style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}
          >
            {descriptor.label}
          </label>
          {descriptor.restartRequired ? (
            <span
              className="rounded-sm px-1.5 py-0.5 text-warning"
              style={{
                fontSize: 10,
                background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
              }}
              title="Restart required"
            >
              Restart
            </span>
          ) : null}
        </div>
        {descriptor.description ? (
          <p className="text-secondary" style={{ fontSize: "var(--font-size-xs)", lineHeight: "var(--line-height-relaxed)" }}>
            {descriptor.description}
          </p>
        ) : null}
        {error ? (
          <p className="text-error" role="alert" style={{ fontSize: "var(--font-size-xs)", marginTop: 2 }}>
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <SettingControlView
          descriptor={descriptor}
          value={current}
          onChange={commit}
          draftText={draftText}
          onDraftText={setDraftText}
        />
        <button
          type="button"
          onClick={() => {
            setError(null);
            reset(descriptor.id);
          }}
          aria-label={`Reset ${descriptor.label}`}
          title="Reset to default"
          className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
        >
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
}

function SettingControlView({
  descriptor,
  value,
  onChange,
  draftText,
  onDraftText,
}: {
  descriptor: SettingDescriptor;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
  draftText: string | null;
  onDraftText: (v: string | null) => void;
}): JSX.Element {
  const c = descriptor.control;
  const isModified = value !== descriptor.defaultValue;

  if (c.kind === "toggle") {
    const checked = Boolean(value);
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={descriptor.label}
        onClick={() => onChange(!checked)}
        className={cn("relative inline-flex h-5 w-9 items-center rounded-full transition-colors")}
        style={{
          background: checked ? "var(--color-primary)" : "var(--bg-hover)",
          border: "1px solid var(--border-default)",
        }}
      >
        <span
          className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
          style={{
            transform: checked ? "translateX(18px)" : "translateX(2px)",
            transitionDuration: "var(--duration-fast)",
          }}
        />
      </button>
    );
  }

  if (c.kind === "select") {
    return (
      <select
        id={`setting-${descriptor.id}`}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        aria-label={descriptor.label}
        className="rounded-md bg-canvas text-primary focus:outline-none"
        style={{
          height: 28,
          padding: "0 8px",
          fontSize: "var(--font-size-xs)",
          border: "1px solid var(--border-default)",
          minWidth: 140,
        }}
      >
        {c.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (c.kind === "number") {
    const num = typeof value === "number" ? value : Number(value) || 0;
    return (
      <div className="flex items-center gap-1">
        <input
          id={`setting-${descriptor.id}`}
          type="number"
          value={Number.isFinite(num) ? num : 0}
          min={c.min}
          max={c.max}
          step={c.step}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : 0);
          }}
          aria-label={descriptor.label}
          className="rounded-md bg-canvas text-primary focus:outline-none"
          style={{
            height: 28,
            width: 88,
            padding: "0 8px",
            fontSize: "var(--font-size-xs)",
            border: "1px solid var(--border-default)",
            fontVariantNumeric: "tabular-nums",
          }}
        />
        {c.unit ? (
          <span className="text-tertiary" style={{ fontSize: "var(--font-size-xs)" }}>
            {c.unit}
          </span>
        ) : null}
      </div>
    );
  }

  if (c.kind === "text") {
    const text = draftText ?? (typeof value === "string" ? value : String(value));
    return (
      <input
        id={`setting-${descriptor.id}`}
        type="text"
        value={text}
        placeholder={c.placeholder}
        onChange={(e) => onDraftText(e.target.value)}
        onBlur={() => {
          if (draftText !== null) {
            onChange(draftText);
            onDraftText(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draftText !== null) {
            e.preventDefault();
            onChange(draftText);
            onDraftText(null);
          } else if (e.key === "Escape" && draftText !== null) {
            e.preventDefault();
            onDraftText(null);
          }
        }}
        aria-label={descriptor.label}
        className="rounded-md bg-canvas text-primary placeholder:text-tertiary focus:outline-none"
        style={{
          height: 28,
          minWidth: 220,
          padding: "0 8px",
          fontSize: "var(--font-size-xs)",
          border: `1px solid ${isModified ? "var(--color-primary)" : "var(--border-default)"}`,
        }}
      />
    );
  }

  // shortcut
  return (
    <ShortcutControl
      label={descriptor.label}
      value={String(value)}
      onChange={onChange}
    />
  );
}

function ShortcutControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const parts: string[] = [];
      if (e.metaKey) parts.push("Cmd");
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      let key = e.key;
      if (key === " ") key = "Space";
      if (key.length === 1) key = key.toUpperCase();
      parts.push(key);
      onChange(parts.join("+"));
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);
  return (
    <button
      type="button"
      onClick={() => setRecording(true)}
      aria-label={`Edit shortcut for ${label}`}
      className={cn(
        "flex items-center gap-1 rounded-md font-mono text-primary",
        recording && "ring-1 ring-inset",
      )}
      style={{
        height: 28,
        padding: "0 10px",
        fontSize: "var(--font-size-xs)",
        background: "var(--bg-canvas)",
        border: "1px solid var(--border-default)",
        minWidth: 140,
      }}
    >
      <Keyboard size={11} className="text-tertiary" />
      <span>{recording ? "Press keys…" : value}</span>
    </button>
  );
}

// ────────────────────────── Hook ────────────────────────────────────────────

/** Convenience hook: read a setting value with type. */
export function useSetting<T extends SettingValue>(id: string, fallback: T): T {
  const v = useSettingsStore((s) => s.values[id]);
  return (v as T) ?? fallback;
}

// Re-export catalog for tests / external validation.
export const SETTING_CATEGORIES = CATEGORIES;
export type { SettingValue };
