import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>): JSX.Element {
  return (
    <kbd
      className={cn("inline-flex min-w-5 items-center justify-center rounded-sm border border-default bg-subtle px-1 font-mono text-xs leading-4 text-secondary shadow-sm", className)}
      {...props}
    />
  );
}
