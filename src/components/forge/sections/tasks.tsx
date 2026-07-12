"use client";

import * as React from "react";
import { formatRelative, formatTimestamp } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { NewTaskDialog } from "@/components/forge/new-task-dialog";
import { Search } from "lucide-react";

export interface TaskRow {
  id: string;
  session_id: string;
  thread_id: string;
  status: string;
  phase: string;
  risk_class: string;
  updated_at: string;
  created_at: string;
  completed_at: string | null;
}

interface TasksProps {
  tasks: TaskRow[];
  sessions: Array<{ id: string; title: string; workspace_id: string; active_thread_id: string | null }>;
  loading: boolean;
  onOpenTask: (taskId: string) => void;
  onCreatedTask?: (t: { id: string; session_id: string; thread_id: string }) => void;
  className?: string;
}

type FilterKey = "all" | "active" | "completed" | "failed";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

export function Tasks({ tasks, sessions, loading, onOpenTask, onCreatedTask, className }: TasksProps) {
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [search, setSearch] = React.useState("");

  const filtered = tasks.filter((t) => {
    if (filter === "active" && !(t.status === "ACTIVE" || t.status === "DRAFT" || t.status === "VERIFYING")) return false;
    if (filter === "completed" && t.status !== "COMPLETED") return false;
    if (filter === "failed" && !(t.status === "FAILED" || t.status === "ABORTED")) return false;
    if (search && !t.id.includes(search) && !t.phase.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Tasks</CardTitle>
            <CardDescription>{tasks.length} task(s) across all sessions</CardDescription>
          </div>
          <NewTaskDialog
            sessions={sessions}
            onCreated={(t) => {
              onCreatedTask?.(t);
              onOpenTask(t.id);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <div className="flex rounded-md border bg-muted/30 p-0.5">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={filter === f.key ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[12rem]">
            <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by id or phase…"
              className="pl-7 text-xs h-8"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No tasks match. Click <strong>New Task</strong> above to create one, or hit <strong>Try the demo</strong>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-mono">id</th>
                  <th className="py-2 pr-3">status</th>
                  <th className="py-2 pr-3">phase</th>
                  <th className="py-2 pr-3">risk</th>
                  <th className="py-2 pr-3 font-mono">session</th>
                  <th className="py-2 pr-3">updated</th>
                  <th className="py-2 pr-3">created</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b last:border-0 hover:bg-accent/40 cursor-pointer"
                    onClick={() => onOpenTask(t.id)}
                  >
                    <td className="py-2 pr-3"><MonoId id={t.id} /></td>
                    <td className="py-2 pr-3"><StatusBadge status={t.status} /></td>
                    <td className="py-2 pr-3 text-xs">{t.phase}</td>
                    <td className="py-2 pr-3"><StatusBadge status={t.risk_class} tone={t.risk_class === "critical" ? "red" : t.risk_class === "high" ? "orange" : "gray"} /></td>
                    <td className="py-2 pr-3"><MonoId id={t.session_id} /></td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground" title={t.updated_at}>{formatRelative(t.updated_at)}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground" title={t.created_at}>{formatTimestamp(t.created_at)}</td>
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
