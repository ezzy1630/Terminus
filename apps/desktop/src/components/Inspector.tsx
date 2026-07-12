/**
 * Forge Desktop — Dynamic right inspector.
 *
 * Per SPEC §11: "The inspector must not be a fixed list of empty
 * sections. Sections appear only after relevant information exists."
 *
 * For the primary slice we surface four sections conditionally:
 *   - Environment (when a task is selected)
 *   - Activity (when the selected task has emitted events)
 *   - Approvals (when an approval event has been observed)
 *   - Computer Use (SPEC §16, when a computer-use session is active)
 *
 * Each section is independently collapsible. The inspector pins by
 * default and never reorders sections while the user is reading.
 *
 * Per SPEC §11.1: floating rounded card, lightweight, restrained
 * maximum width. The wrapping Layout provides the card chrome — the
 * inspector itself is just scrollable content.
 *
 * Per SPEC §11: "Do not show Computer Use before computer use has
 * occurred." The Computer Use section is omitted entirely when no
 * session is active — we don't render an empty placeholder.
 */
import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, Monitor, ShieldAlert, Workflow } from "lucide-react";
import { cn } from "../lib/cn";
import { useSelectedTask, useSelectedTaskEvents, normalizeTaskStatus } from "../hooks/use-forge";
import { statusLabel, StatusIndicator } from "./StatusIndicator";
import { ComputerUsePiP, type ComputerUseState } from "./ComputerUsePiP";
import { ComputerUsePlaceholder } from "./ComputerUsePlaceholder";
import { formatDistanceToNowStrict } from "date-fns";
import type { ForgeSseEvent } from "../types";

interface InspectorProps {
  className?: string;
  /** Computer-use session state. When undefined or inactive, the section is hidden. */
  computerUseSession?: {
    active: boolean;
    expanded?: boolean;
    hidden?: boolean;
  };
  /** Called when the user hides the PiP. */
  onComputerUseHide?: () => void;
  /** Called when the user stops the session. */
  onComputerUseStop?: () => void;
  /** Called when the user toggles expanded mode. */
  onComputerUseToggleExpanded?: (expanded: boolean) => void;
}

interface InspectorSectionProps {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function InspectorSection({
  title,
  icon,
  defaultOpen = true,
  children,
}: InspectorSectionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-subtle">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover"
        style={{ height: 32 }}
      >
        {open ? <ChevronDown size={12} className="text-tertiary" /> : <ChevronRight size={12} className="text-tertiary" />}
        {icon ? <span className="flex-shrink-0 text-secondary">{icon}</span> : null}
        <span
          className="flex-1 truncate text-secondary"
          style={{ fontSize: "var(--font-size-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}
        >
          {title}
        </span>
      </button>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

function NoSelection(): JSX.Element {
  return (
    <div
      className="flex h-full flex-col items-center justify-center px-6 py-8 text-center text-tertiary"
      style={{ fontSize: "var(--font-size-xs)" }}
    >
      <div className="mb-1 text-secondary" style={{ fontSize: "var(--font-size-sm)" }}>
        No task selected
      </div>
      <div>Inspector sections appear when relevant information exists.</div>
    </div>
  );
}

function InspectorImpl({
  className,
  computerUseSession,
  onComputerUseHide,
  onComputerUseStop,
  onComputerUseToggleExpanded,
}: InspectorProps): JSX.Element {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();

  // Derive a simple activity summary (last 5 events).
  const recentEvents = useMemo(() => events.slice(-5).reverse(), [events]);

  // Look for any approval-related events in the log.
  const hasApproval = useMemo(
    () => events.some((ev) => ev.event.startsWith("approval.") || ev.event === "tool.authorized"),
    [events],
  );

  // Local state for "Take over" — the host can override via props.
  const [controlState, setControlState] = useState<ComputerUseState>("agent-controlled");

  if (!task) {
    return (
      <div className={cn("h-full overflow-y-auto", className)}>
        <NoSelection />
      </div>
    );
  }

  const statusKind = normalizeTaskStatus(task.status);

  return (
    <div className={cn("h-full overflow-y-auto bg-inspector", className)}>
      {/* Header — task status + identity. */}
      <div className="border-b border-subtle px-3 py-3">
        <div className="flex items-center gap-2">
          <StatusIndicator status={statusKind} size={12} label={statusLabel(statusKind)} />
        </div>
        <div
          className="mt-1.5 truncate font-mono text-tertiary"
          style={{ fontSize: "var(--font-size-xs)" }}
          title={task.id}
        >
          {task.id}
        </div>
        <div
          className="mt-0.5 text-tertiary"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          Updated {formatDistanceToNowStrict(new Date(task.updated_at), { addSuffix: true })}
        </div>
      </div>

      {/* Environment section. */}
      <InspectorSection title="Environment" icon={<GitBranch size={12} />} defaultOpen>
        <div
          className="flex flex-col gap-1 text-secondary"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          <div className="flex justify-between">
            <span className="text-tertiary">Status</span>
            <span className="font-mono">{task.status}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-tertiary">Phase</span>
            <span className="font-mono">{task.phase}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-tertiary">Risk</span>
            <span className="font-mono">{task.risk_class}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-tertiary">Contract v</span>
            <span className="font-mono">{task.active_contract_version}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-tertiary">Thread</span>
            <span className="font-mono">{task.thread_id.slice(0, 8)}</span>
          </div>
        </div>
      </InspectorSection>

      {/* Activity section — only when events exist. */}
      {recentEvents.length > 0 ? (
        <InspectorSection title="Activity" icon={<Workflow size={12} />} defaultOpen>
          <ul
            className="flex flex-col gap-1.5 text-secondary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            {recentEvents.map((ev: ForgeSseEvent, i) => (
              <li key={ev.id ?? i} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className="rounded-sm bg-hover px-1 py-0.5 font-mono text-tertiary"
                    style={{ fontSize: 10 }}
                  >
                    {ev.event}
                  </span>
                </div>
                {ev.data ? (
                  <div
                    className="selectable truncate font-mono text-tertiary"
                    style={{ fontSize: 10 }}
                    title={ev.data}
                  >
                    {ev.data.slice(0, 80)}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      {/* Approvals section — only when relevant. */}
      {hasApproval ? (
        <InspectorSection title="Approvals" icon={<ShieldAlert size={12} />} defaultOpen>
          <div
            className="text-secondary"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            Approval requests will appear here when the agent asks for permission.
          </div>
        </InspectorSection>
      ) : null}

      {/* Computer Use section — only when a session is active (SPEC §11). */}
      {computerUseSession?.active ? (
        <InspectorSection title="Computer Use" icon={<Monitor size={12} />} defaultOpen>
          <div className="flex flex-col gap-2" aria-live="polite">
            <ComputerUsePiP
              expanded={computerUseSession.expanded}
              hidden={computerUseSession.hidden}
              onHide={onComputerUseHide}
              onStop={onComputerUseStop}
              onToggleExpanded={onComputerUseToggleExpanded}
              onTakeOver={(next) => setControlState(next)}
            />
            <div
              className="text-tertiary"
              style={{ fontSize: "var(--font-size-xs)", lineHeight: 1.4 }}
              aria-label={`Control state: ${controlState}`}
            >
              {controlState === "agent-controlled"
                ? "The agent is driving your desktop. Use Take over to interrupt."
                : "You are in control. Hand back to let the agent continue."}
            </div>
          </div>
        </InspectorSection>
      ) : null}
    </div>
  );
}

export const Inspector = memo(InspectorImpl);
