import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button, type ButtonVariant, type ControlSize } from "./Button";

const squareClasses: Record<ControlSize, string> = {
  sm: "w-6 px-0",
  md: "w-7 px-0",
  lg: "w-8 px-0",
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ControlSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, className, variant = "ghost", size = "md", ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      className={cn("rounded-md", squareClasses[size], className)}
      {...props}
    >
      {icon}
    </Button>
  );
});
