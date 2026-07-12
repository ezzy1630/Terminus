"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/forge/status-badge";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Terminal, Wrench, Boxes, Plug, ShieldCheck } from "lucide-react";

interface CapabilitiesProps {
  className?: string;
}

interface CapabilityRow {
  id: string;
  version: string;
  kind: string;
  trust_level: string;
  status: string;
}

// Static registry — the control plane's /v1/configuration lists the default tools.
const BUILTIN_TOOLS = [
  { id: "read", version: "v1", kind: "tool_pack", trust_level: "trusted", status: "active" },
  { id: "search", version: "v1", kind: "tool_pack", trust_level: "trusted", status: "active" },
  { id: "patch", version: "v1", kind: "tool_pack", trust_level: "trusted", status: "active" },
  { id: "exec", version: "v1", kind: "tool_pack", trust_level: "trusted", status: "active" },
  { id: "job", version: "v1", kind: "tool_pack", trust_level: "trusted", status: "active" },
  { id: "inspect", version: "v1", kind: "tool_pack", trust_level: "trusted", status: "active" },
  { id: "capability", version: "v1", kind: "tool_pack", trust_level: "trusted", status: "active" },
];

const BUILTIN_SKILLS = [
  { id: "skill.diff.apply", version: "v1", kind: "skill", trust_level: "trusted", status: "active" },
  { id: "skill.test.run", version: "v1", kind: "skill", trust_level: "trusted", status: "active" },
  { id: "skill.search.symbol", version: "v1", kind: "skill", trust_level: "trusted", status: "active" },
  { id: "skill.verification.plan", version: "v1", kind: "skill", trust_level: "trusted", status: "active" },
];

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  tool_pack: Wrench,
  skill: Terminal,
  mcp_server: Plug,
  plugin: Boxes,
  external_harness: ShieldCheck,
};

export function Capabilities({ className }: CapabilitiesProps) {
  const [admitOpen, setAdmitOpen] = React.useState(false);
  const all = [...BUILTIN_TOOLS, ...BUILTIN_SKILLS];

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="size-4 text-primary" />
              Capability registry
            </CardTitle>
            <CardDescription>
              SPEC §11 / §28 — skills, MCP servers, plugins. Admitting a new capability goes through activation lifecycle.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setAdmitOpen(true)}>
            <ShieldCheck className="size-4" />
            Admit capability
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                <th className="py-2 pr-3 font-mono">id</th>
                <th className="py-2 pr-3">kind</th>
                <th className="py-2 pr-3">version</th>
                <th className="py-2 pr-3">trust</th>
                <th className="py-2 pr-3">status</th>
              </tr>
            </thead>
            <tbody>
              {all.map((c) => {
                const Icon = ICONS[c.kind] ?? Boxes;
                return (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <Icon className="size-3 text-muted-foreground" />
                        <span className="font-mono text-xs">{c.id}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-3"><StatusBadge status={c.kind} tone="purple" /></td>
                    <td className="py-2 pr-3 font-mono text-xs">{c.version}</td>
                    <td className="py-2 pr-3"><StatusBadge status={c.trust_level} tone={c.trust_level === "trusted" ? "green" : "yellow"} /></td>
                    <td className="py-2 pr-3"><StatusBadge status={c.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
          {all.length} capabilities · 0 MCP servers registered · 0 plugins loaded
        </div>
      </CardContent>

      <Dialog open={admitOpen} onOpenChange={setAdmitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Admit capability (mock)</DialogTitle>
            <DialogDescription>
              Admitting a capability (SPEC §28) requires: manifest validation, capability token mint, isolation
              boundary selection, activation lifecycle, audit log. This stub records the intent only.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdmitOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                toast.info("Capability admission flow is not yet implemented in this build.");
                setAdmitOpen(false);
              }}
            >
              Record intent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

void Badge;
