/**
 * Read-only computer-use availability surface.
 *
 * Terminus does not capture the operator's local display or expose takeover,
 * stop, or hand-back controls until a kernel-backed environment lease, fenced
 * control session, and trusted preview stream are available. View-only hide and
 * expand controls remain local UI preferences.
 */
import { memo } from "react";
import { EyeOff, Maximize2, Minimize2, MonitorOff } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "../ui/Button";

export interface ComputerUsePiPProps {
  className?: string;
  onHide?: () => void;
  onShow?: () => void;
  onToggleExpanded?: (expanded: boolean) => void;
  expanded?: boolean;
  hidden?: boolean;
}

function ComputerUsePiPImpl({
  className,
  onHide,
  onShow,
  onToggleExpanded,
  expanded = false,
  hidden = false,
}: ComputerUsePiPProps): JSX.Element {
  if (hidden) {
    return (
      <Button
        type="button"
        onClick={() => {
          onToggleExpanded?.(false);
          onShow?.();
        }}
        aria-label="Show computer-use availability"
        data-tooltip="Show computer-use availability"
        className={[cn(
          "fixed z-50 flex items-center gap-2 rounded-full border border-default bg-inspector px-3 py-2 shadow-lg",
          className,
        ), "text-xs"].filter(Boolean).join(" ")}
        style={{ right: 24, bottom: 80 }}
      >
        <MonitorOff size={14} className="text-tertiary" aria-hidden />
        <span className="text-secondary">Computer use unavailable</span>
      </Button>
    );
  }

  return (
    <section
      role="region"
      aria-label="Computer-use availability"
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-default bg-inspector shadow-lg",
        expanded ? "absolute inset-0" : "relative min-h-48 w-full",
        className,
      )}
    >
      <header className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-subtle px-3">
        <MonitorOff size={13} className="text-tertiary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-secondary">
          Computer use
        </span>
        <span className="rounded-sm border border-subtle px-1.5 py-0.5 font-mono text-xs text-tertiary">
          unavailable
        </span>
        {onToggleExpanded ? (
          <Button
            type="button"
            onClick={() => onToggleExpanded(!expanded)}
            aria-label={expanded ? "Return computer-use status to inspector" : "Expand computer-use status"}
            data-tooltip={expanded ? "Return to inspector" : "Expand status"}
            className="icon-button flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
          >
            {expanded ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
          </Button>
        ) : null}
        {onHide ? (
          <Button
            type="button"
            onClick={onHide}
            aria-label="Hide computer-use availability"
            data-tooltip="Hide status"
            className="icon-button flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-hover hover:text-primary"
          >
            <EyeOff size={13} aria-hidden />
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 py-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-hover text-tertiary" aria-hidden>
          <MonitorOff size={19} />
        </div>
        <h3 className="text-sm font-medium text-primary">Trusted preview unavailable</h3>
        <p className="max-w-sm text-xs leading-relaxed text-tertiary">
          A kernel-backed environment lease, fenced control session, and trusted preview stream are required. Terminus will not capture this Mac's display as a substitute.
        </p>
      </div>
    </section>
  );
}

export const ComputerUsePiP = memo(ComputerUsePiPImpl);

export { ComputerUsePlaceholder } from "./ComputerUsePlaceholder";
