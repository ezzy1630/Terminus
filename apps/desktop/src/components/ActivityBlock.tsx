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
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import { StatusIndicator } from "./StatusIndicator";
import { format } from "date-fns";
import type { ActivityBlock as ActivityBlockData, ActivityBlockStatus } from "../types";

interface ActivityBlockProps {
  block: ActivityBlockData;
  /** Default expanded state. */
  defaultExpanded?: boolean;
}

function statusKind(s: ActivityBlockStatus): import("../types").TaskStatusKind {
  switch (s) {
    case "working": return "working";
    case "done": return "done";
    case "failed": return "failed";
    case "waiting": return "waiting";
    case "interrupted": return "interrupted";
  }
}

function ActivityBlockImpl({ block, defaultExpanded = false }: ActivityBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const kind = statusKind(block.status);

  return (
    <div
      className={cn(
        "activity-block selectable my-1 overflow-hidden rounded-md border border-transparent",
        expanded && "is-expanded border-subtle bg-elevated",
      )}
      style={{ background: expanded ? "var(--bg-elevated)" : "transparent" }}
    >
      {/* Collapsed header — communicates what + result. */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="activity-header flex w-full items-center gap-2 px-2.5 text-left hover:bg-hover"
        style={{ minHeight: 34 }}
      >
        <ChevronRight
          size={12}
          className={cn("flex-shrink-0 text-tertiary transition-transform", expanded && "rotate-90")}
        />
        <span className="activity-status flex w-4 flex-shrink-0 items-center justify-center">
          <StatusIndicator status={kind} size={11} />
        </span>
        <span
          className="min-w-0 flex-1 truncate text-secondary"
          style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}
        >
          {block.title}
        </span>
        {block.metric ? (
          <span
            className="flex-shrink-0 font-mono text-secondary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            {block.metric}
          </span>
        ) : null}
      </button>

      {/* Expanded details. */}
      {expanded && block.entries.length > 0 ? (
        <div className="activity-detail border-t border-subtle px-3 py-2.5">
          <ul className="flex flex-col gap-1.5">
            {block.entries.map((entry, i) => (
              <li
                key={`entry-${i}`}
                className="flex flex-col gap-0.5 font-mono text-secondary"
                style={{ fontSize: "var(--font-size-xs)" }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-tertiary"
                    title={entry.at}
                  >
                    {format(new Date(entry.at), "HH:mm:ss")}
                  </span>
                  <span className="rounded-sm bg-hover px-1.5 py-0.5 text-tertiary">
                    {entry.tool}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-primary">
                    {entry.summary}
                  </span>
                </div>
                {entry.detail ? (
                  <pre
                    className="selectable mt-1 overflow-x-auto rounded-sm border border-subtle px-2 py-1.5 text-secondary"
                    style={{
                      background: "var(--bg-terminal)",
                      fontSize: "var(--font-size-xs)",
                      lineHeight: 1.5,
                      maxHeight: 220,
                      overflowY: "auto",
                    }}
                  >
                    {entry.detail}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export const ActivityBlock = memo(ActivityBlockImpl);
