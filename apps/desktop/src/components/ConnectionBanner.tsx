/**
 * Terminus Desktop — ConnectionBanner.
 *
 * Connection problems get an explicit, actionable surface instead of a
 * decorative health dot:
 *
 *   - Control plane unreachable → the last error text and a Retry action.
 *   - Navigation data stale or errored → which resource, and Retry.
 *   - SSE stream dropped while the control plane is otherwise healthy
 *     → the transport's own reason; live task updates may lag.
 *
 * Renders nothing when everything is healthy — no permanent chrome for the
 * happy path.
 *
 * Visually this is one hairline strip, not a coloured panel. Each variant used
 * to paint its own tinted background, so a slow start-up washed the top of the
 * window in orange — an ambient alarm for a condition that resolves itself.
 * Colour now lands on the glyph alone; the sentence stays in ordinary
 * secondary text, which is the calm register the rest of the chrome reads in.
 */
import { memo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { useTerminusStore } from "../hooks/use-terminus";
import { Button } from "../ui/Button";

/** The one strip every variant renders through. */
function BannerStrip({
  role,
  ariaLabel,
  tone,
  icon,
  children,
  detail,
  onRetry,
  retryLabel,
}: {
  role: "alert" | "status";
  ariaLabel: string;
  tone: "error" | "warning";
  icon: ReactNode;
  children: ReactNode;
  detail?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}): JSX.Element {
  return (
    <div
      role={role}
      {...(role === "status" ? { "aria-live": "polite" as const } : {})}
      aria-label={ariaLabel}
      data-testid="connection-banner"
      className="flex h-7 flex-shrink-0 items-center gap-2 border-b border-subtle bg-canvas px-4 text-xs"
    >
      <span className={tone === "error" ? "flex-none text-error" : "flex-none text-warning"} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary">{children}</span>
      {detail ? (
        <details className="relative flex-none text-tertiary">
          <summary className="cursor-pointer select-none">Details</summary>
          <div className="z-popover absolute right-0 top-6 w-80 select-text rounded-md border border-subtle bg-[var(--bg-popover)] p-2 font-mono text-xs text-secondary shadow-md">
            {detail}
          </div>
        </details>
      ) : null}
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry} aria-label={retryLabel ?? "Retry"} className="flex-none">
          <RefreshCw size={11} aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

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
  const retry = (): void => void refreshAll();

  if (healthStatus === "offline") {
    return (
      <BannerStrip
        role="alert"
        ariaLabel="Terminus offline"
        tone="error"
        icon={<WifiOff size={13} />}
        detail={healthDetail ?? lastError ?? "The local service did not respond."}
        onRetry={retry}
        retryLabel="Retry connection"
      >
        Terminus is offline. Check the local service, then retry.
      </BannerStrip>
    );
  }

  if (healthStatus === "degraded") {
    return (
      <BannerStrip
        role="alert"
        ariaLabel="Terminus is starting"
        tone="warning"
        icon={<TriangleAlert size={13} />}
        onRetry={retry}
        retryLabel="Retry startup check"
      >
        Terminus is still starting. Some actions are temporarily unavailable.
      </BannerStrip>
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
      <BannerStrip
        role="alert"
        ariaLabel="Navigation data is stale"
        tone="warning"
        icon={<TriangleAlert size={13} />}
        detail={staleResource.resource.error}
        onRetry={retry}
        retryLabel="Retry data refresh"
      >
        {staleResource.label} data is temporarily unavailable. Showing last known data when available.
      </BannerStrip>
    );
  }

  if (streamState === "reconnecting") {
    return (
      <BannerStrip
        role="status"
        ariaLabel="Reconnecting live updates"
        tone="warning"
        icon={<TriangleAlert size={13} />}
      >
        {lastError ?? "Live updates interrupted. Reconnecting…"}
      </BannerStrip>
    );
  }

  return null;
}

export const ConnectionBanner = memo(ConnectionBannerImpl);
