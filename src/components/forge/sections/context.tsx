"use client";

import * as React from "react";
import { forgeFetch, formatTimestamp } from "@/lib/forge-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/forge/status-badge";
import { MonoId } from "@/components/forge/mono-id";
import { ChevronLeft, Search, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContextProps {
  /** Initial manifest id to load (e.g. opened from task detail). */
  manifestId: string | null;
  onClear: () => void;
  className?: string;
}

interface Fragment {
  id: string;
  kind: string;
  source_uri: string;
  source_version: string | null;
  authority: number;
  priority: number;
  trust: string;
  confidentiality: string;
  injection_risk: string;
  exactness: string;
  selected: boolean;
  rendered_position: number;
  estimated_tokens: number;
  selection_reason: string | null;
  omission_reason: string | null;
}

interface Manifest {
  id: string;
  provider_attempt_id: string | null;
  compiler_version: string;
  policy_version: string;
  epoch_id: string | null;
  provider_key: string;
  model_key: string;
  rendered_request_hash: string;
  estimated_tokens: {
    input?: number;
    output?: number;
    cached?: number;
    reasoning?: number;
    tool_schema?: number;
  };
  cache_plan: {
    stable_prefix_hash?: string;
    volatile_suffix_hash?: string;
  };
  experiment: unknown;
  created_at: string;
  fragments: Fragment[];
}

export function Context({ manifestId, onClear, className }: ContextProps) {
  const [search, setSearch] = React.useState(manifestId ?? "");
  const [loadingId, setLoadingId] = React.useState<string | null>(manifestId);
  const [manifest, setManifest] = React.useState<Manifest | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async (id: string) => {
    setLoadingId(id);
    setErr(null);
    setManifest(null);
    try {
      const m = await forgeFetch<Manifest>(`/v1/context/manifests/${id}`);
      setManifest(m);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingId(null);
    }
  }, []);

  React.useEffect(() => {
    if (manifestId) {
      setSearch(manifestId);
      void load(manifestId);
    }
  }, [manifestId, load]);

  return (
    <div className={cn("grid gap-4", className)}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4 text-primary" />
            Context manifest
          </CardTitle>
          <CardDescription>
            SPEC §8: every provider attempt has an immutable manifest. Inspect fragments, token estimates, cache plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="ctx-search">Manifest id</Label>
          <div className="flex gap-2">
            <Input
              id="ctx-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="paste a manifest id (UUID)"
              className="font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter" && search.trim()) void load(search.trim());
              }}
            />
            <Button onClick={() => search.trim() && void load(search.trim())}>Load</Button>
            {manifestId && (
              <Button variant="ghost" onClick={onClear}>
                Clear
              </Button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Tip: open a task and click a manifest link in the timeline to load it here.
          </p>
        </CardContent>
      </Card>

      {loadingId && !manifest && !err && <Skeleton className="h-32 w-full" />}
      {err && (
        <Card>
          <CardContent className="py-4">
            <p className="text-destructive text-sm">Failed to load manifest: {err}</p>
          </CardContent>
        </Card>
      )}
      {manifest && <ManifestView manifest={manifest} />}
    </div>
  );
}

