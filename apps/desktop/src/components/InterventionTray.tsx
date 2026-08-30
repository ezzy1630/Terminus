import { memo } from "react";
import { ShieldAlert } from "lucide-react";
import { cn } from "../lib/cn";
import type { PendingApproval } from "../lib/task-surface";
import type { ApprovalDecision } from "../types";
import { Button } from "../ui/Button";
import { ApprovalCard } from "./ApprovalCard";
import { MaterialQuestionCard } from "./MaterialQuestionCard";

export type InterventionAuthorityState = "loading" | "ready" | "stale" | "error";

export interface InterventionTrayProps {
  taskId: string;
  approvals?: readonly PendingApproval[];
  approvalState?: InterventionAuthorityState;
  approvalError?: string | null;
  approvalPage?: {
    nextCursor: string | null;
    total: number | null;
    loadingMore: boolean;
    error: string | null;
  };
  onApprovalResolved?: (approvalId: string, decision: ApprovalDecision) => void;
  onApprovalExpired?: () => void;
  onLoadMoreApprovals?: () => void;
  onRetryApprovals?: () => void;
  className?: string;
}

function authorityMessage(state: InterventionAuthorityState, error: string | null | undefined): string | null {
  switch (state) {
    case "ready": return null;
    case "loading": return "Checking the control plane before enabling approval decisions.";
    case "stale": return `The last confirmed approval snapshot is stale. Decisions stay disabled${error ? `: ${error}` : "."}`;
    case "error": return `Approval state could not be confirmed. Decisions stay disabled${error ? `: ${error}` : "."}`;
  }
}

function InterventionTrayImpl({
  taskId,
  approvals = [],
  approvalState = "ready",
  approvalError,
  approvalPage,
  onApprovalResolved,
  onApprovalExpired,
  onLoadMoreApprovals,
  onRetryApprovals,
  className,
}: InterventionTrayProps): JSX.Element {
  const decisionsEnabled = approvalState === "ready";
  const message = authorityMessage(approvalState, approvalError);

  return (
    <div className={cn("intervention-tray flex flex-col gap-2", className)}>
      {approvals.length > 0 ? (
        <section
          aria-label={approvals.length === 1 ? "Permission required" : `${approvals.length} permissions required`}
          className="flex flex-col gap-2"
          data-testid="intervention-approvals"
        >
          {message ? <p role="status" className="ui-meta px-1 text-warning">{message}</p> : null}
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              id={approval.id}
              action={approval.action}
              operationHash={approval.operationHash ?? ""}
              operation={approval.operation}
              reason={approval.reason ?? "The task needs permission before this action can continue."}
              risk={approval.risk}
              scope={approval.scope}
              affectedEnvironment={approval.environment}
              requestedAt={approval.requestedAt}
              expiresAt={approval.expiresAt}
              canPersist={approval.canPersist}
              supportedDecisions={approval.supportedDecisions}
              authorizationReady={approval.authorizationReady}
              decisionsEnabled={decisionsEnabled && Boolean(approval.operationHash)}
              onResolved={(decision) => onApprovalResolved?.(approval.id, decision)}
              onExpired={onApprovalExpired}
            />
          ))}
          {approvalPage?.nextCursor && onLoadMoreApprovals ? (
            <div className="px-1">
              <Button
                type="button"
                size="sm"
                variant="bare"
                onClick={onLoadMoreApprovals}
                disabled={approvalPage.loadingMore || !decisionsEnabled}
              >
                {approvalPage.loadingMore
                  ? "Loading more approvals…"
                  : approvalPage.error
                    ? "Retry loading approvals"
                    : `Load more approvals${approvalPage.total === null ? "" : ` (${approvals.length} of ${approvalPage.total})`}`}
              </Button>
              {approvalPage.error ? <p role="alert" className="ui-meta mt-1 text-error">{approvalPage.error}</p> : null}
            </div>
          ) : null}
        </section>
      ) : message ? (
        <div
          role={approvalState === "loading" ? "status" : "alert"}
          data-testid="approval-reconciliation-state"
          className="flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-xs text-secondary"
        >
          <ShieldAlert size={13} className="shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">{message}</span>
          {approvalState !== "loading" && onRetryApprovals ? (
            <Button type="button" size="sm" onClick={onRetryApprovals}>Retry</Button>
          ) : null}
        </div>
      ) : null}
      <MaterialQuestionCard taskId={taskId} surface="intervention" />
    </div>
  );
}

export const InterventionTray = memo(InterventionTrayImpl);
