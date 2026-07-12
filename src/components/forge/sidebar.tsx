"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Activity,
  Boxes,
  Brain,
  Cpu,
  FlaskConical,
  Hammer,
  ListChecks,
  Receipt,
  ShieldCheck,
  Terminal,
  Wrench,
  FileCode,
  Settings,
} from "lucide-react";

export type ForgeSection =
  | "overview"
  | "sessions"
  | "tasks"
  | "context"
  | "tool-calls"
  | "approvals"
  | "verification"
  | "memory"
  | "capabilities"
  | "evals"
  | "configuration"
  | "architecture";

interface NavItem {
  id: ForgeSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint?: string;
}

const NAV: NavItem[] = [
  { id: "overview", label: "Overview", icon: Activity, hint: "system health & live events" },
  { id: "sessions", label: "Sessions", icon: Boxes, hint: "sessions & threads" },
  { id: "tasks", label: "Tasks", icon: ListChecks, hint: "tasks & contracts" },
  { id: "context", label: "Context", icon: FileCode, hint: "context manifests" },
  { id: "tool-calls", label: "Tool calls", icon: Wrench, hint: "audited tool calls" },
  { id: "approvals", label: "Effects & approvals", icon: ShieldCheck, hint: "resolve approvals" },
  { id: "verification", label: "Verification", icon: Cpu, hint: "verification DAGs" },
  { id: "memory", label: "Memory", icon: Brain, hint: "disabled by default" },
  { id: "capabilities", label: "Capabilities", icon: Terminal, hint: "skills, MCP, plugins" },
  { id: "evals", label: "Eval Lab", icon: FlaskConical, hint: "eval suites & baselines" },
  { id: "configuration", label: "Configuration", icon: Settings, hint: "effective config" },
  { id: "architecture", label: "Architecture", icon: Receipt, hint: "layer diagram" },
];

interface SidebarProps {
  active: ForgeSection;
  onSelect: (s: ForgeSection) => void;
  /** Optional badge counts per section. */
  counts?: Partial<Record<ForgeSection, number>>;
  /** Kernel health status. */
  health?: "ok" | "degraded" | "down" | "loading";
  className?: string;
}

/**
 * Forge dashboard left navigation. Uses a simple flex column rather than the
 * shadcn sidebar (the shadcn one is geared toward multi-route apps; we have
 * a single route with section switching).
 */
export function ForgeSidebar({ active, onSelect, counts, health = "loading", className }: SidebarProps) {
  return (
    <aside
      className={cn(
        "hidden md:flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-4 h-14 border-b">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Hammer className="size-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">Forge</span>
          <span className="text-[10px] text-muted-foreground font-mono">v0.1.0</span>
        </div>
        <HealthPill health={health} className="ml-auto" />
      </div>
      <ScrollArea className="flex-1">
        <nav className="grid gap-0.5 p-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.id;
            const count = counts?.[item.id];
            return (
              <Button
                key={item.id}
                variant={isActive ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "w-full justify-start gap-2 px-2 h-9",
                  isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
                title={item.hint}
              >
                <Icon className="size-4 shrink-0" />
                <span className="text-xs">{item.label}</span>
                {count != null && count > 0 && (
                  <Badge variant="outline" className="ml-auto h-4 px-1 text-[10px] font-mono">
                    {count > 999 ? "999+" : count}
                  </Badge>
                )}
              </Button>
            );
          })}
        </nav>
      </ScrollArea>
      <div className="border-t p-3 text-[10px] text-muted-foreground">
        <p className="font-mono">Rust kernel · TS control · Python eval</p>
      </div>
    </aside>
  );
}

/** Mobile bottom-nav variant for very small screens. */
export function ForgeMobileNav({ active, onSelect }: { active: ForgeSection; onSelect: (s: ForgeSection) => void }) {
  return (
    <div className="md:hidden sticky bottom-0 z-30 border-t bg-background/95 backdrop-blur">
      <div className="grid grid-cols-6 gap-0.5 p-1">
        {NAV.slice(0, 6).map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <Button
              key={item.id}
              variant={isActive ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onSelect(item.id)}
              className="flex-col h-12 gap-0.5 px-1"
            >
              <Icon className="size-3.5" />
              <span className="text-[9px] leading-none">{item.label.split(" ")[0]}</span>
            </Button>
          );
        })}
      </div>
      <div className="grid grid-cols-6 gap-0.5 p-1 border-t">
        {NAV.slice(6).map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <Button
              key={item.id}
              variant={isActive ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onSelect(item.id)}
              className="flex-col h-12 gap-0.5 px-1"
            >
              <Icon className="size-3.5" />
              <span className="text-[9px] leading-none">{item.label.split(" ")[0]}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function HealthPill({ health, className }: { health: "ok" | "degraded" | "down" | "loading"; className?: string }) {
  const cfg = {
    ok: { label: "ok", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
    degraded: { label: "degraded", cls: "bg-orange-500/15 text-orange-700 dark:text-orange-300" },
    down: { label: "down", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
    loading: { label: "…", cls: "bg-muted text-muted-foreground" },
  } as const;
  const c = cfg[health];
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-mono", c.cls, className)}>
      {c.label}
    </span>
  );
}
