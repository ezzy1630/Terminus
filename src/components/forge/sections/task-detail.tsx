"use client";

import * as React from "react";
import { forgeFetch, formatTimestamp, formatRelative, formatCost } from "@/lib/forge-client";
import { useForgeEvents, type ForgeEvent } from "@/hooks/use-forge-events";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusBadge, toneForStatus } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { EventStream } from "@/components/forge/event-stream";
import {
  ChevronLeft,
  Cpu,
  FileText,
  GitBranch,
  Hammer,
  ListChecks,
  Network,
  ScrollText,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  onOpenManifest: (manifestId: string) => void;
  className?: string;
}

interface TaskDetail {
  id: string;
  session_id: string;
  thread_id: string;
  status: string;
  phase: string;
  active_contract_version: number;
  risk_class: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  contract: {
    version: number;
    objective: string;
    non_goals: string[];
    allowed_scope: {
      read_paths?: string[];
      write_paths?: string[];
      external_systems?: string[];
    };
  } | null;
}

/** Reconstructed from the event stream — these come from the SSE feed. */
interface ReconstructedTurn {
  id: string;
  sequence?: number;
  state: string;
  user_input?: string;
  started_at?: string;
  completed_at?: string;
  terminal_error?: string;
  manifest_id?: string;
  provider_attempt_id?: string;
  usage?: { input?: number; output?: number; cached?: number; reasoning?: number; tool_schema?: number };
  cost_micros?: number;
  tool_calls: ReconstructedToolCall[];
}

interface ReconstructedToolCall {
  id: string;
  tool?: string;
  state: string;
  decision?: string;
  rule_ids?: string[];
  result_status?: string;
  summary?: string;
  args_artifact?: string;
  result_artifact?: string;
  started_at?: string;
  settled_at?: string;
}

interface ReconstructedManifest {
  id: string;
  fragment_count?: number;
  provider?: string;
  model?: string;
  turn_id?: string;
  artifact?: string;
}

interface ReconstructedVerification {
  plan_id?: string;
  nodes: Array<{ id: string; kind?: string; status: string; passed_at?: string }>;
  plan_completed_status?: string;
}

