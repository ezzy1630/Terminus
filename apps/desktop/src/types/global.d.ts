/**
 * Forge Desktop — global ambient declarations.
 *
 * Re-exports the React 19 JSX namespace globally so existing
 * `JSX.Element` return-type annotations continue to work after the
 * React 19 types removed the implicit global JSX namespace.
 *
 * Also pulls in Vite's `import.meta.env` typing via `vite/client`.
 */
/// <reference types="vite/client" />

import type { JSX as ReactJSX } from "react/jsx-runtime";

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
}

export {};
