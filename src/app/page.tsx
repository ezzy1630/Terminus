/**
 * Forge — public API surface page.
 *
 * Per SPEC §43.4, the primary clients are the TUI (apps/tui/) and CLI
 * (apps/cli/). The web client is explicitly OPTIONAL. This page is NOT a
 * dashboard — it is a minimal status + endpoint discovery page that
 * documents the public API and SSE event stream so a human or tool can
 * connect with a real client.
 *
 * The durable product is the kernel + control plane + eval lab, exposed
 * through the public API (SPEC §32) and SSE event stream (SPEC §30.6).
 */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Forge — Public API",
  description:
    "Forge public API surface. The durable product is the Rust effect kernel, TypeScript control plane, and Python eval lab — exposed through the public API and SSE event stream. Use the TUI (apps/tui/) or CLI (apps/cli/) as the real clients.",
};

const API_GROUPS: Array<{ name: string; path: string; methods: string[]; description: string }> = [
  { name: "System health", path: "/v1/system/health", methods: ["GET"], description: "Kernel + control plane liveness and readiness." },
  { name: "Initialize", path: "/v1/system/initialize", methods: ["POST"], description: "Client capability negotiation handshake (SPEC §30.3)." },
  { name: "Open workspace", path: "/v1/workspaces/open", methods: ["POST"], description: "Register a workspace root URI." },
  { name: "Create session", path: "/v1/sessions", methods: ["POST"], description: "Open a durable collaboration session." },
  { name: "Create thread", path: "/v1/threads", methods: ["POST"], description: "Forkable chronological interaction lineage." },
  { name: "Create task", path: "/v1/tasks", methods: ["POST"], description: "Create a task with a contract (objective, non-goals, acceptance criteria, scope)." },
  { name: "Start task", path: "/v1/tasks/{id}/start", methods: ["POST"], description: "Activate a DRAFT task." },
  { name: "Start turn", path: "/v1/turns", methods: ["POST"], description: "Begin one user-to-terminal-outcome cycle. Triggers the agent loop." },
  { name: "Subscribe events", path: "/v1/events", methods: ["GET"], description: "SSE stream of semantic events with resumable cursors (SPEC §30.6)." },
  { name: "Get context manifest", path: "/v1/context/manifests/{id}", methods: ["GET"], description: "Exact record of what the model saw (SPEC §8.6, §33.13)." },
  { name: "Get artifact", path: "/v1/artifacts/{hash}", methods: ["GET"], description: "Content-addressed immutable artifact bytes." },
  { name: "Resolve approval", path: "/v1/approvals/{id}/resolve", methods: ["POST"], description: "Allow or deny a pending privileged action (SPEC §32.4)." },
  { name: "Stop job", path: "/v1/jobs/{id}/stop", methods: ["POST"], description: "Terminate a durable process tree." },
  { name: "Verification plan", path: "/v1/verification/plans/{id}", methods: ["GET"], description: "DAG of evidence-producing predicates (SPEC §17, §40)." },
  { name: "Compile workflow", path: "/v2/workflows/compile", methods: ["POST"], description: "Compile natural language skills and procedures into typed Workflow IR with source provenance (SPEC §8, §12)." },
  { name: "Validate workflow", path: "/v2/workflows/validate", methods: ["POST"], description: "Static verification for reachability, loop bounds, taint flow, temporal safety, and witness paths." },
  { name: "Workflow DAG & Witness Paths", path: "/v2/workflows/{id}/dag", methods: ["GET"], description: "Inspect compiled graph structure and formal mandatory-step witness paths." },
  { name: "Eval suites", path: "/v1/evals", methods: ["GET"], description: "Benchmark cohorts and baselines (SPEC §18, §41)." },
  { name: "Configuration", path: "/v1/configuration", methods: ["GET"], description: "Effective layered configuration (SPEC §43.5, Appendix F)." },
];

