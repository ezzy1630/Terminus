"use client";

import * as React from "react";
import { useForgeEvents, type ForgeEvent } from "@/hooks/use-forge-events";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/forge-client";
import { Activity, Pause, Play, Trash2, WifiOff, Wifi } from "lucide-react";

interface EventStreamProps {
  taskId?: string;
  sessionId?: string;
  /** Optional title override. */
  title?: string;
  /** Max height in px for the scroll area. */
  maxHeight?: number;
  /** Filter by event name substring. */
  filter?: string;
  /** Show the connection status pill. */
  showStatus?: boolean;
  className?: string;
  /**
   * Client-side filter applied to events from the global stream. Use this
   * when the URL-based task_id filter is insufficient (the control plane's
   * task_id filter is on payload text only).
   */
  clientFilter?: (ev: ForgeEvent) => boolean;
  /** Whether to subscribe to all events (cursor=.) for replay. */
  replayAll?: boolean;
}

/**
 * Live SSE event stream viewer. Subscribes to /v1/events and renders
 * events as they arrive with their event_type, aggregate id, timestamp,
 * and a compact payload summary.
 */
export function EventStream({
  taskId,
  sessionId,
  title = "Live event stream",
  maxHeight = 384,
  filter,
  showStatus = true,
  className,
  clientFilter,
  replayAll,
}: EventStreamProps) {
  const { events, connected, error, reconnect, clear } = useForgeEvents({
    taskId,
    sessionId,
    // When replayAll is set (or a clientFilter is provided), use the sentinel
    // cursor "." to ask the control plane to replay all events since start.
    cursor: replayAll || clientFilter ? "." : undefined,
  });
  const [paused, setPaused] = React.useState(false);
  const [buffer, setBuffer] = React.useState<ForgeEvent[]>([]);
  const lastSeenIdRef = React.useRef<string | null>(null);

  // Apply client filter to incoming events.
  const filteredIncoming = React.useMemo(
    () => (clientFilter ? events.filter(clientFilter) : events),
    [events, clientFilter],
  );

  // When not paused, mirror events -> buffer.
  React.useEffect(() => {
    if (paused) return;
    // Find new events since lastSeenId.
    const newOnes: ForgeEvent[] = [];
    for (const ev of filteredIncoming) {
      if (ev.id === lastSeenIdRef.current) break;
      newOnes.push(ev);
    }
    if (newOnes.length > 0) {
      lastSeenIdRef.current = newOnes[0]!.id;
      setBuffer((prev) => [...newOnes, ...prev].slice(0, 500));
    }
  }, [filteredIncoming, paused]);

  const filtered = React.useMemo(() => {
    if (!filter) return buffer;
    const f = filter.toLowerCase();
    return buffer.filter(
      (e) =>
        e.event.toLowerCase().includes(f) ||
        (typeof e.data === "object" && e.data !== null && JSON.stringify(e.data).toLowerCase().includes(f)),
    );
  }, [buffer, filter]);

  return (
    <Card className={cn("h-full", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-primary" />
            <CardTitle className="text-base">{title}</CardTitle>
            {showStatus && (
              <Badge
                variant="outline"
                className={cn(
                  "ml-2 gap-1 text-[10px]",
                  connected
                    ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/40 text-amber-700 dark:text-amber-300",
                )}
              >
                {connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
                {connected ? "connected" : error ? "reconnecting" : "disconnected"}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPaused((p) => !p)}
              title={paused ? "Resume" : "Pause"}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              <span className="text-xs">{paused ? "Resume" : "Pause"}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={clear} title="Clear">
              <Trash2 className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={reconnect} title="Reconnect">
              <Activity className="size-3.5" />
            </Button>
          </div>
        </div>
        <CardDescription className="text-xs">
          {filtered.length} event{filtered.length === 1 ? "" : "s"} · SSE from /v1/events{taskId ? ` · task ${taskId.slice(0, 8)}…` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <ScrollArea className="rounded-md border" style={{ maxHeight }}>
          <div className="divide-y">
            {filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                Waiting for events…
              </div>
            ) : (
              filtered.map((ev) => <EventRow key={ev.id} ev={ev} />)
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function EventRow({ ev }: { ev: ForgeEvent }) {
  const [expanded, setExpanded] = React.useState(false);
  const payloadStr = React.useMemo(() => {
    try {
      return typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data, null, 2);
    } catch {
      return String(ev.data);
    }
  }, [ev.data]);
  const summary = React.useMemo(() => summarize(ev), [ev]);
  return (
    <button
      type="button"
      onClick={() => setExpanded((e) => !e)}
      className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent/40 transition-colors"
    >
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider">
          {ev.event}
        </Badge>
        <span className="font-mono text-[10px] text-muted-foreground">
          {new Date(ev.receivedAt).toLocaleTimeString()}
        </span>
        <span className="text-muted-foreground text-[10px]">{formatRelative(new Date(ev.receivedAt).toISOString())}</span>
      </div>
      <div className="text-xs text-foreground/90">{summary}</div>
      {expanded && (
        <pre className="mt-1 rounded bg-muted/60 p-2 text-[10px] font-mono whitespace-pre-wrap break-all">
          {payloadStr}
        </pre>
      )}
    </button>
  );
}

function summarize(ev: ForgeEvent): string {
  const d = ev.data;
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    // Pick a friendly summary based on event type.
    switch (ev.event) {
      case "task.created":
      case "task.activated":
      case "task.verifying":
      case "task.completed":
      case "task.aborted":
        return `task ${shortIdStr(o.task_id ?? o.id)} → ${o.status ?? o.phase ?? o.state ?? ""}`.trim();
      case "turn.started":
      case "turn.context_compiling":
      case "turn.provider_running":
      case "turn.response_validating":
      case "turn.finalizing":
      case "turn.completed":
      case "turn.failed":
        return `turn ${shortIdStr(o.turn_id ?? o.id)} · ${o.state ?? o.phase ?? ""} ${o.summary ?? ""}`.trim();
      case "context.manifest_persisted":
        return `manifest ${shortIdStr(o.manifest_id ?? o.id)} · ${o.fragment_count ?? 0} fragments · ${o.provider ?? "?"}/${o.model ?? "?"}`.trim();
      case "tool.proposed":
      case "tool.authorized":
      case "tool.settled":
        return `tool ${shortIdStr(o.tool_call_id ?? o.id)} · ${o.tool ?? ""} · ${o.decision ?? o.status ?? ""}`.trim();
      case "approval.requested":
      case "approval.resolved":
        return `approval ${shortIdStr(o.approval_id ?? o.id)} · ${o.decision ?? o.status ?? ""}`.trim();
      case "verification.node_passed":
      case "verification.node_failed":
        return `node ${o.node_id ?? "?"} (${o.kind ?? ""}) · ${ev.event.split(".")[1] ?? ""}`.trim();
      case "verification.plan_completed":
        return `plan ${shortIdStr(o.plan_id ?? o.id)} · ${o.status ?? ""}`.trim();
      case "session.created":
        return `session ${shortIdStr(o.session_id ?? o.id)} · ${o.title ?? ""}`.trim();
    }
    // Fallback: show first few fields.
    const keys = Object.keys(o).slice(0, 4);
    return keys.map((k) => `${k}=${truncateStr(JSON.stringify(o[k]))}`).join("  ");
  }
  return truncateStr(typeof d === "string" ? d : JSON.stringify(d));
}

function shortIdStr(v: unknown): string {
  if (typeof v === "string") return v.length > 12 ? `${v.slice(0, 8)}…` : v;
  return "?";
}
function truncateStr(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
