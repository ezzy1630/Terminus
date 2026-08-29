/**
 * Terminus Desktop — task context panel.
 *
 * Modelled on the Codex "Environment" card: a flat list of 32px rows, label
 * left, value right, hairline separators between groups only. There are no
 * section boxes, no uppercase micro-labels and no badge pills — a stack of
 * bordered cards reads as a web dashboard, and this is a docked native
 * inspector. The wrapping Layout owns the surface (`.inspector-card`,
 * `bg-inspector`) and the hairline left seam; this file owns the contents.
 *
 * Per SPEC §11: "The inspector must not be a fixed list of empty sections.
 * Sections appear only after relevant information exists." That is enforced
 * literally here — a row is rendered only when the control plane actually
 * reported the value behind it. Nothing renders an em-dash placeholder,
 * because a placeholder is itself a claim (that the field exists and is
 * empty) and for most of these it is neither.
 *
 * Deliberately absent, because nothing on the wire carries them:
 *   - git branch and worktree path. No task, session, workspace or ARP v2
 *     snapshot has a branch field, and SPEC §7.1 forbids promoting worktrees
 *     to a hierarchy level.
 *   - "Commit or push" and "Compare branch". Codex shows both; Terminus
 *     exposes no endpoint for either, and a button that does nothing is
 *     worse than an absent one.
 *   - "Reveal in Finder". The preload bridge (src/types/global.d.ts) exposes
 *     no shell-reveal method, so the Local row copies the path instead.
 *
 * Computer-use preview is intentionally absent until a trusted preview
 * transport exists. Runtime activity alone must not create a dead panel.
 */
import { memo, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Boxes,
  ChevronRight,
  Cpu,
  FileDiff,
  Gauge,
  Hash,
  Laptop,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  UsersRound,
  Workflow,
} from "lucide-react";
import { cn } from "../lib/cn";
import { displayLifecycle } from "../lib/turn-activity";
import {
  useSelectedTask,
  useSelectedTaskApprovals,
  useSelectedTaskEventHistory,
  useSelectedTaskEvents,
  useTerminusStore,
} from "../hooks/use-terminus";
import { deriveProjectTitle, projectUriToPath } from "../lib/projects";
import { deriveSubagentActivity, deriveVerificationActivity, extractUnifiedDiffs } from "../lib/task-surface";
import { StatusIndicator } from "./StatusIndicator";
import TaskV2Panel from "./TaskV2Panel";
import { arpV2 } from "../lib/api-v2";
import { api } from "../lib/api";
import { Button } from "../ui/Button";

import type { SandboxReport, TaskArtifactsPage, TerminusSseEvent } from "../types";

/** Codex row geometry: 32px tall, 16px icon, 13px label, right-aligned value. */
const ROW = "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left";
const ROW_INTERACTIVE = "transition-colors hover:bg-hover";
const ICON_SIZE = 16;

interface InspectorRowProps {
  icon?: React.ReactNode;
  label: string;
  /** Right-aligned value. Omit the row entirely rather than passing a dash. */
  value?: React.ReactNode;
  /** Present only when the row does something real. */
  onClick?: () => void;
  /** Overrides the accessible name when the visible label is not enough. */
  ariaLabel?: string;
  /** Native tooltip for values the column is too narrow to show in full. */
  title?: string;
}

/**
 * One environment row. Non-interactive rows render as plain divs so the
 * panel does not advertise affordances it cannot honour — principle 4 of the
 * design spec is that every control does something real.
 */
function InspectorRow({ icon, label, value, onClick, ariaLabel, title }: InspectorRowProps): JSX.Element {
  const body = (
    <>
      {icon ? <span className="shrink-0 text-secondary">{icon}</span> : null}
      <span className="ui-body min-w-0 flex-1 truncate text-primary">{label}</span>
      {value !== undefined && value !== null ? (
        <span className="ui-body min-w-0 shrink-0 truncate text-secondary">{value}</span>
      ) : null}
    </>
  );
  if (!onClick) {
    return <div className={ROW} title={title}>{body}</div>;
  }
  return (
    <Button
      variant="bare"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      title={title}
      className={cn(ROW, ROW_INTERACTIVE)}
    >
      {body}
    </Button>
  );
}

