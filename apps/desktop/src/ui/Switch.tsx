import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  /** Lets a visible <label htmlFor> point at the control instead of dangling. */
  id?: string;
}

/**
 * AppKit switch proportions: a 26×15 pill with a 13px white knob.
 *
 * The previous 36×20 track was a web toggle — half again as tall as anything
 * macOS draws, which made every settings row read as a form on a page. The
 * knob stays white in both states because that is what AppKit paints; the
 * track carries the state (neutral fill off, accent on).
 */
export function Switch({ checked, onCheckedChange, label, disabled, className, id }: SwitchProps): JSX.Element {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "relative h-[15px] w-[26px] flex-none rounded-full bg-selected transition-colors data-[state=checked]:bg-accent disabled:opacity-45",
        className,
      )}
    >
      <SwitchPrimitive.Thumb className="block h-[13px] w-[13px] translate-x-px rounded-full bg-on-accent shadow-sm transition-transform data-[state=checked]:translate-x-[12px]" />
    </SwitchPrimitive.Root>
  );
}
