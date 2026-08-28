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
 *
 * Each section is independently collapsible. The inspector pins by
 * default and never reorders sections while the user is reading.
 *
 * Per SPEC §11.1: floating rounded card, lightweight, restrained
 * maximum width. The wrapping Layout provides the card chrome — the
 * inspector itself is just scrollable content.
 *
 * Computer-use preview is intentionally absent until a trusted preview
 * transport exists. Runtime activity alone must not create a dead panel.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Boxes, Check, ChevronDown, ChevronRight, Copy, FileDiff, GitBranch, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, UsersRound, Workflow } from "lucide-react";
import { cn } from "../lib/cn";
import { displayLifecycle } from "../lib/turn-activity";
import {
  useSelectedTask,
  useSelectedTaskApprovals,
  useSelectedTaskEventHistory,
  useSelectedTaskEvents,
  useTerminusStore,
} from "../hooks/use-terminus";
import { deriveSubagentActivity, deriveVerificationActivity, extractUnifiedDiffs } from "../lib/task-surface";
import { statusLabel, StatusIndicator } from "./StatusIndicator";
import TaskV2Panel from "./TaskV2Panel";
import { arpV2 } from "../lib/api-v2";
import { api } from "../lib/api";
import { Button } from "../ui/Button";

const INSPECTOR_EVENT_PREVIEW_CHARS = 2_000;
import type { SandboxReport, TaskArtifactsPage, TerminusSseEvent } from "../types";

/**
 * Canonical ARP v2 inspector section. Renders only when the selected task
 * id also exists on the canonical /v2 surface (e.g. created via the CLI's
 * `new-task-v2`); otherwise the section is omitted entirely.
 */
