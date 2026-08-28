/**
 * Terminus Desktop — Preferences window root.
 *
 * ⌘, on macOS opens a Preferences *window*. Terminus used to blanket the app
 * with a full-screen overlay instead, which meant settings and work could
 * never be on screen together and closing settings was the only way back.
 *
 * The main process launches a second renderer with `--terminus-view=settings`
 * and mounts this root instead of <App />. The settings surface itself is
 * unchanged — the same <Settings /> the browser build still uses as an
 * overlay — so there is one implementation of preferences, not two.
 *
 * Both windows share one localStorage, and both stores adopt each other's
 * writes through `storage` events, so appearance previews stay live in the
 * main window while they are being chosen here.
 */
import { memo, useCallback, useEffect, useState } from "react";

import { useTerminusStore } from "../hooks/use-terminus";
import { Settings, SETTING_CATEGORIES } from "./Settings";
import type { SettingCategoryId } from "./Settings";

function isCategoryId(value: string): value is SettingCategoryId {
  return SETTING_CATEGORIES.some((category) => category.id === value);
}

function SettingsWindowImpl(): JSX.Element {
  const [category, setCategory] = useState<SettingCategoryId>("appearance");
  const refreshSessions = useTerminusStore((state) => state.refreshSessions);

  // The Agents category lists the model profiles projects actually run on.
  // This renderer starts with an empty store, so ask once.
  useEffect(() => {
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions]);

  // The main window can ask for a specific category — "Keyboard Shortcuts"
  // from the Help menu, say — after this window is already open.
  useEffect(() => {
    const subscribe = window.terminusDesktop?.onSettingsCategory;
    if (!subscribe) return;
    return subscribe((next) => {
      if (isCategoryId(next)) setCategory(next);
    });
  }, []);

  const close = useCallback((): void => {
    // Closing preferences closes the window. Without a native shell there is
    // nothing to close, and the surface simply stays put.
    void window.terminusDesktop?.windowClose();
  }, []);

  // Remounting on category change is how <App /> drives the same surface;
  // `initialCategoryId` is a starting point, not a controlled prop.
  return <Settings key={category} open onClose={close} initialCategoryId={category} />;
}

export const SettingsWindow = memo(SettingsWindowImpl);
