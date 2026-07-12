/**
 * Terminus Desktop — Dynamic right inspector.
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
import { ChevronDown, ChevronRight, FileDiff, GitBranch, Monitor, ShieldAlert, Sparkles, UsersRound, Workflow } from "lucide-react";
import { cn } from "../lib/cn";
import { useSelectedTask, useSelectedTaskEvents, normalizeTaskStatus } from "../hooks/use-terminus";
import { derivePendingApprovals, deriveSubagentActivity, deriveVerificationActivity, extractUnifiedDiffs } from "../lib/task-surface";
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
  /** Opens the review split when the task has patch evidence. */
  onShowChanges?: () => void;
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
      className="flex h-full flex-col px-4 py-4 text-tertiary"
      style={{ fontSize: "var(--font-size-xs)" }}
    >
      <div className="flex items-center gap-2 border-b border-subtle pb-3 text-secondary">
        <Sparkles size={14} strokeWidth={1.7} />
        <span className="font-medium" style={{ fontSize: "var(--font-size-sm)" }}>Task context</span>
      </div>
      <div className="pt-4" style={{ lineHeight: 1.55 }}>
        Select a task to inspect its environment, activity, changes, and approvals.
      </div>
      <div className="mt-5 border-l-2 border-default pl-3" style={{ lineHeight: 1.5 }}>
        This space stays quiet until the current task has something useful to show.
      </div>
    </div>
  );
}

function InspectorImpl({
  className,
  computerUseSession,
  onComputerUseHide,
  onComputerUseStop,
  onComputerUseToggleExpanded,
  onShowChanges,
}: InspectorProps): JSX.Element {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();

  // Derive a simple activity summary (last 5 events).
  const recentEvents = useMemo(() => events.slice(-5).reverse(), [events]);

  const approvals = useMemo(() => derivePendingApprovals(events), [events]);
  const subagents = useMemo(() => deriveSubagentActivity(events), [events]);
  const verification = useMemo(() => deriveVerificationActivity(events), [events]);
  const hasPatchEvidence = useMemo(() => extractUnifiedDiffs(events).length > 0, [events]);

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
          className="mt-1.5 truncate text-primary"
          style={{ fontSize: "var(--font-size-sm)", fontWeight: 600 }}
          title={task.contract?.objective ?? task.id}
        >
          {task.contract?.objective ?? task.id}
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

      {hasPatchEvidence ? (
        <InspectorSection title="Changes" icon={<FileDiff size={12} />} defaultOpen>
          <button
            type="button"
            onClick={onShowChanges}
            className="flex w-full items-center justify-between rounded-sm border border-subtle px-2.5 py-2 text-left hover:border-default hover:bg-hover"
            style={{ fontSize: "var(--font-size-xs)" }}
          >
            <span className="text-secondary">Patch evidence is ready for review</span>
            <span className="font-mono text-tertiary">Open</span>
          </button>
        </InspectorSection>
      ) : null}

      {subagents.length > 0 ? (
        <InspectorSection title="Subagents" icon={<UsersRound size={12} />} defaultOpen>
          <ul className="flex flex-col gap-2" style={{ fontSize: "var(--font-size-xs)" }}>
            {subagents.map((subagent) => (
              <li key={subagent.id} className="flex items-start gap-2">
                <StatusIndicator
                  status={subagent.state === "working" ? "working" : subagent.state === "failed" ? "failed" : "done"}
                  size={11}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-secondary">{subagent.role}</span>
                  <span className="block truncate font-mono text-tertiary">{subagent.worktreeId ?? subagent.id}</span>
                </span>
                <span className="text-tertiary">{subagent.state}</span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      {verification.length > 0 ? (
        <InspectorSection title="Verification" icon={<Workflow size={12} />} defaultOpen>
          <ul className="flex flex-col gap-1.5" style={{ fontSize: "var(--font-size-xs)" }}>
            {verification.slice(-5).reverse().map((check) => (
              <li key={check.id} className="flex items-start gap-2">
                <StatusIndicator status={check.state === "passed" ? "done" : check.state === "failed" ? "failed" : "working"} size={11} />
                <span className="min-w-0 flex-1 text-secondary">{check.detail}</span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}

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
      {approvals.length > 0 ? (
        <InspectorSection title="Approvals" icon={<ShieldAlert size={12} />} defaultOpen>
          <ul className="flex flex-col gap-2" style={{ fontSize: "var(--font-size-xs)" }}>
            {approvals.map((approval) => (
              <li key={approval.id} className="border-l-2 border-l-[var(--color-approval-risk)] pl-2 text-secondary">
                <span className="block truncate text-primary">{approval.action}</span>
                <span className="text-tertiary">{approval.risk} risk{approval.reversibility ? ` · ${approval.reversibility}` : ""}</span>
              </li>
            ))}
          </ul>
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
