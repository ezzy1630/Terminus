"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";

export interface SessionSummary {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  active_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSummary {
  id: string;
  session_id: string;
  thread_id: string;
  status: string;
  phase: string;
  active_contract_version: number;
  risk_class: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkspaceSummary {
  id: string;
  root_uri: string;
}

interface UseForgeDataResult {
  sessions: SessionSummary[];
  tasks: TaskSummary[];
  workspaces: WorkspaceSummary[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Top-level data fetcher: pulls all sessions (control-plane /v1/sessions),
 * then for each session fetches its tasks in parallel. Workspaces are
 * derived from sessions.
 */
export function useForgeData(): UseForgeDataResult {
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [tasks, setTasks] = React.useState<TaskSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  React.useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const sr = await forgeFetch<{ sessions: SessionSummary[] }>("/v1/sessions");
        if (aborted) return;
        const ss = sr.sessions ?? [];
        setSessions(ss);
        // Fetch tasks per session (control plane has no global /v1/tasks list).
        const taskLists = await Promise.all(
          ss.map((s) =>
            forgeFetch<{ tasks: TaskSummary[] }>(`/v1/sessions/${s.id}/tasks`)
              .then((r) => r.tasks ?? [])
              .catch(() => [] as TaskSummary[]),
          ),
        );
        if (aborted) return;
        const all = taskLists.flat().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        setTasks(all);
      } catch (e) {
        if (!aborted) setError((e as Error).message);
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [reloadKey]);

  // Derive workspaces from sessions (deduplicated by workspace_id).
  const workspaces = React.useMemo(() => {
    const seen = new Set<string>();
    const out: WorkspaceSummary[] = [];
    for (const s of sessions) {
      if (!seen.has(s.workspace_id)) {
        seen.add(s.workspace_id);
        out.push({ id: s.workspace_id, root_uri: "" });
      }
    }
    return out;
  }, [sessions]);

  return { sessions, tasks, workspaces, loading, error, reload };
}