interface InspectorDisclosureProps {
  icon?: React.ReactNode;
  label: string;
  /** Rendered right-aligned, and folded into the accessible name. */
  value?: string;
  /** Tints the value for a genuine warning. Colour is meaning, never decor. */
  tone?: "default" | "warning";
  defaultOpen?: boolean;
  /** Forces the row open and keeps it open — for states the user must see. */
  urgent?: boolean;
  children: React.ReactNode;
}

/**
 * A row that expands. Reserved for detail the panel should not spend 32px on
 * until asked: sandbox diagnostics, the canonical task record, subagent and
 * verification lists.
 */
function InspectorDisclosure({
  icon,
  label,
  value,
  tone = "default",
  defaultOpen = false,
  urgent = false,
  children,
}: InspectorDisclosureProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const effectiveOpen = urgent || open;
  return (
    <div>
      <Button
        variant="bare"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={effectiveOpen}
        aria-label={value ? `${label}, ${value}` : label}
        className={cn(ROW, ROW_INTERACTIVE)}
      >
        {icon ? (
          <span className={cn("shrink-0", tone === "warning" ? "text-warning" : "text-secondary")}>{icon}</span>
        ) : null}
        <span className="ui-body min-w-0 flex-1 truncate text-primary">{label}</span>
        {value ? (
          <span className={cn("ui-body shrink-0 truncate", tone === "warning" ? "text-warning" : "text-secondary")}>
            {value}
          </span>
        ) : null}
        <ChevronRight
          size={14}
          aria-hidden
          className={cn("shrink-0 text-tertiary transition-transform", effectiveOpen && "rotate-90")}
        />
      </Button>
      {effectiveOpen ? <div className="px-2 pb-2.5 pt-0.5">{children}</div> : null}
    </div>
  );
}

/**
 * A named run of rows. Groups are the only place a separator is allowed —
 * inside a group the rows sit directly on the panel surface, as in Codex.
 */
function InspectorGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="border-b border-subtle px-1.5 py-1 last:border-b-0">
      <h2 className="ui-body flex h-8 items-center px-2 text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

/** Working-tree change counts, as parsed off a unified diff. */
export interface InspectorChangeStats {
  additions: number;
  deletions: number;
  files: number;
}

/**
 * Count changed lines and files straight off unified diff text.
 *
 * The control plane sends no stats: `GET /v1/tasks/:id/diff` returns the raw
 * diff and nothing else, so `+N −M` has to be derived here. Header lines
 * ("--- a/x", "+++ b/x") always carry a trailing space, which is what
 * separates them from a content line that happens to begin with a sigil.
 */
