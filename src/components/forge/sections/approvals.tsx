"use client";

import * as React from "react";
import { forgeFetch, formatRelative, formatTimestamp } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { toast } from "sonner";
import { ChevronLeft, ShieldCheck, ShieldAlert, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface ApprovalRow {
  id: string;
  task_id: string | null;
  operation_hash: string;
  status: string;
  risk: unknown;
  requested_at: string;
  resolved_at: string | null;
  rationale: string | null;
}

interface ApprovalsProps {
  className?: string;
}

const DECISIONS = [
  { key: "allow_once", label: "Allow once", tone: "green" as const },
  { key: "allow_exact", label: "Allow exact", tone: "green" as const },
  { key: "allow_task_scope", label: "Allow task scope", tone: "green" as const },
  { key: "deny_once", label: "Deny once", tone: "red" as const },
  { key: "deny_and_rule", label: "Deny + rule", tone: "red" as const },
  { key: "stop_task", label: "Stop task", tone: "red" as const },
];

export function Approvals({ className }: ApprovalsProps) {
  const [approvals, setApprovals] = React.useState<ApprovalRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ApprovalRow | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await forgeFetch<{ approvals: ApprovalRow[] }>("/v1/approvals");
      setApprovals(r.approvals ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (selected) {
    return (
      <ApprovalDetail
        approval={selected}
        onBack={() => {
          setSelected(null);
          void load();
        }}
      />
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-primary" />
          Pending approvals
        </CardTitle>
        <CardDescription>
          SPEC §13.8 / §32.4 — approvals bind to exact action hash, paths, source versions, and scope.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : err ? (
          <p className="text-destructive text-sm">{err}</p>
        ) : approvals.length === 0 ? (
          <div className="py-8 text-center space-y-2">
            <ShieldCheck className="size-8 mx-auto text-emerald-500/50" />
            <p className="text-xs text-muted-foreground">No pending approvals. The agent has not requested any privileged action.</p>
          </div>
        ) : (
          <ul className="divide-y">
            {approvals.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => setSelected(a)}
                  className="flex w-full items-center gap-3 py-2 px-2 hover:bg-accent/40 rounded-md text-left"
                >
                  <StatusBadge status={a.status} tone="yellow" />
                  <MonoId id={a.id} />
                  <MonoId id={a.task_id} className="text-[10px]" />
                  <span className="text-xs text-muted-foreground ml-auto">{formatRelative(a.requested_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalDetail({ approval, onBack }: { approval: ApprovalRow; onBack: () => void }) {
  const [resolving, setResolving] = React.useState(false);
  const risk = (approval.risk ?? {}) as Record<string, unknown>;

  const resolve = async (decision: string) => {
    setResolving(true);
    try {
      await forgeFetch(`/v1/approvals/${approval.id}/resolve`, {
        method: "POST",
        body: { decision, rationale: `resolved from UI: ${decision}` },
      });
      toast.success(`Approval ${decision}`);
      onBack();
    } catch (e) {
      toast.error(`Resolve failed: ${(e as Error).message}`);
    } finally {
      setResolving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4" />
            Back
          </Button>
          <CardTitle className="text-base">Approval detail</CardTitle>
          <StatusBadge status={approval.status} />
        </div>
        <CardDescription>
          id <MonoId id={approval.id} /> · task <MonoId id={approval.task_id} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <Field label="operation_hash" value={<MonoId id={approval.operation_hash} head={16} />} />
          <Field label="requested_at" value={formatTimestamp(approval.requested_at)} />
          <Field label="resolved_at" value={approval.resolved_at ? formatTimestamp(approval.resolved_at) : "—"} />
          <Field label="rationale" value={approval.rationale ?? "—"} />
        </div>

        <Separator />

        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Risk</div>
          <pre className="rounded-md border bg-muted/40 p-2 text-xs font-mono whitespace-pre-wrap">
            {JSON.stringify(risk, null, 2)}
          </pre>
        </div>

        {approval.status === "pending" ? (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Resolve</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {DECISIONS.map((d) => (
                <Button
                  key={d.key}
                  variant={d.tone === "green" ? "default" : "destructive"}
                  onClick={() => void resolve(d.key)}
                  disabled={resolving}
                  className={cn("text-xs h-9", d.tone === "green" && "bg-emerald-600 hover:bg-emerald-700")}
                >
                  {d.tone === "red" && <ShieldAlert className="size-3.5" />}
                  {d.tone === "green" && <Zap className="size-3.5" />}
                  {d.label}
                </Button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              SPEC §32.4: "Always allow" requires a separate policy-edit flow, not a casual approval button.
            </p>
          </div>
        ) : (
          <Alert label={`Already ${approval.status}`} />
        )}
      </CardContent>
    </Card>
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

function Alert({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-muted-foreground/30 bg-muted/30 p-2 text-xs text-muted-foreground">
      {label}
    </div>
  );
}

void Badge;
