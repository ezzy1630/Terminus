import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { Ref } from "react";
import { cn } from "../lib/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  label: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  triggerRef?: Ref<HTMLButtonElement>;
}

/**
 * AppKit pop-up button: a 24px bezel, 13px value, single chevron on the right.
 *
 * Settings rows put this at the end of a 40px row, so the trigger must be
 * shorter than the row and must not carry a min-width — a pop-up button in
 * System Settings hugs its value rather than reserving a column.
 */
export function Select({ value, onValueChange, options, label, disabled, className, id, triggerRef }: SelectProps): JSX.Element {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        ref={triggerRef}
        id={id}
        aria-label={label}
        className={cn(
          "ui-select-trigger ui-body inline-flex h-6 items-center justify-between gap-1.5 rounded-md border border-default bg-elevated pl-2 pr-1.5 text-primary hover:border-strong disabled:cursor-not-allowed disabled:opacity-45",
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon className="text-tertiary"><ChevronDown size={12} aria-hidden /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="ui-popover z-select min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-subtle p-1 shadow-md"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="ui-select-item ui-body relative flex h-6 cursor-default select-none items-center rounded-[5px] pl-6 pr-2 text-secondary outline-none data-[highlighted]:bg-selected data-[highlighted]:text-primary data-[disabled]:opacity-40"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-1.5 text-primary">
                  <Check size={12} aria-hidden />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
