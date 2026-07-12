"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export type BadgeTone = "green" | "yellow" | "red" | "gray" | "blue" | "purple" | "orange";

const toneClasses: Record<BadgeTone, string> = {
  green: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  yellow: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
  red: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-300",
  gray: "border-transparent bg-muted text-muted-foreground",
  blue: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  purple: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300",
  orange: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-300",
};

/**
 * Color-coded status badge. Per spec:
 *   green = success / active / completed
 *   yellow = pending / running
 *   red = failed / denied / error
 *   gray = archived / skipped
 */
export function StatusBadge({
  status,
  tone,
  className,
  title,
}: {
  status: string | null | undefined;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  const resolved = tone ?? toneForStatus(status);
  const label = (status ?? "unknown").toString();
  return (
    <Badge
      variant="outline"
      className={cn(toneClasses[resolved], "font-mono uppercase text-[10px] tracking-wider", className)}
      title={title}
    >
      {label}
    </Badge>
  );
}

/**
 * Decide a tone for a given status string. Heuristic on common Forge state
 * labels (TaskStatus, TurnState, ToolCallState, ApprovalState, JobState,
 * VerificationStatus, etc.). Falls back to gray.
 */
export function toneForStatus(status: string | null | undefined): BadgeTone {
  if (!status) return "gray";
  const s = status.toString().toLowerCase();
  if (
    s === "ok" ||
    s === "ready" ||
    s === "active" ||
    s === "completed" ||
    s === "success" ||
    s === "pass" ||
    s === "passed" ||
    s === "allowed" ||
    s === "settled" ||
    s === "trusted" ||
    s === "enabled"
  ) {
    return "green";
  }
  if (
    s === "pending" ||
    s === "running" ||
    s === "proposed" ||
    s === "validating" ||
    s === "authorized" ||
    s === "started" ||
    s === "context_compiling" ||
    s === "provider_running" ||
    s === "response_validating" ||
    s === "tool_settlement" ||
    s === "finalizing" ||
    s === "verifying" ||
    s === "discover" ||
    s === "intake" ||
    s === "verify" ||
    s === "draft"
  ) {
    return "yellow";
  }
  if (
    s === "failed" ||
    s === "denied" ||
    s === "error" ||
    s === "aborted" ||
    s === "cancelled" ||
    s === "stop_task" ||
    s === "deny_once" ||
    s === "deny_and_rule" ||
    s === "revoked" ||
    s === "down" ||
    s === "degraded"
  ) {
    return s === "degraded" ? "orange" : "red";
  }
  if (s === "skipped" || s === "archived" || s === "deleted" || s === "unknown") {
    return "gray";
  }
  return "blue";
}

/** Convenience: map a numeric confidence (0..1) to a tone. */
export function toneForConfidence(c: number | null | undefined): BadgeTone {
  if (c == null) return "gray";
  if (c >= 0.8) return "green";
  if (c >= 0.5) return "yellow";
  return "red";
}
