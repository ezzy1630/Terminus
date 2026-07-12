"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "next-themes";
import { Hammer, Moon, Sun, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

interface HeaderProps {
  health: "ok" | "degraded" | "down" | "loading";
  onNewTask?: () => void;
  onReload?: () => void;
  className?: string;
  rightSlot?: React.ReactNode;
}

/**
 * Top app header: Forge logo + version + kernel health pill + theme toggle +
 * "New Task" button. Mobile-friendly.
 */
export function ForgeHeader({ health, onNewTask, onReload, className, rightSlot }: HeaderProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const toggleTheme = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");
  const healthCls = {
    ok: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
    degraded: "border-orange-500/40 text-orange-700 dark:text-orange-300",
    down: "border-rose-500/40 text-rose-700 dark:text-rose-300",
    loading: "border-muted-foreground/40 text-muted-foreground",
  }[health];

  return (
    <header className={cn("sticky top-0 z-30 h-14 border-b bg-background/95 backdrop-blur px-3 sm:px-4 flex items-center gap-2", className)}>
      <div className="flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Hammer className="size-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold">Forge</span>
            <Badge variant="outline" className="font-mono text-[10px]">v0.1.0</Badge>
          </div>
          <span className="hidden sm:block text-[10px] text-muted-foreground">Control Plane</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 ml-2">
        <Badge variant="outline" className={cn("gap-1 text-[10px] font-mono uppercase", healthCls)}>
          <Activity className="size-3" />
          kernel: {health}
        </Badge>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {rightSlot}
        {mounted && (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            title={`switch to ${resolvedTheme === "dark" ? "light" : "dark"}`}
          >
            {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        )}
        {onReload && (
          <Button variant="ghost" size="icon" onClick={onReload} title="reload data">
            <Activity className="size-4" />
          </Button>
        )}
        {onNewTask && (
          <Button size="sm" onClick={onNewTask}>
            New Task
          </Button>
        )}
      </div>
    </header>
  );
}
