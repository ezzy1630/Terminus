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
 *   - Agents and Models
 *   - Permissions
 *   - Git
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
import { useDialogFocus } from "../hooks/use-dialog-focus";
import {
  Bell,
  Bug,
  Cpu,
  Folder,
  GitBranch,
  Keyboard,
  Palette,
  Plug,
  Search,
  Settings as SettingsIcon,
  Shield,
  Sliders,
  Wand2,
  X,
  RotateCcw,
} from "lucide-react";
import { create } from "zustand";
import { cn } from "../lib/cn";
import { useThemeStore } from "../hooks/use-theme";
import { useTerminusStore } from "../hooks/use-terminus";
import { SETTINGS_SHORTCUTS, shortcutSettingValue } from "../lib/shortcuts";
import { api, createIdempotencyKey } from "../lib/api";
import type { Density, ProviderConfiguration, ProviderConfigurationResponse, Session, Theme } from "../types";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Kbd } from "../ui/Kbd";
import { Select } from "../ui/Select";
import { Badge } from "../ui/Status";
import { Switch } from "../ui/Switch";
import { DialogSurface } from "../ui/Dialog";
import { GatewayProviderSettings } from "./GatewayProviderSettings";

// ────────────────────────── Setting model ───────────────────────────────────

export type SettingCategoryId =
  | "general"
  | "appearance"
  | "editor"
  | "agents"
  | "permissions"
  | "git"
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
  /** Render a truthful fixed-value reference instead of an editable preference. */
  readOnly?: boolean;
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
 * 13-inch M4 MacBook Air: efficient compact density, system
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
          defaultValue: "compact",
          apply: (v) => useThemeStore.getState().setDensity(v as Density),
        },
        {
          id: "appearance.reduce-motion",
          label: "Reduce motion",
          description: "Disable non-essential animations.",
          control: { kind: "toggle" },
          defaultValue: false,
          apply: (v) => {
            document.documentElement.dataset.reduceMotion = Boolean(v) ? "true" : "false";
          },
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
      settings: SETTINGS_SHORTCUTS.map((shortcut) => ({
        id: `shortcuts.${shortcut.id}`,
        label: shortcut.label,
        description: shortcut.scope === "global"
          ? "Available across the task workspace."
          : shortcut.scope === "composer"
            ? "Available while the message composer is focused."
            : "Available while the diff viewer is focused.",
        control: { kind: "shortcut" as const },
        defaultValue: shortcutSettingValue(shortcut),
      })),
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

// Only surface settings with real behavior. Runtime policy, provider,
// notification, Git, and integration controls remain absent until typed
// control-plane contracts exist; renderer-local values must never masquerade
// as authoritative configuration.
const CATALOG = buildCatalog().flatMap((category): SettingCategory[] => {
  if (category.id === "appearance") return [category];
  if (category.id === "agents") {
    return [{
      ...category,
      description: "Read-only model profiles reported by current control-plane sessions.",
      settings: [],
    }];
  }
  if (category.id === "shortcuts") {
    return [{
      ...category,
      description: "Current fixed shortcuts. Custom bindings are not available yet.",
      settings: category.settings.map((descriptor) => ({ ...descriptor, readOnly: true })),
    }];
  }
  return [];
});
const CATEGORIES = CATALOG;

export function deriveRuntimeModelProfiles(sessions: Session[]): Array<{ id: string; projectCount: number }> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const profile = session.default_model_profile?.trim();
    if (profile) counts.set(profile, (counts.get(profile) ?? 0) + 1);
  }
  return Array.from(counts, ([id, projectCount]) => ({ id, projectCount }));
}

// ────────────────────────── Settings store ──────────────────────────────────

const SETTINGS_KEY = "terminus-desktop.settings.v1";

type SettingValue = string | number | boolean;
type SettingValueMap = Record<string, SettingValue>;

/** null when the payload is missing or unreadable, so callers can tell the two apart. */
function parsePersisted(raw: string | null): SettingValueMap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SettingValueMap : null;
  } catch {
    return null;
  }
}

