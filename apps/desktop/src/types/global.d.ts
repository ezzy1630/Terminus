/**
 * Terminus Desktop — global ambient declarations.
 *
 * Re-exports the React 19 JSX namespace globally so existing
 * `JSX.Element` return-type annotations continue to work after the
 * React 19 types removed the implicit global JSX namespace.
 *
 * Also pulls in Vite's `import.meta.env` typing via `vite/client` and
 * declares the Electron preload bridges (`forgeDesktop`, `forgeTerminal`)
 * on `window`.
 */
/// <reference types="vite/client" />

import type { JSX as ReactJSX } from "react/jsx-runtime";

// ────────────────────────── Electron preload bridges ─────────────────────────

/** Result of forgeTerminal.spawn — `error` is set when the PTY backend is unavailable. */
export interface ForgeTerminalSpawnResult {
  id: string;
  label: string;
  cwd?: string;
  error?: string;
}

/** Screen source from desktopCapturer.getSources (SPEC §16). */
export interface ForgeScreenSource {
  id: string;
  name: string;
  display_id?: string;
}

export interface ForgeTerminalBridge {
  spawn: (
    cwd?: string,
    command?: string,
    cols?: number,
    rows?: number,
  ) => Promise<ForgeTerminalSpawnResult>;
  write: (termId: string, data: string) => Promise<void>;
  resize: (termId: string, cols: number, rows: number) => Promise<void>;
  kill: (termId: string) => Promise<void>;
  onData: (termId: string, cb: (data: string) => void) => () => void;
  onExit: (termId: string, cb: (exitCode: number) => void) => () => void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    type Element = ReactJSX.Element;
    type ElementClass = ReactJSX.ElementClass;
    type ElementType = ReactJSX.ElementType;
    interface ElementAttributesProperty extends ReactJSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends ReactJSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends ReactJSX.IntrinsicClassAttributes<T> {}
    type IntrinsicElements = ReactJSX.IntrinsicElements;
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>;
  }

  interface Window {
    forgeDesktop?: {
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
      getScreenSources: () => Promise<ForgeScreenSource[]>;
    };
    forgeTerminal?: ForgeTerminalBridge;
  }
}

export {};
