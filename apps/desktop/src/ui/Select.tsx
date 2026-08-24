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

export function Select({ value, onValueChange, options, label, disabled, className, id, triggerRef }: SelectProps): JSX.Element {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        ref={triggerRef}
        id={id}
        aria-label={label}
        className={cn(
          "ui-select-trigger inline-flex h-8 min-w-36 items-center justify-between gap-2 rounded-md border border-default bg-canvas px-2.5 text-sm text-primary hover:border-strong disabled:cursor-not-allowed disabled:opacity-45",
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon><ChevronDown size={13} aria-hidden /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={5}
          className="ui-popover z-select min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-default p-1 shadow-md"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="ui-select-item relative flex h-7 cursor-default select-none items-center rounded-md pl-7 pr-2 text-sm text-secondary outline-none data-[highlighted]:bg-hover data-[highlighted]:text-primary data-[disabled]:opacity-40"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2">
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
