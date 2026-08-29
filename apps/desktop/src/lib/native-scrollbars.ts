/**
 * Terminus Desktop — scroll bars that behave like macOS scroll bars.
 *
 * Chromium's default is a web scroll bar: a groove down the edge of every
 * scrollable box, permanently. The stylesheet already hid the track, but it
 * still revealed the thumb on `*:hover`, which meant putting the pointer
 * anywhere in the sidebar drew a bar down its side and held it there. That one
 * detail is most of what makes a window read as a web page rather than an app.
 *
 * AppKit's overlay scroll bars appear while the content is moving and fade out
 * shortly after it stops. CSS cannot express "is scrolling", so this marks the
 * element that scrolled and clears the mark once it has been still for a
 * moment; `[data-scrolling]` in globals.css paints the thumb.
 *
 * It listens once, in the capture phase, because scroll does not bubble — a
 * listener per scroll container would mean finding every scroll container.
 */

/**
 * How long the thumb stays after the last scroll event.
 *
 * AppKit's own fade begins around a second after the gesture ends. Shorter and
 * the bar flickers during the pauses in a slow trackpad drag.
 */
const LINGER_MS = 900;

export function installNativeScrollbars(): () => void {
  if (typeof document === "undefined") return () => {};
  const timers = new WeakMap<HTMLElement, number>();

  const onScroll = (event: Event): void => {
    const element = event.target;
    // The document scroller reports the Document, and the window itself does
    // not scroll here — the layout is a fixed grid of independent panes.
    if (!(element instanceof HTMLElement)) return;
    element.dataset.scrolling = "true";
    const pending = timers.get(element);
    if (pending !== undefined) window.clearTimeout(pending);
    timers.set(element, window.setTimeout(() => {
      delete element.dataset.scrolling;
      timers.delete(element);
    }, LINGER_MS));
  };

  document.addEventListener("scroll", onScroll, true);
  return () => document.removeEventListener("scroll", onScroll, true);
}
