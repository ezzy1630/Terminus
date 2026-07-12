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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus } from "lucide-react";

interface NewSessionDialogProps {
  /** Existing workspaces to pick from (will fall back to /tmp auto-create if empty). */
  workspaces: Array<{ id: string; root_uri: string }>;
  onCreated?: (session: { id: string; workspace_id: string; active_thread_id: string; title: string }) => void;
  trigger?: React.ReactNode;
}

const MODEL_PROFILES = ["classifier", "scout", "implementer", "reviewer", "checkpoint"] as const;
const PERMISSION_PROFILES = ["secure-local-default", "read-only", "trusted-local"] as const;

/**
 * "Create session" dialog. The control plane requires a workspace_id, so
 * the dialog will auto-open a workspace at /tmp if none is provided.
 */
export function NewSessionDialog({ workspaces, onCreated, trigger }: NewSessionDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [workspaceId, setWorkspaceId] = React.useState<string>("");
  const [workspaceRoot, setWorkspaceRoot] = React.useState<string>("/tmp/forge-workspace");
  const [title, setTitle] = React.useState("New session");
  const [modelProfile, setModelProfile] = React.useState<string>("implementer");
  const [permissionProfile, setPermissionProfile] = React.useState<string>("secure-local-default");
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    setSubmitting(true);
    try {
      let wsId = workspaceId;
      if (!wsId) {
        // Open a workspace first.
        const ws = await forgeFetch<{ id: string; root_uri: string }>("/v1/workspaces/open", {
          method: "POST",
          body: { root_uri: workspaceRoot, kind: "local_directory", trust: "trusted" },
        });
        wsId = ws.id;
      }
      const created = await forgeFetch<{
        id: string;
        workspace_id: string;
        active_thread_id: string;
        title: string;
      }>("/v1/sessions", {
        method: "POST",
        body: {
          workspace_id: wsId,
          title: title.trim(),
          default_model_profile: modelProfile,
          default_permission_profile: permissionProfile,
        },
      });
      toast.success(`Session ${created.id.slice(0, 8)}… created`);
      setOpen(false);
      setTitle("New session");
      onCreated?.(created);
    } catch (e) {
      toast.error(`Failed to create session: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <Plus className="size-4" />
            New Session
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create session</DialogTitle>
          <DialogDescription>
            A session lives in a workspace and owns threads, tasks, and turns.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="ns-workspace">Workspace</Label>
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger id="ns-workspace">
                <SelectValue placeholder="Open a new workspace at the path below" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">(open new workspace)</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.root_uri} · {w.id.slice(0, 8)}…
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!workspaceId && (
              <Input
                value={workspaceRoot}
                onChange={(e) => setWorkspaceRoot(e.target.value)}
                placeholder="/tmp/forge-workspace"
                className="font-mono text-xs"
              />
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ns-title">Title</Label>
            <Input
              id="ns-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Add /health endpoint"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ns-model">Default model profile</Label>
              <Select value={modelProfile} onValueChange={setModelProfile}>
                <SelectTrigger id="ns-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_PROFILES.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ns-perm">Default permission profile</Label>
              <Select value={permissionProfile} onValueChange={setPermissionProfile}>
                <SelectTrigger id="ns-perm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_PROFILES.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
