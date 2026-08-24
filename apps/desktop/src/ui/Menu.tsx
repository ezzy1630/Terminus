import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ReactElement, ReactNode } from "react";

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
  keepOpen?: boolean;
}

function ItemContent({ item }: { item: MenuItem }): JSX.Element {
  return (
    <>
      <span>{item.label}</span>
      {item.shortcut ? <span className="ml-auto pl-6 font-mono text-xs text-tertiary">{item.shortcut}</span> : null}
    </>
  );
}

const contentClass = "ui-popover z-popover min-w-48 rounded-lg border border-default p-1 text-sm shadow-md";
const itemClass = "ui-menu-item flex h-7 cursor-default select-none items-center rounded-md px-2 text-secondary outline-none data-[highlighted]:bg-hover data-[highlighted]:text-primary data-[disabled]:opacity-40";

export function Menu({
  trigger,
  items,
  label,
  align = "start",
  side = "bottom",
}: {
  trigger: ReactElement;
  items: readonly MenuItem[];
  label: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}): JSX.Element {
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild aria-label={label}>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content sideOffset={5} align={align} side={side} className={contentClass}>
          {items.map((item) => (
            <DropdownMenuPrimitive.Item
              key={item.id}
              disabled={item.disabled}
              onSelect={(event) => {
                if (item.keepOpen) event.preventDefault();
                item.onSelect?.();
              }}
              className={`${itemClass} ${item.danger ? "text-error" : ""}`}
            >
              <ItemContent item={item} />
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function ContextMenu({ children, items }: { children: ReactNode; items: readonly MenuItem[] }): JSX.Element {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={contentClass}>
          {items.map((item) => (
            <ContextMenuPrimitive.Item
              key={item.id}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={`${itemClass} ${item.danger ? "text-error" : ""}`}
            >
              <ItemContent item={item} />
            </ContextMenuPrimitive.Item>
          ))}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
