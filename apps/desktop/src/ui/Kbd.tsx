import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * A shortcut hint, not a keycap.
 *
 * macOS prints ⌘K as quiet glyph text beside a menu item; the bordered,
 * shadowed keycap is a web convention that pulled more attention than the
 * command it annotates. Glyphs render in the UI face — the mono stack drew
 * ⌘ and ⌥ at the wrong weight.
 */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>): JSX.Element {
  return (
    <kbd
      className={cn("inline-flex items-center justify-center text-xs font-normal text-tertiary", className)}
      {...props}
    />
  );
}