function readPersisted(): SettingValueMap {
  if (typeof window === "undefined") return {};
  return parsePersisted(window.localStorage.getItem(SETTINGS_KEY)) ?? {};
}

function writePersisted(values: SettingValueMap): void {
  if (typeof window === "undefined") return;
  try {
    // Theme and density have one owner: useThemeStore. Keeping a second
    // persisted copy here made lazily opening Settings restore stale values.
    const rendererOnly = Object.fromEntries(
      Object.entries(values).filter(([id]) => id !== "appearance.theme" && id !== "appearance.density"),
    );
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(rendererOnly));
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

function normalizeSettingValue(id: string, value: unknown): SettingValue {
  const descriptor = findDescriptor(id);
  if (!descriptor) return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : "";
  const control = descriptor.control;
  if (control.kind === "toggle") return typeof value === "boolean" ? value : descriptor.defaultValue;
  if (control.kind === "select") {
    return typeof value === "string" && control.options.some((option) => option.value === value)
      ? value
      : descriptor.defaultValue;
  }
  if (control.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return descriptor.defaultValue;
    return Math.min(control.max ?? Number.POSITIVE_INFINITY, Math.max(control.min ?? Number.NEGATIVE_INFINITY, value));
  }
  return typeof value === "string" ? value : descriptor.defaultValue;
}

function normalizedPersistedValues(raw: SettingValueMap): SettingValueMap {
  const values: SettingValueMap = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id === "appearance.theme" || id === "appearance.density") continue;
    if (findDescriptor(id)) values[id] = normalizeSettingValue(id, value);
  }
  return values;
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
  values: { ...defaultValues(), ...normalizedPersistedValues(persisted) },
  get: (id) => get().values[id],
  set: (id, value) => {
    const normalized = normalizeSettingValue(id, value);
    set((state) => {
      const next = { ...state.values, [id]: normalized };
      writePersisted(next);
      return { values: next };
    });
    // Apply side-effects (theme/density live preview).
    const descriptor = findDescriptor(id);
    descriptor?.apply?.(normalized);
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

/**
 * Preferences are edited in their own window (see SettingsWindow), so this
 * store is live in two renderers. A `storage` event means the other window
 * saved: re-read what it wrote and re-apply the live side effects, so a
 * change to motion or transparency takes hold here too. Adopting the written
 * value without writing it back keeps the two windows from echoing.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== SETTINGS_KEY) return;
    // A payload we cannot read is not an instruction to reset every
    // preference; keep what is already in effect.
    const remote = parsePersisted(event.newValue);
    if (remote === null) return;
    const next = { ...defaultValues(), ...normalizedPersistedValues(remote) };
    const previous = useSettingsStore.getState().values;
    useSettingsStore.setState({ values: next });
    for (const [id, value] of Object.entries(next)) {
      if (previous[id] === value) continue;
      findDescriptor(id)?.apply?.(value);
    }
  });
}

// Install every live preference once at module load so persisted motion,
// transparency, theme, and density choices are true before Settings opens.
for (const category of CATALOG) {
  for (const descriptor of category.settings) {
    if (!descriptor.apply) continue;
    if (descriptor.id === "appearance.theme" || descriptor.id === "appearance.density") continue;
    const value = useSettingsStore.getState().get(descriptor.id) ?? descriptor.defaultValue;
    descriptor.apply(value);
  }
}

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
  const [activeCat, setActiveCat] = useState<SettingCategoryId>(initialCategoryId ?? "appearance");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sessions = useTerminusStore((state) => state.sessions);
  const runtimeProfiles = useMemo(() => deriveRuntimeModelProfiles(sessions), [sessions]);
  const [providerConfiguration, setProviderConfiguration] = useState<ProviderConfigurationResponse | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderConfiguration | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerLoading, setProviderLoading] = useState(false);
  const dialogRef = useDialogFocus<HTMLDivElement>(open, onClose);

  // Focus search after the dialog has mounted. Theme and density rows subscribe
  // directly to their canonical store; no cross-store synchronization occurs.
  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open || activeCat !== "agents") return;
    const controller = new AbortController();
    setProviderLoading(true);
    setProviderError(null);
    void api.getProviderConfiguration(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      setProviderConfiguration(response);
      setProviderDraft(response.configuration ?? {
        program: "",
        args: [],
        model: "",
        timeout_seconds: 300,
        tools_enabled: false,
        revision: 0,
        updated_by: "",
        created_at: "",
        updated_at: "",
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setProviderError(error instanceof Error ? error.message : "Provider configuration could not be loaded.");
    }).finally(() => {
      if (!controller.signal.aborted) setProviderLoading(false);
    });
    return () => controller.abort();
  }, [activeCat, open]);

  const saveProviderConfiguration = useCallback(async (): Promise<void> => {
    if (providerDraft === null) return;
    if (providerDraft.program.trim().length === 0 || providerDraft.model.trim().length === 0) {
      setProviderError("Program and model are required.");
      return;
    }
    if (!Number.isSafeInteger(providerDraft.timeout_seconds) || providerDraft.timeout_seconds < 1 || providerDraft.timeout_seconds > 3_600) {
      setProviderError("Timeout must be a whole number between 1 and 3600 seconds.");
      return;
    }
    if (providerDraft.args.some((argument) => argument.length === 0)) {
      setProviderError("Arguments cannot contain a blank argv entry.");
      return;
    }
    setProviderSaving(true);
    setProviderError(null);
    try {
      const response = await api.putProviderConfiguration({
        program: providerDraft.program,
        args: providerDraft.args,
        model: providerDraft.model,
        timeout_seconds: providerDraft.timeout_seconds,
        tools_enabled: providerDraft.tools_enabled,
        expected_revision: providerDraft.revision,
      }, { idempotencyKey: createIdempotencyKey("provider-config") });
      setProviderConfiguration(response);
      setProviderDraft(response.configuration);
    } catch (error: unknown) {
      setProviderError(error instanceof Error ? error.message : "Provider configuration could not be saved.");
    } finally {
      setProviderSaving(false);
    }
  }, [providerDraft]);

  const filteredCategories = useMemo(() => {
    if (!query.trim()) return CATEGORIES;
    const q = query.toLowerCase();
    return CATEGORIES.map((cat) => ({
      ...cat,
      settings: [cat.label, cat.description, cat.id, cat.id === "agents" ? "OpenCode Zen Go local provider command model tools" : ""]
        .some((value) => value.toLowerCase().includes(q))
        ? cat.settings
        : cat.settings.filter(
            (s) =>
              s.label.toLowerCase().includes(q) ||
              (s.description?.toLowerCase().includes(q) ?? false) ||
              s.id.includes(q),
          ),
    })).filter((cat) => cat.settings.length > 0);
  }, [query]);

  if (!open) return <></>;

  const activeCategory = filteredCategories.find((c) => c.id === activeCat) ?? filteredCategories[0] ?? null;
  const activeCategoryHasLiveSettings = activeCategory?.settings.some((descriptor) => typeof descriptor.apply === "function") ?? false;

  return (
    <DialogSurface
      ref={dialogRef}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      accessibleTitle="Settings"
      overlayClassName="bg-canvas"
      className="settings-dialog fixed inset-0 flex flex-col bg-canvas data-[state=open]:animate-fade-in"
    >
      {/* Header. */}
      <div
        className="settings-titlebar titlebar-drag flex h-10 flex-shrink-0 items-center gap-2 border-b border-subtle px-3 pl-20"
      >
        <span className="ui-page-title text-primary">
          Settings
        </span>
        <div className="titlebar-no-drag ml-auto flex items-center gap-2">
          <IconButton
            onClick={onClose}
            label="Close settings"
            icon={<X size={14} aria-hidden />}
          />
        </div>
      </div>
      <div className="settings-body flex min-h-0 flex-1">
        {/* Sidebar — category list + search. */}
        <aside
          className="settings-sidebar flex h-full w-52 flex-shrink-0 flex-col border-r border-subtle bg-sidebar"
        >
          <div className="border-b border-subtle p-2">
            <div className="settings-search flex h-7 items-center gap-2 rounded-md bg-canvas px-2">
              <Search size={14} className="text-tertiary" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                className="h-7 flex-1 border-0 bg-transparent px-0 text-xs shadow-none"
              />
              {query ? (
                <IconButton
                  onClick={() => setQuery("")}
                  label="Clear search"
                  icon={<X size={11} aria-hidden />}
                  size="sm"
                />
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
                <Button
                  key={cat.id}
                  onClick={() => setActiveCat(cat.id)}
                  aria-current={isSel}
                  variant="ghost"
                  size="md"
                  className={cn(
                    "settings-category w-full justify-start rounded-none px-3 text-left",
                    isSel ? "bg-selected text-primary" : "text-secondary",
                  )}
                >
                  <span className="flex-shrink-0 text-tertiary" aria-hidden>
                    {cat.icon}
                  </span>
                  <span className="flex-1 truncate">{cat.label}</span>
                </Button>
              );
            })}
            {filteredCategories.length === 0 ? (
              <div className="px-3 py-4 text-center text-tertiary text-xs" >
                No settings match "{query}".
              </div>
            ) : null}
          </nav>
        </aside>
        {/* Main pane. */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="settings-content mx-auto w-full max-w-[640px] p-4">
              {activeCategory ? (
                <>
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <div>
                      <h1 className="ui-page-title text-primary">
                        {activeCategory.label}
                      </h1>
                      <p className="ui-body mt-0.5 text-secondary" >
                        {activeCategory.description}
                      </p>
                    </div>
                    {activeCategoryHasLiveSettings ? (
                      <Button
                        onClick={() => useSettingsStore.getState().resetCategory(activeCategory.id)}
                        variant="ghost"
                        size="sm"
                        leading={<RotateCcw size={11} aria-hidden />}
                      >
                        <span>Reset category</span>
                      </Button>
                    ) : null}
                  </div>
                    {activeCategory.settings.length > 0 ? (
                      <div className="settings-panel flex flex-col divide-y divide-[var(--border-subtle)]">
                        {activeCategory.settings.map((s) => (
                          <SettingRow key={s.id} descriptor={s} />
                        ))}
                      </div>
                    ) : null}

                    {activeCategory.id === "agents" ? (
                      <>
                      <GatewayProviderSettings />
                      <section className="mb-4 border-t border-subtle pt-4" aria-label="Local provider configuration">
                        <div className="flex items-start gap-3">
                          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-secondary"><Plug size={14} /></div>
                          <div className="min-w-0 flex-1">
                            <div className="ui-section-title flex items-center gap-2 text-primary">
                              Local provider
                              <Badge tone={providerConfiguration?.configured === true ? "success" : "neutral"}>
                                {providerLoading ? "Loading" : providerConfiguration?.configured === true ? "Configured" : "Unconfigured"}
                              </Badge>
                            </div>
                            <p className="ui-meta mt-0.5">
                              Local command for model requests. Arguments are passed directly without a shell.
                            </p>
                          </div>
                        </div>
                        {providerDraft ? (
                          <div className="mt-3 grid gap-2.5">
                            <label className="ui-label grid gap-1 text-secondary">
                              Program
                              <Input aria-label="Local provider program" value={providerDraft.program} onChange={(event) => setProviderDraft({ ...providerDraft, program: event.target.value })} />
                            </label>
                            <label className="ui-label grid gap-1 text-secondary">
                              Model
                              <Input aria-label="Local provider model" value={providerDraft.model} onChange={(event) => setProviderDraft({ ...providerDraft, model: event.target.value })} />
                            </label>
                            <label className="ui-label grid gap-1 text-secondary">
                              Arguments (one argv entry per line)
                              <textarea aria-label="Local provider arguments" className="min-h-20 rounded-md border border-subtle bg-canvas px-2 py-1.5 font-mono text-xs text-primary" value={providerDraft.args.join("\n")} onChange={(event) => setProviderDraft({ ...providerDraft, args: event.target.value.length === 0 ? [] : event.target.value.split("\n") })} />
                            </label>
                            <label className="ui-label grid gap-1 text-secondary">
                              Timeout (seconds)
                              <Input aria-label="Local provider timeout" type="number" min={1} max={3600} step={1} value={providerDraft.timeout_seconds} onChange={(event) => setProviderDraft({ ...providerDraft, timeout_seconds: Number(event.target.value) })} />
                            </label>
                            <div className="flex items-start justify-between gap-4 border-y border-subtle py-2.5">
                              <div>
                                <div className="ui-label text-secondary">Allow standalone tools</div>
                                <p className="ui-meta mt-0.5">Expose read, exact patch, and bounded exec for this task.</p>
                              </div>
                              <Switch checked={providerDraft.tools_enabled} onCheckedChange={(checked) => setProviderDraft({ ...providerDraft, tools_enabled: checked })} label="Allow standalone provider tools" />
                            </div>
                            {providerError ? <p className="text-error text-xs" role="alert">{providerError}</p> : null}
                            <div><Button onClick={() => void saveProviderConfiguration()} disabled={providerSaving || providerLoading} variant="secondary" size="sm">{providerSaving ? "Saving…" : "Save provider configuration"}</Button></div>
                          </div>
                        ) : (
                          <div className="mt-4 text-tertiary text-xs">{providerError ?? "No local provider command is configured."}</div>
                        )}
                      </section>
                      <section className="mb-4 border-t border-subtle pt-4" aria-label="Runtime model profiles">
                        <div className="flex items-start gap-3">
                          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-secondary">
                            <Plug size={14} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="ui-section-title text-primary">Available model profiles</div>
                            <p className="ui-meta mt-0.5">
                              Profiles reported by current projects.
                            </p>
                          </div>
                          <span className="ui-meta tabular-nums" >
                            {runtimeProfiles.length}
                          </span>
                        </div>
                        {runtimeProfiles.length > 0 ? (
                          <ul className="mt-2 divide-y divide-[var(--border-subtle)] border-y border-subtle">
                            {runtimeProfiles.map((profile) => (
                              <li key={profile.id} className="flex min-h-8 items-center justify-between px-1 py-1.5">
                                <span className="min-w-0 truncate font-mono text-primary text-xs" >{profile.id}</span>
                                <span className="ml-3 flex-shrink-0 text-tertiary text-xs" >{profile.projectCount} project{profile.projectCount === 1 ? "" : "s"}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="mt-3 px-1 py-2 text-tertiary text-xs" >
                            No provider-backed model profile has been reported by the control plane.
                          </div>
                        )}
                      </section>
                      </>
                    ) : null}
                </>
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center text-center">
                  <Search size={18} className="text-tertiary" aria-hidden />
                  <h1 className="ui-page-title mt-2 text-primary">
                    No matching settings
                  </h1>
                  <p className="ui-body mt-1 max-w-xs text-secondary" >
                    Nothing matches “{query}”. Try another search or clear it to browse every category.
                  </p>
                  <Button
                    onClick={() => setQuery("")}
                    className="mt-4"
                    variant="secondary"
                    size="md"
                  >
                    Clear search
                  </Button>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </DialogSurface>
  );
}

export const Settings = memo(SettingsImpl);

// ────────────────────────── Setting row ─────────────────────────────────────

function SettingRow({ descriptor }: { descriptor: SettingDescriptor }): JSX.Element {
  const value = useSettingsStore((s) => s.values[descriptor.id]);
  const set = useSettingsStore((s) => s.set);
  const reset = useSettingsStore((s) => s.reset);
  const theme = useThemeStore((state) => state.theme);
  const density = useThemeStore((state) => state.density);
  const setTheme = useThemeStore((state) => state.setTheme);
  const setDensity = useThemeStore((state) => state.setDensity);
  const [error, setError] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);

  const current: SettingValue = descriptor.id === "appearance.theme"
    ? theme
    : descriptor.id === "appearance.density"
      ? density
      : value ?? descriptor.defaultValue;
  const available = typeof descriptor.apply === "function";

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
      if (descriptor.id === "appearance.theme") setTheme(next as Theme);
      else if (descriptor.id === "appearance.density") setDensity(next as Density);
      else set(descriptor.id, next);
    },
    [descriptor, set, setDensity, setTheme],
  );

  return (
    <div
      className={cn(
        "settings-row flex min-h-10 items-center gap-4 px-0 py-2",
        available && "hover:bg-hover",
        !available && !descriptor.readOnly && "is-unavailable",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <label
            htmlFor={`setting-${descriptor.id}`}
            className="ui-label text-primary"
          >
            {descriptor.label}
          </label>
          {descriptor.restartRequired ? (
            <Badge tone="warning">Restart</Badge>
          ) : null}
          {!available && !descriptor.readOnly ? (
            <Badge tone="neutral" aria-label={descriptor.readOnly ? "This shortcut is fixed in the current build" : "This control is not connected yet"}>
              Unavailable
            </Badge>
          ) : null}
        </div>
        {descriptor.description ? (
          <p className="ui-meta text-secondary">
            {descriptor.description}
          </p>
        ) : null}
        {error ? (
          <p className="mt-0.5 text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="settings-control flex flex-shrink-0 items-center gap-2">
        <SettingControlView
          descriptor={descriptor}
          value={current}
          onChange={commit}
          draftText={draftText}
          onDraftText={setDraftText}
          disabled={!available}
        />
        {available && current !== descriptor.defaultValue ? <IconButton
          onClick={() => {
            setError(null);
            if (descriptor.id === "appearance.theme") setTheme(descriptor.defaultValue as Theme);
            else if (descriptor.id === "appearance.density") setDensity(descriptor.defaultValue as Density);
            else reset(descriptor.id);
          }}
          label={`Reset ${descriptor.label} to default`}
          icon={<RotateCcw size={12} aria-hidden />}
          size="md"
        /> : null}
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
  disabled,
}: {
  descriptor: SettingDescriptor;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
  draftText: string | null;
  onDraftText: (v: string | null) => void;
  disabled: boolean;
}): JSX.Element {
  const c = descriptor.control;
  const isModified = value !== descriptor.defaultValue;

  if (c.kind === "toggle") {
    const checked = Boolean(value);
    return (
      <Switch
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        label={descriptor.label}
        disabled={disabled}
      />
    );
  }

  if (c.kind === "select") {
    return (
      <Select
        value={String(value)}
        onValueChange={(next) => onChange(next)}
        label={descriptor.label}
        disabled={disabled}
        options={c.options}
        className="min-w-32"
      />
    );
  }

  if (c.kind === "number") {
    const num = typeof value === "number" ? value : Number(value) || 0;
    return (
      <div className="flex items-center gap-1">
        <Input
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
          disabled={disabled}
          className="w-[88px] tabular-nums"
        />
        {c.unit ? (
          <span className="text-tertiary text-xs" >
            {c.unit}
          </span>
        ) : null}
      </div>
    );
  }

  if (c.kind === "text") {
    const text = draftText ?? (typeof value === "string" ? value : String(value));
    return (
      <Input
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
            e.stopPropagation();
            onDraftText(null);
          }
        }}
        aria-label={descriptor.label}
        disabled={disabled}
        className={cn("settings-text-control min-w-[min(200px,100%)]", isModified && "border-strong")}
      />
    );
  }

  // shortcut
  return (
    <ShortcutControl
      label={descriptor.label}
      value={String(value)}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

function ShortcutControl({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
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
  if (disabled) {
    return (
      <output
        aria-label={`Shortcut for ${label}`}
        className="flex min-w-32 items-center justify-end gap-1 font-mono text-xs text-primary"
      >
        <Kbd>{value}</Kbd>
      </output>
    );
  }
  return (
    <Button
      disabled={disabled}
      onClick={() => setRecording(true)}
      aria-label={`Edit shortcut for ${label}`}
      variant="secondary"
      size="md"
      className={cn(
        "min-w-36 justify-start font-mono",
        recording && "ring-1 ring-inset",
      )}
    >
      <Keyboard size={11} className="text-tertiary" />
      <span>{recording ? "Press keys…" : value}</span>
    </Button>
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
