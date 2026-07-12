"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Brain, ShieldAlert, Lock } from "lucide-react";

interface MemoryProps {
  className?: string;
}

interface MemoryClaim {
  id: string;
  kind: string;
  statement: string;
  confidence_ppm: number;
  status: string;
  scope: unknown;
  provenance: unknown;
  created_at: string;
  updated_at: string;
}

interface MemoryResponse {
  enabled: boolean;
  claims: MemoryClaim[];
}

export function Memory({ className }: MemoryProps) {
  const [data, setData] = React.useState<MemoryResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [enableOpen, setEnableOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await forgeFetch<MemoryResponse>("/v1/memory");
      setData(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Alert className={className}>
        <Lock className="size-4" />
        <AlertTitle>Memory is disabled by default</AlertTitle>
        <AlertDescription>
          SPEC §39 / ADR-0023: durable memory (class 4) requires a promotion gate before activation. Working memory
          (class 2) and episodic trace (class 3) remain active. Enablement is a separate policy flow —
          no casual toggle.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Brain className="size-4 text-primary" />
                Durable memory claims
              </CardTitle>
              <CardDescription>
                Active claims (status=active). Candidates never promote directly (SPEC §39.4).
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEnableOpen(true)}>
              <ShieldAlert className="size-4" />
              Enable memory
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : err ? (
            <p className="text-destructive text-sm">{err}</p>
          ) : !data?.enabled ? (
            <div className="py-8 text-center space-y-2">
              <Lock className="size-8 mx-auto text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground">
                Memory is disabled. No claims are surfaced to the model. Click <strong>Enable memory</strong> to see the promotion gate.
              </p>
            </div>
          ) : data.claims.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No active claims.</p>
          ) : (
            <ul className="divide-y">
              {data.claims.map((c) => (
                <li key={c.id} className="py-2 px-1 space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <StatusBadge status={c.kind} tone="purple" />
                    <StatusBadge status={c.status} />
                    <MonoId id={c.id} className="ml-auto" />
                  </div>
                  <p className="text-sm">{c.statement}</p>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    confidence: {(c.confidence_ppm / 1_000_000).toFixed(2)} · scope: {JSON.stringify(c.scope)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={enableOpen} onOpenChange={setEnableOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Enable durable memory?</DialogTitle>
            <DialogDescription>
              This is a stub. Real enablement requires a separate policy-edit flow per SPEC §39 and ADR-0023:
              candidate extraction → quarantine → consolidation (curator lease) → organization/user policy →
              promotion. Each step has its own review surface.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            Promotion gate:
            <ol className="list-decimal ml-4 mt-1 space-y-0.5">
              <li>Candidate extraction only from completed tasks.</li>
              <li>Conservative confidence; never promote directly.</li>
              <li>Serialized curator process with lease.</li>
              <li>Revalidation of cheap facts.</li>
              <li>Organization / user policy applied.</li>
              <li>Quarantine + invalidation rules.</li>
            </ol>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnableOpen(false)}>Cancel</Button>
            <Button disabled>Open policy editor (coming soon)</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

void Badge;
