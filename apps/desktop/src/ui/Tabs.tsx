import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

/**
 * AppKit segmented control, not web underline tabs.
 *
 * The list itself is the 24px segmented pill; it sits inside a short toolbar
 * strip closed with a hairline, which is how a macOS window separates a
 * segmented view switcher from the content it switches.
 */
export function Tabs({ value, onValueChange, items, label, className }: {
  value: string;
  onValueChange: (value: string) => void;
  items: readonly TabItem[];
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={cn("flex h-full min-h-0 flex-1 flex-col", className)}>
      <div className="flex h-9 flex-none items-center border-b border-subtle px-3">
        <TabsPrimitive.List
          aria-label={label}
          className="inline-flex h-6 items-center gap-px rounded-md border border-subtle bg-[var(--bg-subtle)] p-px"
        >
          {items.map((item) => (
            <TabsPrimitive.Trigger
              key={item.value}
              value={item.value}
              className="ui-tab h-[20px] rounded-[5px] px-2.5 text-xs font-medium text-secondary hover:text-primary data-[state=active]:bg-elevated data-[state=active]:text-primary data-[state=active]:shadow-sm"
            >
              {item.label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
      </div>
      {items.map((item) => (
        <TabsPrimitive.Content
          key={item.value}
          value={item.value}
          className="min-h-0 flex-1 overflow-hidden"
        >
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