const TaskV2Section = memo(function TaskV2Section({ taskId }: { taskId: string }): JSX.Element | null {
  const [requestVersion, setRequestVersion] = useState(0);
  const [probe, setProbe] = useState<{
    taskId: string;
    status: "canonical" | "not_found" | "error";
    error: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    arpV2.getTask(taskId)
      .then((snapshot) => {
        if (!cancelled) setProbe({
          taskId,
          status: snapshot === null ? "not_found" : "canonical",
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setProbe({
          taskId,
          status: "error",
          error: error instanceof Error ? error.message : "ARP v2 probe failed",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [requestVersion, taskId]);
  if (probe?.taskId !== taskId) {
    return (
      <InspectorSection title="Task record" icon={<BadgeCheck size={12} />} summary="Checking">
        <p className="text-tertiary text-xs" >Checking canonical task state…</p>
      </InspectorSection>
    );
  }
  if (probe.status === "not_found") return null;
  if (probe.status === "error") {
    return (
      <InspectorSection title="Task record" icon={<BadgeCheck size={12} />} summary="Unavailable" urgent>
        <p className="text-xs text-secondary" role="alert">Canonical task state is temporarily unavailable.</p>
        <details className="mt-1 text-xs text-tertiary">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 break-words font-mono">{probe.error}</p>
        </details>
        <Button
          type="button"
          onClick={() => {
            setProbe(null);
            setRequestVersion((version) => version + 1);
          }}
          className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-secondary hover:bg-hover hover:text-primary"
        >
          <RefreshCw size={11} aria-hidden /> Retry task record
        </Button>
      </InspectorSection>
    );
  }
  return (
    <InspectorSection title="Task record" icon={<BadgeCheck size={12} />} defaultOpen={false}>
      <TaskV2Panel taskId={taskId} />
    </InspectorSection>
  );
});

/**
 * Live sandbox enforcement report (SPEC §13.4): the kernel reports which
 * controls are enforced, degraded, or unsupported, and the UI must render
 * that honestly. The selected session's effective profile is required; the
 * UI never substitutes a default-profile report or hides an unavailable one.
 */
type SandboxResource =
  | { profileId: string; status: "loading" }
  | { profileId: string; status: "ready" | "stale"; report: SandboxReport; loadedAt: string; refreshing: boolean; error: string | null }
  | { profileId: string; status: "error"; error: string };

const SandboxSection = memo(function SandboxSection({ profileId }: { profileId: string | null }): JSX.Element {
  const [resource, setResource] = useState<SandboxResource | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  useEffect(() => {
    if (!profileId) return;
    const controller = new AbortController();
    api.getSandboxReport(profileId, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setResource({
          profileId,
          status: "ready",
          report: r,
          loadedAt: new Date().toISOString(),
          refreshing: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : "Sandbox report unavailable";
          setResource((current) => {
            if (current?.profileId === profileId && (current.status === "ready" || current.status === "stale")) {
              return { ...current, status: "stale", refreshing: false, error: message };
            }
            return { profileId, status: "error", error: message };
          });
        }
      });
    return () => controller.abort();
  }, [profileId, requestVersion]);

  const refreshSandboxReport = (): void => {
    if (!profileId) return;
    setResource((current) => {
      if (current?.profileId !== profileId || current.status === "error" || current.status === "loading") {
        return { profileId, status: "loading" };
      }
      return { ...current, status: "ready", refreshing: true, error: null };
    });
    setRequestVersion((version) => version + 1);
  };

  if (!profileId) {
    return (
      <InspectorSection title="Permissions" icon={<ShieldCheck size={12} />} summary="Unavailable" urgent>
        <p className="text-tertiary text-xs" style={{ lineHeight: 1.45 }}>
          Effective permission profile unavailable. No default-profile report was substituted.
        </p>
      </InspectorSection>
    );
  }
  if (!resource || resource.profileId !== profileId || resource.status === "loading") {
    return (
      <InspectorSection title="Permissions" icon={<ShieldCheck size={12} />} summary="Checking">
        <p className="text-tertiary text-xs" >
          Checking profile <span className="font-mono">{profileId}</span>…
        </p>
      </InspectorSection>
    );
  }
  if (resource.status === "error") {
    return (
      <InspectorSection title="Permissions" icon={<ShieldCheck size={12} />} summary="Unavailable" urgent>
        <p className="text-xs text-secondary" role="alert">Sandbox enforcement data is temporarily unavailable.</p>
        <details className="mt-1 text-xs text-tertiary">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 break-words font-mono">{resource.error}</p>
        </details>
        <p className="mt-1 text-tertiary text-xs" >
          No enforcement claim is shown for <span className="font-mono">{profileId}</span>.
        </p>
        <Button type="button" onClick={refreshSandboxReport} className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-secondary hover:bg-hover hover:text-primary">
          <RefreshCw size={11} aria-hidden /> Retry
        </Button>
      </InspectorSection>
    );
  }
  const report = resource.report;
  const degradedOrWorse = report.status !== "enforced";
  const issueCount = report.degraded.length + report.unsupported.length;
  return (
    <InspectorSection
      title="Permissions"
      icon={<ShieldCheck size={12} />}
      summary={degradedOrWorse ? "Needs attention" : "Enforced"}
      urgent={degradedOrWorse}
      defaultOpen={false}
    >
      <div className="flex flex-col gap-2 text-xs">
        {resource.status === "stale" ? (
          <div role="alert" data-cockpit-state="stale" className="border-l-2 border-warning/55 px-2 py-1 text-warning">
            Showing the last confirmed enforcement snapshot.
            <details className="mt-1 text-tertiary">
              <summary className="cursor-pointer select-none">Details</summary>
              <span className="mt-1 block break-words font-mono">{resource.error ?? "Refresh failed."}</span>
            </details>
          </div>
        ) : null}
        <p className="text-secondary">
          {degradedOrWorse
            ? `${issueCount} ${issueCount === 1 ? "protection is" : "protections are"} not fully enforced in this environment.`
            : "All reported sandbox protections are enforced."}
        </p>
        <div className="flex items-center justify-between gap-2 text-tertiary">
          <span>Checked {new Date(resource.loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <Button type="button" onClick={refreshSandboxReport} disabled={resource.refreshing} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-secondary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-45" aria-label="Refresh sandbox snapshot">
            <RefreshCw size={11} aria-hidden /> {resource.refreshing ? "Refreshing" : "Refresh"}
          </Button>
        </div>
        <details className="border-t border-subtle pt-2 text-tertiary">
          <summary className="cursor-pointer select-none text-secondary">Diagnostics</summary>
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span>Backend</span>
              <span className="truncate font-mono text-secondary" data-tooltip={report.backend_id}>{report.backend_id}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Status</span>
              <span className="font-mono text-secondary">{report.status}</span>
            </div>
            {report.degraded.length > 0 ? <ReportList label="Degraded controls" entries={report.degraded} /> : null}
            {report.unsupported.length > 0 ? <ReportList label="Unsupported controls" entries={report.unsupported} /> : null}
            {report.notes.map((note, i) => <p key={i} className="leading-relaxed">{note}</p>)}
          </div>
        </details>
      </div>
    </InspectorSection>
  );
});

function ReportList({ label, entries }: { label: string; entries: string[] }): JSX.Element {
  return (
    <div>
      <div className="mb-1 font-medium text-secondary">{label}</div>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <li key={entry} className="truncate font-mono text-secondary" data-tooltip={entry}>
            {entry.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface InspectorProps {
  className?: string;
  /** Opens the review split when the task has patch evidence. */
  onShowChanges?: () => void;
}

interface InspectorSectionProps {
  title: string;
  icon?: React.ReactNode;
  summary?: string;
  urgent?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function activityLabel(eventName: string): string {
  const labels: Record<string, string> = {
    "turn.started": "Turn started",
    "turn.provider_running": "Agent working",
    "turn.response_validating": "Validating response",
    "turn.completed": "Turn completed",
    "tool.proposed": "Tool proposed",
    "tool.authorized": "Tool authorized",
    "tool.settled": "Tool finished",
    "task.completed": "Task completed",
    "task.failed": "Task failed",
  };
  return labels[eventName] ?? eventName.replace(/[._]/g, " ");
}

/**
 * The task's content-addressed artifacts.
 *
 * This list used to be the *fallback view of the Changes pane*: when the
 * working-tree diff came back empty, ⌘D opened onto a column of sha256 hashes
 * for a task that had really edited files. An index of what the kernel stored
 * is reference material, so it lives here, behind a collapsed section, and
 * Changes shows the diff.
 */
const ArtifactsSection = memo(function ArtifactsSection({ taskId }: { taskId: string }): JSX.Element | null {
  const [state, setState] = useState<{
    taskId: string;
    page: TaskArtifactsPage | null;
    error: string | null;
  }>({ taskId, page: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ taskId, page: null, error: null });
    void api.listTaskArtifacts(taskId, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setState({ taskId, page, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          taskId,
          page: null,
          error: error instanceof Error ? error.message : "The artifact list could not be read.",
        });
      });
    return () => controller.abort();
  }, [taskId]);

  if (state.taskId !== taskId) return null;
  if (state.error !== null) {
    return (
      <InspectorSection title="Artifacts" icon={<Boxes size={12} />} summary="Unavailable" urgent defaultOpen={false}>
        <p className="text-xs text-warning" role="status">{state.error}</p>
      </InspectorSection>
    );
  }
  const artifacts = state.page?.artifacts ?? [];
  if (state.page === null || artifacts.length === 0) return null;

  return (
    <InspectorSection
      title="Artifacts"
      icon={<Boxes size={12} />}
      summary={`${state.page.total}`}
      defaultOpen={false}
    >
      <ul className="flex flex-col gap-1.5 text-xs" aria-label="Task artifacts">
        {artifacts.map((artifact) => (
          <li key={artifact.hash} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-secondary" title={artifact.hash}>
              {artifact.hash.replace(/^sha256:/, "").slice(0, 12)}…
            </span>
            <span className="shrink-0 truncate font-mono text-tertiary">{artifact.purpose}</span>
            {artifact.size_bytes !== null ? (
              <span className="shrink-0 font-mono text-tertiary tabular-nums">
                {artifact.size_bytes.toLocaleString()} B
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {artifacts.length < state.page.total ? (
        <p className="mt-2 text-xs text-tertiary">
          Showing {artifacts.length} of {state.page.total}.
        </p>
      ) : null}
    </InspectorSection>
  );
});

function InspectorSection({
  title,
  icon,
  summary,
  urgent = false,
  defaultOpen = false,
  children,
}: InspectorSectionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const effectiveOpen = urgent || open;
  return (
    <div className={cn(
      "rounded-xl border bg-card/60 p-3 shadow-xs transition-all",
      urgent ? "border-warning/40 bg-warning/5" : "border-subtle/80 hover:border-default",
    )}>
      <Button
        variant="bare"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={effectiveOpen}
        aria-label={`${title}${summary ? `, ${summary}` : ""}`}
        className="flex w-full items-center justify-between"
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon ? <span className={cn("text-tertiary shrink-0", urgent && "text-warning")}>{icon}</span> : null}
          <span className="text-xs font-semibold text-primary truncate">{title}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {summary ? (
            <span className={cn("rounded-md bg-subtle px-1.5 py-0.5 text-xs font-mono tabular-nums text-tertiary", urgent && "bg-warning/15 text-warning")}>
              {summary}
            </span>
          ) : null}
          {effectiveOpen ? <ChevronDown size={12} className="text-tertiary" /> : <ChevronRight size={12} className="text-tertiary" />}
        </div>
      </Button>
      {effectiveOpen ? <div className="mt-2.5 pt-2 border-t border-subtle/50">{children}</div> : null}
    </div>
  );
}

function NoSelection(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-tertiary">
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-card border border-subtle text-secondary shadow-xs">
        <Sparkles size={18} strokeWidth={1.7} />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-primary">Task context</h3>
      <p className="mt-1 text-xs text-secondary max-w-[200px]">Select a task to inspect runtime capabilities, subagents, and verification evidence.</p>
    </div>
  );
}

function InspectorImpl({
  className,
  onShowChanges,
}: InspectorProps): JSX.Element {
  const task = useSelectedTask();
  const events = useSelectedTaskEvents();
  const eventHistory = useSelectedTaskEventHistory();
  const approvalResource = useSelectedTaskApprovals();
  const sessions = useTerminusStore((state) => state.sessions);
  const eventDerivedStateComplete = eventHistory === null;
  const [copiedId, setCopiedId] = useState(false);

  // Derive a simple activity summary (last 5 events).
  const recentEvents = useMemo(() => events.slice(-5).reverse(), [events]);

  const approvals = approvalResource.approvals;
  const subagents = useMemo(
    () => eventDerivedStateComplete ? deriveSubagentActivity(events) : [],
    [eventDerivedStateComplete, events],
  );
  const verification = useMemo(
    () => eventDerivedStateComplete ? deriveVerificationActivity(events) : [],
    [eventDerivedStateComplete, events],
  );
  const hasPatchEvidence = useMemo(
    () => eventDerivedStateComplete && extractUnifiedDiffs(events).length > 0,
    [eventDerivedStateComplete, events],
  );
  const permissionProfileId = useMemo(
    () => sessions.find((session) => session.id === task?.session_id)?.default_permission_profile?.trim() || null,
    [sessions, task?.session_id],
  );

  const copyTaskId = async (): Promise<void> => {
    if (!task?.id) return;
    try {
      await navigator.clipboard.writeText(task.id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch {}
  };

  if (!task) {
    return (
      <div className={cn("h-full overflow-y-auto bg-transparent", className)}>
        <NoSelection />
      </div>
    );
  }

  // ACTIVE is the steady state, not "working" — see lib/turn-activity.
  const statusKind = displayLifecycle(task, events);
  const blockedByProvider = task.status === "BLOCKED"
    && task.terminal_reason?.reason === "provider_transport_unavailable";

  return (
    <div className={cn("flex h-full flex-col gap-3 overflow-y-auto bg-transparent p-3.5", className)}>
      {/* Top Quick Action Header & Pill Bar */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-tertiary">Context</span>
          <StatusIndicator
            status={statusKind}
            size={10}
            label={blockedByProvider ? "Provider transport unavailable" : statusLabel(statusKind)}
          />
        </div>

        {/* Floating Quick Action Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {hasPatchEvidence && onShowChanges ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onShowChanges}
              aria-label="Open patch review"
              className="h-7 rounded-lg border-default bg-card px-2.5 text-xs text-primary shadow-xs hover:border-strong hover:bg-hover inline-flex items-center gap-1.5"
            >
              <FileDiff size={12} className="text-info" aria-hidden />
              <span>Review diffs</span>
              <span className="h-1.5 w-1.5 rounded-full bg-success shrink-0" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={copyTaskId}
            aria-label="Copy task ID"
            className="h-7 rounded-lg border border-subtle/80 bg-card/60 px-2.5 text-xs text-secondary hover:bg-hover hover:text-primary inline-flex items-center gap-1.5"
          >
            {copiedId ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            <span>{copiedId ? "Copied" : "Copy ID"}</span>
          </Button>
        </div>
      </div>

      {eventHistory ? (
        <div className="rounded-xl border border-warning/35 bg-warning/10 p-2.5 text-xs text-warning" role="status">
          Authoritative event projection in progress.
        </div>
      ) : null}

      {/* Environment Section */}
      {/*
        Every row here is read from the task or the session.

        The previous version stated "Runtime: Local UDS" (a transport this
        renderer cannot observe and does not choose), relabelled the permission
        profile as "Full access", and defaulted the contract version to `v1`
        and the risk class to "Standard" when the control plane had reported
        neither. Four confident claims, none of them measurements.
      */}
      <InspectorSection title="Environment" icon={<GitBranch size={12} />} summary={statusLabel(statusKind)} defaultOpen>
        <div className="flex flex-col gap-2 text-xs">
          {permissionProfileId ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-tertiary">Permission profile</span>
              <span className="inline-flex items-center gap-1 truncate rounded border border-info/20 bg-info/10 px-1.5 py-0.5 font-mono text-xs font-medium text-info">
                {permissionProfileId}
              </span>
            </div>
          ) : null}
          {/* Both are required fields the decoder rejects when absent, so
              these are the control plane's values, not stand-ins for them. */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-tertiary">Risk class</span>
            <span className="text-secondary">{task.risk_class}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-tertiary">Contract</span>
            <span className="font-mono text-secondary">v{task.active_contract_version}</span>
          </div>
        </div>
      </InspectorSection>

      {/* Canonical Task Section */}
      <TaskV2Section taskId={task.id} />

      {/* Sandbox Section */}
      <SandboxSection profileId={permissionProfileId} />

      {/* Artifacts — reference material, not the review surface. */}
      <ArtifactsSection taskId={task.id} />

      {/* Subagents Section */}
      {subagents.length > 0 ? (
        <InspectorSection
          title="Subagents"
          icon={<UsersRound size={12} />}
          summary={`${subagents.filter((item) => item.state === "working").length} working, ${subagents.filter((item) => item.state === "done").length} done`}
          defaultOpen={false}
        >
          <ul className="flex flex-col gap-2 text-xs">
            {subagents.map((subagent) => (
              <li key={subagent.id} className="flex items-start gap-2 rounded-lg bg-subtle/40 p-2">
                <StatusIndicator
                  status={subagent.state === "working" ? "working" : subagent.state === "failed" ? "failed" : "done"}
                  size={10}
                />
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-primary">{subagent.role}</span>
                  <span className="block truncate font-mono text-xs text-tertiary">{subagent.worktreeId ?? subagent.id}</span>
                </div>
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      {/* Verification Section */}
      {verification.length > 0 ? (
        <InspectorSection
          title="Verification"
          icon={<Workflow size={12} />}
          summary={`${verification.filter((check) => check.state === "passed").length}/${verification.length}`}
          urgent={verification.some((check) => check.state === "failed")}
          defaultOpen
        >
          <ul className="flex flex-col gap-1.5 text-xs">
            {verification.slice(-5).reverse().map((check) => (
              <li key={check.id} className="flex items-start gap-2 rounded bg-subtle/30 px-2 py-1.5">
                <StatusIndicator status={check.state === "passed" ? "done" : check.state === "failed" ? "failed" : "working"} size={10} />
                <span className="min-w-0 flex-1 text-secondary">{check.detail}</span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      {/* Activity Section */}
      {recentEvents.length > 0 ? (
        <InspectorSection title="Activity" icon={<Workflow size={12} />} summary={`${recentEvents.length}`} defaultOpen={false}>
          <ul className="flex flex-col gap-1.5 text-xs text-secondary">
            {recentEvents.map((ev: TerminusSseEvent, i) => (
              <li key={ev.id ?? i} className="flex items-center justify-between gap-2 rounded bg-subtle/30 px-2 py-1">
                <span className="truncate text-secondary">{activityLabel(ev.event)}</span>
                <span className="font-mono text-xs text-tertiary shrink-0">{ev.id ? ev.id.slice(-6) : "ev"}</span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}

      {/* Approvals Section */}
      {approvals.length > 0 ? (
        <InspectorSection title="Approvals" icon={<ShieldAlert size={12} />} summary={`${approvals.length} waiting`} urgent defaultOpen>
          <ul className="flex flex-col gap-1.5 text-xs">
            {approvals.map((approval) => (
              <li key={approval.id} className="rounded-lg bg-warning/10 border border-warning/20 p-2 text-secondary">
                <span className="block font-medium text-primary truncate">{approval.action}</span>
                <span className="text-warning text-xs">{approval.risk} risk{approval.reversibility ? `, ${approval.reversibility}` : ""}</span>
              </li>
            ))}
          </ul>
        </InspectorSection>
      ) : null}
    </div>
  );
}

export const Inspector = memo(InspectorImpl);
