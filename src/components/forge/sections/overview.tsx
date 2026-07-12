"use client";

import * as React from "react";
import { forgeFetch, formatDuration, formatRelative, formatTimestamp } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { EventStream } from "@/components/forge/event-stream";
import { AlertCircle, CheckCircle2, Cpu, Gauge, ListChecks, ShieldAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface OverviewProps {
  sessions: SessionSummary[];
  tasks: TaskSummary[];
  onOpenTask: (taskId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onSwitchSection: (s: "tasks" | "sessions") => void;
}

interface SessionSummary {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}
interface TaskSummary {
  id: string;
  status: string;
  phase: string;
  risk_class: string;
  updated_at: string;
  session_id: string;
}

interface SystemHealth {
  status: string;
  version: string;
  build_commit: string;
  instance_id: string;
  uptime_seconds: number;
  ready: boolean;
  kernel?: {
    status: string;
    ready: boolean;
    instance_id?: string;
    version?: string;
    supported_backends?: string[];
    /** Most control-plane responses nest the report under enforcement_report. */
    enforcement_report?: {
      backend_id?: string;
      status?: string;
      enforced?: string[];
      unsupported?: string[];
      degraded?: string[];
      notes?: string[];
    };
    /** Fallback for older / flatter shapes. */
    backend_id?: string;
    enforced?: string[];
    unsupported?: string[];
    notes?: string[];
  };
}

export function Overview({ sessions, tasks, onOpenTask, onSwitchSection }: OverviewProps) {
  const [health, setHealth] = React.useState<SystemHealth | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const h = await forgeFetch<SystemHealth>("/v1/system/health");
      setHealth(h);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  const activeSessions = sessions.filter((s) => s.status === "active").slice(0, 5);
  const activeTasks = tasks.slice(0, 5);
  const completed = tasks.filter((t) => t.status === "COMPLETED").length;
  const failed = tasks.filter((t) => t.status === "FAILED" || t.status === "ABORTED").length;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <SystemHealthCard health={health} loading={loading} err={err} />
        <KernelEnforcementCard health={health} loading={loading} />
        <QuickStatsCard
          total={tasks.length}
          completed={completed}
          failed={failed}
          sessions={sessions.length}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="size-4 text-primary" />
              Active tasks
              <button
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onSwitchSection("tasks")}
              >
                view all →
              </button>
            </CardTitle>
            <CardDescription>Most recently updated tasks across all sessions.</CardDescription>
          </CardHeader>
          <CardContent>
            {activeTasks.length === 0 ? (
              <EmptyHint label="No tasks yet. Try the demo button below." />
            ) : (
              <ul className="divide-y">
                {activeTasks.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => onOpenTask(t.id)}
                      className="flex w-full items-center gap-3 py-2 text-left hover:bg-accent/40 rounded-md px-2 transition-colors"
                    >
                      <StatusBadge status={t.status} />
                      <MonoId id={t.id} />
                      <span className="text-xs text-muted-foreground ml-auto">{formatRelative(t.updated_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="size-4 text-primary" />
              Active sessions
              <button
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onSwitchSection("sessions")}
              >
                view all →
              </button>
            </CardTitle>
            <CardDescription>Recently updated sessions.</CardDescription>
          </CardHeader>
          <CardContent>
            {activeSessions.length === 0 ? (
              <EmptyHint label="No sessions yet." />
            ) : (
              <ul className="divide-y">
                {activeSessions.map((s) => (
                  <li key={s.id}>
                    <button
                      onClick={() => onSwitchSection("sessions")}
                      className="flex w-full items-center gap-3 py-2 text-left hover:bg-accent/40 rounded-md px-2 transition-colors"
                    >
                      <StatusBadge status={s.status} />
                      <span className="text-sm truncate">{s.title}</span>
                      <MonoId id={s.id} className="ml-auto" />
                      <span className="text-xs text-muted-foreground">{formatRelative(s.updated_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <EventStream title="Live event stream" maxHeight={420} />
    </div>
  );
}

function SystemHealthCard({
  health,
  loading,
  err,
}: {
  health: SystemHealth | null;
  loading: boolean;
  err: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="size-4 text-primary" />
          System health
        </CardTitle>
        <CardDescription>From GET /v1/system/health</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {loading && !health ? (
          <Skeleton className="h-24 w-full" />
        ) : err ? (
          <div className="flex items-center gap-2 text-destructive text-xs">
            <AlertCircle className="size-4" />
            <span className="font-mono">{err}</span>
          </div>
        ) : health ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">status</span>
              <StatusBadge status={health.status} />
            </div>
            <Field label="version" value={health.version} mono />
            <Field label="build_commit" value={health.build_commit} mono />
            <Field label="instance_id" value={health.instance_id} mono />
            <Field label="uptime" value={formatDuration(health.uptime_seconds)} />
            <Field
              label="ready"
              value={
                health.ready ? (
                  <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3" /> ready
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                    <XCircle className="size-3" /> not ready
                  </span>
                )
              }
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function KernelEnforcementCard({
  health,
  loading,
}: {
  health: SystemHealth | null;
  loading: boolean;
}) {
  const kernel = health?.kernel;
  const report = kernel?.enforcement_report ?? kernel;
  const enforced = report?.enforced ?? [];
  const unsupported = report?.unsupported ?? [];
  const notes = report?.notes ?? [];
  const status = report?.status ?? kernel?.status ?? "unknown";
  const backendId = report?.backend_id ?? kernel?.backend_id ?? "unknown";
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4 text-primary" />
          Kernel enforcement
        </CardTitle>
        <CardDescription>
          Honest reporting per SPEC §13.4 — never silently downgrade.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading && !health ? (
          <Skeleton className="h-24 w-full" />
        ) : !kernel ? (
          <p className="text-xs text-muted-foreground">No kernel enforcement report available.</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">backend</span>
              <span className="font-mono text-xs">{backendId}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">kernel status</span>
              <StatusBadge status={status} tone={status === "ok" ? "green" : status === "degraded" ? "orange" : "red"} />
            </div>
            {kernel.supported_backends && kernel.supported_backends.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider">supported backends</div>
                <div className="flex flex-wrap gap-1">
                  {kernel.supported_backends.map((b) => (
                    <Badge key={b} variant="outline" className="text-[10px] font-mono">{b}</Badge>
                  ))}
                </div>
              </div>
            )}
            {enforced.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider">enforced</div>
                <div className="flex flex-wrap gap-1">
                  {enforced.map((e) => (
                    <Badge key={e} variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px] font-mono">
                      <CheckCircle2 className="size-3" />
                      {e}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {unsupported.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider">unsupported / stub</div>
                <div className="flex flex-wrap gap-1">
                  {unsupported.map((e) => (
                    <Badge key={e} variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 text-[10px] font-mono">
                      <XCircle className="size-3" />
                      {e}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {notes.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider">notes</div>
                <ul className="list-disc ml-4 text-xs text-muted-foreground space-y-0.5">
                  {notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function QuickStatsCard({
  total,
  completed,
  failed,
  sessions,
}: {
  total: number;
  completed: number;
  failed: number;
  sessions: number;
}) {
  const stats = [
    { label: "Tasks", value: total, tone: "text-foreground" },
    { label: "Completed", value: completed, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Failed/aborted", value: failed, tone: failed > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground" },
    { label: "Sessions", value: sessions, tone: "text-foreground" },
  ];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Quick stats</CardTitle>
        <CardDescription>Live counts from the control plane.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border bg-muted/30 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.label}</div>
            <div className={cn("text-2xl font-semibold tabular-nums", s.tone)}>{s.value}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function EmptyHint({ label }: { label: string }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{label}</p>;
}
