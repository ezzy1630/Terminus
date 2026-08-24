import {
  AlertTriangle,
  DatabaseZap,
  RefreshCw,
  ServerOff,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { TerminusApiError } from "../../lib/api";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { EmptyState } from "../../ui/EmptyState";
import { Badge, Skeleton } from "../../ui/Status";

export type CockpitResourceStatus = "loading" | "ready" | "error" | "stale";

export interface CockpitResource<T> {
  data: T | null;
  error: Error | null;
  status: CockpitResourceStatus;
  refreshing: boolean;
  loadedAt: string | null;
  retry: () => void;
}

export interface CockpitSnapshotAdapter<T> {
  read: () => { data: T; loadedAt: string } | null;
  write: (snapshot: { data: T; loadedAt: string }) => void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Loads one control-plane resource without converting failure into empty data.
 * If a refresh fails after a successful load, the last snapshot remains visible
 * and is marked stale.
 */
export function useCockpitResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  scopeKey = "global",
  snapshotAdapter?: CockpitSnapshotAdapter<T>,
): CockpitResource<T> {
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<{
    scopeKey: string;
    data: T | null;
    error: Error | null;
    status: CockpitResourceStatus;
    refreshing: boolean;
    loadedAt: string | null;
    hasSnapshot: boolean;
  }>(() => {
    let saved: { data: T; loadedAt: string } | null = null;
    try {
      saved = snapshotAdapter?.read() ?? null;
    } catch {
      saved = null;
    }
    return {
      scopeKey,
      data: saved?.data ?? null,
      error: null,
      status: saved ? "stale" : "loading",
      refreshing: true,
      loadedAt: saved?.loadedAt ?? null,
      hasSnapshot: saved !== null,
    };
  });

  useEffect(() => {
    const controller = new AbortController();

    void load(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        const loadedAt = new Date().toISOString();
        try {
          snapshotAdapter?.write({ data, loadedAt });
        } catch {
          // A failed optional snapshot write does not turn fresh server data
          // into a failed control-plane request.
        }
        setState({
          scopeKey,
          data,
          error: null,
          status: "ready",
          refreshing: false,
          loadedAt,
          hasSnapshot: true,
        });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        const error = toError(reason);
        setState((current) => {
          const data = current.scopeKey === scopeKey ? current.data : null;
          return {
            scopeKey,
            data,
            error,
            status: current.scopeKey === scopeKey && current.hasSnapshot ? "stale" : "error",
            refreshing: false,
            loadedAt: current.scopeKey === scopeKey ? current.loadedAt : null,
            hasSnapshot: current.scopeKey === scopeKey && current.hasSnapshot,
          };
        });
      },
    );

    return () => controller.abort();
  }, [load, requestVersion, scopeKey, snapshotAdapter]);

  const retry = useCallback((): void => {
    setState((current) => current.scopeKey === scopeKey
      ? {
          ...current,
          status: current.hasSnapshot ? "stale" : "loading",
          refreshing: true,
        }
      : current);
    setRequestVersion((version) => version + 1);
  }, [scopeKey]);

  if (state.scopeKey !== scopeKey) {
    return { data: null, error: null, status: "loading", refreshing: true, loadedAt: null, retry };
  }
  const { hasSnapshot: _hasSnapshot, ...resource } = state;
  return { ...resource, retry };
}