function ManifestView({ manifest }: { manifest: Manifest }) {
  const tokens = manifest.estimated_tokens ?? {};
  const totalTokens = Object.values(tokens).reduce<number>((a, b) => a + (typeof b === "number" ? b : 0), 0);
  const selected = manifest.fragments.filter((f) => f.selected);
  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Manifest</CardTitle>
            <MonoId id={manifest.id} />
          </div>
          <CardDescription>
            created {formatTimestamp(manifest.created_at)} · {manifest.fragments.length} fragments ({selected.length} selected)
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <Field label="provider" value={`${manifest.provider_key} / ${manifest.model_key}`} mono />
          <Field label="provider_attempt" value={manifest.provider_attempt_id ?? "—"} mono />
          <Field label="compiler_version" value={manifest.compiler_version} mono />
          <Field label="policy_version" value={manifest.policy_version} mono />
          <Field label="epoch_id" value={manifest.epoch_id ?? "—"} mono />
          <Field label="rendered_request_hash" value={manifest.rendered_request_hash} mono />
          <Field label="cache stable_prefix" value={manifest.cache_plan?.stable_prefix_hash ?? "—"} mono />
          <Field label="cache volatile_suffix" value={manifest.cache_plan?.volatile_suffix_hash ?? "—"} mono />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Estimated tokens</CardTitle>
          <CardDescription>{totalTokens} total tokens across the rendered request.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-5">
            {(["input", "output", "cached", "reasoning", "tool_schema"] as const).map((k) => {
              const v = tokens[k] ?? 0;
              const pct = totalTokens > 0 ? (v / totalTokens) * 100 : 0;
              return (
                <div key={k} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground font-mono">{k}</span>
                    <span className="font-mono">{v}</span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Fragments</CardTitle>
          <CardDescription>
            Each fragment is content-addressed and tagged with trust/confidentiality/exactness labels (SPEC §8.3).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">kind</th>
                  <th className="py-2 pr-2">source</th>
                  <th className="py-2 pr-2">authority</th>
                  <th className="py-2 pr-2">trust</th>
                  <th className="py-2 pr-2">conf</th>
                  <th className="py-2 pr-2">inject</th>
                  <th className="py-2 pr-2">exact</th>
                  <th className="py-2 pr-2">tok</th>
                  <th className="py-2 pr-2">sel</th>
                </tr>
              </thead>
              <tbody>
                {manifest.fragments
                  .sort((a, b) => a.rendered_position - b.rendered_position)
                  .map((f) => (
                    <tr key={f.id} className={cn("border-b last:border-0", !f.selected && "opacity-50")}>
                      <td className="py-2 pr-2 font-mono">{f.rendered_position}</td>
                      <td className="py-2 pr-2"><StatusBadge status={f.kind} tone="purple" /></td>
                      <td className="py-2 pr-2 font-mono text-[10px] truncate max-w-[16ch]" title={f.source_uri}>{f.source_uri}</td>
                      <td className="py-2 pr-2 w-24">
                        <div className="flex items-center gap-1">
                          <Progress value={f.authority} className="h-1.5" />
                          <span className="text-[9px] font-mono w-6">{f.authority}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-2"><StatusBadge status={f.trust} tone={f.trust === "trusted" ? "green" : f.trust === "untrusted" ? "red" : "yellow"} /></td>
                      <td className="py-2 pr-2"><StatusBadge status={f.confidentiality} tone={f.confidentiality === "public" ? "green" : "yellow"} /></td>
                      <td className="py-2 pr-2"><StatusBadge status={f.injection_risk} tone={f.injection_risk === "none" ? "green" : f.injection_risk === "high" ? "red" : "yellow"} /></td>
                      <td className="py-2 pr-2"><StatusBadge status={f.exactness} tone={f.exactness === "exact" ? "green" : "yellow"} /></td>
                      <td className="py-2 pr-2 font-mono">{f.estimated_tokens}</td>
                      <td className="py-2 pr-2">{f.selected ? "✓" : "✗"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <Separator className="my-3" />
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">What did the model see? (SPEC §25 explainer)</div>
            {manifest.fragments.map((f) => (
              <div key={f.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <StatusBadge status={f.kind} tone="purple" />
                  <span className="font-mono text-[10px] truncate max-w-[20ch]">{f.source_uri}</span>
                  {f.selected ? <Badge variant="outline" className="text-[9px] bg-emerald-500/10">included</Badge> : <Badge variant="outline" className="text-[9px]">omitted</Badge>}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {f.selected ? (f.selection_reason ?? "Selected for rendering.") : (f.omission_reason ?? "Omitted by selection policy.")}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn("text-sm", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

void Search;
void ChevronLeft;
