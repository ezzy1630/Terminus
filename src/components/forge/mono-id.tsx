"use client";

import { cn } from "@/lib/utils";
import { shortId } from "@/lib/forge-client";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface MonoIdProps {
  id: string | null | undefined;
  /** Number of chars to keep from the head. */
  head?: number;
  /** Whether to show a tooltip with the full ID on hover. */
  copyable?: boolean;
  className?: string;
}

/**
 * Truncated monospace ID display, with optional hover tooltip showing the
 * full value. SPEC §42.3: IDs/hashes shown in font-mono text-xs.
 */
export function MonoId({ id, head = 8, copyable = true, className }: MonoIdProps) {
  if (!id) {
    return <span className={cn("font-mono text-xs text-muted-foreground", className)}>—</span>;
  }
  const display = shortId(id, head);
  if (display === id || !copyable) {
    return (
      <span className={cn("font-mono text-xs", className)}>{display}</span>
    );
  }
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard?.writeText(id).catch(() => {});
            }}
            className={cn(
              "font-mono text-xs cursor-pointer hover:text-primary transition-colors",
              className,
            )}
            title="click to copy"
          >
            {display}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono text-xs max-w-md break-all">
          {id}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
