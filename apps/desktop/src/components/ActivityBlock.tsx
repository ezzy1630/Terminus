/**
 * Terminus Desktop — grouped execution block.
 *
 * Per SPEC §9.3: hybrid response structure. Normal explanation stays as
 * prose; structured actions use purpose-built compact blocks. Examples:
 *
 *   Explored codebase                          12 files
 *   Implemented authentication                 4 files changed
 *   Ran verification                           18 tests passed
 *   Reviewed browser output                    2 issues found
 *   Delegated visual QA                        1 subagent working
 *
 * Each block expands into exact details. Collapsed blocks must still
 * communicate what happened and whether it succeeded.
 *
 * Per design constraints: no oversized cards. Use restrained motion.
 * Per SPEC §22: "Respect Reduce Motion."
 */
import { memo, useState } from "react";
import { ChevronRight, FilePen, Search, SquareTerminal } from "lucide-react";
import { cn } from "../lib/cn";
import { StatusIndicator } from "./StatusIndicator";
import { clockTimestamp } from "../lib/time";
import type { ActivityBlock as ActivityBlockData, ActivityBlockStatus } from "../types";
import { Button } from "../ui/Button";
import type { TaskLifecycle } from "../lib/task-lifecycle";

interface ActivityBlockProps {
  block: ActivityBlockData;
  /** Default expanded state. */
  defaultExpanded?: boolean;
  /**
   * Resend the prompt this block reports a failure for. Absent on every block
   * without a `retryInput`, so there is no button that can only apologise.
   */
  onRetry?: (input: string) => void;
}

const MAX_RENDERED_ACTIVITY_DETAIL_CHARS = 16_000;

function renderedDetail(detail: string): string {
  if (detail.length <= MAX_RENDERED_ACTIVITY_DETAIL_CHARS) return detail;
  return `[Activity detail rejected: ${detail.length} characters exceeds the ${MAX_RENDERED_ACTIVITY_DETAIL_CHARS}-character presentation limit. Inspect the immutable artifact or continuation reference.]`;
}

/**
 * An activity block is one tool run, not a task, but it reuses the task glyph
 * so a row inside the transcript reads the same as a row in the sidebar.
 */
function statusKind(s: ActivityBlockStatus): TaskLifecycle {
  switch (s) {
    case "working": return "working";
    case "done": return "done";
    case "failed": return "failed";
    case "waiting": return "needs_you";
    case "interrupted": return "cancelled";
    case "unknown": return "unknown";
  }
}

/**
 * Icon for the block's dominant tool. Keyed off the authoritative `tool` id on
 * the first entry, never off display copy, so a re-worded title cannot silently
 * change what the row claims to be.
 */
function ToolIcon({ tool }: { tool: string | undefined }): JSX.Element | null {
  switch (tool) {
    case "read":
    case "search":
    case "grep":
      return <Search size={11} className="flex-shrink-0 text-tertiary" aria-hidden />;
    case "patch":
    case "edit":
    case "write":
      return <FilePen size={11} className="flex-shrink-0 text-tertiary" aria-hidden />;
    case "exec":
    case "bash":
    case "shell":
      return <SquareTerminal size={11} className="flex-shrink-0 text-tertiary" aria-hidden />;
    default:
      return null;
  }
}

function ActivityBlockImpl({ block, defaultExpanded = false, onRetry }: ActivityBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const kind = statusKind(block.status);

  const failed = block.status === "failed";

  return (
    <div
      // A failure is announced, not just drawn. Everything else is quiet.
      role={failed ? "alert" : undefined}
      className={cn(
        // No divider. Consecutive blocks already share one continuous rail
        // (.activity-block::before), so a rule under each one cut the timeline
        // the rail exists to draw into a stack of table rows.
        "activity-block selectable my-0.5 overflow-hidden",
        expanded && "is-expanded",
      )}
    >
      {/* Collapsed header — communicates what + result. */}
      <Button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label={`${block.title}, status ${block.status}${block.metric ? `, ${block.metric}` : ""}`}
        className="activity-header flex min-h-7 w-full items-center justify-start gap-2 px-1.5 text-left hover:bg-hover"
      >
        <ChevronRight
          size={12}
          className={cn("flex-shrink-0 text-tertiary transition-transform", expanded && "rotate-90")}
        />
        <span className="activity-status flex w-4 flex-shrink-0 items-center justify-center">
          <StatusIndicator status={kind} size={11} />
        </span>
        {/* Title and metric read as one phrase. The metric used to be pinned to
            the far edge of the column, hundreds of pixels from the thing it
            measured. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <ToolIcon tool={block.entries[0]?.tool} />
          <span className="ui-label min-w-0 truncate text-secondary">
            {block.title}
          </span>
          {block.metric ? (
            <span className="flex-shrink-0 font-mono text-tertiary text-xs">
              {block.metric}
            </span>
          ) : null}
        </span>
      </Button>

      {/* Retry.

          A failed turn used to end the conversation: the task went terminal and
          the composer said "create a new task to continue". It stays ACTIVE and
          steerable now, so the same prompt can simply go again. */}
      {block.retryInput && onRetry ? (
        <div className="flex items-center gap-2 px-1.5 pb-1.5 pl-8">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onRetry(block.retryInput as string)}
            className="h-6 rounded-md px-2 text-xs"
          >
            Retry
          </Button>
          <span className="min-w-0 truncate text-xs text-tertiary">
            Sends the same message again as a new turn.
          </span>
        </div>
      ) : null}

      {/* Expanded details.

          A turn outcome (the failed/stopped summary) reads as prose — a
          sentence a person can act on, not a monospace log line with a
          timestamp and a "turn" token. Actual tool runs keep the compact
          code row where the timestamp and tool name carry meaning. */}
      {expanded && block.entries.length > 0 ? (
        <div className="activity-detail border-t border-subtle px-2 pb-2 pt-1.5">
          <ul className="flex flex-col gap-1.5">
            {block.entries.map((entry, i) => {
              const isOutcome = entry.tool === "turn";
              return (
                <li
                  key={`entry-${i}`}
                  className={cn(
                    "flex flex-col gap-0.5",
                    isOutcome ? "text-secondary" : "ui-code text-secondary",
                  )}
                >
                  {isOutcome ? (
                    <p className="text-sm leading-relaxed text-primary">{entry.summary}</p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-tertiary" data-tooltip={entry.at}>
                        {clockTimestamp(entry.at)}
                      </span>
                      <span className="text-tertiary">{entry.tool}</span>
                      <span className="min-w-0 flex-1 truncate text-primary">
                        {entry.summary}
                      </span>
                    </div>
                  )}
                  {entry.detail ? (
                    isOutcome ? (
                      <p className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-tertiary">
                        {renderedDetail(entry.detail)}
                      </p>
                    ) : (
                      <pre className="selectable mt-1 max-h-[220px] overflow-auto border-l border-subtle bg-terminal px-2 py-1.5 text-secondary text-xs leading-[1.5]">
                        {renderedDetail(entry.detail)}
                      </pre>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export const ActivityBlock = memo(ActivityBlockImpl);
