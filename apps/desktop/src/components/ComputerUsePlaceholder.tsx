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
      className={className}
      role="status"
      aria-label="No computer-use session active"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: compact ? "16px 12px" : "32px 24px",
        textAlign: "center",
      }}
    >
      <div
        aria-hidden
        className="flex items-center justify-center text-tertiary"
        style={{
          width: compact ? 28 : 40,
          height: compact ? 28 : 40,
          borderRadius: "50%",
          background: "var(--bg-hover)",
        }}
      >
        <Monitor size={compact ? 14 : 20} />
      </div>
      <div
        className="text-secondary text-sm"
        style={{ fontWeight: 500 }}
      >
        No computer-use session
      </div>
      <div
        className="text-tertiary text-xs"
        style={{ maxWidth: 240, lineHeight: 1.4 }}
      >
        When the agent drives the desktop, a live preview will appear here in a floating, resizable picture-in-picture.
      </div>
    </div>
  );
}

export const ComputerUsePlaceholder = memo(ComputerUsePlaceholderImpl);
