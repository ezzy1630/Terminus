export type ShortcutScope = "global" | "composer" | "diff";

export interface FixedShortcut {
  readonly id: string;
  readonly label: string;
  readonly scope: ShortcutScope;
  readonly display: string;
  readonly settingValue: string;
  readonly key: string | "1-9";
  readonly modifier: "primary" | "none";
}

/**
 * Authoritative fixed keyboard map for the current desktop harness.
 * Settings and command surfaces render these definitions; handlers use the
 * same definitions so discoverability cannot drift from behavior.
 */
export const FIXED_SHORTCUTS = {
  commandPalette: { id: "command-palette", label: "Open command palette", scope: "global", display: "⌘K", settingValue: "Cmd+K", key: "k", modifier: "primary" },
  openProject: { id: "open-project", label: "Open project", scope: "global", display: "⌘O", settingValue: "Cmd+O", key: "o", modifier: "primary" },
  settings: { id: "settings", label: "Open settings", scope: "global", display: "⌘,", settingValue: "Cmd+,", key: ",", modifier: "primary" },
  shortcutReference: { id: "shortcut-reference", label: "View keyboard shortcuts", scope: "global", display: "⌘/", settingValue: "Cmd+/", key: "/", modifier: "primary" },
  newTask: { id: "new-task", label: "New task", scope: "global", display: "⌘N", settingValue: "Cmd+N", key: "n", modifier: "primary" },
  showChanges: { id: "show-changes", label: "Toggle changes", scope: "global", display: "⌘D", settingValue: "Cmd+D", key: "d", modifier: "primary" },
  toggleInspector: { id: "toggle-inspector", label: "Toggle inspector", scope: "global", display: "⌘]", settingValue: "Cmd+]", key: "]", modifier: "primary" },
  toggleSidebar: { id: "toggle-sidebar", label: "Toggle sidebar", scope: "global", display: "⌘\\", settingValue: "Cmd+\\", key: "\\", modifier: "primary" },
  taskSlot: { id: "task-slot", label: "Open task 1 through 9", scope: "global", display: "⌘1–9", settingValue: "Cmd+1–9", key: "1-9", modifier: "primary" },
  send: { id: "send", label: "Send or steer message", scope: "composer", display: "⌘↵", settingValue: "Cmd+Enter", key: "Enter", modifier: "primary" },
  stopRun: { id: "stop-run", label: "Stop the current run", scope: "global", display: "⌘.", settingValue: "Cmd+.", key: ".", modifier: "primary" },
  diffNextChange: { id: "diff-next-change", label: "Next change", scope: "diff", display: "J", settingValue: "J", key: "j", modifier: "none" },
  diffPreviousChange: { id: "diff-previous-change", label: "Previous change", scope: "diff", display: "K", settingValue: "K", key: "k", modifier: "none" },
  diffPreviousFile: { id: "diff-previous-file", label: "Previous file", scope: "diff", display: "[", settingValue: "[", key: "[", modifier: "none" },
  diffNextFile: { id: "diff-next-file", label: "Next file", scope: "diff", display: "]", settingValue: "]", key: "]", modifier: "none" },
  diffToggleView: { id: "diff-toggle-view", label: "Toggle unified or split diff", scope: "diff", display: "U", settingValue: "U", key: "u", modifier: "none" },
} as const satisfies Record<string, FixedShortcut>;

export const SETTINGS_SHORTCUTS: readonly FixedShortcut[] = Object.values(FIXED_SHORTCUTS);

interface ShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export type ShortcutPlatform = "mac" | "other";

export function currentShortcutPlatform(): ShortcutPlatform {
  if (typeof window !== "undefined" && typeof window.terminusDesktop?.isMac === "boolean") {
    return window.terminusDesktop.isMac ? "mac" : "other";
  }
  if (typeof navigator !== "undefined") {
    return /Macintosh|Mac OS X/.test(navigator.userAgent) ? "mac" : "other";
  }
  return "other";
}

export function shortcutDisplay(
  shortcut: FixedShortcut,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string {
  if (platform === "mac" || shortcut.modifier === "none") return shortcut.display;
  return shortcut.display.replace(/^⌘/, "Ctrl+");
}

export function shortcutSettingValue(
  shortcut: FixedShortcut,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string {
  if (platform === "mac" || shortcut.modifier === "none") return shortcut.settingValue;
  return shortcut.settingValue.replace(/^Cmd\+/, "Ctrl+");
}

export function matchesShortcut(
  event: ShortcutEvent,
  shortcut: FixedShortcut,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (shortcut.modifier === "primary") {
    const correctPrimary = platform === "mac"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!correctPrimary) return false;
  } else if (event.metaKey || event.ctrlKey) {
    return false;
  }
  if (shortcut.key === "1-9") return /^[1-9]$/.test(event.key);
  return event.key.length === 1
    ? event.key.toLowerCase() === shortcut.key.toLowerCase()
    : event.key === shortcut.key;
}
