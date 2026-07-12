"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hammer, Cpu, Database, FlaskConical, Layers, Network } from "lucide-react";
import { cn } from "@/lib/utils";

interface ArchitectureProps {
  className?: string;
}

export function Architecture({ className }: ArchitectureProps) {
  return (
    <div className={cn("space-y-4", className)}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-primary" />
            Forge architecture
          </CardTitle>
          <CardDescription>
            Three process boundaries (Next.js UI · TS control plane · Rust kernel) plus the Python eval plane
            and shared data layer. The non-bypassability invariant (SPEC §5.2) holds across all of them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            <LayerBox
              tone="blue"
              icon={Hammer}
              title="Next.js UI · port 3000"
              subtitle="Forge Control Plane Dashboard"
              body="The user-visible dashboard. Reads from the control plane via the Caddy gateway using ?XTransformPort=. Pure presentation — no ambient effect authority."
            />
            <Connector label="HTTP / SSE via Caddy gateway (?XTransformPort=)" />
            <LayerBox
              tone="purple"
              icon={Cpu}
              title="TS Control Plane · port 3050"
              subtitle="Sessions · Tasks · Context Compiler · Providers · Orchestration · Verification"
              body="Owns cognition and product state. No ambient effect authority — every privileged operation crosses the kernel boundary."
            />
            <Connector label="privileged effects RPC (capability-token auth)" />
            <LayerBox
              tone="orange"
              icon={Cpu}
              title="Rust Effect Kernel · port 3040"
              subtitle="Sandbox · Process · Patch · Secrets · Network · Git · Artifacts · Code-Intel"
              body="The non-bypassable effect boundary. All file/process/socket/secret operations go through here. Strictest-wins policy evaluation. Capability tokens bound to operation class."
            />
            <Connector label="evidence + offline analysis" />
            <LayerBox
              tone="green"
              icon={FlaskConical}
              title="Evidence & Eval Plane (Python)"
              subtitle="python/forge_evals/"
              body="Offline evaluation laboratory. Columnar data, statistical analysis. Not on the enforcement path."
            />
            <Connector label="storage" />
            <LayerBox
              tone="gray"
              icon={Database}
              title="Data: SQLite/WAL · CAS · Git · FTS5"
              subtitle="prisma/schema.prisma"
              body="SQLite for operational state, content-addressed artifact store (sha256/ab/cd), Git/worktrees for source, FTS5 for code search."
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <LayerCard
          icon={Hammer}
          title="Next.js UI"
          responsibilities={[
            "Single-route dashboard at /",
            "Renders events, manifests, tool calls, approvals",
            "Theme toggle (dark mode via next-themes)",
            "All API calls go through gateway with ?XTransformPort=3050",
            "No direct filesystem / process / network access",
          ]}
          invariants={[
            "Never reads/writes files directly",
            "Never spawns processes",
            "Never holds secrets",
          ]}
        />
        <LayerCard
          icon={Cpu}
          title="TS Control Plane"
          responsibilities={[
            "Session / thread / task lifecycle",
            "Context compiler — assembles manifests",
            "Provider adapters (OpenAI, Anthropic, Google, local)",
            "Orchestration (single-agent default, scouts/writers/reviewer)",
            "Verification DAG engine",
            "Memory candidate extraction & consolidation",
            "Public API + SSE event bus",
          ]}
          invariants={[
            "No ambient effect authority (SPEC §5.2)",
            "Direct Node/Bun subprocess APIs disallowed in production",
            "All workspace writes go through patch transactions",
            "All outbound sockets use the egress proxy",
          ]}
        />
        <LayerCard
          icon={Cpu}
          title="Rust Effect Kernel"
          responsibilities={[
            "Sandbox (Linux bwrap, macOS seatbelt, container)",
            "Process manager (env_clear, process groups, timeout)",
            "Patch engine (transactions, snapshots, rollback)",
            "Secret broker (short-lived handles, redaction)",
            "Egress proxy (allowlist, private-IP denial)",
            "Artifact CAS (sha256, GC, atomic rename)",
            "Git ops, code-intel (tree-sitter), extension host (WASI)",
            "Capability tokens (HMAC, mint/validate/revoke)",
          ]}
          invariants={[
            "Strictest-wins policy evaluation",
            "Workspace writes only via patch transactions",
            "Secrets never serialized across the boundary",
            "Fail-closed when sandbox backend unavailable",
          ]}
        />
        <LayerCard
          icon={Network}
          title="Non-bypassability invariant (SPEC §5.2)"
          responsibilities={[]}
          invariants={[
            "No model-facing process, TS module, plugin, skill script, MCP server, or external agent can spawn a host process, mutate a file, access a secret, or open a network connection outside the Rust broker.",
            "The control plane receives a read-only or virtualized view.",
            "Plugins run in separate processes with capabilities.",
            "Secrets are short-lived process capabilities, never environment-wide values.",
          ]}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Process ports</CardTitle>
          <CardDescription>Reachable through the Caddy gateway using ?XTransformPort=.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3">
          <PortCard label="Next.js UI" port="3000" />
          <PortCard label="TS Control Plane" port="3050" />
          <PortCard label="Rust Effect Kernel" port="3040" />
        </CardContent>
      </Card>
    </div>
  );
}

const toneCls: Record<string, { box: string; icon: string; border: string }> = {
  blue: { box: "bg-sky-500/10", icon: "text-sky-600 dark:text-sky-300", border: "border-sky-500/30" },
  purple: { box: "bg-violet-500/10", icon: "text-violet-600 dark:text-violet-300", border: "border-violet-500/30" },
  orange: { box: "bg-orange-500/10", icon: "text-orange-600 dark:text-orange-300", border: "border-orange-500/30" },
  green: { box: "bg-emerald-500/10", icon: "text-emerald-600 dark:text-emerald-300", border: "border-emerald-500/30" },
  gray: { box: "bg-muted/40", icon: "text-muted-foreground", border: "border-muted-foreground/30" },
};

function LayerBox({
  tone,
  icon: Icon,
  title,
  subtitle,
  body,
}: {
  tone: keyof typeof toneCls;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  body: string;
}) {
  const c = toneCls[tone];
  return (
    <div className={cn("rounded-lg border p-4", c.box, c.border)}>
      <div className="flex items-center gap-2">
        <Icon className={cn("size-5", c.icon)} />
        <div>
          <div className="font-semibold text-sm">{title}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">{subtitle}</div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground font-mono py-0.5">
      <span>│</span>
      <span className="rounded bg-muted/40 px-1.5 py-0.5">{label}</span>
      <span>│</span>
    </div>
  );
}

function LayerCard({
  icon: Icon,
  title,
  responsibilities,
  invariants,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  responsibilities: string[];
  invariants: string[];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {responsibilities.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">responsibilities</div>
            <ul className="list-disc ml-4 text-xs space-y-0.5">
              {responsibilities.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {invariants.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">invariants</div>
            <ul className="list-disc ml-4 text-xs space-y-0.5">
              {invariants.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PortCard({ label, port }: { label: string; port: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="font-mono text-sm">{port}</span>
        <Badge variant="outline" className="text-[9px] font-mono">?XTransformPort={port}</Badge>
      </div>
    </div>
  );
}

void Button;
