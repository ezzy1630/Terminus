"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Settings, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfigurationProps {
  className?: string;
}

export function Configuration({ className }: ConfigurationProps) {
  const [config, setConfig] = React.useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await forgeFetch<Record<string, unknown>>("/v1/configuration");
      setConfig(r);
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
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings className="size-4 text-primary" />
            Effective configuration
          </CardTitle>
          <CardDescription>
            From <code className="font-mono text-xs">GET /v1/configuration</code>. Highlights below; full JSON in the tree.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : err ? (
            <p className="text-destructive text-sm">{err}</p>
          ) : config ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <Highlight label="kernel port" value={(config.kernel as { port?: number })?.port ?? "?"} />
              <Highlight label="sandbox profile" value={(config.sandbox as { profile?: string })?.profile ?? "?"} />
              <Highlight label="sandbox backend" value={(config.sandbox as { backend?: string })?.backend ?? "?"} />
              <Highlight
                label="memory enabled"
                value={
                  ((config.context as { memory?: { enabled?: boolean } })?.memory?.enabled ?? false)
                    ? "true"
                    : "false"
                }
                tone={((config.context as { memory?: { enabled?: boolean } })?.memory?.enabled ?? false) ? "green" : "red"}
              />
              <Highlight label="default orchestration" value={(config.orchestration as { default?: string })?.default ?? "?"} />
              <Highlight
                label="default tools"
                value={((config.aci as { default_tools?: string[] })?.default_tools ?? []).join(", ")}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Full configuration tree</CardTitle>
          <CardDescription>Layered, validated by zod schemas in @forge/config.</CardDescription>
        </CardHeader>
        <CardContent>
          {config ? (
            <pre className="rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-[40rem] overflow-y-auto">
              {JSON.stringify(config, null, 2)}
            </pre>
          ) : (
            <Skeleton className="h-32 w-full" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Highlight({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "green" | "red";
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 flex items-center gap-1 font-mono text-sm",
          tone === "green" && "text-emerald-600 dark:text-emerald-400",
          tone === "red" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {tone === "green" && <CheckCircle2 className="size-3" />}
        {tone === "red" && <XCircle className="size-3" />}
        <span>{value}</span>
      </div>
    </div>
  );
}

void Badge;
