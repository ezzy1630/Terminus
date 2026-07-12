"use client";

import * as React from "react";
import { useForgeEvents, type ForgeEvent } from "@/hooks/use-forge-events";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { RunToolPanel } from "@/components/forge/run-tool-panel";
import { formatRelative } from "@/lib/forge-client";
import { Hammer } from "lucide-react";

interface ToolCallsProps {
  defaultWorkspaceId?: string;
  className?: string;
}

interface ToolCallRow {
  id: string;
  tool?: string;
  state: string;
  decision?: string;
  rule_ids?: string[];
  status?: string;
  summary?: string;
  turn_id?: string;
  receivedAt: number;
}

export function ToolCalls({ defaultWorkspaceId, className }: ToolCallsProps) {
  const { events } = useForgeEvents({ cursor: "." });
  const rows = React.useMemo(() => aggregateToolCalls(events), [events]);

  return (
    <div className="space-y-4">
      <Card className={className}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Hammer className="size-4 text-primary" />
            Recent tool calls
          </CardTitle>
          <CardDescription>
            Reconstructed from the live event stream. Per SPEC §11, every tool call has a policy decision and result.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No tool calls observed yet. Start a task to see them stream in here.
            </p>
          ) : (
            <ScrollArea className="max-h-[28rem]">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                      <th className="py-2 pr-3 font-mono">id</th>
                      <th className="py-2 pr-3">tool</th>
                      <th className="py-2 pr-3">state</th>
                      <th className="py-2 pr-3">decision</th>
                      <th className="py-2 pr-3">result</th>
                      <th className="py-2 pr-3 font-mono">turn</th>
                      <th className="py-2 pr-3">when</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-2 pr-3"><MonoId id={r.id} /></td>
                        <td className="py-2 pr-3 font-mono text-xs">{r.tool ?? "—"}</td>
                        <td className="py-2 pr-3"><StatusBadge status={r.state} /></td>
                        <td className="py-2 pr-3">{r.decision ? <StatusBadge status={r.decision} tone={r.decision === "allow" ? "green" : "red"} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-3">{r.status ? <StatusBadge status={r.status} tone={r.status === "success" ? "green" : r.status === "failed" ? "red" : "gray"} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-3"><MonoId id={r.turn_id} /></td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">{formatRelative(new Date(r.receivedAt).toISOString())}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <RunToolPanel defaultWorkspaceId={defaultWorkspaceId} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Policy decisions</CardTitle>
          <CardDescription>
            Each authorized tool call has a decision with rule ids and an explanation. Click an id above to copy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.filter((r) => r.decision).length === 0 ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <ul className="space-y-2">
              {rows.filter((r) => r.decision).map((r) => (
                <li key={r.id} className="rounded-md border bg-muted/30 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <MonoId id={r.id} />
                    <StatusBadge status={r.decision!} tone={r.decision === "allow" ? "green" : "red"} />
                    <span className="font-mono text-[10px]">{r.tool}</span>
                  </div>
                  {r.rule_ids && r.rule_ids.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.rule_ids.map((rid) => (
                        <Badge key={rid} variant="outline" className="text-[9px] font-mono">{rid}</Badge>
                      ))}
                    </div>
                  )}
                  {r.summary && <p className="mt-1 text-muted-foreground">{r.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function aggregateToolCalls(events: ForgeEvent[]): ToolCallRow[] {
  const map = new Map<string, ToolCallRow>();
  const ordered = [...events].reverse();
  for (const ev of ordered) {
    if (!ev.event.startsWith("tool.")) continue;
    const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
    const id = (d.tool_call_id as string | undefined) ?? ev.id;
    const r = map.get(id) ?? { id, state: "UNKNOWN", receivedAt: ev.receivedAt };
    r.receivedAt = ev.receivedAt;
    if (ev.event === "tool.proposed") {
      r.tool = d.tool as string | undefined;
      r.state = "PROPOSED";
      r.turn_id = d.turn_id as string | undefined;
    } else if (ev.event === "tool.authorized") {
      r.state = "AUTHORIZED";
      r.decision = d.decision as string | undefined;
      r.rule_ids = d.rule_ids as string[] | undefined;
    } else if (ev.event === "tool.settled") {
      r.state = "SETTLED";
      r.status = d.status as string | undefined;
      r.summary = d.summary as string | undefined;
    }
    map.set(id, r);
  }
  return Array.from(map.values()).sort((a, b) => b.receivedAt - a.receivedAt);
}
