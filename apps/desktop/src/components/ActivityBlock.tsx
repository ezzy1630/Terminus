/**
 * Terminus Desktop — grouped execution block.
 *
 * Per SPEC §9.3: hybrid response structure. Normal explanation stays as
 * prose; structured actions use purpose-built compact blocks. A run of them
 * reads as one quiet list of inline progress disclosures:
 *
 *   › ● Explored codebase · 12 files
 *   › ● Ran commands · 3 runs passed
 *   › ● Implemented changes · 4 edits
 *
 * Each block expands into exact details. Collapsed blocks must still
 * communicate what happened and whether it succeeded.
 *
 * Expanded rows are proportional text — monospace is reserved for the payload
 * a tool actually produced (command output, a diff), because setting a whole
 * activity list in a terminal font makes routine work look like an incident.
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
import { boundedActivityDetail } from "./ProgressDrawer";

interface ActivityBlockProps {
  block: ActivityBlockData;
  /** Default expanded state. */
  defaultExpanded?: boolean;
  /**
   * Resend the prompt this block reports a failure for. Absent on every block
   * without a `retryInput`, so there is no button that can only apologise.
   */
  onRetry?: (input: string) => void;
  /**
   * Whether another activity block sits directly above / below this one.
   *
   * The timeline rail is a pseudo-element that globals.css bleeds 3px past the
   * block in both directions and then clamps back with `:first-of-type` /
   * `:last-of-type`, so a run of blocks shares one continuous line and a lone
   * block still reads as a single rounded mark. Every row of the feed is
   * wrapped in its own `role="listitem"` element for assistive technology,
   * which makes every block both the first *and* the last of its type inside
   * its own wrapper — so the clamp always fired and the rail was cut into one
   * short stripe per block, the exact thing it exists to avoid. The feed knows
   * its own neighbours, so it says so here and the bleed is restored only
   * where there is genuinely a neighbour to join.
   */
  joinsAbove?: boolean;
  joinsBelow?: boolean;
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

function ActivityBlockImpl({
  block,
  defaultExpanded = false,
  onRetry,
  joinsAbove: _joinsAbove = false,
  joinsBelow: _joinsBelow = false,
}: ActivityBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const kind = statusKind(block.status);

  const failed = block.status === "failed";

  return (
    <div
      // A failure is announced, not just drawn. Everything else is quiet.
      role={failed ? "alert" : undefined}
      className={cn(
        "activity-block selectable my-0.5",
        expanded && "is-expanded",
      )}
    >
      {/* Collapsed header — communicates what + result in one quiet phrase. */}
      <div className="activity-header group/activity flex min-h-7 items-center rounded-md hover:bg-hover">
        <Button
          type="button"
          variant="bare"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} details for ${block.title}`}
          className="flex min-h-7 min-w-0 flex-1 items-center justify-start gap-2 rounded-md px-1.5 text-left"
        >
          <ChevronRight
            size={12}
            className={cn("shrink-0 text-tertiary transition-transform", expanded && "rotate-90")}
            aria-hidden
          />
          <span className="activity-status flex w-4 flex-shrink-0 items-center justify-center">
            <StatusIndicator status={kind} size={10} />
          </span>
          {/* Title and metric read as one phrase separated by a middot, the way
              Codex writes them. The metric used to be pinned to the far edge of
              the column in a monospace font, hundreds of pixels from the thing it
              measured and set as if it were a machine value. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <ToolIcon tool={block.entries[0]?.tool} />
            <span className="ui-body min-w-0 truncate text-secondary">
              {block.title}
            </span>
            {block.metric ? (
              <>
                <span className="flex-shrink-0 text-tertiary" aria-hidden>·</span>
                <span className="ui-body flex-shrink-0 text-tertiary">
                  {block.metric}
                </span>
              </>
            ) : null}
          </span>
        </Button>
      </div>

      {/* Expanded details.

          A turn outcome (the failed/stopped summary) reads as prose — a
          sentence a person can act on, not a log line with a timestamp and a
          "turn" token. Tool runs keep a compact row: the tool name as a micro
          label, the operand as text, and the exact time in the tooltip rather
          than as a column the reader has to look past. */}
      {expanded && block.entries.length > 0 ? (
        <div className="activity-detail px-1.5 pb-1.5 pl-7">
          <ul className="flex flex-col gap-1.5">
            {block.entries.map((entry, i) => {
              const isOutcome = entry.tool === "turn";
              return (
                <li key={`entry-${i}`} className="flex flex-col gap-0.5">
                  {isOutcome ? (
                    <p className="ui-prose text-primary">{entry.summary}</p>
                  ) : (
                    <div className="flex items-baseline gap-2" data-tooltip={clockTimestamp(entry.at)}>
                      <span className="ui-code flex-shrink-0 text-tertiary">{entry.tool}</span>
                      <span className="ui-body min-w-0 flex-1 truncate text-secondary">
                        {entry.summary}
                      </span>
                    </div>
                  )}
                  {entry.detail ? (
                    isOutcome ? (
                      <p className="ui-body whitespace-pre-line text-tertiary">
                        {boundedActivityDetail(entry.detail)}
                      </p>
                    ) : (
                      // The one place monospace is correct: the bytes a tool
                      // actually emitted.
                      <pre className="selectable mt-1 max-h-[220px] overflow-auto rounded-md border border-subtle bg-terminal px-2 py-1.5 text-xs leading-[1.5] text-secondary">
                        {boundedActivityDetail(entry.detail)}
                      </pre>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Retry.

          A failed turn used to end the conversation: the task went terminal and
          the composer said "create a new task to continue". It stays ACTIVE and
          steerable now, so the same prompt can simply go again. It sits below
          the explanation because that is the order the reader needs — what
          happened, then what to do about it. */}
      {block.retryInput && onRetry ? (
        <div className="flex items-center gap-2 px-1.5 pb-1.5 pl-7 pt-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onRetry(block.retryInput as string)}
          >
            Retry
          </Button>
          <span className="ui-meta min-w-0 truncate">
            Sends the same message again as a new turn.
          </span>
        </div>
      ) : null}
    </div>
  );
}

export const ActivityBlock = memo(ActivityBlockImpl);