export function countDiffStats(diffs: readonly string[]): InspectorChangeStats {
  let additions = 0;
  let deletions = 0;
  const files = new Set<string>();
  for (const diff of diffs) {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ ")) {
        const path = line.slice(4).trim();
        if (path && path !== "/dev/null") files.add(path.replace(/^b\//, ""));
      } else if (line.startsWith("--- ")) {
        // Old-side header. Recorded only when the new side is /dev/null
        // (a deletion), which the "+++ " branch above cannot see.
        continue;
      } else if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
    // A pure deletion names the file only on the old side, and some agents
    // emit `diff --git` headers without a `+++` line at all.
    for (const match of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
      files.add(match[2] ?? match[1] ?? "");
    }
  }
  files.delete("");
  return { additions, deletions, files: files.size };
}

/** Where the change counts came from — the two sources disagree legitimately. */
type ChangeSource = "working_tree" | "proposed";

interface ChangeState {
  taskId: string;
  stats: InspectorChangeStats;
  source: ChangeSource;
}

/**
 * The task's changed-line counts.
 *
 * The working tree is authoritative — `GET /v1/tasks/:id/diff` is the only
 * git-aware endpoint the control plane exposes — but it comes back empty for
 * a task that proposed a patch without applying it, and it is unavailable
 * when the workspace is not a repository. In both cases the patches the agent
 * published on the event stream are the honest second source, and they are
 * what the review pane shows too, so the row and the pane never disagree.
 *
 * The fetch is keyed on the task and its settled/running lifecycle rather
 * than on the event tail: re-reading the working tree on every SSE frame
 * would be one HTTP round trip per token.
 */
function useChangeStats(
  taskId: string | null,
  proposedDiffs: readonly string[],
  lifecycleKey: string,
): ChangeState | null {
  const [workingTree, setWorkingTree] = useState<ChangeState | null>(null);

  useEffect(() => {
    if (!taskId) {
      setWorkingTree(null);
      return;
    }
    const controller = new AbortController();
    void api.getTaskDiff(taskId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const stats = response.git_available ? countDiffStats([response.diff]) : { additions: 0, deletions: 0, files: 0 };
        setWorkingTree({ taskId, stats, source: "working_tree" });
      })
      .catch(() => {
        // A missing or unreadable diff is not an error worth a banner: the
        // proposed-patch fallback below still answers "what changed?".
        if (!controller.signal.aborted) setWorkingTree(null);
      });
    return () => controller.abort();
  }, [taskId, lifecycleKey]);

  const proposed = useMemo(() => {
    if (!taskId || proposedDiffs.length === 0) return null;
    const stats = countDiffStats(proposedDiffs);
    if (stats.additions === 0 && stats.deletions === 0) return null;
    return { taskId, stats, source: "proposed" as const };
  }, [taskId, proposedDiffs]);

  if (workingTree?.taskId === taskId && workingTree.stats.files > 0) return workingTree;
  return proposed;
}

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
    return <InspectorRow icon={<BadgeCheck size={ICON_SIZE} />} label="Task record" value="Checking…" />;
  }
  if (probe.status === "not_found") return null;
  if (probe.status === "error") {
    return (
      <InspectorDisclosure
        icon={<BadgeCheck size={ICON_SIZE} />}
        label="Task record"
        value="Unavailable"
        tone="warning"
        urgent
      >
        <p className="ui-meta text-secondary" role="alert">Canonical task state is temporarily unavailable.</p>
        <p className="ui-meta mt-1 break-words font-mono">{probe.error}</p>
        <Button
          variant="bare"
          onClick={() => {
            setProbe(null);
            setRequestVersion((version) => version + 1);
          }}
          className="ui-meta mt-2 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-secondary transition-colors hover:bg-hover hover:text-primary"
        >
          <RefreshCw size={12} aria-hidden /> Retry task record
        </Button>
      </InspectorDisclosure>
    );
  }
  return (
    <InspectorDisclosure icon={<BadgeCheck size={ICON_SIZE} />} label="Task record" value="Canonical">
      <TaskV2Panel taskId={taskId} />
    </InspectorDisclosure>
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
      <InspectorDisclosure icon={<ShieldCheck size={ICON_SIZE} />} label="Sandbox" value="Unavailable" tone="warning" urgent>
        <p className="ui-meta text-secondary">
          Effective permission profile unavailable. No default-profile report was substituted.
        </p>
      </InspectorDisclosure>
    );
  }
  if (!resource || resource.profileId !== profileId || resource.status === "loading") {
    return <InspectorRow icon={<ShieldCheck size={ICON_SIZE} />} label="Sandbox" value="Checking…" title={profileId} />;
  }
  if (resource.status === "error") {
    return (
      <InspectorDisclosure icon={<ShieldCheck size={ICON_SIZE} />} label="Sandbox" value="Unavailable" tone="warning" urgent>
        <p className="ui-meta text-secondary" role="alert">Sandbox enforcement data is temporarily unavailable.</p>
        <p className="ui-meta mt-1 break-words font-mono">{resource.error}</p>
        <p className="ui-meta mt-1">
          No enforcement claim is shown for <span className="font-mono">{profileId}</span>.
        </p>
        <Button
          variant="bare"
          onClick={refreshSandboxReport}
          className="ui-meta mt-2 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-secondary transition-colors hover:bg-hover hover:text-primary"
        >
          <RefreshCw size={12} aria-hidden /> Retry
        </Button>
      </InspectorDisclosure>
    );
  }
  const report = resource.report;
  const degradedOrWorse = report.status !== "enforced";
  const issueCount = report.degraded.length + report.unsupported.length;
  return (
    <InspectorDisclosure
      icon={<ShieldCheck size={ICON_SIZE} />}
      label="Sandbox"
      value={degradedOrWorse ? "Needs attention" : "Enforced"}
      tone={degradedOrWorse ? "warning" : "default"}
      urgent={degradedOrWorse}
    >
      <div className="flex flex-col gap-2 text-xs">
        {resource.status === "stale" ? (
          <div role="alert" data-cockpit-state="stale" className="border-l-2 border-warning/55 px-2 py-1 text-warning">
            Showing the last confirmed enforcement snapshot.
            <span className="mt-1 block break-words font-mono">{resource.error ?? "Refresh failed."}</span>
          </div>
        ) : null}
        <p className="text-secondary">
          {degradedOrWorse
            ? `${issueCount} ${issueCount === 1 ? "protection is" : "protections are"} not fully enforced in this environment.`
            : "All reported sandbox protections are enforced."}
        </p>
        <div className="flex items-center justify-between gap-2 text-tertiary">
          <span>Checked {new Date(resource.loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <Button
            variant="bare"
            onClick={refreshSandboxReport}
            disabled={resource.refreshing}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-secondary transition-colors hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="Refresh sandbox snapshot"
          >
            <RefreshCw size={11} aria-hidden /> {resource.refreshing ? "Refreshing" : "Refresh"}
          </Button>
        </div>
        <div className="flex flex-col gap-1.5 border-t border-subtle pt-2 text-tertiary">
          <div className="flex items-center justify-between gap-2">
            <span>Backend</span>
            <span className="truncate font-mono text-secondary" title={report.backend_id}>{report.backend_id}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>Profile</span>
            <span className="truncate font-mono text-secondary" title={profileId}>{profileId}</span>
          </div>
          {report.degraded.length > 0 ? <ReportList label="Degraded controls" entries={report.degraded} /> : null}
          {report.unsupported.length > 0 ? <ReportList label="Unsupported controls" entries={report.unsupported} /> : null}
          {report.notes.map((note, i) => <p key={i} className="leading-relaxed">{note}</p>)}
        </div>
      </div>
    </InspectorDisclosure>
  );
});

