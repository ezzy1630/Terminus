"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FlaskConical, PlayCircle } from "lucide-react";

interface EvalsProps {
  className?: string;
}

interface Suite {
  id: string;
  name: string;
  task_count: number;
  description: string;
}
interface Baseline {
  id: string;
  name: string;
  description: string;
}
interface EvalsResponse {
  suites: Suite[];
  baselines: Baseline[];
  last_run: unknown;
}

export function Evals({ className }: EvalsProps) {
  const [data, setData] = React.useState<EvalsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [smokeOpen, setSmokeOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await forgeFetch<EvalsResponse>("/v1/evals");
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
      <Card className={className}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="size-4 text-primary" />
                Eval lab
              </CardTitle>
              <CardDescription>
                SPEC §26.6 — eval suites & baselines. The runner lives in the Python eval lab.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setSmokeOpen(true)}>
              <PlayCircle className="size-4" />
              Run smoke eval
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : err ? (
            <p className="text-destructive text-sm">{err}</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Suites</div>
                <ul className="divide-y rounded-md border">
                  {data?.suites.map((s) => (
                    <li key={s.id} className="p-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{s.id}</span>
                        <Badge variant="outline" className="text-[10px] font-mono">{s.task_count} tasks</Badge>
                      </div>
                      <div className="text-sm font-medium mt-0.5">{s.name}</div>
                      <div className="text-xs text-muted-foreground">{s.description}</div>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Baselines</div>
                <ul className="divide-y rounded-md border">
                  {data?.baselines.map((b) => (
                    <li key={b.id} className="p-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{b.id}</span>
                      </div>
                      <div className="text-sm font-medium mt-0.5">{b.name}</div>
                      <div className="text-xs text-muted-foreground">{b.description}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="mt-3 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
            Last run: {data?.last_run ? JSON.stringify(data.last_run) : "none"}
          </div>
        </CardContent>
      </Card>

      <Dialog open={smokeOpen} onOpenChange={setSmokeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run smoke eval</DialogTitle>
            <DialogDescription>
              The eval runner is in the Python eval lab (<code className="font-mono text-xs">python/forge_evals/</code>).
              This UI will display results when available. For now, run it from the CLI:
              <pre className="mt-2 rounded bg-muted/40 p-2 text-xs font-mono">cd python/forge_evals &amp;&amp; python -m forge_evals.run --suite tiny-bugfix --baseline forge-minimal</pre>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setSmokeOpen(false)}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
