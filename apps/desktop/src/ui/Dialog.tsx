import * as DialogPrimitive from "@radix-ui/react-dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DialogSurfaceProps extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accessibleTitle?: string;
  overlayClassName?: string;
  modal?: boolean;
}

/** Radix owns dismissal, focus containment, inert background behavior, and focus restoration. */
export const DialogSurface = forwardRef<HTMLDivElement, DialogSurfaceProps>(function DialogSurface(
  { open, onOpenChange, accessibleTitle, overlayClassName, className, children, modal = true, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid="dialog-overlay"
          className={cn(
            "fixed inset-0 z-[var(--z-dialog)] bg-black/30 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in",
            overlayClassName,
          )}
        />
        <DialogPrimitive.Content
          ref={ref}
          className={cn("z-[calc(var(--z-dialog)+1)]", className)}
          {...props}
          aria-modal={modal ? true : undefined}
        >
          {accessibleTitle ? <DialogPrimitive.Title className="sr-only">{accessibleTitle}</DialogPrimitive.Title> : null}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
});

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, className }: DialogProps): JSX.Element {
  return (
    <DialogSurface
      open={open}
      onOpenChange={onOpenChange}
      className={cn(
        "dialog-panel fixed left-1/2 top-1/2 flex max-h-[calc(100%-32px)] w-[min(560px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-subtle bg-elevated text-primary shadow-lg",
        className,
      )}
    >
      <header className="px-4 pb-3 pt-3.5">
        <DialogPrimitive.Title className="ui-body font-semibold text-primary">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="ui-meta mt-1">{description}</DialogPrimitive.Description>
        ) : null}
      </header>
      <div className="scrollable min-h-0 flex-1 overflow-auto px-4 pb-1">{children}</div>
      {footer ? <footer className="flex justify-end gap-2 border-t border-subtle px-4 py-3">{footer}</footer> : null}
    </DialogSurface>
  );
}

export const DialogClose = DialogPrimitive.Close;
export const DialogDescription = DialogPrimitive.Description;
export const DialogTitle = DialogPrimitive.Title;
export const DialogTrigger = DialogPrimitive.Trigger;
