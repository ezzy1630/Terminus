import { formatDistanceToNowStrict } from "date-fns";

const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function finiteDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function relativeTimestamp(value: string): string {
  const date = finiteDate(value);
  return date ? formatDistanceToNowStrict(date, { addSuffix: true }) : "time unavailable";
}

export function clockTimestamp(value: string): string {
  const date = finiteDate(value);
  return date ? clockFormatter.format(date) : "time unavailable";
}

/**
 * Elapsed time as a card-sized string: "48s", "4m", "1h 12m", "2d".
 *
 * `relativeTimestamp` answers "when did this last move" and reads as a
 * sentence — "5 hours ago". A card for work that is running right now has to
 * answer "how long has this been going", in the width of a chip, so it is a
 * separate formatter rather than a variant of the same one.
 *
 * `nowMs` is passed in rather than read from the clock so the caller controls
 * how often the string changes, and so the result is testable.
 */
export function compactDuration(value: string, nowMs: number): string | null {
  const date = finiteDate(value);
  if (!date) return null;
  // A timestamp in the future is clock skew between the control plane and this
  // machine, not negative elapsed time.
  const seconds = Math.floor(Math.max(0, nowMs - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const trailingMinutes = minutes % 60;
    return trailingMinutes === 0 ? `${hours}h` : `${hours}h ${trailingMinutes}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}
