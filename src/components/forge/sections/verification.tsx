"use client";

import * as React from "react";
import { useForgeEvents, type ForgeEvent } from "@/hooks/use-forge-events";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { Cpu, Workflow } from "lucide-react";
import { formatRelative } from "@/lib/forge-client";
import { cn } from "@/lib/utils";

interface VerificationProps {
  className?: string;
}

interface PlanRow {
  plan_id?: string;
  task_id?: string;
  nodes: Array<{ id: string; kind?: string; status: string; passed_at?: number }>;
  plan_status?: string;
  receivedAt: number;
}

export function Verification({ className }: VerificationProps) {
  const { events } = useForgeEvents({ cursor: "." });
  const [filter, setFilter] = React.useState("");
  const plans = React.useMemo(() => aggregatePlans(events), [events]);
  const filtered = plans.filter((p) => (filter ? p.plan_id?.includes(filter) || p.task_id?.includes(filter) : true));

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Cpu className="size-4 text-primary" />
          Verification plans
        </CardTitle>
        <CardDescription>
          SPEC §17 — verification is a DAG of predicates (parse / diagnostics / narrow_tests, etc.). Plans are reconstructed from the live event stream.
        </CardDescription>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by plan or task id…"
          className="text-xs h-8 mt-2"
        />
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No verification plans yet. Complete a task to see its DAG.</p>
        ) : (
          <ScrollArea className="max-h-[40rem]">
            <ul className="space-y-3">
              {filtered.map((p, i) => (
                <li key={p.plan_id ?? i} className="rounded-md border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Workflow className="size-3 text-muted-foreground" />
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">plan</span>
                    <MonoId id={p.plan_id} />
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground ml-2">task</span>
                    <MonoId id={p.task_id} />
                    <StatusBadge status={p.plan_status ?? "running"} tone={p.plan_status === "all_passed" ? "green" : "yellow"} />
                    <span className="ml-auto text-[10px] text-muted-foreground">{formatRelative(new Date(p.receivedAt).toISOString())}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-stretch gap-2">
                    {p.nodes.map((n, j) => (
                      <div key={n.id} className="flex items-center gap-2">
                        <div
                          className={cn(
                            "rounded-md border px-2.5 py-1.5 min-w-[6rem] text-xs",
                            n.status === "pass" && "border-emerald-500/40 bg-emerald-500/10",
                            n.status === "fail" && "border-rose-500/40 bg-rose-500/10",
                            n.status === "running" && "border-amber-500/40 bg-amber-500/10",
                            n.status === "skipped" && "border-muted-foreground/30 bg-muted/30",
                          )}
                        >
                          <div className="font-mono">{n.id}</div>
                          <div className="text-[10px] text-muted-foreground">{n.kind ?? "command"}</div>
                          <div className="mt-0.5">
                            <StatusBadge status={n.status} />
                          </div>
                        </div>
                        {j < p.nodes.length - 1 && <span className="text-muted-foreground">→</span>}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 rounded border bg-muted/30 p-1.5 text-[10px] font-mono">
                    completion: {p.nodes.length > 0 ? p.nodes.map((n) => n.id).join(" && ") : "(no nodes)"}
                  </div>
                  {p.plan_status && (
                    <Badge variant="outline" className="mt-2 text-[9px]">
                      {p.plan_status}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function aggregatePlans(events: ForgeEvent[]): PlanRow[] {
  const byTask = new Map<string, PlanRow>();
  const ordered = [...events].reverse();
  for (const ev of ordered) {
    if (!ev.event.startsWith("verification.")) continue;
    const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
    const taskId = (d.task_id as string | undefined) ?? "(unknown task)";
    const planId = (d.plan_id as string | undefined) ?? ev.id;
    const p = byTask.get(taskId) ?? { plan_id: planId, task_id: taskId, nodes: [], receivedAt: ev.receivedAt };
    p.receivedAt = ev.receivedAt;
    if (ev.event === "verification.node_passed" || ev.event === "verification.node_failed") {
      const nodeId = d.node_id as string | undefined;
      if (!nodeId) continue;
      const existing = p.nodes.find((n) => n.id === nodeId);
      if (existing) {
        existing.status = ev.event === "verification.node_passed" ? "pass" : "fail";
        existing.passed_at = ev.receivedAt;
      } else {
        p.nodes.push({
          id: nodeId,
          kind: d.kind as string | undefined,
          status: ev.event === "verification.node_passed" ? "pass" : "fail",
          passed_at: ev.receivedAt,
        });
      }
    } else if (ev.event === "verification.plan_completed") {
      p.plan_status = d.status as string | undefined;
      p.plan_id = planId;
    }
    byTask.set(taskId, p);
  }
  return Array.from(byTask.values()).sort((a, b) => b.receivedAt - a.receivedAt);
}
