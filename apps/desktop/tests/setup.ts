import "@testing-library/jest-dom/vitest";

// jsdom on the bundled Node runtime can expose an opaque-origin window
// without localStorage. The theme store intentionally persists user choices,
// so provide a deterministic storage implementation for offline tests.
if (!window.localStorage) {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } satisfies Storage,
  });
}

// Node can expose an experimental process-wide Storage constructor. Renderer
// code uses the window realm, so tests must spy on that same prototype.
Object.defineProperty(globalThis, "Storage", {
  configurable: true,
  value: window.Storage,
});

// Polyfill ResizeObserver for jsdom
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

// Polyfill matchMedia for jsdom
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Polyfill scrollIntoView for jsdom
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function() {};
}

// Radix Select uses pointer capture in browsers. jsdom does not implement the
// capture API, so expose the inert test equivalent.
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}
