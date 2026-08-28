/**
 * Terminus Desktop — global ambient declarations.
 *
 * Re-exports the React 19 JSX namespace globally so existing
 * `JSX.Element` return-type annotations continue to work after the
 * React 19 types removed the implicit global JSX namespace.
 *
 * Also pulls in Vite's `import.meta.env` typing via `vite/client` and
 * declares the constrained Electron preload bridge (`terminusDesktop`) on
 * `window`.
 */
/// <reference types="vite/client" />

import type { JSX as ReactJSX } from "react/jsx-runtime";

// ────────────────────────── Electron preload bridges ─────────────────────────

declare global {
  type TerminusDesktopCommandId =
    | "command-palette"
    | "open-project"
    | "settings"
    | "shortcut-reference"
    | "new-task"
    | "stop-run"
    | "show-changes"
    | "toggle-inspector"
    | "toggle-sidebar";
  /** Where the native shell is asking the renderer to go. */
  type TerminusNavigationTarget =
    | { kind: "task"; taskId: string }
    | { kind: "project"; sessionId: string }
    | { kind: "project-path"; path: string };
  type TerminusThemeChoice = "system" | "light" | "dark";
  interface TerminusNativeThemeState {
    themeSource: TerminusThemeChoice;
    shouldUseDarkColors: boolean;
  }
  /** Result of resolving a dropped or picked project directory. */
  interface TerminusDirectoryValidation {
    ok: boolean;
    isGit: boolean;
    canonicalPath: string | null;
  }

  namespace JSX {
    type Element = ReactJSX.Element;
    type ElementClass = ReactJSX.ElementClass;
    type ElementType = ReactJSX.ElementType;
    type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
    type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
    type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>;
  }

  interface Window {
    terminusDesktop?: {
      /** null when the shell could not supply an approved control origin. */
      apiBase: string | null;
      /** Why `apiBase` is null. Surface it; do not fall back to a guess. */
      apiBaseError: string | null;
      isMac: boolean;
      /** "settings" when this window is the preferences window. */
      view?: "main" | "settings";
      /** True when the native window is a vibrant material the renderer paints over. */
      vibrancy?: boolean;
      /** The settings category this window was launched on, if any. */
      settingsCategory?: string | null;
      notify: (title: string, body: string, taskId?: string) => Promise<unknown>;
      openSettings?: (category?: string) => Promise<unknown>;
      setAttentionCount?: (count: number) => Promise<unknown>;
      onNavigate?: (callback: (target: TerminusNavigationTarget) => void) => () => void;
      onOpenTask?: (callback: (taskId: string) => void) => () => void;
      onSettingsCategory?: (callback: (category: string) => void) => () => void;
      onNativeThemeChange?: (callback: (state: TerminusNativeThemeState) => void) => () => void;
      /** Closes the window that called it, not always the main window. */
      windowClose: () => Promise<unknown>;
      setWindowTitle: (title: string) => Promise<string>;
      getTheme: () => Promise<TerminusThemeChoice>;
      setTheme: (theme: TerminusThemeChoice) => Promise<TerminusThemeChoice>;
      pickDirectory: () => Promise<string | null>;
      validateDirectory?: (path: string) => Promise<TerminusDirectoryValidation>;
      noteRecentProject?: (path: string) => Promise<readonly string[]>;
      onDirectoryDrop: (callback: (path: string) => void) => () => void;
      onCommand: (callback: (commandId: TerminusDesktopCommandId) => void) => () => void;
    };
  }
}

export {};
