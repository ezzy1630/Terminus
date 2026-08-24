import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ value, onValueChange, items, label, className }: {
  value: string;
  onValueChange: (value: string) => void;
  items: readonly TabItem[];
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={cn("flex h-full min-h-0 flex-1 flex-col", className)}>
      <TabsPrimitive.List aria-label={label} className="flex h-8 flex-none items-stretch gap-0.5 border-b border-subtle px-3">
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className="ui-tab border-b-2 border-transparent px-2 text-xs font-medium text-secondary hover:text-primary data-[state=active]:border-primary data-[state=active]:text-primary"
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
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
