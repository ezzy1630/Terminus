"use client";

import * as React from "react";
import { forgeFetch, formatRelative, formatTimestamp } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { NewSessionDialog } from "@/components/forge/new-session-dialog";
import { ChevronLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SessionRow {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  active_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  status: string;
  phase: string;
  risk_class: string;
  updated_at: string;
  created_at: string;
}

interface ThreadRow {
  id: string;
  sessionId: string;
  createdAt: string;
  status: string;
}

interface SessionsProps {
  workspaces: Array<{ id: string; root_uri: string }>;
  onOpenTask: (taskId: string) => void;
  onCreatedSession?: (s: { id: string; workspace_id: string; active_thread_id: string; title: string }) => void;
  className?: string;
}

export function Sessions({ workspaces, onOpenTask, onCreatedSession, className }: SessionsProps) {
  const [sessions, setSessions] = React.useState<SessionRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<SessionRow | null>(null);
  const [filter, setFilter] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await forgeFetch<{ sessions: SessionRow[] }>("/v1/sessions");
      setSessions(r.sessions ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = sessions.filter((s) =>
    filter
      ? s.title.toLowerCase().includes(filter.toLowerCase()) ||
        s.id.includes(filter) ||
        s.workspace_id.includes(filter)
      : true,
  );

  if (selected) {
    return (
      <SessionDetail
        session={selected}
        onBack={() => {
          setSelected(null);
          void load();
        }}
        onOpenTask={onOpenTask}
        className={className}
      />
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Sessions</CardTitle>
            <CardDescription>{sessions.length} session(s) · control plane state</CardDescription>
          </div>
          <NewSessionDialog
            workspaces={workspaces}
            onCreated={(s) => {
              onCreatedSession?.(s);
              void load();
            }}
          />
        </div>
        <div className="relative mt-2">
          <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by title, id, or workspace…"
            className="pl-7 text-xs h-8"
          />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : err ? (
          <p className="text-destructive text-sm">{err}</p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No sessions yet. Click <strong>New Session</strong> above to create one, or hit <strong>Try the demo</strong> on the overview.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                  <th className="py-2 pr-3">Title</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3 font-mono">workspace</th>
                  <th className="py-2 pr-3 font-mono">thread</th>
                  <th className="py-2 pr-3">Updated</th>
                  <th className="py-2 pr-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr
                    key={s.id}
                    className="border-b last:border-0 hover:bg-accent/40 cursor-pointer"
                    onClick={() => setSelected(s)}
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium truncate max-w-[24ch]">{s.title}</div>
                      <MonoId id={s.id} className="text-[10px] text-muted-foreground" />
                    </td>
                    <td className="py-2 pr-3"><StatusBadge status={s.status} /></td>
                    <td className="py-2 pr-3"><MonoId id={s.workspace_id} /></td>
                    <td className="py-2 pr-3"><MonoId id={s.active_thread_id} /></td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground" title={s.updated_at}>{formatRelative(s.updated_at)}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground" title={s.created_at}>{formatTimestamp(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SessionDetail({
  session,
  onBack,
  onOpenTask,
  className,
}: {
  session: SessionRow;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  className?: string;
}) {
  const [tasks, setTasks] = React.useState<TaskRow[]>([]);
  const [threads, setThreads] = React.useState<ThreadRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let aborted = false;
    setLoading(true);
    setErr(null);
    Promise.all([
      forgeFetch<{ tasks: TaskRow[] }>(`/v1/sessions/${session.id}/tasks`),
      forgeFetch<{ threads: ThreadRow[] }>(`/v1/sessions/${session.id}/threads`),
    ])
      .then(([t, th]) => {
        if (aborted) return;
        setTasks(t.tasks ?? []);
        setThreads(th.threads ?? []);
      })
      .catch((e) => !aborted && setErr((e as Error).message))
      .finally(() => !aborted && setLoading(false));
    return () => {
      aborted = true;
    };
  }, [session.id]);

  return (
    <div className={cn("grid gap-4", className)}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onBack}>
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <CardTitle className="text-base">{session.title}</CardTitle>
            <StatusBadge status={session.status} />
          </div>
          <CardDescription>
            session <MonoId id={session.id} /> · workspace <MonoId id={session.workspace_id} /> · active thread <MonoId id={session.active_thread_id} />
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <Field label="created" value={formatTimestamp(session.created_at)} />
          <Field label="updated" value={formatTimestamp(session.updated_at)} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Tasks in session</CardTitle>
            <CardDescription>{tasks.length} task(s)</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : err ? (
              <p className="text-destructive text-xs">{err}</p>
            ) : tasks.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No tasks in this session yet.</p>
            ) : (
              <ul className="divide-y">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => onOpenTask(t.id)}
                      className="flex w-full items-center gap-3 py-2 text-left hover:bg-accent/40 rounded-md px-2"
                    >
                      <StatusBadge status={t.status} />
                      <MonoId id={t.id} />
                      <span className="text-xs text-muted-foreground">{t.phase}</span>
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
            <CardTitle className="text-base">Threads</CardTitle>
            <CardDescription>{threads.length} thread(s)</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <ul className="divide-y">
                {threads.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2 px-2">
                    <StatusBadge status={t.status} />
                    <MonoId id={t.id} />
                    <span className="text-xs text-muted-foreground ml-auto">{formatTimestamp(t.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-sm">{value}</span>
      <Separator orientation="vertical" className="hidden" />
    </div>
  );
}
