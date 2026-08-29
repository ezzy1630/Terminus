/**
 * Terminus Desktop — Computer Use placeholder (empty state).
 *
 * Per SPEC §11: "Do not show Computer Use before computer use has
 * occurred." When no computer-use session is active, the inspector
 * shows this calm placeholder instead of an empty PiP frame.
 *
 * The placeholder is intentionally not interactive — it's a label
 * that says "no session yet, here's what to expect." When a session
 * starts, the inspector swaps in <ComputerUsePiP /> instead.
 */
import { memo } from "react";
import { Monitor } from "lucide-react";
import { cn } from "../lib/cn";

interface ComputerUsePlaceholderProps {
  /** Optional className override. */
  className?: string;
  /** Compact mode (renders inline in the inspector). */
  compact?: boolean;
}

function ComputerUsePlaceholderImpl({
  className,
  compact = true,
}: ComputerUsePlaceholderProps): JSX.Element {
  return (
    <div
      role="status"
      aria-label="No computer-use session active"
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 text-center",
        compact ? "px-3 py-4" : "px-6 py-8",
        className,
      )}
    >
      <Monitor size={compact ? 14 : 18} className="text-tertiary" aria-hidden />
      <p className="ui-body font-medium text-secondary">No computer-use session</p>
      <p className="ui-meta max-w-[34ch] leading-relaxed">
        When the agent drives the desktop, a live preview appears here.
      </p>
    </div>
  );
}

export const ComputerUsePlaceholder = memo(ComputerUsePlaceholderImpl);
