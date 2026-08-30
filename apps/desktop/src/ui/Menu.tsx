import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { Fragment } from "react";
import type { ReactElement, ReactNode } from "react";

export interface MenuItem {
  id: string;
  label: string;
  /** A muted second line — a project's path, not a description of the action. */
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Marks the current choice in a list of alternatives. */
  selected?: boolean;
  /** Draws a rule above this item, grouping what follows. */
  separatorBefore?: boolean;
  onSelect?: () => void;
  keepOpen?: boolean;
}

function ItemContent({ item, indicator }: { item: MenuItem; indicator?: ReactNode }): JSX.Element {
  return (
    <>
      {item.selected === undefined ? null : (
        <span className="mr-1.5 flex w-3 shrink-0 items-center justify-center" aria-hidden>{indicator}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{item.label}</span>
        {item.detail ? <span className="truncate text-xs text-tertiary">{item.detail}</span> : null}
      </span>
      {item.shortcut ? <span className="ml-auto pl-6 font-mono text-xs text-tertiary">{item.shortcut}</span> : null}
    </>
  );
}

const contentClass = "ui-popover z-popover min-w-48 rounded-lg border border-default p-1 text-sm shadow-md";
const itemClass = "ui-menu-item flex min-h-7 cursor-default select-none items-center rounded-md px-2 py-1 text-secondary outline-none data-[highlighted]:bg-hover data-[highlighted]:text-primary data-[disabled]:opacity-40";
const separatorClass = "my-1 h-px bg-[var(--border-subtle)]";

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
          <DropdownMenuPrimitive.RadioGroup value={items.find((item) => item.selected)?.id ?? ""}>
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore ? <DropdownMenuPrimitive.Separator className={separatorClass} /> : null}
                {item.selected === undefined ? (
                  <DropdownMenuPrimitive.Item
                    disabled={item.disabled}
                    onSelect={(event) => {
                      if (item.keepOpen) event.preventDefault();
                      item.onSelect?.();
                    }}
                    className={`${itemClass} ${item.danger ? "text-error" : ""}`}
                  >
                    <ItemContent item={item} />
                  </DropdownMenuPrimitive.Item>
                ) : (
                  <DropdownMenuPrimitive.RadioItem
                    value={item.id}
                    disabled={item.disabled}
                    onSelect={(event) => {
                      if (item.keepOpen) event.preventDefault();
                      item.onSelect?.();
                    }}
                    className={`${itemClass} ${item.danger ? "text-error" : ""}`}
                  >
                    <ItemContent
                      item={item}
                      indicator={<DropdownMenuPrimitive.ItemIndicator><Check size={12} strokeWidth={2} /></DropdownMenuPrimitive.ItemIndicator>}
                    />
                  </DropdownMenuPrimitive.RadioItem>
                )}
              </Fragment>
            ))}
          </DropdownMenuPrimitive.RadioGroup>
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
          <ContextMenuPrimitive.RadioGroup value={items.find((item) => item.selected)?.id ?? ""}>
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore ? <ContextMenuPrimitive.Separator className={separatorClass} /> : null}
                {item.selected === undefined ? (
                  <ContextMenuPrimitive.Item
                    disabled={item.disabled}
                    onSelect={item.onSelect}
                    className={`${itemClass} ${item.danger ? "text-error" : ""}`}
                  >
                    <ItemContent item={item} />
                  </ContextMenuPrimitive.Item>
                ) : (
                  <ContextMenuPrimitive.RadioItem
                    value={item.id}
                    disabled={item.disabled}
                    onSelect={item.onSelect}
                    className={`${itemClass} ${item.danger ? "text-error" : ""}`}
                  >
                    <ItemContent
                      item={item}
                      indicator={<ContextMenuPrimitive.ItemIndicator><Check size={12} strokeWidth={2} /></ContextMenuPrimitive.ItemIndicator>}
                    />
                  </ContextMenuPrimitive.RadioItem>
                )}
              </Fragment>
            ))}
          </ContextMenuPrimitive.RadioGroup>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
