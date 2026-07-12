"use client";

import * as React from "react";
import { forgeFetch } from "@/lib/forge-client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Play } from "lucide-react";

interface RunToolPanelProps {
  /** Workspace to scope reads/exec to. */
  defaultWorkspaceId?: string;
}

/**
 * Direct tool invocation panel (for IDE/test use, SPEC §32.2). Lets the
 * operator run a `read` or `exec` tool through the same control-plane
 * audit path as model-originated calls.
 */
export function RunToolPanel({ defaultWorkspaceId }: RunToolPanelProps) {
  const [tool, setTool] = React.useState<"read" | "exec">("read");
  const [workspaceId, setWorkspaceId] = React.useState(defaultWorkspaceId ?? "dev");
  const [path, setPath] = React.useState("README.md");
  const [program, setProgram] = React.useState("echo");
  const [args, setArgs] = React.useState("hello forge");
  const [cwd, setCwd] = React.useState(".");
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<unknown>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (defaultWorkspaceId) setWorkspaceId(defaultWorkspaceId);
  }, [defaultWorkspaceId]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      if (tool === "read") {
        const r = await forgeFetch("/v1/tools/read", {
          method: "POST",
          body: { workspace_id: workspaceId, path },
        });
        setResult(r);
      } else {
        const r = await forgeFetch("/v1/tools/exec", {
          method: "POST",
          body: {
            program,
            args: args.split(/\s+/).filter(Boolean),
            cwd,
          },
        });
        setResult(r);
      }
      toast.success("Tool call settled");
    } catch (e) {
      setError((e as Error).message);
      toast.error(`Tool call failed: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Play className="size-4 text-primary" />
          Run tool
        </CardTitle>
        <CardDescription>
          Direct tool invocation for IDE/test use. Goes through the same policy + audit path as model-originated calls.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="rt-tool">Tool</Label>
            <Select value={tool} onValueChange={(v) => setTool(v as "read" | "exec")}>
              <SelectTrigger id="rt-tool">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">read</SelectItem>
                <SelectItem value="exec">exec</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rt-ws">Workspace id</Label>
            <Input
              id="rt-ws"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        </div>
        {tool === "read" ? (
          <div className="grid gap-2">
            <Label htmlFor="rt-path">Path (relative to workspace)</Label>
            <Input
              id="rt-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono text-xs"
              placeholder="README.md"
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="rt-prog">Program</Label>
              <Input
                id="rt-prog"
                value={program}
                onChange={(e) => setProgram(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rt-args">Args (space-sep)</Label>
              <Input
                id="rt-args"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rt-cwd">cwd (relative)</Label>
              <Input
                id="rt-cwd"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={running}>
            <Play className="size-4" />
            {running ? "Running…" : "Run tool"}
          </Button>
          {error && <Badge variant="destructive">error</Badge>}
        </div>
        {error && (
          <pre className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs font-mono whitespace-pre-wrap break-all">
            {error}
          </pre>
        )}
        {result !== null && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Result</div>
            <pre className="rounded-md border bg-muted/60 p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
