"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";
import { useForgeData } from "@/hooks/use-forge-data";
import { ForgeSidebar, ForgeMobileNav, type ForgeSection } from "@/components/forge/sidebar";
import { ForgeHeader } from "@/components/forge/header";
import { Overview } from "@/components/forge/sections/overview";
import { Sessions } from "@/components/forge/sections/sessions";
import { Tasks } from "@/components/forge/sections/tasks";
import { TaskDetail } from "@/components/forge/sections/task-detail";
import { Context } from "@/components/forge/sections/context";
import { ToolCalls } from "@/components/forge/sections/tool-calls";
import { Approvals } from "@/components/forge/sections/approvals";
import { Verification } from "@/components/forge/sections/verification";
import { Memory } from "@/components/forge/sections/memory";
import { Capabilities } from "@/components/forge/sections/capabilities";
import { Evals } from "@/components/forge/sections/evals";
import { Configuration } from "@/components/forge/sections/configuration";
import { Architecture } from "@/components/forge/sections/architecture";
import { DemoSeed } from "@/components/forge/demo-seed";
import { NewTaskDialog } from "@/components/forge/new-task-dialog";
import { Button } from "@/components/ui/button";
import { Github, FileText } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface HealthState {
  status: "ok" | "degraded" | "down" | "loading";
}

export default function Page() {
  const [section, setSection] = React.useState<ForgeSection>("overview");
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);
  const [selectedManifestId, setSelectedManifestId] = React.useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);
  const [health, setHealth] = React.useState<HealthState>({ status: "loading" });

  const { sessions, tasks, workspaces, loading, error, reload } = useForgeData();

  // Poll kernel health every 15s.
  React.useEffect(() => {
    let aborted = false;
    const check = async () => {
      try {
        const h = await forgeFetch<{ status: string; ready: boolean; kernel?: { status?: string; ready?: boolean } }>(
          "/v1/system/health",
        );
        if (aborted) return;
        const k = h.kernel ?? { ready: h.ready, status: h.status };
        if (k.ready === false) setHealth({ status: "degraded" });
        else if (h.status === "ok" && k.status === "ok") setHealth({ status: "ok" });
        else setHealth({ status: h.status === "ok" ? "ok" : "degraded" });
      } catch {
        if (!aborted) setHealth({ status: "down" });
      }
    };
    void check();
    const t = window.setInterval(check, 15_000);
    return () => {
      aborted = true;
      window.clearInterval(t);
    };
  }, []);

  // Helpers to navigate between sections while preserving context.
  const openTask = React.useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSection("tasks");
  }, []);
  const openManifest = React.useCallback((manifestId: string) => {
    setSelectedManifestId(manifestId);
    setSection("context");
  }, []);

  const showDemo = !loading && sessions.length === 0;

  const renderSection = () => {
    switch (section) {
      case "overview":
        return (
          <Overview
            sessions={sessions}
            tasks={tasks}
            onOpenTask={openTask}
            onOpenSession={() => setSection("sessions")}
            onSwitchSection={(s) => setSection(s)}
          />
        );
      case "sessions":
        return (
          <Sessions
            workspaces={workspaces}
            onOpenTask={openTask}
            onCreatedSession={() => reload()}
          />
        );
      case "tasks":
        return selectedTaskId ? (
          <TaskDetail
            taskId={selectedTaskId}
            onBack={() => setSelectedTaskId(null)}
            onOpenManifest={openManifest}
          />
        ) : (
          <Tasks
            tasks={tasks}
            sessions={sessions}
            loading={loading}
            onOpenTask={openTask}
            onCreatedTask={(t) => {
              reload();
              openTask(t.id);
            }}
          />
        );
      case "context":
        return <Context manifestId={selectedManifestId} onClear={() => setSelectedManifestId(null)} />;
      case "tool-calls":
        return <ToolCalls defaultWorkspaceId={workspaces[0]?.id} />;
      case "approvals":
        return <Approvals />;
      case "verification":
        return <Verification />;
      case "memory":
        return <Memory />;
      case "capabilities":
        return <Capabilities />;
      case "evals":
        return <Evals />;
      case "configuration":
        return <Configuration />;
      case "architecture":
        return <Architecture />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <div className="flex flex-1 min-h-0">
        <ForgeSidebar
          active={section}
          onSelect={(s) => {
            setSection(s);
            if (s !== "tasks") setSelectedTaskId(null);
            if (s !== "context") setSelectedManifestId(null);
          }}
          counts={{
            tasks: tasks.length,
            sessions: sessions.length,
          }}
          health={health.status}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <ForgeHeader
            health={health.status}
            onReload={reload}
            onNewTask={() => {
              if (sessions.length === 0) {
                toast.info("Create a session first — opening New Session flow.");
                setSection("sessions");
              } else {
                setNewTaskOpen(true);
              }
            }}
            rightSlot={
              <DemoSeed
                visible={showDemo && section === "overview"}
                onDone={(t) => {
                  reload();
                  openTask(t.id);
                }}
              />
            }
          />
          <main className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6">
            {error && section === "overview" ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                Failed to load dashboard: {error}. Is the control plane running on port 3050?
              </div>
            ) : null}
            {renderSection()}
          </main>
        </div>
      </div>

      <ForgeFooter />

      <ForgeMobileNav active={section} onSelect={(s) => setSection(s)} />

      {/* Header-controlled New Task dialog. Renders a hidden trigger because
          Radix Dialog needs a Trigger to anchor focus, but we drive open state
          from the header button. */}
      <NewTaskDialog
        sessions={sessions.map((s) => ({
          id: s.id,
          title: s.title,
          workspace_id: s.workspace_id,
          active_thread_id: s.active_thread_id,
        }))}
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        onCreated={(t) => {
          setNewTaskOpen(false);
          reload();
          openTask(t.id);
        }}
        trigger={<span className="hidden" aria-hidden />}
      />
    </div>
  );
}

function ForgeFooter() {
  return (
    <footer
      className={cn(
        "mt-auto border-t bg-background/95 backdrop-blur",
        "px-4 py-2 text-[10px] text-muted-foreground",
        "flex flex-wrap items-center justify-between gap-2",
      )}
    >
      <span>
        Forge v0.1.0 — provider-neutral coding-agent OS · Rust effect kernel · TypeScript control plane · Python eval lab
      </span>
      <span className="flex items-center gap-3">
        <a
          href="/SPEC.md"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <FileText className="size-3" />
          SPEC.md
        </a>
        <a
          href="https://github.com/forge/forge"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <Github className="size-3" />
          GitHub
        </a>
      </span>
    </footer>
  );
}