const ARCHITECTURE_LAYERS = [
  {
    name: "Rust Effect Kernel",
    port: "3040",
    role: "Non-bypassable privileged boundary. All process, filesystem, network, secret, and patch operations cross this boundary (SPEC §5.2, §13, §27, §31).",
    status: "104 tests passing",
  },
  {
    name: "TypeScript Control Plane",
    port: "3050",
    role: "Cognition and product state — sessions, tasks, context compiler, providers, orchestration, verification, memory. No ambient effect authority (SPEC §5, §27, §32).",
    status: "26 packages, 0 typecheck errors",
  },
  {
    name: "Python Eval Lab",
    port: "—",
    role: "Offline/non-privileged research plane. Evaluation analysis, statistical tests, ablations. Never on the production enforcement path (SPEC §18, §41, §43.3).",
    status: "158 tests passing",
  },
  {
    name: "Data Plane",
    port: "—",
    role: "SQLite/WAL · content-addressed artifact store · Git/worktrees · FTS5/BM25 · OpenTelemetry · Parquet/DuckDB (SPEC §7.3, §29).",
    status: "Prisma schema synced",
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground">
      <div className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 sm:py-12 space-y-10">
        <header className="space-y-3">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Forge</h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl">
            A provider-neutral coding-agent operating system with a non-bypassable
            Rust effect kernel, an inspectable Context Compiler, evidence-based
            completion, and an eval gate for complexity.
          </p>
          <p className="text-sm text-muted-foreground">
            This page documents the public API surface. The durable clients are
            the <span className="font-mono">TUI</span> (apps/tui/) and{" "}
            <span className="font-mono">CLI</span> (apps/cli/). A web dashboard is
            explicitly optional per SPEC §43.4 and is not provided here.
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Architecture</h2>
          <div className="grid gap-3">
            {ARCHITECTURE_LAYERS.map((layer) => (
              <div
                key={layer.name}
                className="rounded-lg border border-border bg-card p-4 space-y-1"
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <h3 className="font-medium">{layer.name}</h3>
                  <span className="font-mono text-xs text-muted-foreground">
                    port {layer.port}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{layer.role}</p>
                <p className="text-xs font-mono text-muted-foreground/80">
                  {layer.status}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Public API (SPEC §32)</h2>
          <p className="text-sm text-muted-foreground">
            All endpoints are relative. Through the Caddy gateway, append{" "}
            <span className="font-mono">?XTransformPort=3050</span> to reach the
            control plane, or <span className="font-mono">?XTransformPort=3040</span>{" "}
            to reach the kernel directly. Mutating requests accept an{" "}
            <span className="font-mono">Idempotency-Key</span> header (SPEC §30.5).
          </p>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Endpoint</th>
                  <th className="text-left p-3 font-medium w-20">Methods</th>
                  <th className="text-left p-3 font-medium">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {API_GROUPS.map((ep) => (
                  <tr key={ep.path} className="hover:bg-muted/30">
                    <td className="p-3 font-mono text-xs align-top">{ep.path}</td>
                    <td className="p-3 align-top">
                      <span className="font-mono text-xs">{ep.methods.join(", ")}</span>
                    </td>
                    <td className="p-3 text-muted-foreground align-top">{ep.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">SSE Event Stream (SPEC §30.6)</h2>
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <p className="text-sm">
              Subscribe to semantic events with resumable cursors:
            </p>
            <pre className="font-mono text-xs bg-muted/50 p-3 rounded overflow-x-auto">
{`GET /v1/events?cursor=<last-event-id>&task_id=<optional>&session_id=<optional>

# Each event is an SSE block:
# id: <event_id>
# event: <event_type>
# data: <payload_json>

# Reconnect with Last-Event-ID to resume.
# If the cursor expired, server returns CURSOR_EXPIRED
# plus the resource snapshot endpoint to resynchronize.`}
            </pre>
            <p className="text-xs text-muted-foreground">
              Event types include: task.created, task.activated, task.completed,
              task.failed, turn.started, turn.context_compiled,
              turn.provider_running, turn.tool_settled, turn.completed,
              tool.proposed, tool.authorized, tool.settled, tool.failed,
              policy.decision, approval.requested, approval.resolved,
              effect.proposed, effect.authorized, effect.started, effect.settled,
              context.epoch_started, context.manifest_persisted,
              checkpoint.created, agent.spawned, agent.completed,
              verification.node_passed, verification.node_failed,
              verification.plan_completed, memory.claim_created,
              capability.activated.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Error Model (SPEC §30.4)</h2>
          <pre className="font-mono text-xs bg-muted/50 p-3 rounded overflow-x-auto border border-border">
{`{
  "error": {
    "code": "STALE_SOURCE_VERSION",
    "message": "src/auth/token.ts changed after it was observed.",
    "retryable": true,
    "category": "conflict",
    "details": { "path": "...", "expected": "...", "actual": "..." },
    "suggested_action": "Re-read the affected symbol and retry the patch.",
    "trace_id": "..."
  }
}

# Categories: validation, not_found, conflict, permission, policy_denied,
# approval_required, sandbox_unavailable, resource_exhausted, budget_exhausted,
# timeout, cancelled, provider, external_dependency, integrity, internal,
# unknown_settlement`}
          </pre>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Clients</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-card p-4 space-y-1">
              <h3 className="font-medium font-mono text-sm">apps/tui/</h3>
              <p className="text-xs text-muted-foreground">
                Terminal client. The primary client surface per SPEC §43.4.
                Reconnects from server snapshots and event cursors.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 space-y-1">
              <h3 className="font-medium font-mono text-sm">apps/cli/</h3>
              <p className="text-xs text-muted-foreground">
                Non-interactive CLI for CI and automation. Same public API.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 space-y-1">
              <h3 className="font-medium font-mono text-sm">apps/ide-acp/</h3>
              <p className="text-xs text-muted-foreground">
                ACP adapter for editor integration. Calls the public API; no
                direct filesystem authority (SPEC §32.6).
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4 space-y-1">
              <h3 className="font-medium font-mono text-sm">apps/web/</h3>
              <p className="text-xs text-muted-foreground">
                Optional browser client. Not provided. Framework remains
                replaceable behind generated clients (SPEC §43.4).
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Quickstart</h2>
          <pre className="font-mono text-xs bg-muted/50 p-3 rounded overflow-x-auto border border-border">
{`# 1. Start the Rust kernel + TS control plane
bash scripts/start-mini-services.sh

# 2. Verify health
curl -sS http://127.0.0.1:3040/v1/health \\
  -X POST -H "Authorization: Bearer forge-kernel-dev-token" -d '{}'

curl -sS http://127.0.0.1:3050/v1/system/health

# 3. Create a workspace, session, task, and turn
W=$(curl -sS -X POST http://127.0.0.1:3050/v1/workspaces/open \\
  -d '{"root_uri":"/tmp/forge-demo"}' | jq -r .id)

S=$(curl -sS -X POST http://127.0.0.1:3050/v1/sessions \\
  -d "{\\"workspace_id\\":\\"$W\\",\\"title\\":\\"demo\\"}" \\
  | jq -r '.id,.active_thread_id')
SID=$(echo "$S" | head -1); TID=$(echo "$S" | tail -1)

T=$(curl -sS -X POST http://127.0.0.1:3050/v1/tasks \\
  -d "{\\"session_id\\":\\"$SID\\",\\"thread_id\\":\\"$TID\\",\\"objective\\":\\"demo\\"}" \\
  | jq -r .id)

curl -sS -X POST "http://127.0.0.1:3050/v1/tasks/$T/start" > /dev/null

curl -sS -X POST http://127.0.0.1:3050/v1/turns \\
  -d "{\\"thread_id\\":\\"$TID\\",\\"task_id\\":\\"$T\\",\\"user_input\\":\\"hello\\"}"

# 4. Watch the agent loop complete
sleep 5
curl -sS "http://127.0.0.1:3050/v1/tasks/$T" | jq '{status,phase}'`}
          </pre>
        </section>
      </div>

      <footer className="mt-auto border-t border-border bg-card">
        <div className="max-w-4xl mx-auto w-full px-4 py-4 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
          <span>
            Forge v0.1.0 — provider-neutral coding-agent OS · Rust effect kernel
            · TypeScript control plane · Python eval lab
          </span>
          <span className="font-mono">SPEC §1, §5, §32, §43.4</span>
        </div>
      </footer>
    </main>
  );
}
