/**
 * Terminus Desktop — resolve the window an IPC message came from.
 *
 * Every `window:*` handler used to act on the module-level `mainWindow`, so
 * Preferences' Close button closed the document window instead of itself.
 * A window command must act on the window that sent it, and on nothing else.
 *
 * The resolution is expressed against small structural interfaces rather than
 * `BrowserWindow` so it can be tested without an Electron runtime; `main.ts`
 * supplies `BrowserWindow.fromWebContents` as the lookup.
 */
import type { IpcMainInvokeEvent, WebContents } from "electron";

export const UNTRUSTED_RENDERER_MESSAGE = "desktop IPC rejected an untrusted renderer";

/** The part of `BrowserWindow` routing depends on. */
export interface RoutableWindow {
  isDestroyed(): boolean;
}

/** The part of an `IpcMainInvokeEvent` routing depends on. */
export interface RoutingRequest<Sender> {
  readonly sender: Sender;
  readonly senderFrameUrl: string | null | undefined;
}

export interface WindowRouter<Window extends RoutableWindow, Sender> {
  /** `BrowserWindow.fromWebContents` in production. */
  readonly windowForSender: (sender: Sender) => Window | null;
  /** Whether the shell still owns this window (main or settings). */
  readonly isOwnedWindow: (window: Window) => boolean;
  /** Whether the frame URL is the renderer entry this build trusts. */
  readonly isTrustedUrl: (url: string) => boolean;
}

/**
 * Resolve the sending window, or throw.
 *
 * Throwing rather than returning null is deliberate: an untrusted sender is
 * not a condition a handler should be able to ignore, and `ipcMain.handle`
 * turns the throw into a rejected promise in the renderer.
 */
export function resolveTrustedWindow<Window extends RoutableWindow, Sender>(
  request: RoutingRequest<Sender>,
  router: WindowRouter<Window, Sender>,
): Window {
  const frameUrl = request.senderFrameUrl;
  if (typeof frameUrl !== "string" || frameUrl.length === 0 || !router.isTrustedUrl(frameUrl)) {
    throw new Error(UNTRUSTED_RENDERER_MESSAGE);
  }
  const window = router.windowForSender(request.sender);
  if (window === null || window.isDestroyed() || !router.isOwnedWindow(window)) {
    throw new Error(UNTRUSTED_RENDERER_MESSAGE);
  }
  return window;
}

/** Narrow an Electron invoke event to the fields routing reads. */
export function routingRequest(event: IpcMainInvokeEvent): RoutingRequest<WebContents> {
  return { sender: event.sender, senderFrameUrl: event.senderFrame?.url ?? null };
}
