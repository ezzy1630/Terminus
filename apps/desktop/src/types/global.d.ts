/**
 * Terminus Desktop — global ambient declarations.
 *
 * Re-exports the React 19 JSX namespace globally so existing
 * `JSX.Element` return-type annotations continue to work after the
 * React 19 types removed the implicit global JSX namespace.
 *
 * Also pulls in Vite's `import.meta.env` typing via `vite/client` and
 * declares the Electron preload bridges (`terminusDesktop`, `terminusTerminal`)
 * on `window`.
 */
/// <reference types="vite/client" />

import type { JSX as ReactJSX } from "react/jsx-runtime";

// ────────────────────────── Electron preload bridges ─────────────────────────

/** Result of terminusTerminal.spawn — `error` is set when the PTY backend is unavailable. */
export interface TerminusTerminalSpawnResult {
  id: string;
  label: string;
  cwd?: string;
  error?: string;
}

/** Screen source from desktopCapturer.getSources (SPEC §16). */
export interface TerminusScreenSource {
  id: string;
  name: string;
  display_id?: string;
}

export interface TerminusTerminalBridge {
  spawn: (
    cwd?: string,
    command?: string,
    cols?: number,
    rows?: number,
  ) => Promise<TerminusTerminalSpawnResult>;
  write: (termId: string, data: string) => Promise<void>;
  resize: (termId: string, cols: number, rows: number) => Promise<void>;
  kill: (termId: string) => Promise<void>;
  onData: (termId: string, cb: (data: string) => void) => () => void;
  onExit: (termId: string, cb: (exitCode: number) => void) => () => void;
}

declare global {
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
      gateway: string;
      token: string;
      platform: string;
      isMac: boolean;
      notify: (title: string, body: string) => Promise<unknown>;
      windowMinimize: () => Promise<unknown>;
      windowMaximize: () => Promise<unknown>;
      windowClose: () => Promise<unknown>;
      getTheme: () => Promise<"system" | "light" | "dark">;
      setTheme: (theme: "system" | "light" | "dark") => Promise<"system" | "light" | "dark">;
      getScreenSources: () => Promise<TerminusScreenSource[]>;
      pickDirectory: () => Promise<string | null>;
    };
    terminusTerminal?: TerminusTerminalBridge;
  }
}

export {};
