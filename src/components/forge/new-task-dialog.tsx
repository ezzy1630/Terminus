"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface SessionOption {
  id: string;
  title: string;
  workspace_id: string;
  active_thread_id: string | null;
}

interface NewTaskDialogProps {
  sessions: SessionOption[];
  defaultSessionId?: string;
  onCreated?: (task: { id: string; session_id: string; thread_id: string }) => void;
  trigger?: React.ReactNode;
  /** Controlled open state. If provided, the dialog won't manage its own state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const RISK_CLASSES = ["normal", "elevated", "high", "critical"] as const;

/**
 * "New Task" dialog: creates a task under a session+thread with an objective,
 * non-goals, acceptance criteria, allowed scope, and risk class. The
 * underlying POST is to /v1/tasks with the SPEC §32 body shape.
 */
export function NewTaskDialog({ sessions, defaultSessionId, onCreated, trigger, open: controlledOpen, onOpenChange }: NewTaskDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [sessionId, setSessionId] = React.useState<string>(defaultSessionId ?? "");
  const [objective, setObjective] = React.useState("");
  const [nonGoals, setNonGoals] = React.useState("");
  const [criteria, setCriteria] = React.useState("");
  const [readPaths, setReadPaths] = React.useState("");
  const [writePaths, setWritePaths] = React.useState("");
  const [riskClass, setRiskClass] = React.useState<string>("normal");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (defaultSessionId && !sessionId) setSessionId(defaultSessionId);
  }, [defaultSessionId, sessionId]);

  const selectedSession = sessions.find((s) => s.id === sessionId);

  const submit = async () => {
    if (!sessionId || !selectedSession) {
      toast.error("Pick a session first.");
      return;
    }
    if (!objective.trim()) {
      toast.error("Objective is required.");
      return;
    }
    if (!selectedSession.active_thread_id) {
      toast.error("Session has no active thread — create one first.");
      return;
    }
    setSubmitting(true);
    try {
      const acceptance_criteria = criteria
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((statement, i) => ({
          id: `ac-${i + 1}`,
          statement,
          required: true,
        }));
      const body = {
        session_id: sessionId,
        thread_id: selectedSession.active_thread_id,
        objective: objective.trim(),
        non_goals: nonGoals.split("\n").map((s) => s.trim()).filter(Boolean),
        acceptance_criteria,
        allowed_scope: {
          read_paths: readPaths.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
          write_paths: writePaths.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
          external_systems: [],
        },
        risk_class: riskClass,
      };
      const created = await forgeFetch<{ id: string; session_id: string; thread_id: string }>(
        "/v1/tasks",
        { method: "POST", body },
      );
      toast.success(`Task ${created.id.slice(0, 8)}… created`);
      setOpen(false);
      setObjective("");
      setNonGoals("");
      setCriteria("");
      setReadPaths("");
      setWritePaths("");
      onCreated?.(created);
    } catch (e) {
      toast.error(`Failed to create task: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== undefined ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Create a task with a contract: objective, non-goals, acceptance criteria, allowed scope, and risk class.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="nt-session">Session</Label>
            <Select value={sessionId} onValueChange={setSessionId}>
              <SelectTrigger id="nt-session">
                <SelectValue placeholder="Pick a session" />
              </SelectTrigger>
              <SelectContent>
                {sessions.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No sessions yet — create one first.</div>
                ) : (
                  sessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.title} · {s.id.slice(0, 8)}…
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {selectedSession?.active_thread_id && (
              <p className="text-[10px] font-mono text-muted-foreground">
                thread: {selectedSession.active_thread_id}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nt-objective">Objective *</Label>
            <Textarea
              id="nt-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="e.g. Add a /health endpoint to the API server"
              rows={3}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nt-non-goals">Non-goals (one per line)</Label>
            <Textarea
              id="nt-non-goals"
              value={nonGoals}
              onChange={(e) => setNonGoals(e.target.value)}
              placeholder="e.g. Do not change the auth middleware"
              rows={2}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nt-criteria">Acceptance criteria (one per line; all required)</Label>
            <Textarea
              id="nt-criteria"
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              placeholder={"GET /health returns 200\nResponse body contains { status: 'ok' }"}
              rows={3}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="nt-read">Allowed read paths (comma or newline)</Label>
              <Input
                id="nt-read"
                value={readPaths}
                onChange={(e) => setReadPaths(e.target.value)}
                placeholder="src/, tests/"
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nt-write">Allowed write paths (comma or newline)</Label>
              <Input
                id="nt-write"
                value={writePaths}
                onChange={(e) => setWritePaths(e.target.value)}
                placeholder="src/api/health.ts"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nt-risk">Risk class</Label>
            <Select value={riskClass} onValueChange={setRiskClass}>
              <SelectTrigger id="nt-risk">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RISK_CLASSES.map((r) => (
                  <SelectItem key={r} value={r}>{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
