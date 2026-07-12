import "@testing-library/jest-dom/vitest";

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