function ReportList({ label, entries }: { label: string; entries: string[] }): JSX.Element {
  return (
    <div>
      <div className="mb-1 font-medium text-secondary">{label}</div>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <li key={entry} className="truncate font-mono text-secondary" title={entry}>
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

/**
 * Plain-language names for the event stream's lifecycle frames. Anything not
 * listed falls back to the raw event name with separators softened, so a new
 * kernel event degrades to something readable rather than disappearing.
 */
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
 * The tool a `tool.*` frame is about, when the payload names one. Used as the
 * row's right-aligned value so the Activity list reads as "what ran", not as
 * a column of event ids.
 */
function activityDetail(event: TerminusSseEvent): string | undefined {
  if (!event.event.startsWith("tool.")) return undefined;
  try {
    const payload: unknown = JSON.parse(event.data);
    if (typeof payload !== "object" || payload === null) return undefined;
    const record = payload as Record<string, unknown>;
    for (const key of ["tool", "tool_name", "name"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  } catch {
    // A frame we cannot parse still deserves its label; it just has no detail.
  }
  return undefined;
}

/**
 * The task's content-addressed artifacts.
 *
 * This list used to be the *fallback view of the Changes pane*: when the
 * working-tree diff came back empty, ⌘D opened onto a column of sha256 hashes
 * for a task that had really edited files. An index of what the kernel stored
 * is reference material, so it lives here, in its own group, and Changes
 * shows the diff.
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
      <InspectorGroup title="Artifacts">
        <p className="ui-meta px-2 pb-1 text-warning" role="status">{state.error}</p>
      </InspectorGroup>
    );
  }
  const artifacts = state.page?.artifacts ?? [];
  if (state.page === null || artifacts.length === 0) return null;

  return (
    <InspectorGroup title="Artifacts">
      <ul aria-label="Task artifacts">
        {artifacts.map((artifact) => (
          <li key={artifact.hash}>
            <InspectorRow
              icon={<Boxes size={ICON_SIZE} />}
              label={artifact.purpose}
              value={artifact.size_bytes !== null ? formatBytes(artifact.size_bytes) : undefined}
              title={artifact.hash}
            />
          </li>
        ))}
      </ul>
      {artifacts.length < state.page.total ? (
        <p className="ui-meta px-2 pb-1">Showing {artifacts.length} of {state.page.total}.</p>
      ) : null}
    </InspectorGroup>
  );
});

/** Byte counts in the value column, kept short enough not to wrap the row. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function NoSelection(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Sparkles size={20} strokeWidth={1.6} className="text-tertiary" aria-hidden />
      <p className="ui-body mt-3 max-w-[200px] text-tertiary">
        Select a task to see its environment and activity.
      </p>
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
  const sessionId = task?.session_id ?? null;
  // Narrower than subscribing to `sessions`: the panel re-renders only when
  // this session's object identity changes, not on every list refresh.
  const session = useTerminusStore(
    (state) => (sessionId ? state.sessions.find((entry) => entry.id === sessionId) ?? null : null),
  );
  const eventDerivedStateComplete = eventHistory === null;
  const [copied, setCopied] = useState<"path" | "id" | null>(null);

  const approvals = approvalResource.approvals;

  /*
   * One pass over the event tail, not four.
   *
   * Each of these derivations used to be its own `useMemo` keyed on the
   * `events` array, so a single SSE flush walked the tail four times — and any
   * re-render that handed back a fresh array identity for unchanged content
   * walked it four times for nothing. Length plus the last event id is what
   * actually determines all four results (the tail is append-only), so the
   * fingerprint is the honest dependency and `events` is deliberately not in
   * the dependency list.
   */
  const eventFingerprint = `${events.length}:${events[events.length - 1]?.id ?? ""}:${eventDerivedStateComplete}`;
  const derived = useMemo(() => {
    const tail = [...events];
    return {
      subagents: eventDerivedStateComplete ? deriveSubagentActivity(tail) : [],
      verification: eventDerivedStateComplete ? deriveVerificationActivity(tail) : [],
      recentEvents: tail.slice(-5).reverse(),
      proposedDiffs: eventDerivedStateComplete ? extractUnifiedDiffs(tail) : [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [eventFingerprint]);
  const { subagents, verification, recentEvents } = derived;

  // ACTIVE is the steady state, not "working" — see lib/turn-activity.
  const statusKind = task ? displayLifecycle(task, events) : "idle";
  const changes = useChangeStats(task?.id ?? null, derived.proposedDiffs, statusKind);

  const permissionProfileId = session?.default_permission_profile?.trim() || null;
  const workspacePath = projectUriToPath(session?.workspace_root_uri);

  /** Copies `value`, then flags `field` so its row can confirm briefly. */
  const copy = async (field: "path" | "id", value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(field);
      setTimeout(() => setCopied(null), 1_600);
    } catch {
      // Clipboard access can be denied; the row simply does not confirm.
    }
  };

  if (!task) {
    return (
      <div className={cn("h-full overflow-y-auto", className)}>
        <NoSelection />
      </div>
    );
  }

  const blockedByProvider = task.status === "BLOCKED"
    && task.terminal_reason?.reason === "provider_transport_unavailable";
  const hasEnvironmentRows = changes !== null || workspacePath !== null;

  return (
    <div className={cn("flex h-full flex-col overflow-y-auto pb-3", className)}>
      {eventHistory ? (
        <p className="ui-meta border-b border-subtle px-3.5 py-2 text-warning" role="status">
          Authoritative event projection in progress.
        </p>
      ) : null}

      {blockedByProvider ? (
        <p className="ui-meta border-b border-subtle px-3.5 py-2 text-warning" role="status">
          Provider transport unavailable.
        </p>
      ) : null}

      {/*
        Environment — the Codex card, minus the rows Terminus has no data or
        endpoint for. `Changes` is the only one that can act, and it opens the
        same review surface ⌘D does.
      */}
      {hasEnvironmentRows ? (
        <InspectorGroup title="Environment">
          {changes !== null ? (
            <InspectorRow
              icon={<FileDiff size={ICON_SIZE} />}
              label="Changes"
              ariaLabel="Open patch review"
              onClick={onShowChanges}
              title={
                changes.source === "working_tree"
                  ? `${changes.stats.files} file${changes.stats.files === 1 ? "" : "s"} changed in the working tree`
                  : `${changes.stats.files} file${changes.stats.files === 1 ? "" : "s"} in patches the agent proposed`
              }
              value={
                <span className="tabular-nums">
                  <span className="text-addition">+{changes.stats.additions.toLocaleString()}</span>
                  {" "}
                  <span className="text-deletion">−{changes.stats.deletions.toLocaleString()}</span>
                </span>
              }
            />
          ) : null}
          {workspacePath ? (
            <InspectorRow
              icon={<Laptop size={ICON_SIZE} />}
              label="Local"
              value={copied === "path" ? "Copied" : deriveProjectTitle(workspacePath)}
              ariaLabel="Copy workspace path"
              onClick={() => void copy("path", workspacePath)}
              title={workspacePath}
            />
          ) : null}
        </InspectorGroup>
      ) : null}

      {/*
        Context — what this task is running as. Model and effort come from the
        session's defaults, which is what the control plane routes turns with
        when a turn does not override them; both are optional on the wire, so
        both rows disappear when unset rather than inventing a default.

        Risk class and contract version are required fields the decoder
        rejects when absent, so these are measurements, not stand-ins.
      */}
      <InspectorGroup title="Context">
        {session?.default_model ? (
          <InspectorRow
            icon={<Cpu size={ICON_SIZE} />}
            label="Model"
            value={session.default_model}
            title={session.default_model}
          />
        ) : null}
        {session?.default_reasoning_effort ? (
          <InspectorRow icon={<Gauge size={ICON_SIZE} />} label="Effort" value={session.default_reasoning_effort} />
        ) : null}
        {permissionProfileId ? (
          <InspectorRow
            icon={<ShieldAlert size={ICON_SIZE} />}
            label="Access"
            value={permissionProfileId}
            title={permissionProfileId}
          />
        ) : null}
        <InspectorRow icon={<Workflow size={ICON_SIZE} />} label="Risk" value={task.risk_class} />
        <InspectorRow icon={<BadgeCheck size={ICON_SIZE} />} label="Contract" value={`v${task.active_contract_version}`} />
        {/* The id is what a bug report needs and what nothing else on screen
            shows in full, so the row hands over the whole thing. */}
        <InspectorRow
          icon={<Hash size={ICON_SIZE} />}
          label="Task"
          value={copied === "id" ? "Copied" : task.id.slice(-8)}
          ariaLabel="Copy task ID"
          onClick={() => void copy("id", task.id)}
          title={task.id}
        />
        <SandboxSection profileId={permissionProfileId} />
        <TaskV2Section taskId={task.id} />
      </InspectorGroup>

      {/* Activity — the recent run, plus the two derived lists worth keeping. */}
      {recentEvents.length > 0 || subagents.length > 0 || verification.length > 0 ? (
        <InspectorGroup title="Activity">
          {subagents.length > 0 ? (
            <InspectorDisclosure
              icon={<UsersRound size={ICON_SIZE} />}
              label="Subagents"
              value={`${subagents.filter((item) => item.state === "working").length} working, ${subagents.filter((item) => item.state === "done").length} done`}
            >
              <ul className="flex flex-col gap-1.5">
                {subagents.map((subagent) => (
                  <li key={subagent.id} className="flex items-center gap-2">
                    <StatusIndicator
                      status={subagent.state === "working" ? "working" : subagent.state === "failed" ? "failed" : "done"}
                      size={8}
                    />
                    <span className="ui-meta min-w-0 flex-1 truncate text-secondary">{subagent.role}</span>
                  </li>
                ))}
              </ul>
            </InspectorDisclosure>
          ) : null}
          {verification.length > 0 ? (
            <InspectorDisclosure
              icon={<Workflow size={ICON_SIZE} />}
              label="Verification"
              value={`${verification.filter((check) => check.state === "passed").length}/${verification.length}`}
              tone={verification.some((check) => check.state === "failed") ? "warning" : "default"}
              urgent={verification.some((check) => check.state === "failed")}
            >
              <ul className="flex flex-col gap-1.5">
                {verification.slice(-5).reverse().map((check) => (
                  <li key={check.id} className="flex items-start gap-2">
                    <StatusIndicator
                      status={check.state === "passed" ? "done" : check.state === "failed" ? "failed" : "working"}
                      size={8}
                    />
                    <span className="ui-meta min-w-0 flex-1 text-secondary">{check.detail}</span>
                  </li>
                ))}
              </ul>
            </InspectorDisclosure>
          ) : null}
          <ul aria-label="Recent activity">
            {recentEvents.map((ev: TerminusSseEvent, i) => (
              <li key={ev.id ?? i}>
                <InspectorRow
                  icon={<Terminal size={ICON_SIZE} />}
                  label={activityLabel(ev.event)}
                  value={activityDetail(ev)}
                />
              </li>
            ))}
          </ul>
        </InspectorGroup>
      ) : null}

      <ArtifactsSection taskId={task.id} />

      {/* Approvals — the one group that is always open, because it blocks. */}
      {approvals.length > 0 ? (
        <InspectorGroup title="Approvals">
          <ul>
            {approvals.map((approval) => (
              <li key={approval.id}>
                <InspectorRow
                  icon={<ShieldAlert size={ICON_SIZE} className="text-warning" />}
                  label={approval.action}
                  value={approval.risk}
                  title={approval.reversibility ? `${approval.risk} risk, ${approval.reversibility}` : `${approval.risk} risk`}
                />
              </li>
            ))}
          </ul>
        </InspectorGroup>
      ) : null}
    </div>
  );
}

export const Inspector = memo(InspectorImpl);