export function CockpitPage({
  title,
  description,
  selectedTaskId,
  actions,
  snapshot,
  children,
}: {
  title: string;
  description: string;
  selectedTaskId?: string | null;
  actions?: ReactNode;
  snapshot?: Pick<CockpitResource<unknown>, "loadedAt" | "refreshing" | "retry">;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden bg-canvas text-primary" aria-labelledby="cockpit-page-title">
      <header className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-subtle px-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 id="cockpit-page-title" className="ui-page-title shrink-0 truncate">
            {title}
          </h1>
          <p className="sr-only">
            {description}
          </p>
          {selectedTaskId ? <span className="sr-only">Task {selectedTaskId}</span> : null}
        </div>
        {actions || snapshot ? (
          <div className="flex flex-shrink-0 items-center gap-2">
            {snapshot ? (
              <IconButton
                onClick={snapshot.retry}
                disabled={snapshot.refreshing}
                size="md"
                icon={<RefreshCw size={13} aria-hidden />}
                label="Refresh snapshot"
                aria-busy={snapshot.refreshing || undefined}
                data-tooltip={snapshot.refreshing
                  ? "Refreshing snapshot"
                  : snapshot.loadedAt
                    ? `Snapshot ${new Date(snapshot.loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : "Refresh snapshot"}
              />
            ) : null}
            {actions}
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">{children}</div>
    </section>
  );
}

function statePanel({
  state,
  icon,
  title,
  description,
  action,
  role = "status",
}: {
  state: string;
  icon: ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  role?: "status" | "alert";
}): JSX.Element {
  return (
    <div
      role={role}
      aria-live={role === "alert" ? "assertive" : "polite"}
      data-cockpit-state={state}
      className="min-h-28"
    >
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        action={action ? { label: action.label, onClick: action.onClick } : undefined}
        compact
      />
    </div>
  );
}

export function CockpitLoadingState({ label }: { label: string }): JSX.Element {
  return (
    <div role="status" aria-label={`Loading ${label}`} data-cockpit-state="loading" className="grid max-w-sm gap-2 px-1 py-3">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

export function CockpitEmptyState({ title, description }: { title: string; description: string }): JSX.Element {
  return statePanel({
    state: "empty",
    icon: <DatabaseZap size={18} />,
    title,
    description,
  });
}

export function TaskRequiredState({ feature }: { feature: string }): JSX.Element {
  return statePanel({
    state: "task-required",
    icon: <AlertTriangle size={18} />,
    title: "Choose a task",
    description: `Select from Recent to use ${feature.toLowerCase()}.`,
  });
}

export function FeatureUnavailableState({ feature, detail }: { feature: string; detail: string }): JSX.Element {
  return statePanel({
    state: "unavailable",
    icon: <ServerOff size={18} />,
    title: `${feature} unavailable`,
    description: detail,
  });
}

export function CockpitErrorState({ error, retry }: { error: Error; retry: () => void }): JSX.Element {
  const isOffline = error instanceof TerminusApiError && error.status === 0;
  const isUnavailable = error instanceof TerminusApiError && [404, 405, 501].includes(error.status);
  const title = isOffline
    ? "Terminus is offline"
    : isUnavailable
      ? "This view is unavailable"
      : "Couldn't load this view";
  return statePanel({
    state: isOffline || isUnavailable ? "unavailable" : "error",
    icon: isOffline || isUnavailable ? <ServerOff size={18} /> : <AlertTriangle size={18} />,
    title,
    description: isOffline ? "Reconnect to the local service, then try again." : error.message,
    action: { label: "Retry", onClick: retry },
    role: "alert",
  });
}

export function StaleDataBanner({ error, retry }: { error: Error; retry: () => void }): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      data-cockpit-state="stale"
      className="mb-2 flex min-h-8 items-center gap-2 border-l-2 border-warning/55 px-2.5 py-1.5"
    >
      <AlertTriangle size={14} style={{ color: "var(--color-warning)" }} aria-hidden />
      <p className="min-w-0 flex-1 text-secondary text-xs" >
        Showing the last successful snapshot. Refresh failed: {error.message}
      </p>
      <Button onClick={retry} variant="ghost" size="sm">
        Retry
      </Button>
    </div>
  );
}

export type SemanticTone = "neutral" | "info" | "success" | "warning" | "error";

export function SemanticBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: SemanticTone }): JSX.Element {
  const badgeTone = tone === "error" ? "danger" : tone;
  return <Badge tone={badgeTone}>{children}</Badge>;
}

export function DataSection({ title, detail, children }: { title: string; detail?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-3 first:mt-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="ui-section-title text-primary">{title}</h2>
        {detail ? <span className="ui-meta tabular-nums" >{detail}</span> : null}
      </div>
      {children}
    </section>
  );
}