export function TaskDetail({ taskId, onBack, onOpenManifest, className }: TaskDetailProps) {
  const [task, setTask] = React.useState<TaskDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  // Subscribe to ALL events (no task_id filter — control plane filter is on
  // payload text, which misses most events). We filter client-side using a
  // multi-pass approach: build turn_id→task_id and tool_call_id→turn_id maps,
  // then for each event derive its owning task.
  const { events, connected } = useForgeEvents({ cursor: "." });
  const taskEvents = React.useMemo(() => filterEventsForTask(events, taskId), [events, taskId]);

  // Fetch the task snapshot once.
  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const t = await forgeFetch<TaskDetail>(`/v1/tasks/${taskId}`);
      setTask(t);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Aggregate events into turns / manifests / tool_calls / verification.
  const aggregated = React.useMemo(() => aggregateEvents(taskEvents), [taskEvents]);

  // Filter callback for the live event stream panel — same predicate as
  // taskEvents but applied incrementally to incoming events.
  const eventStreamFilter = React.useCallback(
    (ev: ForgeEvent) => taskEvents.some((te) => te.id === ev.id),
    [taskEvents],
  );

  return (
    <div className={cn("grid gap-4", className)}>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onBack}>
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <CardTitle className="text-base flex items-center gap-2">
              Task <MonoId id={taskId} />
            </CardTitle>
            {task && <StatusBadge status={task.status} />}
            <Badge variant="outline" className="text-[10px] font-mono">
              {connected ? "live" : "loading"}
            </Badge>
          </div>
          <CardDescription>
            {task ? (
              <>
                phase <span className="font-mono">{task.phase}</span> · risk <span className="font-mono">{task.risk_class}</span> · session <MonoId id={task.session_id} /> · thread <MonoId id={task.thread_id} />
              </>
            ) : (
              "loading…"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : err ? (
            <p className="text-destructive text-sm">{err}</p>
          ) : task ? (
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <Field label="created" value={formatTimestamp(task.created_at)} />
              <Field label="updated" value={formatTimestamp(task.updated_at)} />
              <Field label="completed" value={task.completed_at ? formatTimestamp(task.completed_at) : "—"} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {task?.contract && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="size-4 text-primary" />
              Contract v{task.contract.version}
            </CardTitle>
            <CardDescription>Objective, non-goals, allowed scope. Mutating requires a new version.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">objective</div>
              <p className="text-sm">{task.contract.objective}</p>
            </div>
            {task.contract.non_goals.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">non-goals</div>
                <ul className="list-disc ml-4 text-sm">
                  {task.contract.non_goals.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">read paths</div>
                <div className="flex flex-wrap gap-1">
                  {(task.contract.allowed_scope.read_paths ?? []).map((p, i) => (
                    <Badge key={i} variant="outline" className="font-mono text-[10px]">{p}</Badge>
                  ))}
                  {(task.contract.allowed_scope.read_paths ?? []).length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">write paths</div>
                <div className="flex flex-wrap gap-1">
                  {(task.contract.allowed_scope.write_paths ?? []).map((p, i) => (
                    <Badge key={i} variant="outline" className="font-mono text-[10px] bg-amber-500/10">{p}</Badge>
                  ))}
                  {(task.contract.allowed_scope.write_paths ?? []).length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <GitBranch className="size-4 text-primary" />
              Turn timeline
            </CardTitle>
            <CardDescription>{aggregated.turns.length} turn(s) reconstructed from event stream</CardDescription>
          </CardHeader>
          <CardContent>
            {aggregated.turns.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No turns yet.</p>
            ) : (
              <ScrollArea className="max-h-[28rem]">
                <ol className="relative border-l ml-3 space-y-3">
                  {aggregated.turns.map((t) => (
                    <li key={t.id} className="pl-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={t.state} />
                        <MonoId id={t.id} />
                        <span className="text-xs text-muted-foreground ml-auto">
                          {t.started_at ? formatRelative(t.started_at) : ""}
                        </span>
                      </div>
                      {t.user_input && (
                        <p className="mt-1 text-xs italic text-muted-foreground">"{t.user_input}"</p>
                      )}
                      <div className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-muted-foreground">
                        {t.manifest_id && (
                          <span>
                            manifest:{" "}
                            <button
                              onClick={() => onOpenManifest(t.manifest_id!)}
                              className="font-mono hover:text-primary"
                            >
                              <MonoId id={t.manifest_id} copyable={false} />
                            </button>
                          </span>
                        )}
                        {t.provider_attempt_id && <span>provider: <MonoId id={t.provider_attempt_id} copyable={false} /></span>}
                        {t.usage && (
                          <span className="font-mono">
                            tok in/out: {t.usage.input ?? 0}/{t.usage.output ?? 0}
                          </span>
                        )}
                        {t.cost_micros != null && <span className="font-mono">cost: {formatCost(t.cost_micros)}</span>}
                      </div>
                      {t.tool_calls.length > 0 && (
                        <ul className="mt-1 space-y-1">
                          {t.tool_calls.map((tc) => (
                            <li key={tc.id} className="rounded-md border bg-muted/30 p-1.5 text-[11px]">
                              <div className="flex items-center gap-2">
                                <Hammer className="size-3 text-muted-foreground" />
                                <span className="font-mono">{tc.tool ?? "tool"}</span>
                                <StatusBadge status={tc.state} />
                                {tc.decision && <StatusBadge status={tc.decision} tone={tc.decision === "allow" ? "green" : "red"} />}
                                <MonoId id={tc.id} className="ml-auto text-[10px]" />
                              </div>
                              {tc.summary && <p className="mt-0.5 text-muted-foreground">{tc.summary}</p>}
                              {tc.rule_ids && tc.rule_ids.length > 0 && (
                                <div className="mt-0.5 flex flex-wrap gap-1">
                                  {tc.rule_ids.map((r) => (
                                    <Badge key={r} variant="outline" className="text-[9px] font-mono">{r}</Badge>
                                  ))}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Workflow className="size-4 text-primary" />
              Verification DAG
            </CardTitle>
            <CardDescription>
              {aggregated.verification.nodes.length} node(s) · plan status:{" "}
              <span className="font-mono">{aggregated.verification.plan_completed_status ?? "running"}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {aggregated.verification.nodes.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No verification nodes yet — turn COMPLETED will trigger the plan.</p>
            ) : (
              <VerificationDagView verification={aggregated.verification} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4 text-primary" />
            Context manifests
          </CardTitle>
          <CardDescription>Manifests referenced by this task. Click to inspect fragments.</CardDescription>
        </CardHeader>
        <CardContent>
          {aggregated.manifests.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No manifests persisted yet.</p>
          ) : (
            <ul className="divide-y">
              {aggregated.manifests.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => onOpenManifest(m.id)}
                    className="flex w-full items-center gap-3 py-2 px-2 hover:bg-accent/40 rounded-md text-left"
                  >
                    <FileText className="size-4 text-muted-foreground" />
                    <MonoId id={m.id} />
                    <span className="text-xs text-muted-foreground">{m.fragment_count ?? 0} fragments</span>
                    <span className="text-xs text-muted-foreground font-mono ml-auto">{m.provider}/{m.model}</span>
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
            <Network className="size-4 text-primary" />
            Provider attempts
          </CardTitle>
          <CardDescription>From RESPONSE_VALIDATING events. Cost in micros (1e-6 USD).</CardDescription>
        </CardHeader>
        <CardContent>
          {aggregated.turns.filter((t) => t.provider_attempt_id).length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No provider attempts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                    <th className="py-2 pr-3 font-mono">attempt</th>
                    <th className="py-2 pr-3">turn</th>
                    <th className="py-2 pr-3">input</th>
                    <th className="py-2 pr-3">output</th>
                    <th className="py-2 pr-3">cached</th>
                    <th className="py-2 pr-3">reasoning</th>
                    <th className="py-2 pr-3">schema</th>
                    <th className="py-2 pr-3">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {aggregated.turns.filter((t) => t.provider_attempt_id).map((t) => (
                    <tr key={t.id} className="border-b last:border-0">
                      <td className="py-2 pr-3"><MonoId id={t.provider_attempt_id} /></td>
                      <td className="py-2 pr-3"><MonoId id={t.id} /></td>
                      <td className="py-2 pr-3 font-mono text-xs">{t.usage?.input ?? 0}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{t.usage?.output ?? 0}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{t.usage?.cached ?? 0}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{t.usage?.reasoning ?? 0}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{t.usage?.tool_schema ?? 0}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{formatCost(t.cost_micros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4 text-primary" />
            Tool calls
          </CardTitle>
          <CardDescription>Reconstructed from tool.proposed / authorized / settled events.</CardDescription>
        </CardHeader>
        <CardContent>
          {aggregated.turns.every((t) => t.tool_calls.length === 0) ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No tool calls yet.</p>
          ) : (
            <ul className="divide-y">
              {aggregated.turns.flatMap((t) =>
                t.tool_calls.map((tc) => (
                  <li key={tc.id} className="py-2 px-1 grid gap-1">
                    <div className="flex items-center gap-2 text-xs">
                      <Hammer className="size-3 text-muted-foreground" />
                      <span className="font-mono">{tc.tool ?? "tool"}</span>
                      <StatusBadge status={tc.state} />
                      {tc.decision && <StatusBadge status={tc.decision} tone={tc.decision === "allow" ? "green" : "red"} />}
                      <MonoId id={tc.id} className="ml-auto" />
                    </div>
                    {tc.summary && <p className="text-xs text-muted-foreground">{tc.summary}</p>}
                    {tc.rule_ids && tc.rule_ids.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {tc.rule_ids.map((r) => (
                          <Badge key={r} variant="outline" className="text-[9px] font-mono">{r}</Badge>
                        ))}
                      </div>
                    )}
                    {tc.args_artifact && (
                      <p className="text-[10px] text-muted-foreground font-mono">args: {tc.args_artifact}</p>
                    )}
                    {tc.result_artifact && (
                      <p className="text-[10px] text-muted-foreground font-mono">result: {tc.result_artifact}</p>
                    )}
                  </li>
                )),
              )}
            </ul>
          )}
        </CardContent>
      </Card>

      <EventStream
        title="Live event stream (this task)"
        maxHeight={400}
        clientFilter={eventStreamFilter}
      />
    </div>
  );
}

function VerificationDagView({ verification }: { verification: ReconstructedVerification }) {
  const nodes = verification.nodes;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-stretch gap-2">
        {nodes.map((n, i) => (
          <div key={n.id} className="flex items-center gap-2">
            <div
              className={cn(
                "rounded-md border px-3 py-2 min-w-[7rem] text-xs",
                n.status === "pass" && "border-emerald-500/40 bg-emerald-500/10",
                n.status === "fail" && "border-rose-500/40 bg-rose-500/10",
                n.status === "running" && "border-amber-500/40 bg-amber-500/10",
                n.status === "skipped" && "border-muted-foreground/30 bg-muted/30",
              )}
            >
              <div className="font-mono">{n.id}</div>
              <div className="text-[10px] text-muted-foreground">{n.kind ?? "command"}</div>
              <div className="mt-1">
                <StatusBadge status={n.status} />
              </div>
            </div>
            {i < nodes.length - 1 && <span className="text-muted-foreground">→</span>}
          </div>
        ))}
      </div>
      <div className="rounded-md border bg-muted/30 p-2 text-xs font-mono">
        completion: {nodes.map((n) => n.id).join(" && ")}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

// ────────────────────────── Event aggregation ──────────────────────────────

/**
 * Filter the global event stream down to events that belong to a given task.
 *
 * The control plane's SSE endpoint does NOT include correlationId in the
 * payload (only `id`, `event`, and the original `data` payload). Many events
 * also don't include task_id in their payload. So we use a multi-pass
 * approach:
 *   1. Build a turn_id → task_id map from turn.started events (whose payload
 *      DOES include task_id).
 *   2. Build a tool_call_id → turn_id map from tool.proposed events (whose
 *      payload includes turn_id).
 *   3. Build a manifest_id → turn_id map from context.manifest_persisted
 *      events (payload includes turn_id).
 *   4. Track the most recently seen "verifying" task at each event index —
 *      verification.* events are attributed to it (heuristic, good enough
 *      for the single-task demo).
 */
function filterEventsForTask(events: ForgeEvent[], taskId: string): ForgeEvent[] {
  // events arrive newest-first from the hook; iterate oldest-first for the
  // map-building pass.
  const ordered = [...events].reverse();
  const turnToTask = new Map<string, string>();
  const toolToTurn = new Map<string, string>();
  const manifestToTurn = new Map<string, string>();
  const planToTask = new Map<string, string>();

  // Current task "in flight" — i.e. the most recent task that emitted a
  // task.activated event and hasn't yet emitted task.completed / task.aborted.
  // We use this to attribute verification.* events (which lack a task ref).
  let activeTask: string | null = null;
  // We also build a per-event "owning task" lookup.
  const ownerAt = new Array<string | null>(ordered.length).fill(null);

  for (let i = 0; i < ordered.length; i++) {
    const ev = ordered[i]!;
    const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
    let owner: string | null = null;
    switch (ev.event) {
      case "session.created":
        owner = null;
        break;
      case "task.created":
      case "task.activated":
      case "task.verifying":
      case "task.completed":
      case "task.aborted":
        // aggregateId === taskId for task.* events.
        owner = ev.id;
        if (ev.event === "task.activated") activeTask = ev.id;
        if (ev.event === "task.completed" || ev.event === "task.aborted") {
          if (activeTask === ev.id) activeTask = null;
        }
        break;
      case "turn.started": {
        const tid = d.task_id as string | undefined;
        const turnId = (d.turn_id as string | undefined) ?? ev.id;
        if (tid) {
          turnToTask.set(turnId, tid);
          owner = tid;
        } else {
          owner = turnToTask.get(turnId) ?? null;
        }
        break;
      }
      case "turn.context_compiling":
      case "turn.provider_running":
      case "turn.response_validating":
      case "turn.finalizing":
      case "turn.completed":
      case "turn.failed":
        owner = turnToTask.get(ev.id) ?? null;
        break;
      case "context.manifest_persisted": {
        const turnId = d.turn_id as string | undefined;
        const manifestId = (d.manifest_id as string | undefined) ?? ev.id;
        if (turnId) {
          manifestToTurn.set(manifestId, turnId);
          owner = turnToTask.get(turnId) ?? null;
        } else {
          owner = manifestToTurn.get(manifestId)
            ? turnToTask.get(manifestToTurn.get(manifestId)!) ?? null
            : null;
        }
        break;
      }
      case "tool.proposed": {
        const turnId = d.turn_id as string | undefined;
        const toolId = (d.tool_call_id as string | undefined) ?? ev.id;
        if (turnId) toolToTurn.set(toolId, turnId);
        owner = turnId ? (turnToTask.get(turnId) ?? null) : (toolToTurn.get(toolId) ? turnToTask.get(toolToTurn.get(toolId)!) ?? null : null);
        break;
      }
      case "tool.authorized":
      case "tool.settled":
        owner = toolToTurn.get(ev.id) ? turnToTask.get(toolToTurn.get(ev.id)!) ?? null : null;
        break;
      case "verification.node_passed":
      case "verification.node_failed": {
        // No payload task reference; attribute to the currently verifying
        // task or the most recently active task.
        owner = activeTask;
        break;
      }
      case "verification.plan_completed": {
        const planId = (d.plan_id as string | undefined) ?? ev.id;
        if (activeTask) planToTask.set(planId, activeTask);
        owner = planToTask.get(planId) ?? activeTask;
        break;
      }
      default:
        owner = null;
        break;
    }
    ownerAt[i] = owner;
  }

  // Now collect events whose owner matches taskId.
  const out: ForgeEvent[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (ownerAt[i] === taskId) out.push(ordered[i]!);
  }
  // Reverse back to newest-first for display.
  return out.reverse();
}

function aggregateEvents(events: ForgeEvent[]): {
  turns: ReconstructedTurn[];
  manifests: ReconstructedManifest[];
  verification: ReconstructedVerification;
} {
  const turns = new Map<string, ReconstructedTurn>();
  const manifests = new Map<string, ReconstructedManifest>();
  const verification: ReconstructedVerification = { nodes: [] };
  const toolCalls = new Map<string, ReconstructedToolCall>();

  // Walk events oldest-first (events are newest-first from the hook).
  const ordered = [...events].reverse();
  for (const ev of ordered) {
    const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<string, unknown>;
    switch (ev.event) {
      case "turn.started": {
        const id = (d.turn_id as string) ?? ev.id;
        if (!turns.has(id)) {
          turns.set(id, {
            id,
            state: "PENDING",
            sequence: d.sequence as number | undefined,
            user_input: d.user_input as string | undefined,
            started_at: new Date(ev.receivedAt).toISOString(),
            tool_calls: [],
          });
        }
        break;
      }
      case "turn.context_compiling": {
        const id = (d.turn_id as string) ?? ev.id;
        const t = turns.get(id) ?? { id, state: "CONTEXT_COMPILING", tool_calls: [] };
        t.state = "CONTEXT_COMPILING";
        turns.set(id, t);
        break;
      }
      case "context.manifest_persisted": {
        const id = (d.manifest_id as string) ?? ev.id;
        const m: ReconstructedManifest = {
          id,
          fragment_count: d.fragment_count as number | undefined,
          provider: d.provider as string | undefined,
          model: d.model as string | undefined,
          turn_id: d.turn_id as string | undefined,
        };
        manifests.set(id, m);
        if (m.turn_id) {
          const t = turns.get(m.turn_id);
          if (t) {
            t.manifest_id = id;
            turns.set(m.turn_id, t);
          }
        }
        break;
      }
      case "turn.provider_running": {
        const id = (d.turn_id as string) ?? ev.id;
        const t = turns.get(id) ?? { id, state: "PROVIDER_RUNNING", tool_calls: [] };
        t.state = "PROVIDER_RUNNING";
        t.provider_attempt_id = d.provider_attempt_id as string | undefined;
        turns.set(id, t);
        break;
      }
      case "turn.response_validating": {
        const id = (d.turn_id as string) ?? ev.id;
        const t = turns.get(id) ?? { id, state: "RESPONSE_VALIDATING", tool_calls: [] };
        t.state = "RESPONSE_VALIDATING";
        const usage = d.usage as { input?: number; output?: number; cached?: number; reasoning?: number; tool_schema?: number } | undefined;
        if (usage) t.usage = usage;
        turns.set(id, t);
        break;
      }
      case "tool.proposed": {
        const id = (d.tool_call_id as string) ?? ev.id;
        const tc: ReconstructedToolCall = {
          id,
          tool: d.tool as string | undefined,
          state: "PROPOSED",
          args_artifact: (d.args_summary as string | undefined) ?? (Array.isArray(d.artifactRefs) ? (d.artifactRefs as string[])[0] : undefined),
        };
        toolCalls.set(id, tc);
        const turnId = d.turn_id as string | undefined;
        if (turnId) {
          const t = turns.get(turnId) ?? { id: turnId, state: "TOOL_SETTLEMENT", tool_calls: [] };
          if (!t.tool_calls.find((x) => x.id === id)) t.tool_calls.push(tc);
          turns.set(turnId, t);
        }
        break;
      }
      case "tool.authorized": {
        const id = (d.tool_call_id as string) ?? ev.id;
        const tc = toolCalls.get(id);
        if (tc) {
          tc.state = "AUTHORIZED";
          tc.decision = d.decision as string | undefined;
          tc.rule_ids = d.rule_ids as string[] | undefined;
          toolCalls.set(id, tc);
        }
        break;
      }
      case "tool.settled": {
        const id = (d.tool_call_id as string) ?? ev.id;
        const tc = toolCalls.get(id);
        if (tc) {
          tc.state = "SETTLED";
          tc.result_status = d.status as string | undefined;
          tc.summary = d.summary as string | undefined;
          tc.settled_at = new Date(ev.receivedAt).toISOString();
          toolCalls.set(id, tc);
        }
        break;
      }
      case "turn.finalizing": {
        const id = (d.turn_id as string) ?? ev.id;
        const t = turns.get(id) ?? { id, state: "FINALIZING", tool_calls: [] };
        t.state = "FINALIZING";
        turns.set(id, t);
        break;
      }
      case "turn.completed": {
        const id = (d.turn_id as string) ?? ev.id;
        const t = turns.get(id) ?? { id, state: "COMPLETED", tool_calls: [] };
        t.state = "COMPLETED";
        t.completed_at = new Date(ev.receivedAt).toISOString();
        if (d.summary) t.user_input = t.user_input ?? (d.summary as string);
        turns.set(id, t);
        break;
      }
      case "turn.failed": {
        const id = (d.turn_id as string) ?? ev.id;
        const t = turns.get(id) ?? { id, state: "FAILED", tool_calls: [] };
        t.state = "FAILED";
        t.terminal_error = d.error as string | undefined;
        t.completed_at = new Date(ev.receivedAt).toISOString();
        turns.set(id, t);
        break;
      }
      case "verification.node_passed":
      case "verification.node_failed": {
        const nodeId = d.node_id as string | undefined;
        if (!nodeId) break;
        const existing = verification.nodes.find((n) => n.id === nodeId);
        if (existing) {
          existing.status = ev.event === "verification.node_passed" ? "pass" : "fail";
          existing.passed_at = new Date(ev.receivedAt).toISOString();
        } else {
          verification.nodes.push({
            id: nodeId,
            kind: d.kind as string | undefined,
            status: ev.event === "verification.node_passed" ? "pass" : "fail",
            passed_at: new Date(ev.receivedAt).toISOString(),
          });
        }
        break;
      }
      case "verification.plan_completed": {
        verification.plan_id = (d.plan_id as string | undefined) ?? ev.id;
        verification.plan_completed_status = d.status as string | undefined;
        break;
      }
      default:
        break;
    }
  }

  return {
    turns: Array.from(turns.values()).sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0)),
    manifests: Array.from(manifests.values()),
    verification,
  };
}

// Tag the SectionHeading icon list to avoid unused warnings.
void ListChecks;
void ShieldCheck;
