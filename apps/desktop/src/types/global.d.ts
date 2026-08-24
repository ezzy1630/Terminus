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
  type TerminusWindowBounds = { x: number; y: number; width: number; height: number };
  type TerminusDesktopCommandId =
    | "command-palette"
    | "open-project"
    | "settings"
    | "shortcut-reference"
    | "new-task"
    | "show-changes"
    | "toggle-inspector"
    | "toggle-sidebar";

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
      apiBase: string;
      platform: string;
      isMac: boolean;
      notify: (title: string, body: string) => Promise<unknown>;
      windowMinimize: () => Promise<unknown>;
      windowMaximize: () => Promise<unknown>;
      windowClose: () => Promise<unknown>;
      getTheme: () => Promise<"system" | "light" | "dark">;
      setTheme: (theme: "system" | "light" | "dark") => Promise<"system" | "light" | "dark">;
      pickDirectory: () => Promise<string | null>;
      validateDirectoryDrop: (path: string) => Promise<string | null>;
      onDirectoryDrop: (callback: (path: string) => void) => () => void;
      onCommand: (callback: (commandId: TerminusDesktopCommandId) => void) => () => void;
      setWindowTitle: (title: string) => Promise<string>;
      getWindowBounds: () => Promise<TerminusWindowBounds | null>;
      setWindowBounds: (bounds: TerminusWindowBounds) => Promise<TerminusWindowBounds>;
      onWindowBoundsChange: (callback: (bounds: TerminusWindowBounds) => void) => () => void;
    };
  }
}

export {};
