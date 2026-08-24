import { format, formatDistanceToNowStrict } from "date-fns";

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
  return date ? format(date, "HH:mm:ss") : "time unavailable";
}
