import { memo } from "react";
import { ChevronDown } from "lucide-react";
import { Menu } from "../ui/Menu";
import { Button } from "../ui/Button";

export type ActiveRunSendMode = "after_current" | "steer_now";

export interface ComposerRunModePickerProps {
  value: ActiveRunSendMode;
  onChange: (value: ActiveRunSendMode) => void;
  disabled?: boolean;
}

const LABELS: Readonly<Record<ActiveRunSendMode, string>> = {
  after_current: "After current turn",
  steer_now: "Steer current turn now",
};

function ComposerRunModePickerImpl({
  value,
  onChange,
  disabled = false,
}: ComposerRunModePickerProps): JSX.Element {
  return (
    <Menu
      label="Choose when to send this message"
      side="top"
      align="end"
      items={([
        ["after_current", "After current turn", "Starts after the current work finishes."],
        ["steer_now", "Steer current turn now", "Redirects the work already in progress."],
      ] as const).map(([id, label, detail]) => ({
        id: `composer-run-mode-${id}`,
        label,
        detail,
        selected: value === id,
        onSelect: () => onChange(id),
      }))}
      trigger={(
        <Button
          type="button"
          variant="bare"
          disabled={disabled}
          aria-label={`Send mode: ${LABELS[value]}`}
          className="composer-control flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-secondary hover:bg-hover hover:text-primary"
        >
          <span className="max-w-36 truncate">{LABELS[value]}</span>
          <ChevronDown size={12} strokeWidth={1.8} className="shrink-0 text-tertiary" aria-hidden />
        </Button>
      )}
    />
  );
}

export const ComposerRunModePicker = memo(ComposerRunModePickerImpl);
