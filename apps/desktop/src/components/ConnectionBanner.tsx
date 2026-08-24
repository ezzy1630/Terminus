/**
 * Terminus Desktop — ConnectionBanner.
 *
 * Replaces the old unlabeled 1.5px health dot. Per SPEC §27 (error
 * catalog) and §17 (calm, honest feedback): connection problems get an
 * explicit, actionable surface instead of a decorative indicator.
 *
 *   - Control plane unreachable → error banner with the last error text
 *     and a Retry action (re-runs the store's refresh flow).
 *   - SSE stream dropped while the control plane is otherwise healthy
 *     → subtle "Reconnecting…" pill; live task updates may lag.
 *
 * Renders nothing when everything is healthy — no permanent chrome for
 * the happy path.
 */
import { memo } from "react";
import { RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { useTerminusStore } from "../hooks/use-terminus";
import { Button } from "../ui/Button";

function ConnectionBannerImpl(): JSX.Element | null {
  const healthStatus = useTerminusStore((s) => s.healthStatus);
  const healthDetail = useTerminusStore((s) => s.healthDetail);
  const lastError = useTerminusStore((s) => s.lastError);
  const streamState = useTerminusStore((s) => s.streamState);
  const refreshAll = useTerminusStore((s) => s.refreshAll);
  const sessionsFreshness = useTerminusStore((s) => s.sessionsFreshness);
  const selectedSessionId = useTerminusStore((s) => s.selectedSessionId);
  const selectedTaskId = useTerminusStore((s) => s.selectedTaskId);
  const taskListFreshness = useTerminusStore((s) =>
    selectedSessionId ? s.taskListFreshnessBySession[selectedSessionId] : undefined,
  );
  const taskFreshness = useTerminusStore((s) =>
    selectedTaskId ? s.taskFreshnessById[selectedTaskId] : undefined,
  );
  const approvalFreshness = useTerminusStore((s) =>
    selectedTaskId ? s.approvalFreshnessByTask[selectedTaskId] : undefined,
  );

  if (healthStatus === "offline") {
    return (
      <div
        role="alert"
        aria-label="Terminus offline"
        data-testid="connection-banner"
        className="flex h-7 flex-shrink-0 items-center gap-2 border-b px-4 text-xs"
        style={{ borderColor: "var(--border-subtle)", background: "color-mix(in srgb, var(--color-error) 4%, var(--bg-canvas))" }}
      >
        <WifiOff size={13} className="flex-shrink-0" style={{ color: "var(--color-error)" }} aria-hidden />
        <span className="min-w-0 flex-1 text-secondary">Terminus is offline. Check the local service, then retry.</span>
        <details className="relative text-tertiary">
          <summary className="cursor-pointer select-none text-xs">Details</summary>
          <div className="z-popover absolute right-0 top-6 w-80 rounded-md border border-default bg-elevated p-2 font-mono text-xs text-secondary shadow-lg">
            {healthDetail ?? lastError ?? "The local service did not respond."}
          </div>
        </details>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refreshAll()}
          aria-label="Retry connection"
        >
          <RefreshCw size={11} aria-hidden />
          Retry
        </Button>
      </div>
    );
  }

  if (healthStatus === "degraded") {
    return (
      <div
        role="alert"
        aria-label="Terminus is starting"
        data-testid="connection-banner"
        className="flex h-7 flex-shrink-0 items-center gap-2 border-b px-4 text-xs"
        style={{ borderColor: "var(--border-subtle)", background: "color-mix(in srgb, var(--color-warning) 4%, var(--bg-canvas))" }}
      >
        <TriangleAlert size={13} className="flex-shrink-0" style={{ color: "var(--color-warning)" }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-secondary">Terminus is still starting. Some actions are temporarily unavailable.</span>
        <Button size="sm" variant="ghost" onClick={() => void refreshAll()} aria-label="Retry startup check">
          <RefreshCw size={11} aria-hidden />
          Retry
        </Button>
      </div>
    );
  }

  const staleResource = [
    { label: "Projects", resource: sessionsFreshness },
    { label: "Tasks", resource: taskListFreshness },
    { label: "Selected task", resource: taskFreshness },
    { label: "Approvals", resource: approvalFreshness },
  ].find(({ resource }) => resource?.status === "stale" || resource?.status === "error");

  if (staleResource?.resource) {
    return (
      <div
        role="alert"
        aria-label="Navigation data is stale"
        data-testid="connection-banner"
        className="flex h-7 flex-shrink-0 items-center gap-2 border-b px-4 text-xs"
        style={{ borderColor: "var(--border-subtle)", background: "color-mix(in srgb, var(--color-warning) 4%, var(--bg-canvas))" }}
      >
        <TriangleAlert size={13} className="flex-shrink-0" style={{ color: "var(--color-warning)" }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-secondary">
          {staleResource.label} data is temporarily unavailable. Showing last known data when available.
        </span>
        {staleResource.resource.error ? (
          <details className="relative text-tertiary">
            <summary className="cursor-pointer select-none text-xs">Details</summary>
            <div className="z-popover absolute right-0 top-6 w-80 rounded-md border border-default bg-elevated p-2 font-mono text-xs text-secondary shadow-lg">
              {staleResource.resource.error}
            </div>
          </details>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refreshAll()}
          aria-label="Retry data refresh"
        >
          <RefreshCw size={11} aria-hidden />
          Retry
        </Button>
      </div>
    );
  }

  if (streamState === "reconnecting") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Reconnecting live updates"
        data-testid="connection-banner"
        className="flex h-7 flex-shrink-0 items-center gap-2 border-b px-4 text-xs"
        style={{ borderColor: "var(--border-subtle)", background: "color-mix(in srgb, var(--color-warning) 4%, var(--bg-canvas))" }}
      >
        <TriangleAlert size={13} className="flex-shrink-0" style={{ color: "var(--color-warning)" }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-secondary">
          Live updates interrupted. Reconnecting.
        </span>
      </div>
    );
  }

  return null;
}

export const ConnectionBanner = memo(ConnectionBannerImpl);
